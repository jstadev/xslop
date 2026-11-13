// @vitest-environment happy-dom
// Observations (SPEC 13.8) after consent: three fields for each reply on a status page, never the text.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { parseContentMsg } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, type Observation } from '../../src/shared/types';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { frames, mountFixture } from '../helpers/dom';

let f: FakeChrome;
let items: Observation[] = [];

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
  f.local.set('config', { ...DEFAULT_CONFIG, observe: { enabled: true, batchMax: 4, flushSec: 30 } });
  mountFixture('status.html', 'https://x.com/alice/status/100');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await import('../../src/content/main');
  await frames();
  vi.advanceTimersByTime(30_000);
  vi.advanceTimersByTime(30_000);
  for (const m of f.sent) if ((m as { t: string }).t === 'observe') items.push(...(m as { items: Observation[] }).items);
});
afterAll(() => vi.useRealTimers());

describe('observations', () => {
  it('cover every reply on the status page, not the focal, ancestor, own or promoted tweet', () => {
    expect(items.map((i) => i.tweetId)).toEqual(['101', '102', '103', '104', '105', '108', '109']);
  });

  it('go in batches of at most batchMax, once per flushSec', () => {
    const batches = f.sent.filter((m) => (m as { t: string }).t === 'observe') as { items: unknown[] }[];
    expect(batches.map((b) => b.items.length)).toEqual([4, 3]);
    for (const b of batches) expect(parseContentMsg(b)).not.toBeNull();
  });

  it('carry the account, the post id and the id of the post that it answers, and nothing else', () => {
    expect(items[0]).toEqual({ handle: 'slopbot', tweetId: '101', parentTweetId: '100' });
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['handle', 'parentTweetId', 'tweetId']);
    expect(JSON.stringify(f.sent)).not.toContain('game changer');
    expect(JSON.stringify(f.sent)).not.toContain('alice');
  });

  it('sends each tweet once per page', async () => {
    document.body.append(document.createElement('div'));
    await frames();
    vi.advanceTimersByTime(60_000);
    expect(f.sent.filter((m) => (m as { t: string }).t === 'observe')).toHaveLength(2);
  });
});
