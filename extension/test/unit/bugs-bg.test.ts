// Bugs in the background worker: each test failed before its fix.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApi } from '../mock-server';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { setApi } from '../helpers/setup';
import { ALL_KEYS } from '../../src/shared/storage';
import { DEFAULT_SETTINGS, EMPTY_OUTBOX, type Observation, type Outbox, type Vote, type VoteBody } from '../../src/shared/types';

let mock: MockApi;
let f: FakeChrome;
let idbKeys: Map<string, unknown>;

const body = (handle: string): VoteBody => ({
  handle, value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: '2026-11-07T09:10:12.000Z', context: 'reply',
});
const outbox = (): Outbox => f.local.get('outbox') as Outbox;
const vote = (h: string): Vote => ({ h, v: 1, at: 1, tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' });

async function load() {
  return { outbox: await import('../../src/bg/outbox') };
}

beforeAll(async () => {
  mock = new MockApi({ difficulty: 8 });
  setApi(await mock.start());
});
afterAll(() => mock.close());

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/bg/api');
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  idbKeys = new Map();
  vi.doMock('../../src/bg/idb', () => ({
    idbGet: async (k: string) => idbKeys.get(k),
    idbSet: async (k: string, v: unknown) => idbKeys.set(k, v),
  }));
  mock.failures.length = 0;
  mock.rejected.length = 0;
  mock.observations.length = 0;
  mock.log.length = 0;
});

describe('outbox caps and retries', () => {
  it('sends every vote when the queue is longer than one pass', async () => {
    let n = 0;
    vi.doMock('../../src/bg/api', () => ({
      ApiError: class ApiError extends Error {
        constructor(readonly status: number, readonly code: string, readonly retryAfterSec: number | null = null) {
          super(`${status} ${code}`);
        }
      },
      resetInstall: async () => undefined,
      ensureInstall: async () => ({ installId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-11-07T00:00:00.000Z' }),
      signedFetch: async () => {
        n += 1;
        return new Response(null, { status: 200 });
      },
    }));
    const ops = Array.from({ length: 1001 }, (_, i) => ({ seq: i + 1, h: `h${i}`, k: 'vote' as const, body: body('slopbot') }));
    f.local.set('outbox', { ...EMPTY_OUTBOX, ops, seq: 1001 });
    const { outbox: o } = await load();
    await o.flush();
    expect(n).toBe(1001);
    expect(outbox().ops).toEqual([]);
    expect(f.alarms.has('outbox')).toBe(false);
  });

  it('retries clock_skew at once and does not rotate the key', async () => {
    const { outbox: o } = await load();
    await o.enqueueVote(body('first'));
    await o.flush();
    const installs = mock.installs.size;
    mock.failures.push({ prefix: '/api/v1/votes', status: 401, left: 1, code: 'clock_skew' });
    await o.enqueueVote(body('skewed'));
    await o.flush();
    expect(mock.votesFor('skewed')).toHaveLength(1);
    expect(outbox().ops).toEqual([]);
    expect(f.alarms.has('outbox')).toBe(false);
    expect(mock.installs.size).toBe(installs);
  });

  it('backs off when clock_skew comes back on the immediate retry', async () => {
    const { outbox: o } = await load();
    mock.failures.push({ prefix: '/api/v1/votes', status: 401, left: 2, code: 'clock_skew' });
    await o.enqueueVote(body('skew2'));
    await o.flush();
    const posts = mock.log.filter((l) => l.method === 'POST' && l.path === '/api/v1/votes');
    expect(posts).toHaveLength(2);
    expect(outbox().ops).toHaveLength(1);
    expect(outbox().lastError).toBe('clock_skew');
    expect(f.alarms.has('outbox')).toBe(true);
  });

  it('keeps an observation that arrived while a batch was in flight', async () => {
    f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
    const orig = globalThis.fetch;
    let swapped = false;
    const fresh: Observation = { handle: 'keptone', tweetId: '999', parentTweetId: null };
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!swapped && url.includes('/api/v1/observations')) {
        swapped = true;
        const store = await import('../../src/bg/store');
        const s = await store.state();
        await store.save('outbox', { ...s.outbox, obs: [fresh] });
      }
      return orig(input, init);
    };
    try {
      const { outbox: o } = await load();
      await o.enqueueObservations([{ handle: 'slopbot', tweetId: '101', parentTweetId: '100' }]);
      await o.flush();
      expect(swapped).toBe(true);
      expect(mock.observations).toContainEqual(fresh);
      expect(outbox().obs).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('a key that cannot sign', () => {
  it('replaces a stored private key that is not a CryptoKey and still sends the vote', async () => {
    const { outbox: o } = await load();
    await o.enqueueVote(body('before'));
    await o.flush();
    const rec = idbKeys.get('device') as { publicJwk: unknown };
    idbKeys.set('device', { privateKey: {}, publicJwk: rec.publicJwk });
    vi.resetModules();
    const again = await load();
    await again.outbox.enqueueVote(body('afterkey'));
    await again.outbox.flush();
    expect(mock.votesFor('afterkey')).toHaveLength(1);
    expect(outbox().ops).toEqual([]);
    expect(outbox().lastError).toBeNull();
  });
});

describe('corrupt stored votes', () => {
  it('drops a vote entry that is not an object and keeps the rest', async () => {
    const kept = vote('kept');
    f.local.set('votes', [null, 1, kept]);
    const { readStored } = await import('../../src/shared/storage');
    const got = await readStored(ALL_KEYS);
    expect(got.votes).toEqual([kept]);
  });
});
