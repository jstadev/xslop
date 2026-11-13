// The background message guard (SPEC 7.4): only this extension's contexts, typed and validated.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApi } from '../mock-server';
import { deliver, fakeChrome, type FakeChrome } from '../helpers/chrome';
import { setApi } from '../helpers/setup';
import type { Outbox, Settings, Stats, Vote } from '../../src/shared/types';

let mock: MockApi;
let f: FakeChrome;
const content = { id: 'xslop-test-id', tab: { id: 4 } as chrome.tabs.Tab, url: 'https://x.com/alice/status/100' };
const popup = { id: 'xslop-test-id', url: 'chrome-extension://xslop-test-id/popup.html' };
const vote = { t: 'vote', handle: 'SlopBot', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' };
const obs = { handle: 'slopbot', tweetId: '101', parentTweetId: '100' };

beforeAll(async () => {
  mock = new MockApi({ difficulty: 8 });
  setApi(await mock.start());
});
afterAll(() => mock.close());

beforeEach(async () => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  const keys = new Map<string, unknown>();
  vi.doMock('../../src/bg/idb', () => ({ idbGet: async (k: string) => keys.get(k), idbSet: async (k: string, v: unknown) => keys.set(k, v) }));
  await import('../../src/background');
});

describe('background messages', () => {
  it('stores a vote from an X tab, tells the tabs, and queues it', async () => {
    f.tabs = [{ id: 4, url: 'https://x.com/home' } as chrome.tabs.Tab];
    expect(await deliver(f, vote, content)).toEqual({ ok: true });
    expect((f.local.get('votes') as Vote[]).map((v) => [v.h, v.v])).toEqual([['slopbot', 1]]);
    expect(f.tabSent).toContainEqual({ tabId: 4, msg: { t: 'votes', set: [['slopbot', 1]], del: [] } });
    // Registration (proof of work) and the signed send run behind the answer: give them time on a loaded host.
    await vi.waitFor(() => expect(mock.votesFor('slopbot')).toHaveLength(1), { timeout: 10_000 });
    // The request carries these six fields and nothing else: no post text.
    expect(mock.votesFor('slopbot')[0]!.body).toEqual({ handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' });
  });

  it('ignores messages from other extensions and answers bad input with an error', async () => {
    expect(await deliver(f, vote, { ...content, id: 'another-extension' })).toBeUndefined();
    expect(await deliver(f, vote, { ...content, url: 'https://evil.example/x' })).toEqual({ error: 'bad_message' });
    expect(await deliver(f, { ...vote, tweetId: 'x' }, content)).toEqual({ error: 'bad_message' });
    expect(f.local.get('votes')).toBeUndefined();
  });

  it('lets only extension pages change settings', async () => {
    expect(await deliver(f, { t: 'settings', patch: { share: true } }, content)).toEqual({ error: 'bad_message' });
    expect(await deliver(f, { t: 'settings', patch: { share: true, strictness: 'strict' } }, popup)).toEqual({ ok: true });
    expect(f.local.get('settings')).toMatchObject({ share: true, strictness: 'strict', display: 'collapse', mute: false } satisfies Partial<Settings>);
  });

  it('drops observations without consent, deduplicates them with it, and clears them when you opt out', async () => {
    mock.failures.push({ prefix: '/api/v1/', status: 503, left: 100 });
    await deliver(f, { t: 'observe', items: [obs] }, content);
    expect((f.local.get('outbox') as Outbox | undefined)?.obs ?? []).toEqual([]);
    await deliver(f, { t: 'settings', patch: { share: true } }, popup);
    await deliver(f, { t: 'observe', items: [obs] }, content);
    await deliver(f, { t: 'observe', items: [obs, { ...obs, tweetId: '102' }] }, content);
    expect((f.local.get('outbox') as Outbox).obs.map((o) => o.tweetId)).toEqual(['101', '102']);
    await deliver(f, { t: 'settings', patch: { share: false } }, popup);
    expect((f.local.get('outbox') as Outbox).obs).toEqual([]);
    mock.failures.length = 0;
  });

  it('counts each hidden reply once per local day, across tabs', async () => {
    await deliver(f, { t: 'hidden', ids: ['101', '103', '104'] }, content);
    await deliver(f, { t: 'hidden', ids: ['101', '103', '109'] }, { ...content, tab: { id: 9 } as chrome.tabs.Tab });
    expect((f.local.get('stats') as Stats).hidden).toBe(4);
    expect(await deliver(f, { t: 'hidden', ids: ['x'] }, content)).toEqual({ error: 'bad_message' });
  });

  it('removes and restores a vote from the popup', async () => {
    await deliver(f, vote, content);
    const saved = (f.local.get('votes') as Vote[])[0]!;
    await deliver(f, { t: 'unvote', handle: 'slopbot' }, popup);
    expect(f.local.get('votes')).toEqual([]);
    await deliver(f, { t: 'restore', vote: saved }, popup);
    expect((f.local.get('votes') as Vote[]).map((v) => v.h)).toEqual(['slopbot']);
  });
});

describe('concurrent messages', () => {
  it('keeps every vote when many arrive at once', async () => {
    await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map((h) => deliver(f, { ...vote, handle: h }, content)));
    expect((f.local.get('votes') as Vote[]).map((v) => v.h).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
  it('counts hidden replies once when two tabs report together', async () => {
    await Promise.all([
      deliver(f, { t: 'hidden', ids: ['1', '2'] }, content),
      deliver(f, { t: 'hidden', ids: ['2', '3'] }, { ...content, tab: { id: 9 } as chrome.tabs.Tab }),
    ]);
    expect((f.local.get('stats') as Stats).hidden).toBe(3);
  });
});
