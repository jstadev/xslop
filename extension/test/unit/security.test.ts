// @vitest-environment happy-dom
// Security round of 2026-11-10 (report section "Checked and sound", extension items 3, 4, 6 and 7).
// None of these was a hole. The tests keep the rules that a tweet author, a hostile list or a hostile config meets.
import { describe, expect, it } from 'vitest';
import { pickMenuItem } from '../../src/content/menu';
import { parseTweet } from '../../src/content/parse';
import { DEFAULT_CONFIG, parseConfig, type Selectors } from '../../src/shared/config';
import { parseDelta, parseList } from '../../src/shared/list';
import { parseFixture } from '../helpers/dom';

const sel = DEFAULT_CONFIG.selectors;
const page = parseFixture('status.html');

/** A copy of the reply of @slopbot (tweet 101) from the status page fixture. */
function reply(): HTMLElement {
  const all = [...page.querySelectorAll<HTMLElement>(sel.article)];
  const found = all.find((a) => [...a.querySelectorAll('time')].some((t) => t.closest('a[href$="/status/101"]')))!;
  return found.cloneNode(true) as HTMLElement;
}

describe('a tweet author cannot aim the click at another account', () => {
  it('reads the author from the profile link, whatever the display name says', () => {
    for (const name of ['@victim', 'victim (@victim)', '‮@victim‬', '/victim', 'Mute @victim', '@victim‏', '<a href="/victim">@victim</a>']) {
      const a = reply();
      a.querySelector('[data-testid="User-Name"] a span span')!.textContent = name;
      expect([name, parseTweet(a, sel)?.handle, parseTweet(a, sel)?.tweetId]).toEqual([name, 'slopbot', '101']);
    }
  });

  it('ignores a mention, a status link and a copied name block inside the text', () => {
    const a = reply();
    a.querySelector('[data-testid="tweetText"]')!.innerHTML =
      '<a href="/victim">@victim</a> <a href="/victim/status/555"><time datetime="2026-01-01T00:00:00.000Z">now</time></a> <div data-testid="User-Name"><a href="/victim">Victim</a></div>';
    expect(parseTweet(a, sel)).toMatchObject({ handle: 'slopbot', tweetId: '101', replyingTo: false });
  });

  it('ignores the name of the account that reposted, above the tweet', () => {
    const a = reply();
    a.insertAdjacentHTML('afterbegin', '<div><span data-testid="socialContext"><a href="/victim">Victim reposted</a></span></div>');
    expect(parseTweet(a, sel)?.handle).toBe('slopbot');
  });

  it('takes a profile link only when the whole path is one handle', () => {
    for (const href of ['//victim', '/victim?x=1', '/victim#a', '/victim/status/1', 'https://x.com/victim', '/@victim', '/victim%2f', '/ｖｉｃｔｉｍ', '/victim\n', '/victim/with_replies']) {
      const a = reply();
      for (const link of a.querySelectorAll('[data-testid="User-Name"] a')) if (!link.querySelector('time')) link.setAttribute('href', href);
      expect([href, parseTweet(a, sel)]).toEqual([href, null]);
    }
  });
});

describe('a hostile remote config stays data', () => {
  const withSelectors = (over: Partial<Selectors>): Selectors => parseConfig({ ...structuredClone(DEFAULT_CONFIG), selectors: { ...sel, ...over } })!.selectors;

  it('cannot make a tweet look like an account that the tweet does not link to', () => {
    const everything = withSelectors({ userName: 'html, body, :root, *', userLink: 'a[href="/victim"]', quote: 'no-such-element' });
    const hits = [...page.querySelectorAll(sel.article)].filter((a) => parseTweet(a, everything)?.handle === 'victim');
    expect(hits).toEqual([]);
  });

  it('known limit: a selector can move the click to an account that the same tweet names, only when that tweet has no avatar', () => {
    const a = reply();
    a.querySelector('[data-testid="tweetText"]')!.innerHTML = 'hello <a href="/victim">@victim</a>';
    // The outer avatar still names the author, so the selector cannot move the click.
    expect(parseTweet(a, withSelectors({ userName: '[data-testid="tweetText"]' }))).toBeNull();
    a.querySelector('[data-testid="Tweet-User-Avatar"]')?.remove();
    expect(parseTweet(a, withSelectors({ userName: '[data-testid="tweetText"]' }))?.handle).toBe('victim');
    expect(parseTweet(a, sel)?.handle).toBe('slopbot');
  });

  it('refuses a bearer that could add a header, and keeps no key that names an endpoint', () => {
    const config = structuredClone(DEFAULT_CONFIG) as unknown as { mute: Record<string, unknown> };
    for (const bearer of [`${'A'.repeat(100)}\r\nx-evil: 1`, `${'A'.repeat(100)} x`, `${'A'.repeat(100)}\n`, 'A'.repeat(99), 'A'.repeat(201)]) {
      expect(parseConfig({ ...config, mute: { ...config.mute, webBearer: bearer } })).toBeNull();
    }
    const extra = parseConfig({ ...config, mute: { ...config.mute, createPath: '/i/api/1.1/blocks/create.json', op: 'block' }, script: 'alert(1)' })!;
    expect(Object.keys(extra).sort()).toEqual(['minVersion', 'mute', 'observe', 'selectors', 'v']);
    expect(Object.keys(extra.mute).sort()).toEqual(['enabled', 'jitter', 'maxPerDay', 'minIntervalSec', 'webBearer']);
  });
});

describe('a hostile list answer', () => {
  const list = { v: 1, version: 5, generatedAt: '2026-11-10T00:00:00.000Z', accounts: [['abc', 50, 2]] };
  const delta = { v: 1, from: 5, version: 6, add: [], remove: ['abc'] };

  it('is refused as a whole when one row is not [handle, score 0..100, tier 1|2], or when it has more than 200,000 rows', () => {
    expect(parseList(list, null)?.accounts).toEqual([['abc', 50, 2]]);
    const bad: unknown[] = [['ABC', 50, 2], ['a b', 50, 2], ['abc', 101, 2], ['abc', 1.5, 2], ['abc', 50, 0], ['abc', 50, 3], ['abc', 50, 2, 'x'], ['abc', '50', 2], [null, 50, 2]];
    for (const row of bad) expect([row, parseList({ ...list, accounts: [row] }, null)]).toEqual([row, null]);
    expect(parseList({ ...list, accounts: Array.from({ length: 200_001 }, (_, i) => [`h${i}`, 1, 2]) }, null)).toBeNull();
    for (const version of [-1, 2 ** 53, '5', 1.5]) expect(parseList({ ...list, version }, null)).toBeNull();
  });

  it('SPEC 13.8 gives no ids, and keeps the list, when the ids are longer than the rows, carry letters, or number 200,001', () => {
    expect(parseList({ ...list, ids: ['42'] }, null)?.ids).toEqual(['42']);
    for (const ids of [['42', '43'], ['4e2'], ['42 '], ['-42'], ['0x2a'], ['1&screen_name=someone'], ['1\nuser_id=2'], Array.from({ length: 200_001 }, (_, i) => String(i))]) {
      const got = parseList({ ...list, ids }, null);
      expect([ids.length, got?.accounts, got?.ids]).toEqual([ids.length, [['abc', 50, 2]], [null]]);
    }
    const rows = Array.from({ length: 200_001 }, (_, i) => [`h${i}`, 1, 2]);
    expect(parseList({ ...list, accounts: rows, ids: rows.map((_, i) => String(i)) }, null)).toBeNull();
    expect(parseDelta({ ...delta, add: [['abc', 5, 2]], addIds: ['1', '2'] })).toMatchObject({ add: [['abc', 5, 2]], ids: [null] });
  });

  it('cannot move a delta backwards or sideways', () => {
    expect(parseDelta(delta)).toMatchObject({ from: 5, version: 6 });
    for (const version of [5, 4, 0]) expect(parseDelta({ ...delta, version })).toBeNull();
    expect(parseDelta({ ...delta, remove: ['A B'] })).toBeNull();
    expect(parseDelta({ ...delta, remove: Array.from({ length: 200_001 }, (_, i) => `h${i}`) })).toBeNull();
    expect(parseDelta({ ...delta, add: [['abc', 5, 9]] })).toBeNull();
  });
});

describe("the menu rule with names that X's menu shows today (the handle only)", () => {
  const item = (text: string): HTMLElement => {
    const el = document.createElement('div');
    el.setAttribute('role', 'menuitem');
    el.textContent = text;
    return el;
  };
  const pick = (texts: string[], handle: string, op: 'create' | 'destroy' = 'create') => pickMenuItem(texts.map(item), handle, op)?.textContent ?? null;

  it('finds no item to click for an account whose handle is a mute word or an unmute word', () => {
    expect(pick(['Follow @mute', 'Block @mute', 'Report @mute'], 'mute')).toBeNull();
    expect(pick(['Follow @unmute', 'Block @unmute'], 'unmute')).toBeNull();
    expect(pick(['Unfollow @silenciar', 'Bloquear a @silenciar'], 'silenciar')).toBeNull();
    expect(pick(['Mute @unmute', 'Block @unmute'], 'unmute')).toBe('Mute @unmute');
  });

  it('never takes an item that names another account, also one that looks the same', () => {
    expect(pick(['Mute @victim2', 'Mute @victim_', 'Mute @viсtim', 'Mute @VICTIMS'], 'victim')).toBeNull();
    expect(pick(['Mute @victim'], 'victim2')).toBeNull();
  });
});
