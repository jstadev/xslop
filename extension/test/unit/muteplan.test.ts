import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import type { XResult } from '../../src/shared/messages';
import { DAY_MS, INSTANT_GRACE_MS, INSTANT_RETRY_MS, applyInstant, applyOwnFailure, applyOwnSnapshot, applyReadFailure, applyResult, cleanMute, dropNoId, earliest, expectInstant, followRenames, gapMs, nextDue, nextOp, noteWrongId, parseXResult, recordedId, rollDay, targets, takeBack, wrongIdOf } from '../../src/shared/muteplan';
import { DEFAULT_SETTINGS, EMPTY_MUTE, type MuteState, type StoredList, type Vote } from '../../src/shared/types';
import { localDay } from '../../src/shared/util';

const cfg = DEFAULT_CONFIG.mute;
const on = { ...DEFAULT_SETTINGS, mute: true };
const vote = (h: string, v: 0 | 1, at: number): Vote => ({ h, v, at, tweetId: '1', parentTweetId: null, postedAt: null, context: 'reply' });
const list: StoredList = { version: 3, generatedAt: '2026-11-07T00:00:00.000Z', etag: null, accounts: [['g1', 70, 2], ['g2', 95, 2], ['t1', 99, 1], ['ok', 90, 2]] };
const votes = [vote('mine_old', 1, 1), vote('mine_new', 1, 2), vote('ok', 0, 3)];
const ok = (id: string | null = null, name: string | null = null): XResult => ({ status: 200, id, code: null, ids: null, next: null, name });
const res = (status: number, code: number | null = null): XResult => ({ status, id: null, code, ids: null, next: null, name: null });
const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime();
const st = (p: Partial<MuteState> = {}): MuteState => ({ ...EMPTY_MUTE, day: localDay(NOW), ...p });

describe('mute targets (SPEC 7.7)', () => {
  it('orders your slop votes first (newest first), then global tier 2 by score; skips tier 1 and your allow list', () => {
    expect(targets(on, votes, list).order).toEqual(['mine_new', 'mine_old', 'g2', 'g1']);
  });
  it('uses no global account when strictness is Off', () => {
    expect(targets({ ...on, strictness: 'off' }, votes, list).order).toEqual(['mine_new', 'mine_old']);
  });
  it('skips accounts already muted by xslop or skipped', () => {
    const s = st({ muted: [['mine_new', { at: 1, id: '9' }]], skipped: [['mine_old', 'own']] });
    expect(nextOp(s, on, votes, list, NOW)).toEqual({ op: 'create', handle: 'g2', id: null });
  });
  it('unmutes first when an account left the list or you allowed it, with the recorded user id', () => {
    expect(nextOp(st({ muted: [['gone', { at: 1, id: '5' }]] }), on, votes, list, NOW)).toEqual({ op: 'destroy', handle: 'gone', id: '5' });
    expect(nextOp(st({ muted: [['ok', { at: 1, id: null }]] }), on, votes, list, NOW)).toEqual({ op: 'destroy', handle: 'ok', id: null });
  });
  it('F2 regression: drops a record without a user id and counts it', () => {
    const s = dropNoId(st({ muted: [['ok', { at: 1, id: null }], ['g1', { at: 1, id: '3' }]], lost: 1 }), 'ok');
    expect(s.muted).toEqual([['g1', { at: 1, id: '3' }]]);
    expect(s.lost).toBe(2);
  });
  it('reads stored state with only the known fields', () => {
    const old = { ...EMPTY_MUTE, preMuted: ['1', '2'], preMutedAt: 5 } as Partial<MuteState>;
    expect(cleanMute(old)).toEqual(EMPTY_MUTE);
    expect(cleanMute(undefined)).toEqual(EMPTY_MUTE);
  });
  it('SPEC 13.6: a create goes by the X user id that the list carries for the handle, and by handle when it carries none', () => {
    const withIds: StoredList = { ...list, accounts: [...list.accounts, ['mine_old', 60, 1]], ids: ['701', '702', null, null, '703'] };
    expect(nextOp(st(), on, votes, withIds, NOW)).toEqual({ op: 'create', handle: 'mine_new', id: null });
    expect(nextOp(st({ muted: [['mine_new', { at: 1, id: '9' }]] }), on, votes, withIds, NOW)).toEqual({ op: 'create', handle: 'mine_old', id: '703' });
    expect(nextOp(st({ muted: [['mine_new', { at: 1, id: '9' }], ['mine_old', { at: 1, id: '703' }]] }), on, votes, withIds, NOW))
      .toEqual({ op: 'create', handle: 'g2', id: '702' });
    // A list that an older build stored has no ids: every create goes by handle.
    expect(nextOp(st({ muted: [['mine_new', { at: 1, id: '9' }], ['mine_old', { at: 1, id: '703' }]] }), on, votes, list, NOW))
      .toEqual({ op: 'create', handle: 'g2', id: null });
  });
  it('SPEC 13.6: a rename does not undo a mute; the record moves to the handle that the list now gives its id, with no X call', () => {
    const renamed: StoredList = { ...list, accounts: [...list.accounts, ['slop_new_handle_demo', 80, 2]], ids: ['701', null, null, null, '704'] };
    const old = st({ muted: [['slop_old_handle_demo', { at: 1, id: '704' }]] });
    // Without the move, the old handle left the list and xslop would unmute the account.
    expect(nextOp(old, on, votes, renamed, NOW)).toEqual({ op: 'destroy', handle: 'slop_old_handle_demo', id: '704' });
    const moved = followRenames(old, on, votes, renamed);
    expect(moved.muted).toEqual([['slop_new_handle_demo', { at: 1, id: '704' }]]);
    const rest = { ...moved, muted: [...moved.muted, ['mine_new', { at: 1, id: '9' }], ['mine_old', { at: 1, id: '8' }], ['g2', { at: 1, id: '7' }]] as MuteState['muted'] };
    expect(nextOp(rest, on, votes, renamed, NOW)).toEqual({ op: 'create', handle: 'g1', id: '701' });
    // A record of the new handle with the same id holds the mute: the old record goes, nothing is unmuted.
    const both = st({ muted: [['slop_old_handle_demo', { at: 1, id: '704' }], ['slop_new_handle_demo', { at: 2, id: '704' }]] });
    expect(followRenames(both, on, votes, renamed).muted).toEqual([['slop_new_handle_demo', { at: 2, id: '704' }]]);
  });
  it('SPEC 13.6: a record does not move when you took the mark back, when the new handle is not wanted, holds another mute, or the list has no ids', () => {
    const renamed: StoredList = { ...list, accounts: [...list.accounts, ['slop_new_handle_demo', 80, 2]], ids: [null, null, null, null, '704'] };
    const rec = (p: object = {}): MuteState => st({ muted: [['slop_old_handle_demo', { at: 1, id: '704', ...p }]] });
    for (const [s, l, set] of [
      [rec({ undoAt: NOW }), renamed, on],
      [rec(), { ...renamed, accounts: [...list.accounts, ['slop_new_handle_demo', 80, 1]] }, on],
      [rec(), renamed, { ...on, strictness: 'off' }],
      [rec(), { ...renamed, ids: undefined }, on],
      [st({ muted: [['slop_old_handle_demo', { at: 1, id: '704' }], ['slop_new_handle_demo', { at: 2, id: '705' }]] }), renamed, on],
      [st({ muted: [['slop_old_handle_demo', { at: 1, id: '704' }]], undoAll: true }), renamed, on],
    ] as [MuteState, StoredList, typeof on][]) expect(followRenames(s, set, votes, l)).toBe(s);
    // You marked the old handle not slop: the mute goes, also when the list names the account under a new handle.
    const allowed = [...votes, vote('slop_old_handle_demo', 0, 4)];
    const mine = rec();
    expect(followRenames(mine, on, allowed, renamed)).toBe(mine);
    expect(nextOp(mine, on, allowed, renamed, NOW)).toEqual({ op: 'destroy', handle: 'slop_old_handle_demo', id: '704' });
    // Your slop vote keeps the old handle wanted: no move, and no second mute of the same account under the new handle.
    const kept = st({ muted: [['mine_old', { at: 1, id: '704' }], ['mine_new', { at: 1, id: '9' }], ['g2', { at: 1, id: '7' }]] });
    expect(followRenames(kept, on, votes, renamed)).toBe(kept);
    expect(nextOp(kept, on, votes, renamed, NOW)).toEqual({ op: 'create', handle: 'g1', id: null });
  });
  it('makes no new mute when sync is off, but still undoes its own', () => {
    const off = { ...on, mute: false };
    expect(nextOp(st(), off, votes, list, NOW)).toBeNull();
    expect(nextOp(st({ muted: [['g1', { at: 1, id: '4' }]], undoAll: true }), off, votes, list, NOW)).toEqual({ op: 'destroy', handle: 'g1', id: '4' });
    expect(nextOp(st({ muted: [['g1', { at: 1, id: null }]] }), off, votes, list, NOW)).toBeNull();
  });
});

describe('the retry queue (SPEC 12.3)', () => {
  const noBulk = { ...DEFAULT_SETTINGS, mute: false, muteOnMark: true };
  const queued = (h: string, due: number): MuteState => st({ retry: [[h, due]] });

  it('without bulk sync, only a due instant mute becomes a paced call', () => {
    expect(nextOp(queued('mine_new', NOW + 1), noBulk, votes, list, NOW)).toBeNull();
    expect(nextOp(queued('mine_new', NOW), noBulk, votes, list, NOW)).toEqual({ op: 'create', handle: 'mine_new', id: null });
    expect(nextOp(st(), noBulk, votes, list, NOW)).toBeNull();
    // A vote from before v1.1 never starts a mute by itself after the upgrade.
    expect(nextOp(st({ retry: [['mine_old', NOW + 1]] }), noBulk, votes, list, NOW)).toBeNull();
  });
  it('bulk sync skips a mark whose instant mute may still run', () => {
    expect(nextOp(queued('mine_new', NOW + INSTANT_GRACE_MS), on, votes, list, NOW)).toEqual({ op: 'create', handle: 'mine_old', id: null });
  });
  it('a pending undo and a due queue entry: unmutes come first', () => {
    const s = st({ muted: [['gone', { at: 1, id: '5', undoAt: NOW - INSTANT_GRACE_MS }]], retry: [['mine_new', NOW]] });
    expect(nextOp(s, noBulk, votes, list, NOW)).toEqual({ op: 'destroy', handle: 'gone', id: '5' });
  });
  it('holds a taken back record during the grace time and names the next wake-up', () => {
    const s = st({ muted: [['gone', { at: 1, id: '5', undoAt: NOW }]] });
    expect(nextOp(s, noBulk, [], list, NOW)).toBeNull();
    expect(nextDue(s, NOW)).toBe(NOW + INSTANT_GRACE_MS);
    expect(nextOp(s, noBulk, [], list, NOW + INSTANT_GRACE_MS)).toEqual({ op: 'destroy', handle: 'gone', id: '5' });
  });
  it('a bulk sync that is off keeps its old mutes; an undo of your mark does not', () => {
    const undone = st({ muted: [['g1', { at: 1, id: '5', undoAt: NOW - INSTANT_GRACE_MS }]] });
    expect(nextOp(undone, noBulk, [], list, NOW)).toEqual({ op: 'destroy', handle: 'g1', id: '5' });
    expect(nextOp(undone, on, [], list, NOW)).toEqual({ op: 'create', handle: 'g2', id: null });
    expect(nextOp(st({ muted: [['g1', { at: 1, id: '5' }]] }), noBulk, [], list, NOW)).toBeNull();
  });
  it('nextDue returns the soonest future time, or null', () => {
    expect(nextDue(st(), NOW)).toBeNull();
    expect(nextDue(st({ retry: [['a', NOW + 5], ['b', NOW + 3]] }), NOW)).toBe(NOW + 3);
    expect(nextDue(st({ retry: [['a', NOW]] }), NOW)).toBeNull();
  });
});

describe('instant results (SPEC 12.3)', () => {
  const report = (o: Partial<import('../../src/shared/messages').MuteResult>) =>
    ({ handle: 'a', id: null, status: 200, code: null, via: 'rest', op: 'create', ...o } as import('../../src/shared/messages').MuteResult);

  it('never changes the paced limits', () => {
    const s = st({ count: 5, nextAt: NOW + 9, pausedUntil: NOW + 7, fails: 2 });
    for (const r of [report({ id: '1' }), report({ status: 429 }), report({ status: 500 }), report({ status: 0, code: -4 })]) {
      expect(applyInstant(s, r, NOW)).toMatchObject({ count: 5, nextAt: NOW + 9, pausedUntil: NOW + 7, fails: 2 });
    }
  });
  it('records a mute and clears the queue and an old skip', () => {
    const s = applyInstant(st({ retry: [['a', NOW]], skipped: [['a', 'rejected']] }), report({ id: '7' }), NOW);
    expect(s).toMatchObject({ muted: [['a', { at: NOW, id: '7' }]], skipped: [], retry: [] });
  });
  it('a menu mute without an id keeps an id that xslop knew', () => {
    expect(applyInstant(st({ muted: [['a', { at: 1, id: '9' }]] }), report({ via: 'menu' }), NOW).muted).toEqual([['a', { at: NOW, id: '9' }]]);
    expect(applyInstant(st(), report({ via: 'menu' }), NOW).muted).toEqual([['a', { at: NOW, id: null }]]);
  });
  it('an id in the snapshot is your own: skipped, no record', () => {
    expect(applyInstant(st({ own: ['7'] }), report({ id: '7' }), NOW)).toMatchObject({ muted: [], skipped: [['a', 'own']] });
    expect(recordedId(applyInstant(st({ own: ['7'] }), report({ id: '7' }), NOW), 'a')).toBeNull();
  });
  it.each([[429, 88], [403, 326], [500, null], [0, null], [0, -4], [404, null]])('status %i code %s: waits in the paced queue', (status, code) => {
    expect(applyInstant(st(), report({ status, code }), NOW).retry).toEqual([['a', NOW + INSTANT_RETRY_MS]]);
  });
  it('a missing account is skipped, not retried', () => {
    expect(applyInstant(st(), report({ status: 403, code: 50 }), NOW)).toMatchObject({ skipped: [['a', 'missing']], retry: [] });
  });
  it('an unmute removes the record, a refused unmute keeps it for the paced sync', () => {
    const m = [['a', { at: 1, id: '9' }]] as MuteState['muted'];
    expect(applyInstant(st({ muted: m }), report({ op: 'destroy', id: '9' }), NOW).muted).toEqual([]);
    expect(applyInstant(st({ muted: m }), report({ op: 'destroy', status: 403, code: 63 }), NOW).muted).toEqual([]);
    expect(applyInstant(st({ muted: m }), report({ op: 'destroy', status: 500 }), NOW).muted).toEqual(m);
  });
  it('tracks the X login from instant results', () => {
    expect(applyInstant(st(), report({ status: 0, code: -1 }), NOW).waiting).toBe('login');
    expect(applyInstant(st(), report({ status: 401 }), NOW).waiting).toBe('login');
    expect(applyInstant(st({ waiting: 'login' }), report({ id: '1' }), NOW).waiting).toBeNull();
    expect(applyInstant(st({ waiting: 'login' }), report({ status: 0 }), NOW).waiting).toBe('login');
  });
  it('a mark waits for its instant call; a result that came first keeps its later time', () => {
    expect(expectInstant(st(), 'a', NOW, true).retry).toEqual([['a', NOW + INSTANT_GRACE_MS]]);
    expect(expectInstant(st(), 'a', NOW, false).retry).toEqual([]);
    expect(expectInstant(st({ retry: [['a', NOW + INSTANT_RETRY_MS]] }), 'a', NOW, true).retry).toEqual([['a', NOW + INSTANT_RETRY_MS]]);
    expect(expectInstant(st({ skipped: [['a', 'own']] }), 'a', NOW, true).retry).toEqual([]);
    expect(expectInstant(st({ muted: [['a', { at: 1, id: '9', undoAt: 5 }]] }), 'a', NOW, true)).toMatchObject({ muted: [['a', { at: 1, id: '9' }]], retry: [] });
  });
  it('taking back a mark forgets the queue entry and stamps only a recorded mute', () => {
    const s = st({ muted: [['a', { at: 1, id: '9' }]], retry: [['a', NOW], ['b', NOW]] });
    const stamped = takeBack(s, 'a', NOW, true);
    expect(stamped.muted[0]![1].undoAt).toBe(NOW);
    expect(stamped.retry).toEqual([['b', NOW]]);
    expect(takeBack(s, 'a', NOW, false).muted[0]![1].undoAt).toBeUndefined();
  });
});

describe('snapshot of your own mutes (SPEC 12.3)', () => {
  it('stores the ids without the ones that xslop made', () => {
    const s = applyOwnSnapshot(st({ muted: [['a', { at: 1, id: '7' }], ['b', { at: 1, id: null }]], waiting: 'login' }), new Set(['7', '8']), NOW);
    expect(s).toMatchObject({ own: ['8'], ownAt: NOW, waiting: null });
  });
  it('a failed read: X answered counts as the read of this period, a logged out browser does not', () => {
    expect(applyOwnFailure(st(), 429, 88, NOW)).toMatchObject({ ownAt: NOW });
    expect(applyOwnFailure(st(), 0, -1, NOW)).toMatchObject({ waiting: 'login', ownAt: 0 });
    expect(applyOwnFailure(st(), 401, null, NOW)).toMatchObject({ waiting: 'login', ownAt: NOW });
    expect(applyOwnFailure(st(), 0, null, NOW)).toEqual(st());
  });
  it('a paced result keeps queued instant mutes of other accounts', () => {
    const s = applyResult(st({ retry: [['a', NOW], ['b', NOW]] }), { op: 'create', handle: 'a', id: null }, ok('1'), cfg, NOW, 0);
    expect(s.retry).toEqual([['b', NOW]]);
  });
});

describe('X answers that concern one account', () => {
  const report = (o: Partial<import('../../src/shared/messages').MuteResult>) =>
    ({ handle: 'a', id: null, status: 403, code: null, via: 'rest', op: 'create', ...o } as import('../../src/shared/messages').MuteResult);
  const recorded: MuteState['muted'] = [['a', { at: 1, id: '9' }]];

  it('F2 regression: a destroy answered 272 (you unmuted it yourself) drops the record, with no pause', () => {
    expect(applyResult(st({ muted: recorded }), { op: 'destroy', handle: 'a', id: '9' }, res(403, 272), cfg, NOW, 0))
      .toMatchObject({ muted: [], pausedUntil: 0, reason: null });
  });
  it('F2 regression: a create answered 271 (this account is you) skips it, with no pause', () => {
    expect(applyResult(st(), { op: 'create', handle: 'a', id: null }, res(403, 271), cfg, NOW, 0))
      .toMatchObject({ skipped: [['a', 'rejected']], pausedUntil: 0, reason: null });
  });
  it('F2 regression: the instant path reads the two codes the same way', () => {
    expect(applyInstant(st({ muted: recorded }), report({ op: 'destroy', code: 272 }), NOW).muted).toEqual([]);
    expect(applyInstant(st(), report({ code: 271 }), NOW)).toMatchObject({ skipped: [['a', 'rejected']], retry: [] });
  });
  it('F12 regression: a mute that xslop records leaves the snapshot of your own mutes', () => {
    expect(applyResult(st({ own: ['42', '43'] }), { op: 'create', handle: 'a', id: null }, ok('42'), cfg, NOW, 0).own).toEqual(['43']);
  });
});

describe('a list id that names an account on your allow list (SPEC 13.10 item 9)', () => {
  // The list gives g1 the X id of @ok, which you marked not slop.
  const wrongList: StoredList = { ...list, ids: ['701', '702', null, null] };
  const plan = { op: 'create' as const, handle: 'g1', id: '701' };
  const none = new Set<string>();

  it('X names an account on your allow list: unmute at once by the id that X returned, and note the pair of the list', () => {
    expect(wrongIdOf(plan, ok('701', 'ok'), votes, none)).toEqual({ pair: ['g1', '701'], undo: { op: 'destroy', handle: 'ok', id: '701' } });
    // X answers with another account than the id asked for: the unmute goes by the id that X returned.
    expect(wrongIdOf(plan, ok('999', 'ok'), votes, none)).toEqual({ pair: ['g1', '701'], undo: { op: 'destroy', handle: 'ok', id: '999' } });
  });
  it('any other answer keeps the behaviour of before: a mute by handle, no or an odd screen_name, no id, a refusal, an account not on your allow list, your own mute', () => {
    for (const [p, r, own] of [
      [{ ...plan, id: null }, ok('701', 'ok'), none],
      [plan, ok('701', null), none],
      [plan, ok(null, 'ok'), none],
      [plan, null, none],
      [plan, { ...ok('701', 'ok'), status: 403 }, none],
      [plan, ok('701', 'g2'), none],
      [plan, ok('701', 'mine_old'), none],
      [plan, ok('701', 'ok'), new Set(['701'])],
      [{ op: 'destroy' as const, handle: 'g1', id: '701' }, ok('701', 'ok'), none],
    ] as [typeof plan, XResult | null, Set<string>][]) expect([p, r, wrongIdOf(p, r, votes, own)]).toEqual([p, r, null]);
  });
  it('the record moves to the handle that X named, where the unmute removes it; nothing is left', () => {
    const w = wrongIdOf(plan, ok('701', 'ok'), votes, none)!;
    const noted = noteWrongId(applyResult(st({ retry: [['g1', NOW]] }), plan, ok('701', 'ok'), cfg, NOW, 0), w);
    expect(noted).toMatchObject({ muted: [['ok', { at: NOW, id: '701' }]], wrongIds: [['g1', '701']], retry: [], count: 1 });
    expect(applyResult(noted, w.undo, ok('701', 'ok'), cfg, NOW, 0)).toMatchObject({ muted: [], wrongIds: [['g1', '701']], count: 1 });
    // The unmute failed: the paced sync unmutes the account first, as one on your allow list.
    expect(nextOp(noted, on, votes, wrongList, NOW)).toEqual({ op: 'destroy', handle: 'ok', id: '701' });
  });
  it('xslop does not mute by that id again while the list gives it to that handle; a new id for the handle is tried', () => {
    const s = st({ muted: [['mine_new', { at: 1, id: '9' }], ['mine_old', { at: 1, id: '8' }]], wrongIds: [['g1', '701']] });
    expect(nextOp(s, on, votes, { ...wrongList, ids: [null, '702', null, null] }, NOW)).toEqual({ op: 'create', handle: 'g2', id: '702' });
    const g2 = { ...s, muted: [...s.muted, ['g2', { at: 1, id: '702' }]] as MuteState['muted'] };
    expect(nextOp(g2, on, votes, wrongList, NOW)).toBeNull();
    expect(nextOp(g2, on, votes, { ...wrongList, ids: ['705', '702', null, null] }, NOW)).toEqual({ op: 'create', handle: 'g1', id: '705' });
    expect(nextOp(g2, on, votes, { ...wrongList, ids: [null, '702', null, null] }, NOW)).toEqual({ op: 'create', handle: 'g1', id: null });
  });
  it('one pair per handle, and at most 2000', () => {
    const w = (h: string, id: string) => ({ pair: [h, id] as [string, string], undo: { op: 'destroy' as const, handle: 'ok', id } });
    expect(noteWrongId(st({ wrongIds: [['g1', '700'], ['g2', '702']] }), w('g1', '701')).wrongIds).toEqual([['g2', '702'], ['g1', '701']]);
    const full = st({ wrongIds: Array.from({ length: 2000 }, (_, i) => [`h${i}`, String(i)] as [string, string]) });
    expect(noteWrongId(full, w('g1', '701')).wrongIds).toEqual([...full.wrongIds.slice(1), ['g1', '701']]);
  });
  it('the background reads the screen name only as a handle in lower case', () => {
    const base = ok('701');
    expect(parseXResult({ ...base, name: 'ok_handle_1' })).toEqual({ ...base, name: 'ok_handle_1' });
    for (const name of ['OK', 'a'.repeat(16), '@ok', '', 7, undefined]) expect([name, parseXResult({ ...base, name })]).toEqual([name, null]);
  });
});

describe('mute pace', () => {
  it('keeps at least minIntervalSec between calls, with up to `jitter` more', () => {
    expect(gapMs(cfg, 0)).toBe(90_000);
    expect(gapMs(cfg, 1)).toBe(117_000);
    const after = applyResult(st(), { op: 'create', handle: 'a', id: null }, ok(), cfg, NOW, 0.5);
    expect(after.nextAt).toBe(NOW + 103_500);
    expect(earliest(after, cfg, NOW + 1000, 'create')).toBe(NOW + 103_500);
    expect(earliest(after, cfg, NOW + 1000, 'destroy')).toBe(NOW + 103_500);
  });
  it('stops at maxPerDay until the next local day', () => {
    const full = st({ count: cfg.maxPerDay });
    const midnight = new Date(2026, 10, 8, 0, 0, 0).getTime();
    expect(earliest(full, cfg, NOW, 'create')).toBe(midnight);
    expect(rollDay(full, midnight + 1).count).toBe(0);
  });
  it('R2-6 an unmute does not wait for the daily cap and does not count toward it; the mutes behind it still wait', () => {
    const midnight = new Date(2026, 10, 8, 0, 0, 0).getTime();
    // The 40 calls of today are used, and an account that xslop muted left the list.
    const full = st({ count: cfg.maxPerDay, nextAt: NOW + 5_000, muted: [['gone', { at: 1, id: '5' }]] });
    const plan = nextOp(full, on, votes, list, NOW);
    expect(plan).toEqual({ op: 'destroy', handle: 'gone', id: '5' });
    expect(earliest(full, cfg, NOW, 'destroy')).toBe(NOW + 5_000);
    const after = applyResult(full, plan!, ok('5'), cfg, NOW + 5_000, 0);
    expect(after).toMatchObject({ muted: [], count: cfg.maxPerDay, nextAt: NOW + 5_000 + 90_000 });
    expect(nextOp(after, on, votes, list, NOW + 5_000)).toEqual({ op: 'create', handle: 'mine_new', id: null });
    expect(earliest(after, cfg, NOW + 5_000, 'create')).toBe(midnight);
    // An unmute that X refuses for that one account also uses none of the day.
    expect(applyResult(full, plan!, res(403, 272), cfg, NOW + 5_000, 0)).toMatchObject({ muted: [], count: cfg.maxPerDay });
  });
  it('R2-6 an unmute keeps the 24 hour stop rules', () => {
    const plan = { op: 'destroy' as const, handle: 'gone', id: '5' };
    const recorded = st({ muted: [['gone', { at: 1, id: '5' }]] });
    const stopped = applyResult(recorded, plan, res(429), cfg, NOW, 0);
    expect(stopped).toMatchObject({ pausedUntil: NOW + DAY_MS, muted: recorded.muted });
    expect(earliest(stopped, cfg, NOW + 1000, 'destroy')).toBe(NOW + DAY_MS);
    let s = applyResult(recorded, plan, res(503), cfg, NOW, 0);
    s = applyResult(s, plan, res(500), cfg, NOW, 0);
    expect(applyResult(s, plan, res(502), cfg, NOW, 0).pausedUntil).toBe(NOW + DAY_MS);
  });
});

describe('mute results and stop rules', () => {
  const plan = { op: 'create' as const, handle: 'a', id: null };
  it('records a mute that xslop made, and counts it', () => {
    const s = applyResult(st(), plan, ok('42'), cfg, NOW, 0);
    expect(s.muted).toEqual([['a', { at: NOW, id: '42' }]]);
    expect(s.count).toBe(1);
  });
  it('never records an account that you muted yourself before', () => {
    const s = applyResult(st(), plan, ok('42'), cfg, NOW, 0, new Set(['42']));
    expect(s.muted).toEqual([]);
    expect(s.skipped).toEqual([['a', 'own']]);
  });
  it.each([401, 403, 429])('pauses 24 h on %i and says why', (code) => {
    const s = applyResult(st(), plan, res(code), cfg, NOW, 0);
    expect(s.pausedUntil).toBe(NOW + DAY_MS);
    expect(s.reason).toContain(String(code));
    expect(earliest(s, cfg, NOW, 'create')).toBe(NOW + DAY_MS);
    expect(s.muted).toEqual([]);
  });
  it('pauses 24 h after three 5xx in a row, not before', () => {
    let s = applyResult(st(), plan, res(503), cfg, NOW, 0);
    s = applyResult(s, plan, res(500), cfg, NOW, 0);
    expect(s.pausedUntil).toBe(0);
    expect(s.fails).toBe(2);
    s = applyResult(s, plan, res(502), cfg, NOW, 0);
    expect(s.pausedUntil).toBe(NOW + DAY_MS);
    expect(s.reason).toContain('three times');
  });
  it('a success resets the 5xx count', () => {
    let s = applyResult(st(), plan, res(503), cfg, NOW, 0);
    s = applyResult(s, plan, ok(), cfg, NOW, 0);
    expect(s.fails).toBe(0);
  });
  it('skips an account that X does not have, without a pause', () => {
    const s = applyResult(st(), plan, res(403, 50), cfg, NOW, 0);
    expect(s.pausedUntil).toBe(0);
    expect(s.skipped).toEqual([['a', 'missing']]);
    for (const r of [res(403, 50), res(404, 50), res(403, 63), res(403, 272)]) {
      const gone = applyResult(st({ muted: [['a', { at: 1, id: '9' }]] }), { op: 'destroy', handle: 'a', id: '9' }, r, cfg, NOW, 0);
      expect([r.status, r.code, gone.muted, gone.pausedUntil]).toEqual([r.status, r.code, [], 0]);
    }
    expect(applyResult(st(), plan, res(404, 50), cfg, NOW, 0)).toMatchObject({ skipped: [['a', 'missing']], pausedUntil: 0 });
  });
  it('EXT-1 regression: a 404 that names no account is X refusing the call (SPEC 12.3): it pauses 24 h, keeps the record and skips nothing', () => {
    const rec: [string, { at: number; id: string }] = ['a', { at: 1, id: '9' }];
    for (const r of [res(404), res(404, 34)]) {
      const undo = applyResult(st({ muted: [rec] }), { op: 'destroy', handle: 'a', id: '9' }, r, cfg, NOW, 0);
      expect([r.code, undo.muted, undo.pausedUntil]).toEqual([r.code, [rec], NOW + DAY_MS]);
      expect(undo.reason).toContain('404');
      const mute = applyResult(st(), plan, r, cfg, NOW, 0);
      expect([r.code, mute.skipped, mute.pausedUntil]).toEqual([r.code, [], NOW + DAY_MS]);
    }
  });
  it('waits for an x.com tab or a login, without a call', () => {
    expect(applyResult(st(), plan, null, cfg, NOW, 0).waiting).toBe('tab');
    expect(applyResult(st(), plan, res(0, -1), cfg, NOW, 0).waiting).toBe('login');
  });
  it('a failed read of your own mutes pauses, because the path may be stale', () => {
    expect(applyReadFailure(st(), res(404), cfg, NOW, 0).pausedUntil).toBe(NOW + DAY_MS);
    expect(applyReadFailure(st(), res(503), cfg, NOW, 0).fails).toBe(1);
  });
});
