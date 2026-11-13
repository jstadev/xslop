// @vitest-environment happy-dom
// Observations and your own handle (finding 6): none while xslop does not know it; never your handle.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { DEFAULT_SETTINGS, type Observation } from '../../src/shared/types';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { fixture, frames } from '../helpers/dom';

let f: FakeChrome;
const observed = () => f.sent.filter((m) => (m as { t: string }).t === 'observe').flatMap((m) => (m as { items: Observation[] }).items);
let profile: Element;

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
  f.local.set('config', { ...DEFAULT_CONFIG, observe: { enabled: true, batchMax: 100, flushSec: 5 } });
  // Your own post: the focal tweet is by me_user. The profile tab link is not rendered yet.
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://x.com/me_user/status/100');
  const html = fixture('status.html').replace(/alice/g, 'me_user');
  document.body.replaceChildren(...[...new DOMParser().parseFromString(html, 'text/html').body.childNodes].map((n) => document.importNode(n, true)));
  profile = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!;
  profile.remove();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await import('../../src/content/main');
  await frames();
  vi.advanceTimersByTime(5000);
});

describe('observations and your handle', () => {
  it('F6 regression: sends no observation while your handle is unknown', () => {
    expect(observed()).toEqual([]);
  });

  it('F6 regression: once your handle is known, observations on your own post carry the post id, never your handle', async () => {
    document.body.prepend(profile);
    await frames();
    vi.advanceTimersByTime(5000);
    const items = observed();
    expect(items.map((i) => i.tweetId)).toEqual(['101', '102', '103', '104', '105', '108', '109']);
    expect(items.every((i) => i.parentTweetId === '100')).toBe(true);
    expect(JSON.stringify(f.sent)).not.toContain('me_user');
    vi.useRealTimers();
  });
});
