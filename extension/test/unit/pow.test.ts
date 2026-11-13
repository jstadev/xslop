// Registration proof of work limits (finding 8): no work above difficulty 22, two rounds, then wait.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import type { Outbox, VoteBody } from '../../src/shared/types';

let f: FakeChrome;
let challenges = 0;
let installs = 0;
let difficulty = 22;

beforeEach(() => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  vi.doMock('../../src/bg/idb', () => ({ idbGet: async () => undefined, idbSet: async () => 'k' }));
  challenges = 0;
  installs = 0;
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (u.includes('/challenge')) {
      challenges++;
      return new Response(JSON.stringify({ challenge: 'c'.repeat(40), difficulty }), { status: 200 });
    }
    installs++;
    return new Response('{}', { status: 500 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registration proof of work', () => {
  it('F8 regression: refuses a difficulty above 22 without any work', async () => {
    difficulty = 23;
    const api = await import('../../src/bg/api');
    await expect(api.ensureInstall()).rejects.toThrow('bad_challenge');
    expect(challenges).toBe(1);
  });

  it('F8 regression: stops after two rounds that run out of time, then waits for the list alarm', async () => {
    difficulty = 22;
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 60_000)); // each check sees a minute pass
    const api = await import('../../src/bg/api');
    await expect(api.ensureInstall()).rejects.toThrow('pow_timeout');
    expect([challenges, installs]).toEqual([2, 0]);
    // A vote flush right after the failure starts no new work.
    await expect(api.ensureInstall()).rejects.toThrow('pow_timeout');
    expect(challenges).toBe(2);
    // The next list alarm, 10 minutes later, tries again.
    t += 10 * 60_000;
    await expect(api.ensureInstall()).rejects.toThrow('pow_timeout');
    expect(challenges).toBe(4);
  });

  it('F8 regression: your votes stay in the outbox when registration fails', async () => {
    difficulty = 23;
    const o = await import('../../src/bg/outbox');
    const body: VoteBody = { handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: null, postedAt: null, context: 'reply' };
    await o.enqueueVote(body);
    await o.flush();
    expect((f.local.get('outbox') as Outbox).ops.map((x) => x.h)).toEqual(['slopbot']);
    expect(f.alarms.has('outbox')).toBe(true);
  });
});
