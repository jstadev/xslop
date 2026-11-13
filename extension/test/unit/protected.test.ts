// @vitest-environment happy-dom
// Protected accounts (finding 4): no tweet text of a protected account leaves the page.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { DEFAULT_SETTINGS, type Observation } from '../../src/shared/types';
import { fakeChrome, trustedClick, type FakeChrome } from '../helpers/chrome';
import { articleOf, fixture, frames, markButton, mountFixture } from '../helpers/dom';

let f: FakeChrome;
const sentOf = (t: string) => f.sent.filter((m) => (m as { t: string }).t === t) as Record<string, unknown>[];
const observed = () => sentOf('observe').flatMap((m) => m.items as Observation[]);

/** The lock icon in the header, as X draws it: by test id, or by its label only. */
function lock(id: string, attrs: Record<string, string>): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  articleOf(id).querySelector('[data-testid="User-Name"]')!.append(svg);
}

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
  f.local.set('config', { ...DEFAULT_CONFIG, observe: { enabled: true, batchMax: 100, flushSec: 5 } });
  mountFixture('status.html', 'https://x.com/alice/status/100');
  lock('101', { 'data-testid': 'icon-lock', 'aria-label': 'Protected account' });
  lock('105', { 'aria-label': 'Protected account' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await import('../../src/content/main');
  await frames();
  vi.advanceTimersByTime(5000);
});

describe('protected accounts', () => {
  it('F4 regression: sends no observation from a protected author (lock by test id or by label)', () => {
    const ids = observed().map((o) => o.tweetId);
    expect(ids).toContain('102');
    expect(ids).not.toContain('101');
    expect(ids).not.toContain('105');
  });

  it('F4 regression: a vote carries no post text, on a protected account or an open one', () => {
    trustedClick(markButton('101')!);
    trustedClick(markButton('102')!);
    const votes = sentOf('vote');
    expect(votes.map((v) => [v.handle, v.tweetId])).toEqual([['slopbot', '101'], ['human_dev', '102']]);
    for (const v of votes) expect(v).not.toHaveProperty('text');
    expect(JSON.stringify(f.sent)).not.toContain('game changer');
  });

  it('F4 regression: sends no observation under a protected focal tweet', async () => {
    // A second status page, with new tweet ids, whose focal author is protected.
    const html = fixture('status.html').replace(/\/status\/(\d+)/g, '/status/7$1');
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://x.com/alice/status/7100');
    document.body.replaceChildren(...[...new DOMParser().parseFromString(html, 'text/html').body.childNodes].map((n) => document.importNode(n, true)));
    lock('7100', { 'data-testid': 'icon-lock' });
    const before = observed().length;
    await frames();
    vi.advanceTimersByTime(5000);
    expect(markButton('7101')).not.toBeNull(); // the page was processed
    expect(observed().length).toBe(before);
    vi.useRealTimers();
  });
});
