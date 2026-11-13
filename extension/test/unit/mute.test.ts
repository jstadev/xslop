// Mute scheduler (SPEC 7.7) with a fake x.com tab that answers like the content script.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { DAY_MS } from '../../src/shared/muteplan';
import type { XCall, XResult } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, EMPTY_MUTE, type MuteState, type Vote } from '../../src/shared/types';
import { localDay } from '../../src/shared/util';

let f: FakeChrome;
let calls: (XCall & { at: number })[];
let answer: (m: XCall) => XResult;
const T0 = new Date(2026, 10, 7, 12, 0, 0).getTime();
const vote = (h: string, at: number): Vote => ({ h, v: 1, at, tweetId: '1', parentTweetId: null, postedAt: null, context: 'reply' });
const ok = (id: string | null, name: string | null = null): XResult => ({ status: 200, id, code: null, ids: null, next: null, name });
const mute = () => f.local.get('mute') as MuteState;
const creates = () => calls.filter((c) => c.op === 'create').map((c) => c.handle);

async function tick(): Promise<void> {
  const m = await import('../../src/bg/mute');
  await m.tick();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  calls = [];
  answer = (m) => ok(m.handle === 'own' ? '42' : '7');
  f.tabs = [{ id: 7, active: true, url: 'https://x.com/home', discarded: false } as chrome.tabs.Tab];
  f.onTabMessage = async (_id, m: XCall) => {
    if (m.t !== 'xcall') return { ok: true };
    calls.push({ ...m, at: Date.now() });
    if (m.op === 'ids') return { status: 200, id: null, code: null, ids: ['42'], next: '0', name: null };
    return answer(m);
  };
  f.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
  f.local.set('votes', [vote('a', 3), vote('own', 2), vote('b', 1)]);
});
afterEach(() => vi.useRealTimers());

describe('mute scheduler', () => {
  it('F1 regression: a stored config of 500 a day at 30 s still runs at most 40 a day, 90 s or more apart', async () => {
    f.local.set('config', { ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, createPath: '/i/api/1.1/friendships/create.json', maxPerDay: 500, minIntervalSec: 30, jitter: 0 } });
    await tick();
    expect(f.alarms.get('mute')!.scheduledTime - T0).toBe(90_000);
    expect(calls.every((c) => !('path' in c))).toBe(true);
    const m = await import('../../src/bg/store');
    await m.save('mute', { ...mute(), count: 40, nextAt: 0 });
    vi.setSystemTime(T0 + 100_000);
    await tick();
    expect(creates()).toEqual(['a']);
    expect(f.alarms.get('mute')!.scheduledTime).toBe(new Date(2026, 10, 8, 0, 0, 0).getTime());
  });

  it('F2 regression: unmutes by the recorded user id, not by the handle that may belong to someone else now', async () => {
    f.local.set('votes', []);
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['s', { at: 1, id: '111' }]] });
    await tick();
    expect(calls.map((c) => [c.op, c.handle, c.userId])).toEqual([['destroy', null, '111']]);
    expect(mute().muted).toEqual([]);
  });

  it('SPEC 13.6: a create of a listed account goes to the tab with the X id of the list, a mark without one by handle only', async () => {
    f.local.set('votes', [vote('a', 3)]);
    f.local.set('list', { version: 2, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"2"', accounts: [['g1', 90, 2]], ids: ['501'] });
    answer = (m) => ok(m.userId ?? '7');
    await tick();
    vi.setSystemTime(T0 + 200_000);
    await tick();
    expect(calls.filter((c) => c.op === 'create').map((c) => [c.handle, c.userId])).toEqual([['a', null], ['g1', '501']]);
    expect(mute().muted).toEqual([['a', { at: T0, id: '7' }], ['g1', { at: T0 + 200_000, id: '501' }]]);
  });

  it('SPEC 13.6: a rename does not undo a mute: the tick moves the record to the new handle and calls X for nothing', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, mute: false });
    f.local.set('votes', []);
    f.local.set('list', { version: 3, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"3"', accounts: [['slop_new_handle_demo', 90, 2]], ids: ['704'] });
    f.local.set('mute', { ...EMPTY_MUTE, day: localDay(T0), muted: [['slop_old_handle_demo', { at: 1, id: '704' }]] });
    await tick();
    expect(calls).toEqual([]);
    expect(mute().muted).toEqual([['slop_new_handle_demo', { at: 1, id: '704' }]]);
  });

  describe('SPEC 13.10 item 9: the list gives a handle the X id of an account on your allow list', () => {
    const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
    const ops = () => calls.map((c) => [c.op, c.userId ?? c.handle]);
    beforeEach(() => {
      f.local.set('votes', [{ ...vote('xslop_demo_ok', 1), v: 0 }]);
      f.local.set('list', { version: 4, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"4"', accounts: [['xslop_demo_list', 90, 2]], ids: ['777'] });
    });

    it('unmutes it at once by the id that X returned, records nothing, and does not try that id again while the list gives it to that handle', async () => {
      answer = (m) => ok(m.userId, m.op === 'create' ? 'xslop_demo_ok' : null);
      await tick();
      expect(ops()).toEqual([['ids', null], ['create', '777'], ['destroy', '777']]);
      expect(mute()).toMatchObject({ muted: [], skipped: [], wrongIds: [['xslop_demo_list', '777']], count: 1, pausedUntil: 0 });
      later(DAY_MS / 2);
      await tick();
      expect(calls).toHaveLength(3);
      // The list gives the handle another id: xslop tries that one.
      const store = await import('../../src/bg/store');
      await store.save('list', { version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts: [['xslop_demo_list', 90, 2]], ids: ['778'] });
      answer = (m) => ok(m.userId, 'xslop_demo_list');
      await tick();
      expect(ops().slice(3)).toEqual([['ids', null], ['create', '778']]);
      expect(mute().muted).toEqual([['xslop_demo_list', { at: Date.now(), id: '778' }]]);
    });

    it('X answers with another account than the id asked for: the unmute goes by the id that X returned', async () => {
      answer = (m) => ok(m.op === 'create' ? '999' : m.userId, m.op === 'create' ? 'xslop_demo_ok' : null);
      await tick();
      expect(ops()).toEqual([['ids', null], ['create', '777'], ['destroy', '999']]);
      expect(mute()).toMatchObject({ muted: [], wrongIds: [['xslop_demo_list', '777']] });
    });

    it('an account that is not on your allow list, or an answer without a screen name: the mute is recorded as before', async () => {
      answer = () => ok('999', 'xslop_demo_some');
      await tick();
      answer = () => ok('777', null);
      await (await import('../../src/bg/store')).save('mute', { ...mute(), muted: [], nextAt: 0 });
      await tick();
      expect(ops()).toEqual([['ids', null], ['create', '777'], ['ids', null], ['create', '777']]);
      expect(mute()).toMatchObject({ muted: [['xslop_demo_list', { id: '777' }]], wrongIds: [] });
    });

    it('the unmute at once fails: the record waits under your allowed handle, and the paced sync unmutes it after the pause', async () => {
      answer = (m) => (m.op === 'create' ? ok('777', 'xslop_demo_ok') : { status: 429, id: null, code: 88, ids: null, next: null, name: null });
      await tick();
      expect(mute()).toMatchObject({ muted: [['xslop_demo_ok', { id: '777' }]], wrongIds: [['xslop_demo_list', '777']], pausedUntil: T0 + DAY_MS });
      answer = (m) => ok(m.userId);
      later(DAY_MS);
      await tick();
      expect(ops()).toEqual([['ids', null], ['create', '777'], ['destroy', '777'], ['destroy', '777']]);
      expect(mute()).toMatchObject({ muted: [], wrongIds: [['xslop_demo_list', '777']] });
    });

    it('an account that you muted yourself before stays muted', async () => {
      f.onTabMessage = async (_id, m: XCall) => {
        calls.push({ ...m, at: Date.now() });
        return m.op === 'ids' ? { status: 200, id: null, code: null, ids: ['777'], next: '0', name: null } : ok('777', 'xslop_demo_ok');
      };
      await tick();
      expect(ops()).toEqual([['ids', null], ['create', '777']]);
      expect(mute()).toMatchObject({ muted: [], skipped: [['xslop_demo_list', 'own']], wrongIds: [] });
    });

    it('a hostile list gives that id to 3 handles: 3 creates, each undone at once, 3 of the 40 mutes of the day, then no call', async () => {
      const handles = ['xslop_demo_rot1', 'xslop_demo_rot2', 'xslop_demo_rot3'];
      f.local.set('list', { version: 6, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"6"', accounts: handles.map((h) => [h, 90, 2]), ids: handles.map(() => '777') });
      answer = (m) => ok(m.userId, m.op === 'create' ? 'xslop_demo_ok' : null);
      for (let i = 0; i < 4; i++) {
        await tick();
        later(DAY_MS / 8);
      }
      expect(ops().filter(([op]) => op !== 'ids')).toEqual(handles.flatMap(() => [['create', '777'], ['destroy', '777']]));
      expect(mute()).toMatchObject({ muted: [], count: 3, wrongIds: handles.map((h) => [h, '777']) });
    });
  });

  it('F2 regression: drops an old record without a user id, with no X call, and counts it', async () => {
    f.local.set('votes', [vote('keep', 1)]);
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['old1', { at: 1, id: null }], ['old2', { at: 1, id: null }], ['keep', { at: 1, id: '9' }]] });
    await tick();
    expect(calls).toEqual([]);
    expect(mute()).toMatchObject({ muted: [['keep', { at: 1, id: '9' }]], lost: 2 });
  });

  it('F3 regression: reads your mutes again before every create; a mute you made later stays yours', async () => {
    const xMuted = new Set<string>();
    const ids: Record<string, string> = { a: '1', h: '99' };
    f.onTabMessage = async (_id, m: XCall) => {
      calls.push({ ...m, at: Date.now() });
      if (m.op === 'ids') return { status: 200, id: null, code: null, ids: [...xMuted], next: '0', name: null };
      if (m.op === 'create') xMuted.add(ids[m.handle!]!);
      else xMuted.delete(m.userId!);
      return ok(m.op === 'create' ? ids[m.handle!]! : m.userId);
    };
    const store = await import('../../src/bg/store');
    f.local.set('votes', [vote('a', 1)]);
    await tick();
    vi.setSystemTime(T0 + 3_600_000);
    xMuted.add('99'); // you mute @h yourself in X, then click xslop on @h
    await store.save('votes', [vote('a', 1), vote('h', 2)]);
    await tick();
    vi.setSystemTime(T0 + 7_200_000);
    await store.save('votes', [vote('a', 1), { ...vote('h', 3), v: 0 }]); // later: "Not slop" on @h
    await tick();
    expect(calls.map((c) => c.op + ' ' + (c.handle ?? c.userId ?? ''))).toEqual(['ids ', 'create a', 'ids ', 'create h']);
    expect(mute().skipped).toEqual([['h', 'own']]);
    expect(mute().muted.map((e) => e[0])).toEqual(['a']);
    expect(xMuted.has('99')).toBe(true);
  });

  it('F3 regression: stops mute sync and says why when the read of your mutes hits the page cap', async () => {
    f.onTabMessage = async (_id, m: XCall) => {
      calls.push({ ...m, at: Date.now() });
      return { status: 200, id: null, code: null, ids: [String(calls.length)], next: String(calls.length + 1000), name: null };
    };
    await tick();
    expect(calls.map((c) => c.op)).toEqual(Array(20).fill('ids'));
    expect((f.local.get('settings') as { mute: boolean }).mute).toBe(false);
    expect(mute().reason).toContain('too many accounts');
    expect(f.alarms.has('mute')).toBe(false);
  });

  describe('X tabs', () => {
    const tab = (id: number, active = false) => ({ id, active, url: 'https://x.com/home', discarded: false } as chrome.tabs.Tab);
    const loggedOut: XResult = { status: 0, id: null, code: -1, ids: null, next: null, name: null };

    it('known item 3: looks for tabs on every X host that xslop may call', async () => {
      await tick();
      expect(f.tabQueries[0]).toEqual({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*'] });
    });

    it('F3 regression: goes on to the next tab when one has no content script or is logged out', async () => {
      f.tabs = [tab(1, true), tab(2), tab(3)];
      const first = f.onTabMessage;
      f.onTabMessage = async (id, m: XCall) => {
        if (id === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (id === 2) return loggedOut;
        return first(id, m);
      };
      await tick();
      expect(creates()).toEqual(['a']);
      expect(mute().waiting).toBeNull();
      expect(mute().muted.map((e) => e[0])).toEqual(['a']);
    });

    it('F3 regression: reports a missing login only when every tab is logged out', async () => {
      f.tabs = [tab(1, true), tab(2)];
      f.onTabMessage = async () => loggedOut;
      await tick();
      expect(mute().waiting).toBe('login');
      expect(creates()).toEqual([]);
    });

    it('F3 regression: a tab that never answers does not hold up the sync, and is asked once', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: T0 });
      f.tabs = [tab(1, true), tab(2)];
      const first = f.onTabMessage;
      f.onTabMessage = (id, m: XCall) => (id === 1 ? new Promise(() => undefined) : first(id, m));
      const m = await import('../../src/bg/mute');
      const run = m.tick();
      await vi.advanceTimersByTimeAsync(20_000);
      await run;
      expect(creates()).toEqual(['a']);
      expect(f.tabSent.filter((x) => x.tabId === 1)).toHaveLength(1);
    });
  });

  it('reads your own mutes first, then mutes one account per interval', async () => {
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['ids', 'create']);
    expect(calls[1]).toEqual({ t: 'xcall', op: 'create', handle: 'a', userId: null, cursor: null, bearer: DEFAULT_CONFIG.mute.webBearer, at: T0 });
    const next = f.alarms.get('mute')!.scheduledTime;
    expect(next).toBeGreaterThanOrEqual(T0 + 90_000);
    expect(next).toBeLessThanOrEqual(T0 + 117_000);

    vi.setSystemTime(T0 + 30_000);
    await tick();
    expect(creates()).toEqual(['a']);

    vi.setSystemTime(next);
    await tick();
    expect(creates()).toEqual(['a', 'own']);
    expect(mute().skipped).toEqual([['own', 'own']]);

    vi.setSystemTime(f.alarms.get('mute')!.scheduledTime);
    await tick();
    expect(creates()).toEqual(['a', 'own', 'b']);
    expect(mute().muted.map((m) => m[0])).toEqual(['a', 'b']);
    expect(mute().count).toBe(3);
    // Nothing left: no alarm.
    expect(f.alarms.has('mute')).toBe(false);
  });

  it('pauses for 24 hours on 429 and makes no call during the pause', async () => {
    answer = () => ({ status: 429, id: null, code: 88, ids: null, next: null, name: null });
    await tick();
    expect(mute().pausedUntil).toBe(T0 + 86_400_000);
    expect(mute().reason).toContain('429');
    expect(f.alarms.get('mute')!.scheduledTime).toBe(T0 + 86_400_000);
    vi.setSystemTime(T0 + 3_600_000);
    await tick();
    expect(creates()).toEqual(['a']);
  });

  it('waits for an x.com tab and makes no call without one', async () => {
    f.tabs = [];
    await tick();
    expect(calls).toEqual([]);
    expect(mute().waiting).toBe('tab');
  });

  it('respects maxPerDay and continues on the next local day', async () => {
    f.local.set('config', { ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, maxPerDay: 1 } });
    await tick();
    expect(creates()).toEqual(['a']);
    expect(f.alarms.get('mute')!.scheduledTime).toBe(new Date(2026, 10, 8, 0, 0, 0).getTime());
    vi.setSystemTime(new Date(2026, 10, 8, 0, 0, 1).getTime());
    await tick();
    expect(creates()).toEqual(['a', 'own']);
  });

  it('R2-6 unmutes an account that left the list when the calls of today are used up; the next mute waits for the next local day', async () => {
    f.local.set('votes', [vote('a', 1)]);
    f.local.set('mute', { ...EMPTY_MUTE, day: localDay(T0), count: 40, muted: [['gone', { at: 1, id: '111' }]] });
    await tick();
    expect(calls.map((c) => [c.op, c.handle, c.userId])).toEqual([['destroy', null, '111']]);
    expect(mute()).toMatchObject({ muted: [], count: 40 });
    expect(f.alarms.get('mute')!.scheduledTime).toBe(new Date(2026, 10, 8, 0, 0, 0).getTime());
    vi.setSystemTime(T0 + 3_600_000);
    await tick();
    expect(creates()).toEqual([]);
  });

  it('R2-6 "Undo all" keeps the pace between its unmutes, and no daily cap holds it', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, day: localDay(T0), count: 40, muted: [['a', { at: 1, id: '7' }], ['b', { at: 1, id: '8' }]] });
    const m = await import('../../src/bg/mute');
    await m.undoAll();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7']]);
    const next = f.alarms.get('mute')!.scheduledTime;
    expect(next).toBeGreaterThanOrEqual(T0 + 90_000);
    expect(next).toBeLessThanOrEqual(T0 + 117_000);
    vi.setSystemTime(T0 + 30_000);
    await m.tick();
    expect(calls).toHaveLength(1);
    vi.setSystemTime(next);
    await m.tick();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7'], ['destroy', '8']]);
    expect(mute()).toMatchObject({ muted: [], undoAll: false, count: 40 });
  });

  it('EXT-1 regression: "Undo all" keeps every record and pauses when X refuses the REST call with 404 (SPEC 12.3)', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['a', { at: 1, id: '7' }], ['b', { at: 1, id: '8' }]] });
    answer = () => ({ status: 404, id: null, code: 34, ids: null, next: null, name: null });
    const m = await import('../../src/bg/mute');
    await m.undoAll();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7']]);
    expect(mute()).toMatchObject({ muted: [['a', { at: 1, id: '7' }], ['b', { at: 1, id: '8' }]], undoAll: true, pausedUntil: T0 + DAY_MS });
    expect(mute().reason).toContain('404');
    vi.setSystemTime(T0 + DAY_MS);
    answer = () => ok('7');
    await m.tick();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7'], ['destroy', '7']]);
    expect(mute().muted).toEqual([['b', { at: 1, id: '8' }]]);
  });

  it('keeps an "Undo all" that arrives while a call runs', async () => {
    const m = await import('../../src/bg/mute');
    const store = await import('../../src/bg/store');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answer = (x) => ok(x.handle === 'own' ? '42' : '7');
    const first = f.onTabMessage;
    f.onTabMessage = async (id, x: XCall) => {
      if (x.op === 'create') await gate;
      return first(id, x);
    };
    const running = m.tick();
    await vi.waitFor(() => expect(calls.some((c) => c.op === 'ids')).toBe(true));
    const s = await store.state();
    await store.save('mute', { ...s.mute, undoAll: true });
    release();
    await running;
    expect(mute().undoAll).toBe(true);
    expect(mute().muted.map((x) => x[0])).toEqual(['a']);
  });

  it('does nothing when the remote config switches mute sync off', async () => {
    f.local.set('config', { ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, enabled: false } });
    await tick();
    expect(calls).toEqual([]);
  });

  it('undo all removes only the mutes in xslop\'s record, and turns muting off', async () => {
    f.local.set('mute', { ...(await import('../../src/shared/types')).EMPTY_MUTE, muted: [['a', { at: 1, id: '7' }], ['b', { at: 1, id: '8' }]], skipped: [['own', 'own']] });
    const m = await import('../../src/bg/mute');
    await m.undoAll();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7']]);
    vi.setSystemTime(f.alarms.get('mute')!.scheduledTime);
    await m.tick();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '7'], ['destroy', '8']]);
    expect(mute()).toMatchObject({ muted: [], undoAll: false });
    expect(f.local.get('settings')).toMatchObject({ mute: false, muteOnMark: false });
    expect(f.alarms.has('mute')).toBe(false);
  });
});
