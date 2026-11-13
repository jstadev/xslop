// Background modules against the local mock API over real HTTP: proof of work, signatures, outbox, list sync.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApi, defaultConfig } from '../mock-server';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { setApi } from '../helpers/setup';
import { DEFAULT_SETTINGS, type Observation, type Outbox, type Status, type StoredList, type VoteBody } from '../../src/shared/types';

let mock: MockApi;
let f: FakeChrome;

const body = (handle: string, value: VoteBody['value'] = 'slop'): VoteBody => ({
  handle, value, tweetId: '101', parentTweetId: '100', postedAt: '2026-11-07T09:10:12.000Z', context: 'reply',
});
const outbox = () => f.local.get('outbox') as Outbox;
const status = () => f.local.get('status') as Status;

async function load() {
  return {
    outbox: await import('../../src/bg/outbox'),
    api: await import('../../src/bg/api'),
    sync: await import('../../src/bg/sync'),
  };
}

beforeAll(async () => {
  mock = new MockApi({ difficulty: 10, list: [['abe', 50, 1], ['bob', 70, 2]] });
  setApi(await mock.start());
});
afterAll(() => mock.close());

beforeEach(() => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  const keys = new Map<string, unknown>();
  vi.doMock('../../src/bg/idb', () => ({
    idbGet: async (k: string) => keys.get(k),
    idbSet: async (k: string, v: unknown) => keys.set(k, v),
  }));
  mock.failures.length = 0;
  mock.rejected.length = 0;
});

describe('identity and signed votes (round trip)', () => {
  it('registers with proof of work, signs the vote, and the server verifies it', async () => {
    const { outbox: o } = await load();
    await o.enqueueVote(body('slopbot'));
    await o.flush();
    const identity = f.local.get('identity') as { installId: string };
    expect(mock.installs.has(identity.installId)).toBe(true);
    expect(mock.installs.get(identity.installId)!.jwk).not.toHaveProperty('d');
    expect(mock.votesFor('slopbot').map((v) => v.body)).toEqual([body('slopbot')]);
    expect(mock.rejected).toEqual([]);
    expect(outbox().ops).toEqual([]);
  });

  it('registers once when two writes race', async () => {
    const { outbox: o } = await load();
    const before = mock.installs.size;
    await Promise.all([o.enqueueVote(body('a1')), o.enqueueVote(body('a2')), o.enqueueDelete('a3')]);
    await o.flush();
    expect(mock.installs.size).toBe(before + 1);
    expect(outbox().ops).toEqual([]);
  });
});

describe('outbox (SPEC 7.4)', () => {
  it('backs off with jitter on 503, survives in storage, then sends', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 503, left: 1 });
    const t0 = Date.now();
    await o.enqueueVote(body('retry1'));
    await o.flush();
    expect(outbox().ops).toHaveLength(1);
    expect(outbox().attempt).toBe(1);
    const alarm = f.alarms.get('outbox')!;
    expect(alarm.scheduledTime).toBeGreaterThanOrEqual(t0 + 15_000);
    expect(alarm.scheduledTime).toBeLessThanOrEqual(Date.now() + 30_000);
    // The worker restarts: a fresh module set reads the outbox from storage when the alarm fires.
    vi.resetModules();
    const again = await load();
    await again.outbox.flush();
    expect(mock.votesFor('retry1')).toHaveLength(1);
    expect(outbox()).toMatchObject({ ops: [], attempt: 0, lastError: null });
    expect(f.alarms.has('outbox')).toBe(false);
  });

  it('grows the delay exponentially up to one hour', async () => {
    const { outbox: o } = await load();
    expect(o.backoffSec(1, 0)).toBe(15);
    expect(o.backoffSec(1, 1)).toBe(30);
    expect(o.backoffSec(3, 1)).toBe(120);
    expect(o.backoffSec(20, 1)).toBe(3600);
    expect(o.backoffSec(20, 0)).toBe(1800);
  });

  it('honours Retry-After on 429', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 429, left: 1, retryAfter: 900 });
    await o.enqueueVote(body('limited'));
    await o.flush();
    expect(f.alarms.get('outbox')!.scheduledTime).toBeGreaterThanOrEqual(Date.now() + 899_000);
    expect(outbox().lastError).toBe('rate_limited');
  });

  it('R3 a Retry-After of 30 days (a network full of installs) parks the outbox for one hour at most', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 429, left: 1, retryAfter: 2_592_000 });
    await o.enqueueVote(body('parked'));
    await o.flush();
    expect(outbox()).toMatchObject({ attempt: 1, lastError: 'rate_limited' });
    expect(outbox().nextAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(f.alarms.get('outbox')!.scheduledTime).toBe(outbox().nextAt);
  });

  it('R2-2 a vote over the daily limit of the network (429) stays in the outbox, later votes queue behind it, and all go out at the next try', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 429, left: 1, retryAfter: 432 });
    await o.enqueueVote(body('capped1'));
    await o.flush();
    expect(outbox()).toMatchObject({ attempt: 1, lastError: 'rate_limited' });
    expect(f.alarms.get('outbox')!.scheduledTime).toBeGreaterThanOrEqual(Date.now() + 431_000);
    // The backoff runs: a new vote is stored and waits. Nothing is sent and nothing is lost.
    const sent = mock.log.length;
    await o.enqueueVote(body('capped2'));
    await o.enqueueDelete('capped3');
    expect(mock.log.length).toBe(sent);
    expect(outbox().ops.map((x) => [x.h, x.k])).toEqual([['capped1', 'vote'], ['capped2', 'vote'], ['capped3', 'del']]);
    expect(mock.votesFor('capped1')).toEqual([]);
    // The alarm fires at its time.
    await o.flush();
    expect([mock.votesFor('capped1').length, mock.votesFor('capped2').length]).toEqual([1, 1]);
    expect(mock.deletes.some((d) => d.handle === 'capped3')).toBe(true);
    expect(outbox()).toMatchObject({ ops: [], attempt: 0, lastError: null });
  });

  it('R3 sends a vote that an older build left in the outbox, without its post text', async () => {
    const old = { ...body('legacy'), text: 'Great point! 🚀' };
    f.local.set('outbox', { ops: [{ seq: 1, h: 'legacy', k: 'vote', body: old }], obs: [], attempt: 0, nextAt: 0, seq: 1, lastError: null });
    const { outbox: o } = await load();
    await o.flush();
    expect(mock.votesFor('legacy').map((v) => v.body)).toEqual([body('legacy')]);
    expect(mock.rejected).toEqual([]);
    expect(outbox().ops).toEqual([]);
  });

  it('drops an op that the server refuses as bad input', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 400, left: 1, code: 'bad_vote' });
    await o.enqueueVote(body('bad'));
    await o.flush();
    expect(outbox().ops).toEqual([]);
    expect(f.alarms.has('outbox')).toBe(false);
    expect(mock.votesFor('bad')).toEqual([]);
  });

  it('keeps only the latest op per handle', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/', status: 503, left: 1 });
    await o.enqueueVote(body('flip'));
    await o.flush();
    await o.enqueueVote(body('flip', 'not_slop'));
    await o.enqueueDelete('flip');
    expect(outbox().ops.map((x) => x.k)).toEqual(['del']);
    await o.flush();
    expect(mock.votesFor('flip')).toEqual([]);
    expect(mock.deletes.some((d) => d.handle === 'flip')).toBe(true);
  });

  it('registers again after 401 unknown_install and retries', async () => {
    const { outbox: o } = await load();
    await o.enqueueVote(body('first'));
    await o.flush();
    const old = (f.local.get('identity') as { installId: string }).installId;
    mock.installs.delete(old);
    await o.enqueueVote(body('second'));
    await o.flush();
    const now = (f.local.get('identity') as { installId: string }).installId;
    expect(now).not.toBe(old);
    expect(mock.votesFor('second')).toHaveLength(1);
    expect(mock.rejected.map((r) => r.code)).toEqual(['unknown_install']);
  });

  it('recovers after a new device key could not be stored', async () => {
    const { outbox: o, api } = await load();
    await o.enqueueVote(body('before'));
    await o.flush();
    const idb = await import('../../src/bg/idb');
    let fail = true;
    const realSet = idb.idbSet;
    (idb as unknown as { idbSet: typeof idb.idbSet }).idbSet = async (k, v) => {
      if (fail) throw new Error('quota');
      return realSet(k, v);
    };
    await expect(api.resetInstall(true)).rejects.toThrow('quota');
    fail = false;
    await api.resetInstall(true);
    await o.enqueueVote(body('after'));
    await o.flush();
    expect(mock.votesFor('after')).toHaveLength(1);
  });

  it('stops sending when the install is banned', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 403, left: 1, code: 'banned' });
    await o.enqueueVote(body('x1'));
    await o.flush();
    expect(status().banned).toBe(true);
    const n = mock.log.length;
    await o.enqueueVote(body('x2'));
    await o.flush();
    expect(mock.log.length).toBe(n);
    expect(outbox().ops.map((x) => x.h).sort()).toEqual(['x1', 'x2']);
  });

  it('sends observations in batches of at most 100', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
    const { outbox: o } = await load();
    const before = mock.observations.length;
    const item = (i: number): Observation => ({ handle: 'slopbot', tweetId: String(5000 + i), parentTweetId: '100' });
    const posts = () => mock.log.filter((l) => l.path === '/api/v1/observations').length;
    const p0 = posts();
    await o.enqueueObservations(Array.from({ length: 150 }, (_, i) => item(i)));
    await o.flush();
    expect(mock.observations.length - before).toBe(150);
    expect(posts() - p0).toBe(2);
    expect(outbox().obs).toEqual([]);
  });

  it('SPEC 13.8 sends an observation that 1.1.3 queued in the three fields of v2', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
    const old = {
      handle: 'slopbot', tweetId: '777', parentTweetId: '100', parentHandle: 'alice', replyAt: '2026-11-07T09:10:12.000Z',
      parentAt: '2026-11-07T09:10:00.000Z', textLen: 37, simhash: '0123456789abcdef', genericScore: 0.8, overlapScore: 0, hasMedia: false, verified: true,
    };
    f.local.set('outbox', { ops: [], obs: [old], attempt: 0, nextAt: 0, seq: 0, lastError: null });
    const { outbox: o } = await load();
    const before = mock.observations.length;
    await o.flush();
    // The mock answers 400 to an item with any other field.
    expect(mock.rejected).toEqual([]);
    expect(mock.observations.slice(before)).toEqual([{ handle: 'slopbot', tweetId: '777', parentTweetId: '100' }]);
    expect(outbox().obs).toEqual([]);
  });
});

describe('list and config sync (SPEC 7.4)', () => {
  it('fetches the full list, then deltas, then 304; on 410 it fetches the full list again', async () => {
    const { sync } = await load();
    expect(await sync.syncList()).toBe(true);
    const v1 = f.local.get('list') as StoredList;
    expect(v1.accounts).toEqual([['abe', 50, 1], ['bob', 70, 2]]);
    expect(v1.etag).toBe(`"${v1.version}"`);

    mock.publish([['abe', 81, 2], ['cat', 60, 1]]);
    expect(await sync.syncList()).toBe(true);
    const v2 = f.local.get('list') as StoredList;
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.accounts).toEqual([['abe', 81, 2], ['cat', 60, 1]]);
    expect(f.tabSent).toEqual([]); // no x.com tab is open

    expect(await sync.syncList()).toBe(false);
    expect(mock.log.at(-1)).toMatchObject({ path: '/api/v1/list/delta', status: 304 });

    f.local.set('list', { ...v2, version: 999_999, etag: '"999999"' });
    vi.resetModules();
    const again = await load();
    expect(await again.sync.syncList()).toBe(true);
    expect((f.local.get('list') as StoredList).version).toBe(mock.version);
  });

  it('sends the delta to open x.com tabs', async () => {
    const { sync } = await load();
    await sync.syncList();
    f.tabs = [{ id: 3, url: 'https://x.com/home' } as chrome.tabs.Tab];
    const from = (f.local.get('list') as StoredList).version;
    mock.publish([['abe', 81, 2], ['dan', 40, 2]]);
    await sync.syncList();
    expect(f.tabSent.at(-1)).toEqual({ tabId: 3, msg: { t: 'list', from, version: from + 1, add: [['dan', 40, 2]], remove: ['cat'] } });
  });

  it('SPEC 13.8 stores the X id of each listed handle and follows an id change, an add and a remove through deltas', async () => {
    const { sync } = await load();
    mock.publish([['abe', 50, 1], ['bob', 70, 2]], { bob: '702' });
    expect(await sync.syncList()).toBe(true);
    expect((f.local.get('list') as StoredList).ids).toEqual([null, '702']);
    // Only the id of bob changes: the delta carries bob as a changed entry.
    mock.publish([['abe', 50, 1], ['bob', 70, 2], ['cat', 60, 2]], { bob: '703', cat: '704' });
    expect(await sync.syncList()).toBe(true);
    expect(mock.log.at(-1)).toMatchObject({ path: '/api/v1/list/delta', status: 200 });
    expect(f.local.get('list')).toMatchObject({ accounts: [['abe', 50, 1], ['bob', 70, 2], ['cat', 60, 2]], ids: [null, '703', '704'] });
    mock.publish([['abe', 50, 1], ['cat', 60, 2]], { cat: '704' });
    expect(await sync.syncList()).toBe(true);
    expect((f.local.get('list') as StoredList).ids).toEqual([null, '704']);
  });

  it('SPEC 13.8 fetches the full list once, without its ETag, over a list that 1.1.3 stored without ids', async () => {
    mock.publish([['abe', 50, 1], ['bob', 70, 2]], { bob: '702' });
    f.local.set('list', { version: mock.version, generatedAt: '2026-11-07T00:00:00.000Z', etag: `"${mock.version}"`, accounts: [['abe', 50, 1], ['bob', 70, 2]] });
    const { sync } = await load();
    const n = mock.log.length;
    expect(await sync.syncList()).toBe(true);
    expect(mock.log.slice(n)).toEqual([{ method: 'GET', path: '/api/v1/list', status: 200 }]);
    expect((f.local.get('list') as StoredList).ids).toEqual([null, '702']);
    expect(await sync.syncList()).toBe(false);
    expect(mock.log.at(-1)).toMatchObject({ path: '/api/v1/list/delta', status: 304 });
  });

  it('SPEC 13.10 a list that a 1.2.0 test build stored with [handle, id] pairs takes the next delta, and is stored with the ids beside the rows', async () => {
    mock.publish([['abe', 50, 1], ['bob', 70, 2]], { abe: '701', bob: '702' });
    f.local.set('list', { version: mock.version, generatedAt: '2026-11-12T00:00:00.000Z', etag: `"${mock.version}"`, accounts: [['abe', 50, 1], ['bob', 70, 2]], ids: [['abe', '701'], ['bob', '702']] });
    mock.publish([['abe', 50, 1], ['bob', 70, 2], ['cat', 60, 2]], { abe: '701', bob: '702', cat: '703' });
    const { sync } = await load();
    const n = mock.log.length;
    expect(await sync.syncList()).toBe(true);
    expect(mock.log.slice(n)).toEqual([{ method: 'GET', path: '/api/v1/list/delta', status: 200 }]);
    expect(f.local.get('list')).toMatchObject({ accounts: [['abe', 50, 1], ['bob', 70, 2], ['cat', 60, 2]], ids: ['701', '702', '703'] });
  });

  it('SPEC 13.8 works with a server from before v2: a list and deltas without ids', async () => {
    mock.listIds = false;
    try {
      const { sync } = await load();
      mock.publish([['abe', 50, 1], ['bob', 70, 2]], { bob: '702' });
      expect(await sync.syncList()).toBe(true);
      expect(f.local.get('list')).toMatchObject({ accounts: [['abe', 50, 1], ['bob', 70, 2]], ids: [null, null] });
      mock.publish([['abe', 50, 1], ['dan', 40, 2]], { dan: '705' });
      expect(await sync.syncList()).toBe(true);
      expect(mock.log.at(-1)).toMatchObject({ path: '/api/v1/list/delta', status: 200 });
      expect(f.local.get('list')).toMatchObject({ accounts: [['abe', 50, 1], ['dan', 40, 2]], ids: [null, null] });
    } finally {
      mock.listIds = true;
    }
  });

  it('keeps the last good config and flags a newer minVersion', async () => {
    const { sync } = await load();
    expect(await sync.syncConfig()).toBe(true);
    expect(f.local.get('config')).toMatchObject({ v: 1, mute: { maxPerDay: 40 } });
    const good = f.local.get('config');
    mock.config = { ...defaultConfig(), mute: { enabled: true } };
    expect(await sync.syncConfig()).toBe(false);
    expect(f.local.get('config')).toEqual(good);
    mock.config = { ...defaultConfig(), minVersion: '9.0.0' };
    expect(await sync.syncConfig()).toBe(false);
    expect(status().updateNeeded).toBe(true);
    expect(f.local.get('config')).toEqual(good);
    mock.config = defaultConfig();
  });

  it('R3 refuses a config answer above 64 KiB over real HTTP, and keeps the last good one', async () => {
    const { sync } = await load();
    expect(await sync.syncConfig()).toBe(true);
    const good = f.local.get('config');
    mock.config = { ...defaultConfig(), minVersion: '1.0.1', pad: 'x'.repeat(70_000) };
    await expect(sync.syncConfig()).rejects.toThrow('answer_too_large');
    expect(f.local.get('config')).toEqual(good);
    mock.config = defaultConfig();
  });

  it('R3 stops reading a list answer that never ends, at 16 MiB', async () => {
    const { sync } = await load();
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    vi.stubGlobal('fetch', async () => new Response(endless, { status: 200 }));
    try {
      await expect(sync.syncList()).rejects.toThrow('answer_too_large');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toBeLessThanOrEqual(18 * 1024 * 1024);
    expect(f.local.get('list')).toBeUndefined();
  });
});

describe('your standing (SPEC 13.8, GET /api/v1/me)', () => {
  const reads = (): number => mock.log.filter((l) => l.path === '/api/v1/me').length;
  async function registered() {
    const m = await load();
    await m.api.ensureInstall();
    return m;
  }
  afterEach(() => {
    mock.me = { standing: false, goodMarks: 0, trusted: false };
  });

  it('reads it from the signed /me answer, at most every 10 minutes', async () => {
    const { sync } = await registered();
    mock.me = { standing: true, goodMarks: 3, trusted: false };
    const n = reads();
    await sync.syncMe();
    expect(status()).toMatchObject({ standing: true });
    expect(status().meAt).toBeGreaterThan(Date.now() - 60_000);
    expect(mock.rejected).toEqual([]);
    await sync.syncMe();
    expect(reads()).toBe(n + 1);
  });

  it.each([
    ['an answer of an older server, without the new fields', null, null],
    ['standing false', { standing: false, goodMarks: 1, trusted: false }, false],
    ['standing as a string', { standing: 'true', goodMarks: 3, trusted: true }, null],
    ['standing as a number', { standing: 1, goodMarks: -5, trusted: 'yes' }, null],
    ['an answer of 5000 votes', { standing: true, votes: Array(5000).fill({ handle: 'abcdefghijklmno', value: 'not_slop', at: '2026-11-12T20:33:21.000Z' }) }, true],
  ])('reads %s', async (_, me, want) => {
    const { sync } = await registered();
    mock.me = me;
    await sync.syncMe();
    expect(status().standing).toBe(want);
  });

  it('refuses an answer above 512 KiB and keeps what it knew', async () => {
    const { sync } = await registered();
    mock.me = { standing: true, pad: 'x'.repeat(600_000) };
    await expect(sync.syncMe()).rejects.toThrow('answer_too_large');
    expect(status()).toMatchObject({ standing: null, meAt: 0 });
  });

  it('asks nothing before this install is registered', async () => {
    const { sync } = await load();
    const n = reads();
    await sync.syncMe();
    expect(reads()).toBe(n);
    expect(f.local.get('identity')).toBeUndefined();
  });
});
