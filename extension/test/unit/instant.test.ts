// Instant mutes in the background (SPEC 12.3): the record, the retry queue, the snapshot of your own mutes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliver, fakeChrome, type FakeChrome } from '../helpers/chrome';
import type { XCall, XResult } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, EMPTY_MUTE, type MuteState, type Settings, type Vote } from '../../src/shared/types';

let f: FakeChrome;
let calls: XCall[];
const T0 = new Date(2026, 10, 7, 12, 0, 0).getTime();
const content = { id: 'xslop-test-id', tab: { id: 7 } as chrome.tabs.Tab, url: 'https://x.com/alice/status/100' };
const popup = { id: 'xslop-test-id', url: 'chrome-extension://xslop-test-id/popup.html' };
const vote = (h: string, at = T0): Vote => ({ h, v: 1, at, tweetId: '1', parentTweetId: null, postedAt: null, context: 'reply' });
const voteMsg = (h: string) => ({ t: 'vote', handle: h, value: 'slop', tweetId: '1', parentTweetId: null, postedAt: null, context: 'reply' });
const muted = (handle: string, status: number, id: string | null, op = 'create', code: number | null = null, via = 'rest') =>
  ({ t: 'muted', handle, id, status, code, via, op });
const mute = () => f.local.get('mute') as MuteState;
const ok = (id: string | null): XResult => ({ status: 200, id, code: null, ids: null, next: null, name: null });
let snapshot: string[];
const flushDue = vi.fn(async () => undefined);

async function boot(): Promise<void> {
  await import('../../src/background');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  vi.doMock('../../src/bg/outbox', () => ({
    OUTBOX_ALARM: 'outbox', enqueueDelete: async () => undefined, enqueueObservations: async () => undefined,
    enqueueVote: async () => undefined, flush: async () => undefined, flushDue, obsConsent: async () => true,
  }));
  calls = [];
  snapshot = ['900'];
  f.tabs = [{ id: 7, active: true, url: 'https://x.com/home', discarded: false } as chrome.tabs.Tab];
  f.onTabMessage = async (_id, m: XCall) => {
    if (m.t !== 'xcall') return { ok: true };
    calls.push(m);
    return m.op === 'ids' ? { status: 200, id: null, code: null, ids: snapshot, next: '0', name: null } : ok(m.op === 'create' ? '555' : m.userId);
  };
  f.local.set('settings', { ...DEFAULT_SETTINGS });
});
afterEach(() => {
  vi.doUnmock('../../src/bg/outbox');
  vi.useRealTimers();
});

/** Let background work finish. Only Date is fake, so real macrotasks still run and the clock stands still. */
const idle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function settled(): Promise<void> {
  await idle();
  const { tick } = await import('../../src/bg/mute');
  await tick();
  await idle();
}

describe('recording an instant mute', () => {
  it('records the X user id and counts nothing against the paced limits', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    expect(await deliver(f, muted('slopbot', 200, '123'), content)).toEqual({ ok: true });
    await settled();
    expect(mute().muted).toEqual([['slopbot', { at: T0, id: '123' }]]);
    expect(mute()).toMatchObject({ count: 0, nextAt: 0, pausedUntil: 0, fails: 0, retry: [] });
    expect(calls).toEqual([]);
  });

  it('never double-counts a mark while the instant call runs: bulk sync skips it during the grace time', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await settled();
    expect(calls.filter((c) => c.op === 'create')).toEqual([]);
    // The instant result lands; the sync never calls X for this account.
    await deliver(f, muted('slopbot', 200, '123'), content);
    await settled();
    vi.setSystemTime(T0 + 3_600_000);
    await settled();
    expect(calls.filter((c) => c.op === 'create')).toEqual([]);
    expect(mute().count).toBe(0);
  });

  it('is not blocked by a running 24 hour pause of the paced sync', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, pausedUntil: T0 + 3_600_000, reason: 'X answered 429.' });
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 200, '123'), content);
    expect(mute().muted).toEqual([['slopbot', { at: T0, id: '123' }]]);
    expect(mute().pausedUntil).toBe(T0 + 3_600_000);
  });

  it('keeps a refused mute in the paced queue and lets a later paced call land it', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 429, null, 'create', 88), content);
    await settled();
    expect(mute().retry).toEqual([['slopbot', T0 + 15 * 60_000]]);
    expect(calls).toEqual([]);
    // The alarm fires: the worker may have restarted in between.
    vi.resetModules();
    vi.setSystemTime(T0 + 15 * 60_000);
    await boot();
    await settled();
    expect(calls.map((c) => c.op)).toEqual(['ids', 'create']);
    expect(mute().muted).toEqual([['slopbot', { at: T0 + 15 * 60_000, id: '555' }]]);
    expect(mute().retry).toEqual([]);
    expect(mute().count).toBe(1);
  });

  it('marks a missing account as missing and does not retry it', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 403, null, 'create', 50), content);
    expect(mute().skipped).toEqual([['slopbot', 'missing']]);
    expect(mute().retry).toEqual([]);
  });

  it('records a mute through the menu without an id', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 200, null, 'create', null, 'menu'), content);
    await settled();
    expect(mute().muted).toEqual([['slopbot', { at: T0, id: null }]]);
    expect(await deliver(f, { t: 'muteRecord', handle: 'slopbot' }, content)).toEqual({ id: null, stays: true });
  });

  it('keeps a result that arrives while a paced call runs', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
    f.local.set('votes', [vote('queued', T0 - 3_600_000)]);
    await boot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = f.onTabMessage;
    f.onTabMessage = async (id, m: XCall) => {
      if (m.t === 'xcall' && m.op === 'create') await gate;
      return first(id, m);
    };
    const { tick } = await import('../../src/bg/mute');
    const running = tick();
    await idle();
    expect(f.tabSent.some((x) => x.msg.op === 'create')).toBe(true);
    await deliver(f, muted('instant', 200, '321'), content);
    release();
    await running;
    expect(mute().muted.map((e) => e[0]).sort()).toEqual(['instant', 'queued']);
  });
});

describe('undo by recorded id', () => {
  beforeEach(() => {
    f.local.set('votes', [vote('slopbot')]);
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['slopbot', { at: 1, id: '123' }]] });
  });

  it('answers with the recorded id and removes the record after the instant unmute', async () => {
    await boot();
    expect(await deliver(f, { t: 'muteRecord', handle: 'SlopBot' }, content)).toEqual({ id: '123', stays: false });
    await deliver(f, muted('slopbot', 200, '123', 'destroy'), content);
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    await settled();
    expect(mute().muted).toEqual([]);
    expect(calls).toEqual([]);
    expect(mute().count).toBe(0);
  });

  it('answers null for an account without a record: no unmute', async () => {
    await boot();
    expect(await deliver(f, { t: 'muteRecord', handle: 'someone' }, content)).toEqual({ id: null, stays: false });
  });

  it('the paced sync does not unmute during the grace time, then takes over a failed unmute', async () => {
    await boot();
    await deliver(f, { t: 'muteRecord', handle: 'slopbot' }, content);
    await deliver(f, muted('slopbot', 500, '123', 'destroy'), content);
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    await settled();
    expect(calls).toEqual([]);
    expect(mute().muted[0]![1].undoAt).toBe(T0);
    expect(f.alarms.get('mute')!.scheduledTime).toBe(T0 + 60_000);
    vi.setSystemTime(T0 + 60_000);
    await settled();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '123']]);
    expect(mute().muted).toEqual([]);
  });

  it('an undo from the popup unmutes the account, also when the shared list has it and bulk sync is off', async () => {
    f.local.set('list', { version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: null, accounts: [['slopbot', 90, 2]] });
    await boot();
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, popup);
    await settled();
    vi.setSystemTime(T0 + 60_000);
    await settled();
    expect(calls.map((c) => [c.op, c.userId])).toEqual([['destroy', '123']]);
  });

  it('with bulk sync on, an account on the shared list stays muted after an undo', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
    f.local.set('list', { version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: null, accounts: [['slopbot', 90, 2]] });
    await boot();
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, popup);
    await settled();
    vi.setSystemTime(T0 + 60_000);
    await settled();
    expect(calls).toEqual([]);
    expect(mute().muted.map((e) => e[0])).toEqual(['slopbot']);
  });

  it('marking again cancels an undo that the paced sync did not run yet', async () => {
    await boot();
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, popup);
    await deliver(f, voteMsg('slopbot'), content);
    vi.setSystemTime(T0 + 60_000);
    await settled();
    expect(calls).toEqual([]);
    expect(mute().muted).toEqual([['slopbot', { at: 1, id: '123' }]]);
  });
});

describe('races around a click', () => {
  const list = { version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: null, accounts: [['slopbot', 90, 2]] };

  it('F6 regression: a mute that lands after you took the mark back gets undone, even for a listed account', async () => {
    f.local.set('list', list);
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    await deliver(f, muted('slopbot', 200, '123'), content);
    await settled();
    expect(mute().muted).toEqual([['slopbot', { at: T0, id: '123', undoAt: T0 }]]);
    vi.setSystemTime(T0 + 60_000);
    await settled();
    expect(calls.map((c) => [c.op, c.userId])).toContainEqual(['destroy', '123']);
  });

  it('F6 regression: a refused mute after you took the mark back does not wait in the queue', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    await deliver(f, muted('slopbot', 500, null), content);
    expect(mute().retry).toEqual([]);
  });

  it('F7 regression: an undo right behind a mark wins, even when the storage write of the mark is slow', async () => {
    await boot();
    const real = f.api.storage.local.set;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    f.api.storage.local.set = (async (o: Record<string, unknown>) => {
      if (first) {
        first = false;
        await gate;
      }
      return real(o);
    }) as typeof f.api.storage.local.set;
    const marked = deliver(f, voteMsg('slopbot'), content);
    await idle();
    const undone = deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    await idle();
    release();
    await Promise.all([marked, undone]);
    expect(f.local.get('votes')).toEqual([]);
  });

  it('F8 regression: a tab that never answers cannot hold up a vote', async () => {
    await boot();
    f.onTabMessage = () => new Promise(() => undefined);
    expect(await deliver(f, voteMsg('slopbot'), content)).toEqual({ ok: true });
    expect(await deliver(f, { t: 'unvote', handle: 'slopbot' }, content)).toEqual({ ok: true });
  });

  it('F12 regression: a retried mute whose first report was lost is xslop\'s own, so Undo can remove it', async () => {
    // The tab closed after X took the mute: the id is in the new read, not in the snapshot from before.
    f.local.set('votes', [vote('slopbot')]);
    f.local.set('mute', { ...EMPTY_MUTE, own: ['900'], ownAt: T0, retry: [['slopbot', T0]] });
    snapshot = ['900', '555'];
    await boot();
    const { tick } = await import('../../src/bg/mute');
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['ids', 'create']);
    expect(mute().skipped).toEqual([]);
    expect(mute().muted).toEqual([['slopbot', { at: T0, id: '555' }]]);
    expect(mute().own).toEqual(['900']);
    expect(await deliver(f, { t: 'muteRecord', handle: 'slopbot' }, content)).toEqual({ id: '555', stays: false });
  });

  it('F16 regression: says when a mute stays on X after an undo', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['bymenu', { at: 1, id: null }]], skipped: [['mine', 'own'], ['gone', 'missing']] });
    await boot();
    const ask = (handle: string) => deliver(f, { t: 'muteRecord', handle }, content);
    expect(await ask('bymenu')).toEqual({ id: null, stays: true });
    expect(await ask('mine')).toEqual({ id: null, stays: true });
    expect(await ask('gone')).toEqual({ id: null, stays: false });
  });
});

describe('after a worker restart or an update', () => {
  it('F13 regression: the list alarm sends what a killed worker left in the outbox', async () => {
    f.local.set('identity', { installId: 'x', createdAt: '2026-11-07T00:00:00.000Z' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await boot();
    flushDue.mockClear();
    f.alarmFired[0]!({ name: 'list' });
    await idle();
    expect(flushDue).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('F13 regression: the mute queue runs at startup even when the list sync fails', async () => {
    f.local.set('votes', [vote('slopbot')]);
    f.local.set('mute', { ...EMPTY_MUTE, retry: [['slopbot', T0 - 1]] });
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await boot();
    f.startup[0]!();
    await vi.waitFor(() => expect(calls.map((c) => c.op)).toEqual(['ids', 'create']));
    vi.unstubAllGlobals();
  });

  it.each([
    [{ reason: 'install' }, true],
    [{ reason: 'update', previousVersion: '1.0.1' }, true],
    [{ reason: 'update', previousVersion: '1.1.0' }, false],
    [{ reason: 'update' }, false],
    [{ reason: 'browser_update' }, false],
  ])('F14 regression: %j opens the page that says what a click does: %s', async (details, opens) => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await boot();
    f.installed[0]!(details);
    await idle();
    expect(f.created.map((c) => c.url)).toEqual(opens ? ['chrome-extension://xslop-test-id/onboarding.html'] : []);
    vi.unstubAllGlobals();
  });
});

describe('your own mutes stay yours (SPEC 12.3)', () => {
  it('reads the snapshot when an x.com tab appears, at most every 6 hours', async () => {
    await boot();
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(mute().ownAt).toBe(T0);
    expect(mute().own).toEqual(['900']);
    expect(calls.map((c) => c.op)).toEqual(['ids']);
    await deliver(f, { t: 'hello' }, content);
    vi.setSystemTime(T0 + 3_600_000 * 5);
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(calls.filter((c) => c.op === 'ids')).toHaveLength(1);
    vi.setSystemTime(T0 + 3_600_000 * 6);
    snapshot = ['900', '901'];
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(mute().own).toEqual(['900', '901']);
  });

  it('a mute of an account in the snapshot is recorded as skipped: own, and undo leaves it muted', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, own: ['900'], ownAt: T0 });
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 200, '900'), content);
    expect(mute().skipped).toEqual([['slopbot', 'own']]);
    expect(mute().muted).toEqual([]);
    expect(await deliver(f, { t: 'muteRecord', handle: 'slopbot' }, content)).toEqual({ id: null, stays: true });
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, content);
    vi.setSystemTime(T0 + 3_600_000);
    await settled();
    expect(calls).toEqual([]);
  });

  it('leaves the mutes that xslop made out of the snapshot, so a later undo can remove them', async () => {
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['slopbot', { at: 1, id: '123' }]] });
    snapshot = ['123', '900'];
    await boot();
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(mute().own).toEqual(['900']);
  });

  it('does not read the snapshot when instant mute is off', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, muteOnMark: false });
    await boot();
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(calls).toEqual([]);
  });

  it('remembers a missing X login, tells nothing false, and reads again when you log in', async () => {
    await boot();
    f.onTabMessage = async (_id, m: XCall) => {
      if (m.t !== 'xcall') return { ok: true };
      calls.push(m);
      return { status: 0, id: null, code: -1, ids: null, next: null, name: null };
    };
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(mute().waiting).toBe('login');
    expect(mute().ownAt).toBe(0);
    f.onTabMessage = async (_id, m: XCall) => {
      if (m.t !== 'xcall') return { ok: true };
      calls.push(m);
      return { status: 200, id: null, code: null, ids: ['900'], next: '0', name: null };
    };
    await deliver(f, { t: 'hello' }, content);
    await settled();
    expect(mute().ownAt).toBe(T0);
    expect(mute().waiting).toBeNull();
  });
});

describe('settings', () => {
  it('turning instant mute off clears the queue and stops new retries', async () => {
    await boot();
    await deliver(f, voteMsg('slopbot'), content);
    await deliver(f, muted('slopbot', 500, null), content);
    expect(mute().retry).toHaveLength(1);
    await deliver(f, { t: 'settings', patch: { muteOnMark: false } }, popup);
    expect(mute().retry).toEqual([]);
    expect(f.local.get('settings')).toMatchObject({ muteOnMark: false } satisfies Partial<Settings>);
    expect(f.tabSent.some((x) => x.msg.t === 'settings' && x.msg.settings.muteOnMark === false)).toBe(true);
  });
});

describe('message guard', () => {
  it('takes the new messages only from an X tab', async () => {
    await boot();
    expect(await deliver(f, muted('slopbot', 200, '1'), popup)).toEqual({ error: 'bad_message' });
    expect(await deliver(f, muted('slopbot', 200, '1'), { ...content, url: 'https://evil.example/' })).toEqual({ error: 'bad_message' });
    expect(await deliver(f, { ...muted('slopbot', 200, '1'), extra: 1 }, content)).toEqual({ error: 'bad_message' });
    expect(f.local.get('mute')).toBeUndefined();
  });
});
