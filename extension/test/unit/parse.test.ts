// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { caretOf, newerId, ownHandle, parseTweet, statusIdOf, type Parsed } from '../../src/content/parse';
import { parseFixture } from '../helpers/dom';

const sel = DEFAULT_CONFIG.selectors;

function parseAll(name: string): { doc: Document; byId: Map<string, Parsed> } {
  const doc = parseFixture(name);
  const byId = new Map<string, Parsed>();
  for (const a of doc.querySelectorAll(sel.article)) {
    const p = parseTweet(a, sel);
    if (p) byId.set(p.tweetId, p);
  }
  return { doc, byId };
}

describe('your own handle', () => {
  const page = (body: string): Document => new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
  const avatar = (id: string): string => `<button data-testid="DashButton_ProfileIcon_Link"><div data-testid="UserAvatar-Container-${id}"><img></div></button>`;

  it('reads the profile link of a wide page, in lower case', () => {
    expect(ownHandle(page('<a href="/Me_User" data-testid="AppTabBar_Profile_Link"></a>'), sel)).toBe('me_user');
  });
  it('known item 4: reads the avatar in the phone layout, where the profile link does not exist', () => {
    expect(ownHandle(page(avatar('Me_User')), sel)).toBe('me_user');
  });
  it('known item 4: does not take X\'s placeholder for a handle', () => {
    expect(ownHandle(page(avatar('unknown')), sel)).toBeNull();
  });
  it('is null on a page that shows neither', () => {
    expect(ownHandle(page('<div data-testid="UserAvatar-Container-someone_else"></div>'), sel)).toBeNull();
  });
});

describe('the caret', () => {
  const article = (html: string): Element => new DOMParser().parseFromString(`<article>${html}</article>`, 'text/html').querySelector('article')!;

  it('finds the control that opens the menu of the tweet', () => {
    expect(caretOf(article('<button data-testid="caret" aria-haspopup="menu"></button>'), sel)).not.toBeNull();
  });
  it('F1 regression: refuses a control that opens no menu, so a remote selector cannot aim the click at Like', () => {
    expect(caretOf(article('<button data-testid="like"></button>'), { ...sel, caret: '[data-testid="like"]' })).toBeNull();
  });
});

describe('selectors on a status page with focal tweet and replies', () => {
  const { doc, byId } = parseAll('status.html');

  it('reads every tweet', () => {
    expect([...byId.keys()]).toEqual(['99', '100', '101', '102', '103', '104', '105', '106', '107', '108', '109']);
  });

  it('reads handle (lower case), id and time, and never the text of the post', () => {
    expect(byId.get('101')).toMatchObject({ handle: 'slopbot', tweetId: '101', time: '2026-11-07T09:10:12.000Z', promoted: false, replyingTo: false });
    expect(byId.get('101')!.actionBar?.getAttribute('role')).toBe('group');
    expect(byId.get('101')!.cell?.getAttribute('data-testid')).toBe('cellInnerDiv');
    expect(JSON.stringify(byId.get('101'), (k, v: unknown) => (v instanceof Element ? undefined : v))).not.toContain('game changer');
  });

  it('reads the focal tweet, whose time sits below the text', () => {
    expect(byId.get('100')).toMatchObject({ handle: 'alice', time: '2026-11-07T09:10:00.000Z', replyingTo: true });
  });

  it('detects a "Replying to" line, and not a mention inside the text', () => {
    const a = [...doc.querySelectorAll(sel.article)].find((x) => parseTweet(x, sel)?.tweetId === '102')!;
    expect(parseTweet(a, sel)!.replyingTo).toBe(true);
    expect(a.querySelector(sel.text)!.textContent).toContain('@alice');
    a.querySelector('[id^="id__rt"]')!.parentElement!.remove();
    expect(parseTweet(a, sel)!.replyingTo).toBe(false);
  });

  it('marks a promoted tweet', () => {
    expect(byId.get('107')!.promoted).toBe(true);
    expect(byId.get('101')!.promoted).toBe(false);
  });

  it('reads a quote reply as the outer author, not the quoted one', () => {
    expect(byId.get('108')).toMatchObject({ handle: 'quoter', tweetId: '108', replyingTo: true });
    expect(byId.has('555')).toBe(false);
  });

  it('reads a media reply without text', () => {
    expect(byId.get('109')).toMatchObject({ handle: 'photoguy', tweetId: '109' });
  });

  it('reads the logged-in handle', () => {
    expect(ownHandle(doc, sel)).toBe('me_user');
  });

  it('F4 regression: marks a protected account by its lock icon, by test id or by label', () => {
    expect(byId.get('101')!.protected).toBe(false);
    const article = (id: string) => [...doc.querySelectorAll(sel.article)].find((x) => parseTweet(x, sel)?.tweetId === id)!;
    const add = (id: string, attr: [string, string]) => {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute(...attr);
      article(id).querySelector(sel.userName)!.append(svg);
    };
    add('101', ['data-testid', 'icon-lock']);
    add('105', ['aria-label', 'Protected account']);
    expect(parseTweet(article('101'), sel)!.protected).toBe(true);
    expect(parseTweet(article('105'), sel)!.protected).toBe(true);
    expect(parseTweet(article('102'), sel)!.protected).toBe(false);
  });
});

describe('selectors on the home timeline', () => {
  const { byId } = parseAll('home.html');
  it('finds replies by their "Replying to" line only', () => {
    expect([...byId.values()].filter((p) => p.replyingTo).map((p) => p.tweetId)).toEqual(['202', '205', '206']);
  });
  it('ignores the "Replying to" line inside a quoted tweet', () => {
    expect(byId.get('203')).toMatchObject({ handle: 'erin', replyingTo: false });
  });
  it('marks the promoted tweet', () => {
    expect(byId.get('204')!.promoted).toBe(true);
  });
});

describe('status page path', () => {
  it.each([
    ['/alice/status/100', '100'],
    ['/Alice/status/100/photo/1', '100'],
    ['/i/web/status/55', '55'],
    ['/home', null],
    ['/alice', null],
    ['/alice/status/abc', null],
    ['/alice/status/100/video/1', '100'],
    ['/alice/status/100/quotes', null],
    ['/alice/status/100/retweets', null],
    ['/alice/status/100/history', null],
  ])('%s -> %s', (path, id) => {
    expect(statusIdOf(path)).toBe(id);
  });
});

describe('tweet ids and the caret', () => {
  it('orders tweet ids across lengths, as X assigns them over time', () => {
    expect(newerId('101', '100')).toBe(true);
    expect(newerId('99', '100')).toBe(false);
    expect(newerId('100', '100')).toBe(false);
    expect(newerId('1794256261000000000', '999')).toBe(true);
  });

  it('finds the caret of the tweet itself, not one inside a quoted tweet', () => {
    const doc = parseFixture('status.html');
    const article = [...doc.querySelectorAll(sel.article)].find((x) => parseTweet(x, sel)?.tweetId === '108')!;
    const quote = article.querySelector(sel.quote)!;
    const inner = doc.createElement('button');
    inner.setAttribute('data-testid', 'caret');
    quote.prepend(inner);
    const own = caretOf(article, sel)!;
    expect(own).not.toBe(inner);
    expect(own.getAttribute('data-testid')).toBe('caret');
    expect(quote.contains(own)).toBe(false);
  });
});
