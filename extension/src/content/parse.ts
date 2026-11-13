// Read a tweet out of X's markup. Every selector comes from the config (SPEC 7.3, 7.6).
import type { Selectors } from '../shared/config';

export interface Parsed {
  handle: string;
  tweetId: string;
  time: string | null;
  replyingTo: boolean;
  promoted: boolean;
  /** A protected account (lock icon): xslop sends no signal from or about it. */
  protected: boolean;
  actionBar: HTMLElement | null;
  cell: HTMLElement | null;
}

const PROFILE_PATH = /^\/([A-Za-z0-9_]{1,15})\/?$/;
const AVATAR_TEST_ID = /^UserAvatar-Container-([A-Za-z0-9_]{1,15})$/;
const STATUS_IN_HREF = /\/status\/([0-9]{1,20})(?:[/?#]|$)/;
// The status page itself and its photo or video view; /quotes and /retweets are lists, with no focal post.
const STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([0-9]{1,20})(?:\/(?:photo|video)\/[0-9]+)?\/?$/;

/** Handle of a one-segment profile link ("/name"), lower case. */
function profileHandle(href: string | null): string | null {
  const m = PROFILE_PATH.exec(href ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/** Tweet id of a status page URL path, or null. */
export const statusIdOf = (pathname: string): string | null => STATUS_PATH.exec(pathname)?.[1] ?? null;

/** True when tweet id `a` is newer than `b`. X ids grow with time, so this orders posts without reading the page. */
export const newerId = (a: string, b: string): boolean => (a.length === b.length ? a > b : a.length > b.length);

/** Handle in the test id of an avatar, lower case. X writes "unknown" when the avatar has no handle. */
function avatarHandle(testId: string | null): string | null {
  const handle = AVATAR_TEST_ID.exec(testId ?? '')?.[1]?.toLowerCase();
  return handle && handle !== 'unknown' ? handle : null;
}

/** Your handle: the link to your profile on a wide page, your avatar in X's phone layout. Null when the page shows neither. */
export function ownHandle(doc: Document, sel: Selectors): string | null {
  const el = doc.querySelector(sel.ownProfile);
  return el && (profileHandle(el.getAttribute('href')) ?? avatarHandle(el.getAttribute('data-testid')));
}

/** True when `el` is part of this tweet and not of a quoted tweet inside it. */
function outer(article: Element, el: Element, quote: string): boolean {
  const q = el.closest(quote);
  return !q || !article.contains(q) || q === article;
}

function firstOuter(article: Element, selector: string, quote: string): HTMLElement | null {
  for (const el of article.querySelectorAll<HTMLElement>(selector)) if (outer(article, el, quote)) return el;
  return null;
}

function lastOuter(article: Element, selector: string, quote: string): HTMLElement | null {
  const all = article.querySelectorAll<HTMLElement>(selector);
  for (let i = all.length - 1; i >= 0; i--) if (outer(article, all[i]!, quote)) return all[i]!;
  return null;
}

/** A "Replying to @name" line: a profile link that reads "@..." outside the header, the text and any quote, above the text. */
function hasReplyingTo(article: Element, sel: Selectors, header: Element, text: Element | null, anchor: Element | null): boolean {
  for (const a of article.querySelectorAll(sel.replyingTo)) {
    if (header.contains(a) || text?.contains(a) || !outer(article, a, sel.quote)) continue;
    if (!profileHandle(a.getAttribute('href')) || !(a.textContent ?? '').trim().startsWith('@')) continue;
    if (!anchor || a.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
  }
  return false;
}

/** The action bar (reply, repost, like...) of the tweet itself. */
export const actionBarOf = (article: Element, sel: Selectors): HTMLElement | null => lastOuter(article, sel.actionBar, sel.quote);

/** The "More" button of the tweet itself. It must open a menu, so that a remote selector cannot aim the click at Like or Follow. */
export function caretOf(article: Element, sel: Selectors): HTMLElement | null {
  const caret = firstOuter(article, sel.caret, sel.quote);
  return caret?.getAttribute('aria-haspopup') === 'menu' ? caret : null;
}

export function parseTweet(article: Element, sel: Selectors): Parsed | null {
  const header = firstOuter(article, sel.userName, sel.quote);
  if (!header) return null;
  let handle: string | null = null;
  for (const a of header.querySelectorAll(sel.userLink)) {
    handle = profileHandle(a.getAttribute('href'));
    if (handle) break;
  }
  if (!handle) return null;

  let tweetId: string | null = null;
  let time: string | null = null;
  for (const t of article.querySelectorAll(sel.time)) {
    if (!outer(article, t, sel.quote)) continue;
    const link = t.closest(sel.statusLink);
    const m = link && article.contains(link) ? STATUS_IN_HREF.exec(link.getAttribute('href') ?? '') : null;
    if (m) {
      tweetId = m[1]!;
      time = t.getAttribute('datetime');
      break;
    }
  }
  if (!tweetId) return null;

  const textEl = firstOuter(article, sel.text, sel.quote);
  const actionBar = actionBarOf(article, sel);
  const media = firstOuter(article, sel.media, sel.quote);
  return {
    handle,
    tweetId,
    time,
    replyingTo: hasReplyingTo(article, sel, header, textEl, textEl ?? media ?? actionBar),
    // Ads wrap the whole article; the same test id inside an article marks a video, not an ad.
    promoted: !!article.closest(sel.promoted),
    protected: !!header.querySelector(sel.protected),
    actionBar,
    cell: article.closest<HTMLElement>(sel.cell),
  };
}
