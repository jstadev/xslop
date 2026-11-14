// @vitest-environment happy-dom
// The content script end to end in a page: the button on every tweet, the instant mute of a click, Undo,
// and the rules of the X calls: the limit, the stop, X's own menu as the second path.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../../src/shared/config';
import { NOT_CALLED, parseContentMsg, type ContentMsg, type XCall } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/types';
import { X_SELF_CODE } from '../../src/shared/muteplan';
import { createInstant, type Instant } from '../../src/content/instant';
import { pickMenuItem, runMenu } from '../../src/content/menu';
import { hideToast } from '../../src/content/toast';
import { xcall } from '../../src/content/xcall';
import { deliver, fakeChrome, trustedClick, type FakeChrome } from '../helpers/chrome';
import { articleOf, barButton, barText, cellOf, frames, isHidden, markButton, mountFixture, rootOf } from '../helpers/dom';

let f: FakeChrome;
const bg = { id: 'xslop-test-id' };
const sentOf = (t: string) => f.sent.filter((m) => (m as { t: string }).t === t) as Record<string, unknown>[];
const setSettings = async (s: Partial<Settings>) => {
  await deliver(f, { t: 'settings', settings: { ...DEFAULT_SETTINGS, ...s } }, bg);
  await frames(1);
};
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** happy-dom keeps cookies per origin: set this after every URL change. */
const logIn = (): void => {
  document.cookie = `ct0=${CT0}; path=/`;
};

const CT0 = 'c%2B0token';
const BEARER = DEFAULT_CONFIG.mute.webBearer;
const X_CREATE = 'https://x.com/i/api/1.1/mutes/users/create.json';
const X_DESTROY = 'https://x.com/i/api/1.1/mutes/users/destroy.json';
const okX = (id: string) => new Response(JSON.stringify({ id_str: id, screen_name: 'x' }), { status: 200 });
const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okX('1234567890'));
const xBodies = (url: string) => fetchMock.mock.calls.filter((c) => c[0] === url).map((c) => c[1].body);

function toastRoot(): ShadowRoot {
  return rootOf(document.querySelector('.xslop-toast'))!;
}
const toastText = (): string => toastRoot().querySelector('[role="status"] span')?.textContent ?? '';
const toastUndo = (): HTMLButtonElement => toastRoot().querySelector('button')!;
const parseHandle = (id: string): string => articleOf(id).querySelector('[data-testid="User-Name"] a')!.getAttribute('href')!.slice(1).toLowerCase();

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('list', { version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"1"', accounts: [['flaggedone', 64, 1], ['globalslop', 87, 2]] });
  let lastId: string | null = null;
  f.onRuntimeMessage = async (msg: ContentMsg) => {
    if (msg.t === 'muted' && msg.op === 'create') lastId = msg.id;
    if (msg.t === 'muteRecord') return { id: lastId };
    return { ok: true };
  };
  vi.stubGlobal('fetch', fetchMock);
  mountFixture('status.html', 'https://x.com/alice/status/100');
  logIn();
  await import('../../src/content/main');
  await frames();
});
afterAll(() => vi.unstubAllGlobals());

describe('button on every tweet', () => {
  it('puts one button on the focal post, its ancestors and the replies; none on your own tweet or an ad', () => {
    for (const id of ['99', '100', '101', '102', '103', '104', '105', '108', '109']) expect(articleOf(id).querySelectorAll('.xslop-host')).toHaveLength(1);
    for (const id of ['106', '107']) expect(articleOf(id).querySelectorAll('.xslop-host')).toHaveLength(0);
  });

  it('places it in the action bar, in a shadow root, with a label and a keyboard focusable button', () => {
    const host = articleOf('101').querySelector('.xslop-host')!;
    expect(host.parentElement!.getAttribute('role')).toBe('group');
    const b = markButton('101')!;
    expect(b.getAttribute('aria-label')).toBe('Mark @slopbot as slop');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.tagName).toBe('BUTTON');
    expect(b.querySelector('svg')).not.toBeNull();
    expect(markButton('108')!.getAttribute('aria-label')).toBe('Mark @quoter as slop');
  });

  it('gives a quoted tweet inside another tweet no button of its own', () => {
    expect(articleOf('108').querySelectorAll('.xslop-host')).toHaveLength(1);
    expect(articleOf('108').querySelector('div[role="link"] .xslop-host')).toBeNull();
  });

  it('is idempotent across new mutations', async () => {
    document.body.append(document.createElement('div'));
    articleOf('102').querySelector('[role="group"]')!.append(document.createElement('span'));
    await frames();
    for (const id of ['101', '102', '109']) expect(articleOf(id).querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('adds the button when the action bar renders late', async () => {
    const cell = cellOf('109').cloneNode(true) as HTMLElement;
    cell.querySelector('.xslop-host')?.remove();
    for (const a of cell.querySelectorAll('a[href*="/status/109"]')) a.setAttribute('href', a.getAttribute('href')!.replace('109', '110'));
    const group = cell.querySelector('[role="group"]')!;
    const parent = group.parentElement!;
    group.remove();
    document.querySelector('[data-testid="cellInnerDiv"]')!.parentElement!.append(cell);
    await frames();
    expect(articleOf('110').querySelectorAll('.xslop-host')).toHaveLength(0);
    parent.append(group);
    await frames();
    expect(articleOf('110').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('puts the button back when X replaces the action bar', async () => {
    const group = articleOf('105').querySelector('[role="group"]')!;
    const parent = group.parentElement!;
    group.remove();
    const fresh = document.createElement('div');
    fresh.setAttribute('role', 'group');
    parent.append(fresh);
    await frames();
    expect(fresh.querySelectorAll('.xslop-host')).toHaveLength(1);
    expect(articleOf('105').querySelectorAll('.xslop-host')).toHaveLength(1);
  });
});

describe('global list', () => {
  it('collapses a tier 2 account with its score, and leaves tier 1 visible in Balanced', () => {
    expect(isHidden('104')).toBe(true);
    expect(barText('104')).toBe('Hidden by xslop (score 87)·Show·Not slop');
    expect(isHidden('105')).toBe(false);
  });

  it('reports the hidden count to the background', () => {
    expect(sentOf('hidden')).toEqual([{ t: 'hidden', ids: ['104'] }]);
  });
});

describe('click, show, undo', () => {
  it('ignores a click that a page script makes: no vote, no hide, no call to X', async () => {
    markButton('101')!.click();
    await frames(1);
    expect(sentOf('vote')).toEqual([]);
    expect(isHidden('101')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collapses the tweet, calls X and sends the vote in the same task as the click', () => {
    let xSaw = false;
    articleOf('101').addEventListener('click', () => (xSaw = true));
    trustedClick(markButton('101')!);
    // No await before these lines: everything has happened already.
    expect(isHidden('101')).toBe(true);
    expect(isHidden('103')).toBe(true);
    expect(isHidden('102')).toBe(false);
    expect(barText('101')).toBe('Hidden reply from @slopbot·Show·Undo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(X_CREATE);
    expect(init).toMatchObject({
      method: 'POST', credentials: 'include', redirect: 'error', body: 'screen_name=slopbot',
      headers: {
        authorization: `Bearer ${BEARER}`, 'x-csrf-token': 'c+0token', 'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes', 'content-type': 'application/x-www-form-urlencoded',
      },
    });
    const [vote] = sentOf('vote');
    expect(vote).toMatchObject({
      t: 'vote', handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: '2026-11-07T09:10:12.000Z', context: 'reply',
    });
    expect(parseContentMsg(vote)).not.toBeNull();
    // X's own click handler (it opens the tweet) never sees the click.
    expect(xSaw).toBe(false);
  });

  it('reports the X result to the background and confirms with a toast that has Undo', async () => {
    await settled();
    expect(sentOf('muted')).toEqual([{ t: 'muted', handle: 'slopbot', id: '1234567890', status: 200, code: null, via: 'rest', op: 'create' }]);
    expect(parseContentMsg(sentOf('muted')[0])).not.toBeNull();
    expect(toastText()).toBe('Muted @slopbot on X');
    expect(toastRoot().querySelector('[role="status"]')).not.toBeNull();
    expect(toastUndo().hidden).toBe(false);
  });

  it('Show reveals only that reply; the button then reads as pressed', async () => {
    trustedClick(barButton('101', 'Show'));
    expect(isHidden('101')).toBe(false);
    expect(isHidden('103')).toBe(true);
    expect(markButton('101')!.getAttribute('aria-pressed')).toBe('true');
    expect(markButton('101')!.getAttribute('aria-label')).toBe('Unmark @slopbot as slop');
  });

  it('F6 regression: Undo drops the vote in the same task, then unmutes by the recorded user id', async () => {
    trustedClick(barButton('103', 'Undo'));
    expect(isHidden('101')).toBe(false);
    expect(isHidden('103')).toBe(false);
    // No await before this line: a tab that closes during the X call cannot lose the undo.
    expect(sentOf('unvote')).toMatchObject([{ t: 'unvote', handle: 'slopbot' }]);
    await settled();
    expect(sentOf('muteRecord')).toEqual([{ t: 'muteRecord', handle: 'slopbot' }]);
    expect(xBodies(X_DESTROY)).toEqual(['user_id=1234567890']);
    expect(sentOf('muted').at(-1)).toEqual({ t: 'muted', handle: 'slopbot', id: '1234567890', status: 200, code: null, via: 'rest', op: 'destroy' });
    expect(toastText()).toBe('Unmuted @slopbot on X');
  });

  it('F5 regression: the toast Undo counts only while the toast itself can be seen', async () => {
    trustedClick(markButton('101')!);
    await settled();
    fetchMock.mockClear();
    const host = document.querySelector<HTMLElement>('.xslop-toast')!;
    host.style.opacity = '0';
    trustedClick(toastUndo());
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isHidden('101')).toBe(true);
    host.style.opacity = '';
    trustedClick(toastUndo());
    await settled();
    expect(isHidden('101')).toBe(false);
  });

  it('Undo from the toast does the same as the bar', async () => {
    trustedClick(markButton('101')!);
    await settled();
    fetchMock.mockClear();
    trustedClick(toastUndo());
    await settled();
    expect(isHidden('101')).toBe(false);
    expect(xBodies(X_DESTROY)).toEqual(['user_id=1234567890']);
  });

  it('a page script cannot press the toast Undo', async () => {
    trustedClick(markButton('101')!);
    await settled();
    fetchMock.mockClear();
    toastUndo().click();
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isHidden('101')).toBe(true);
    trustedClick(toastUndo());
    await settled();
  });

  it('Not slop on a global account sends not_slop and keeps it visible', () => {
    trustedClick(barButton('104', 'Not slop'));
    expect(isHidden('104')).toBe(false);
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'globalslop', value: 'not_slop', tweetId: '104' });
  });

  it('muteOnMark off: the click hides and votes, and xslop makes no X call', async () => {
    const tip = () => markButton('105')!.querySelector('.tip')!.textContent;
    expect(tip()).toBe('Mark as slop, hide and mute');
    await setSettings({ muteOnMark: false });
    expect(tip()).toBe('Mark as slop and hide');
    fetchMock.mockClear();
    const before = sentOf('muted').length;
    trustedClick(markButton('105')!);
    await settled();
    expect(isHidden('105')).toBe(true);
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'flaggedone', value: 'slop' });
    expect(fetchMock).not.toHaveBeenCalled();
    trustedClick(barButton('105', 'Undo'));
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentOf('muted')).toHaveLength(before);
    expect(sentOf('unvote').at(-1)).toMatchObject({ t: 'unvote', handle: 'flaggedone' });
    await setSettings({});
  });

  it('the remote kill switch stops instant mutes too', async () => {
    f.local.set('config', { ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, enabled: false } });
    await deliver(f, { t: 'config' }, bg);
    await frames();
    fetchMock.mockClear();
    trustedClick(markButton('105')!);
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    trustedClick(barButton('105', 'Undo'));
    await settled();
    f.local.delete('config');
    await deliver(f, { t: 'config' }, bg);
    await frames();
  });
});

describe('the focal post', () => {
  it('is never collapsed: a click marks it and leaves it open', async () => {
    fetchMock.mockClear();
    trustedClick(markButton('100')!);
    expect(isHidden('100')).toBe(false);
    expect(markButton('100')!.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'alice', tweetId: '100', parentTweetId: null, context: 'post' });
    await settled();
    trustedClick(markButton('100')!);
    await settled();
    expect(markButton('100')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('F10 regression: the second click of a double click does nothing', async () => {
    fetchMock.mockClear();
    trustedClick(markButton('100')!, 1);
    trustedClick(markButton('100')!, 2);
    expect(markButton('100')!.getAttribute('aria-pressed')).toBe('true');
    await settled();
    expect(xBodies(X_DESTROY)).toEqual([]);
    expect(xBodies(X_CREATE)).toHaveLength(1);
    trustedClick(markButton('100')!, 1);
    await settled();
    expect(markButton('100')!.getAttribute('aria-pressed')).toBe('false');
    expect(xBodies(X_DESTROY)).toHaveLength(1);
  });

  it('an ancestor of the focal post is a post, with no parent', async () => {
    trustedClick(markButton('99')!);
    expect(isHidden('99')).toBe(true);
    expect(barText('99')).toBe('Hidden post from @bob·Show·Undo');
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'bob', tweetId: '99', parentTweetId: null, context: 'post' });
    await settled();
    trustedClick(barButton('99', 'Undo'));
    await settled();
  });
});

describe('after an update of the extension', () => {
  const runtime = (): { id?: string } => f.api.runtime as unknown as { id?: string };

  it('F9 regression: this old script makes no X call and no vote, and tells you to reload', async () => {
    const id = runtime().id;
    fetchMock.mockClear();
    const before = f.sent.length;
    runtime().id = undefined;
    trustedClick(markButton('102')!);
    trustedClick(barButton('104', 'Not slop'));
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(before);
    expect(isHidden('102')).toBe(false);
    expect(toastText()).toBe('xslop was updated. Reload this page.');
    runtime().id = id;
    hideToast();
  });
});

describe('strictness and display', () => {
  it('Strict also hides tier 1; Off hides only your own list', async () => {
    await setSettings({ strictness: 'strict' });
    expect(isHidden('105')).toBe(true);
    expect(barText('105')).toBe('Hidden by xslop (score 64)·Show·Not slop');
    trustedClick(markButton('102')!);
    await settled();
    await setSettings({ strictness: 'off' });
    expect(isHidden('105')).toBe(false);
    expect(isHidden('102')).toBe(true);
  });

  it('Remove hides the whole cell without a bar, except the reply you just marked', async () => {
    await setSettings({ display: 'remove' });
    expect(cellOf('102').getAttribute('data-xslop-cell')).toBe('collapsed');
    await deliver(f, { t: 'votes', set: [['flaggedone', 1]], del: [] }, bg);
    expect(cellOf('105').getAttribute('data-xslop-cell')).toBe('removed');
    expect(barText('105')).toBeNull();
    await setSettings({ display: 'collapse' });
    expect(barText('105')).toBe('Hidden reply from @flaggedone·Show·Undo');
  });

  it('applies list deltas from the background', async () => {
    await setSettings({});
    await deliver(f, { t: 'list', from: 1, version: 2, add: [['photoguy', 91, 2]], remove: ['flaggedone'] }, bg);
    expect(barText('109')).toBe('Hidden by xslop (score 91)·Show·Not slop');
  });

  it('ignores messages that do not come from the background', async () => {
    await deliver(f, { t: 'votes', set: [['quoter', 1]], del: [] }, { id: 'another-extension' });
    await deliver(f, { t: 'votes', set: [['quoter', 1]], del: [] }, { id: 'xslop-test-id', tab: { id: 1 } as chrome.tabs.Tab });
    expect(isHidden('108')).toBe(false);
  });

  it('sends no observation without consent', () => {
    expect(sentOf('observe')).toEqual([]);
  });
});

describe('other surfaces', () => {
  beforeAll(async () => {
    mountFixture('home.html', 'https://x.com/home');
    logIn();
    await frames();
  });

  it('puts the button on posts and replies, none on your own tweet or an ad', () => {
    for (const id of ['201', '202', '203', '205']) expect(articleOf(id).querySelectorAll('.xslop-host')).toHaveLength(1);
    for (const id of ['204', '206']) expect(articleOf(id).querySelectorAll('.xslop-host')).toHaveLength(0);
  });

  it('a click on a post hides that post and sends context post with no parent', async () => {
    trustedClick(markButton('201')!);
    expect(isHidden('201')).toBe(true);
    expect(barText('201')).toBe('Hidden post from @dave·Show·Undo');
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'dave', tweetId: '201', parentTweetId: null, context: 'post' });
    await settled();
  });

  it('a reply on a timeline keeps context reply', async () => {
    trustedClick(markButton('202')!);
    expect(sentOf('vote').at(-1)).toMatchObject({ handle: 'slopbot', tweetId: '202', parentTweetId: null, context: 'reply' });
    await settled();
  });

  it('known item 4: when X says that this account is you, xslop takes the mark back and removes the button', async () => {
    // A page that does not show who you are, as X's phone layout may do.
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!.remove();
    fetchMock.mockImplementationOnce(answer(403, { errors: [{ code: X_SELF_CODE }] }) as never);
    const handle = parseHandle('205');
    trustedClick(markButton('205')!);
    expect(isHidden('205')).toBe(true);
    await settled();
    await frames(1);
    expect(isHidden('205')).toBe(false);
    expect(articleOf('205').querySelector('.xslop-host')).toBeNull();
    expect(sentOf('unvote').at(-1)).toMatchObject({ t: 'unvote', handle });
    expect(toastText()).toBe('This is your own account. xslop did not mark it.');
  });
});

// ---- the rules of the X calls, on their own ----

interface Harness {
  sent: ContentMsg[];
  toasts: string[];
  undone: string[];
  yours: string[];
  instant: Instant;
}

function harness(articleOf: () => Element | null = () => null): Harness {
  const h: Harness = { sent: [], toasts: [], undone: [], yours: [], instant: undefined as unknown as Instant };
  h.instant = createInstant({
    send: async (msg) => {
      h.sent.push(msg);
      return msg.t === 'muteRecord' ? { id: '777' } : { ok: true };
    },
    config: (): Config => DEFAULT_CONFIG,
    articleOf,
    undo: (handle) => h.undone.push(handle),
    yours: (handle) => h.yours.push(handle),
    toast: (message) => h.toasts.push(message),
  });
  return h;
}

const muted = (h: Harness) => h.sent.filter((m) => m.t === 'muted');
const answer = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

describe('instant mute rules', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => okX('1234567890'));
    logIn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => vi.useRealTimers());
  const flushNow = () => vi.advanceTimersByTimeAsync(0);

  it('allows 30 instant mutes a minute: past that, no X call, and the mute goes to the paced queue', async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.instant.mute(`bot${i}`);
    await flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(30);
    h.instant.mute('bot30');
    await flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(muted(h).at(-1)).toEqual({ t: 'muted', handle: 'bot30', id: null, status: 0, code: NOT_CALLED, via: 'rest', op: 'create' });
    expect(parseContentMsg(muted(h).at(-1))).not.toBeNull();
    expect(h.toasts.at(-1)).toBe('Hidden here. The mute on X comes later.');
    vi.setSystemTime(1_000_000 + 60_001);
    h.instant.mute('bot31');
    await flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(31);
  });

  it.each([401, 429])('X %i stops instant mutes for 15 minutes and says so', async (status) => {
    fetchMock.mockImplementation(answer(status) as never);
    const h = harness();
    h.instant.mute('alpha');
    await flushNow();
    expect(muted(h)).toEqual([{ t: 'muted', handle: 'alpha', id: null, status, code: null, via: 'rest', op: 'create' }]);
    expect(h.toasts.at(-1)).toBe('Hidden here. X limits mutes right now, so instant mutes stop for 15 minutes.');
    h.instant.mute('beta');
    await flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(muted(h).at(-1)).toMatchObject({ handle: 'beta', status: 0, code: NOT_CALLED });
    fetchMock.mockImplementation(async () => okX('5'));
    vi.setSystemTime(1_000_000 + 15 * 60_000 + 1);
    h.instant.mute('gamma');
    await flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.toasts.at(-1)).toBe('Muted @gamma on X');
  });

  it('says plainly when X refuses and when you are not logged in', async () => {
    fetchMock.mockImplementation(answer(500) as never);
    const h = harness();
    h.instant.mute('alpha');
    await flushNow();
    expect(h.toasts.at(-1)).toBe('Hidden here. X did not accept the mute.');
    document.cookie = 'ct0=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    h.instant.mute('beta');
    await flushNow();
    expect(h.toasts.at(-1)).toBe('Hidden here. Log in to X to mute this account there.');
    document.cookie = 'ct0=%E0%A4%A; path=/';
    h.instant.mute('gamma');
    await flushNow();
    expect(h.toasts.at(-1)).toBe('Hidden here. Log in to X to mute this account there.');
  });

  it('does not try the menu when X says the account is missing or suspended', async () => {
    const opened = vi.fn(() => null);
    fetchMock.mockImplementation(answer(403, { errors: [{ code: 63 }] }) as never);
    const h = harness(opened);
    h.instant.mute('gone');
    await flushNow();
    expect(opened).not.toHaveBeenCalled();
    expect(muted(h).at(-1)).toMatchObject({ status: 403, code: 63, via: 'rest' });
    expect(h.toasts.at(-1)).toBe('Hidden here. X did not accept the mute.');
  });

  it('F2 regression: X\'s answer "this account is you" does not run the menu; xslop learns the handle', async () => {
    const opened = vi.fn(() => null);
    fetchMock.mockImplementation(answer(403, { errors: [{ code: X_SELF_CODE }] }) as never);
    const h = harness(opened);
    h.instant.mute('me_user');
    await flushNow();
    expect(opened).not.toHaveBeenCalled();
    expect(muted(h).at(-1)).toMatchObject({ status: 403, code: X_SELF_CODE, via: 'rest', op: 'create' });
    expect(h.yours).toEqual(['me_user']);
    expect(h.toasts).toEqual([]);
  });

  it('F2 regression: X\'s answer "you do not mute this user" does not run the menu on an undo', async () => {
    const opened = vi.fn(() => null);
    fetchMock.mockImplementation(answer(403, { errors: [{ code: 272 }] }) as never);
    const h = harness(opened);
    await Promise.all([h.instant.unmute('alpha'), flushNow()]);
    expect(opened).not.toHaveBeenCalled();
    expect(muted(h).at(-1)).toMatchObject({ status: 403, code: 272, via: 'rest', op: 'destroy' });
  });

  it('an Undo waits for the mute that it undoes, then uses the id of the record', async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { finish = r; }));
    const h = harness();
    h.instant.mute('alpha');
    const undone = h.instant.unmute('alpha');
    await flushNow();
    expect(h.sent.some((m) => m.t === 'muteRecord')).toBe(false);
    finish(okX('5'));
    await flushNow();
    await undone;
    expect(h.sent.map((m) => m.t)).toEqual(['muted', 'muteRecord', 'muted']);
    expect(fetchMock.mock.calls[1]![0]).toBe(X_DESTROY);
    expect(fetchMock.mock.calls[1]![1].body).toBe('user_id=777');
  });

  it('no recorded id means no unmute: a mute that you made yourself stays, and xslop says so', async () => {
    const h = harness();
    h.instant = createInstant({
      send: async (msg) => { h.sent.push(msg); return msg.t === 'muteRecord' ? { id: null, stays: true } : { ok: true }; },
      config: () => DEFAULT_CONFIG, articleOf: () => null, undo: () => undefined, yours: () => undefined, toast: (m) => h.toasts.push(m),
    });
    await h.instant.unmute('alpha');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(muted(h)).toEqual([]);
    expect(h.toasts).toEqual(['Shown again here. @alpha stays muted on X.']);
  });

  it('no record at all: an undo says nothing about X', async () => {
    const h = harness();
    h.instant = createInstant({
      send: async (msg) => { h.sent.push(msg); return msg.t === 'muteRecord' ? { id: null, stays: false } : { ok: true }; },
      config: () => DEFAULT_CONFIG, articleOf: () => null, undo: () => undefined, yours: () => undefined, toast: (m) => h.toasts.push(m),
    });
    await h.instant.unmute('alpha');
    expect(h.toasts).toEqual([]);
  });

  it('an Undo past the limit goes to the paced queue and says so', async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.instant.mute(`bot${i}`);
    await flushNow();
    const undo = h.instant.unmute('alpha');
    await flushNow();
    await undo;
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(muted(h).at(-1)).toEqual({ t: 'muted', handle: 'alpha', id: '777', status: 0, code: NOT_CALLED, via: 'rest', op: 'destroy' });
    expect(h.toasts.at(-1)).toBe('Shown again here. The unmute on X comes later.');
  });

  it('the toast Undo runs the undo of the bar', () => {
    let press: (() => void) | undefined;
    const undone: string[] = [];
    const instant = createInstant({
      send: async () => ({ ok: true }),
      config: () => DEFAULT_CONFIG, articleOf: () => null, undo: (handle) => undone.push(handle), yours: () => undefined,
      toast: (_message, onUndo) => { press = onUndo; },
    });
    instant.mute('alpha');
    return vi.advanceTimersByTimeAsync(0).then(() => {
      press!();
      expect(undone).toEqual(['alpha']);
    });
  });
});

describe('the X origin', () => {
  const create: XCall = { t: 'xcall', op: 'create', handle: 'slopbot', userId: null, cursor: null, bearer: BEARER };
  const setURL = (u: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(u);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => okX('1'));
  });
  afterAll(() => {
    setURL('https://x.com/home');
    logIn();
  });

  it.each(['https://x.com', 'https://twitter.com', 'https://mobile.x.com'])('calls the current origin on %s', async (origin) => {
    setURL(`${origin}/home`);
    logIn();
    await xcall(create);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${origin}/i/api/1.1/mutes/users/create.json`);
  });

  it('refuses every other origin', async () => {
    setURL('https://example.com/home');
    logIn();
    expect(await xcall(create)).toMatchObject({ status: 0, code: -2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- X's own menu, the second path ----

const item = (text: string): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('role', 'menuitem');
  el.textContent = text;
  return el;
};

describe('pickMenuItem: the rule that keeps a wrong click from happening', () => {
  const pick = (texts: string[], op: 'create' | 'destroy' = 'create', handle = 'slopbot') =>
    pickMenuItem(texts.map(item), handle, op)?.textContent ?? null;

  it('picks the Mute item in English', () => {
    expect(pick(['Follow @SlopBot', 'Mute @SlopBot', 'Block @SlopBot'])).toBe('Mute @SlopBot');
  });

  it('refuses Block and Unfollow in English', () => {
    expect(pick(['Block @SlopBot', 'Unfollow @SlopBot'])).toBeNull();
  });

  it('refuses Block and Unfollow in Spanish and German, and still picks Mute there', () => {
    expect(pick(['Bloquear a @SlopBot', 'Dejar de seguir a @SlopBot'])).toBeNull();
    expect(pick(['@SlopBot blockieren', '@SlopBot entfolgen'])).toBeNull();
    expect(pick(['Bloquear a @SlopBot', 'Silenciar a @SlopBot'])).toBe('Silenciar a @SlopBot');
    expect(pick(['@SlopBot blockieren', '@SlopBot stummschalten'])).toBe('@SlopBot stummschalten');
  });

  it('refuses an item whose only mute word sits inside the handle', () => {
    expect(pick(['Block @mute_bot', 'Unfollow @mute_bot', 'Follow @mute_bot'], 'create', 'mute_bot')).toBeNull();
  });

  it('refuses an item for a longer handle that starts with this one', () => {
    expect(pick(['Mute @SlopBot2'])).toBeNull();
  });

  it('refuses an item with no handle, such as Mute this conversation', () => {
    expect(pick(['Mute this conversation', 'Report post'])).toBeNull();
  });

  it('for create, refuses the Unmute item: the account is already yours to manage', () => {
    expect(pick(['Unmute @SlopBot', 'Block @SlopBot'])).toBeNull();
    expect(pick(['Dejar de silenciar a @SlopBot'])).toBeNull();
  });

  it('for destroy, picks only the Unmute item', () => {
    expect(pick(['Mute @SlopBot', 'Block @SlopBot', 'Unmute @SlopBot'], 'destroy')).toBe('Unmute @SlopBot');
    expect(pick(['Mute @SlopBot'], 'destroy')).toBeNull();
  });

  it('reads the handle across marks that X adds', () => {
    expect(pick(['Mute ⁦@SlopBot⁩'])).toBe('Mute ⁦@SlopBot⁩');
  });
});

describe('runMenu: the 404 path', () => {
  const sel = DEFAULT_CONFIG.selectors;
  let article: HTMLElement;
  let caret: HTMLElement;
  let clicked: string[];

  /** X's markup: the caret opens a [role=menu] in #layers; a menu item closes it; Escape closes it. */
  function mountMenu(texts: string[], openedAfterMs = 0, on: HTMLElement = caret): void {
    clicked = [];
    on.onclick = () => {
      const open = () => {
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        for (const t of texts) {
          const it = item(t);
          it.onclick = () => {
            clicked.push(t);
            menu.remove();
          };
          menu.append(it);
        }
        menu.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') menu.remove();
        });
        document.body.append(menu);
      };
      if (openedAfterMs) setTimeout(open, openedAfterMs);
      else open();
    };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    article = document.createElement('article');
    caret = document.createElement('button');
    caret.setAttribute('data-testid', 'caret');
    caret.setAttribute('aria-haspopup', 'menu');
    article.append(caret);
    document.body.append(article);
  });

  const menuHiddenStyle = () => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes(sel.menu));

  it('clicks only the Mute item, hides the menu during the run, removes the style after', async () => {
    mountMenu(['Follow @SlopBot', 'Block @SlopBot', 'Mute @SlopBot']);
    const open = caret.onclick as (e: unknown) => unknown;
    let hiddenWhenOpen = false;
    caret.onclick = (e) => {
      hiddenWhenOpen = menuHiddenStyle();
      return open.call(caret, e);
    };
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(true);
    expect(hiddenWhenOpen).toBe(true);
    expect(clicked).toEqual(['Mute @SlopBot']);
    expect(document.querySelector(sel.menu)).toBeNull();
    expect(menuHiddenStyle()).toBe(false);
  });

  it('with only Block and Unfollow, clicks nothing and closes the menu', async () => {
    mountMenu(['Unfollow @SlopBot', 'Block @SlopBot']);
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(false);
    expect(clicked).toEqual([]);
    expect(document.querySelector(sel.menu)).toBeNull();
    expect(menuHiddenStyle()).toBe(false);
  });

  it('waits for a menu that X draws late', async () => {
    mountMenu(['Mute @SlopBot'], 120);
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(true);
    expect(clicked).toEqual(['Mute @SlopBot']);
  });

  it('F1 regression: a control that opens no menu is never pressed', async () => {
    caret.removeAttribute('aria-haspopup');
    let pressed = false;
    caret.onclick = () => { pressed = true; };
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(false);
    expect(pressed).toBe(false);
  });

  it('F11 regression: two runs at the same time take turns, and both land', async () => {
    const other = document.createElement('article');
    const otherCaret = document.createElement('button');
    otherCaret.setAttribute('data-testid', 'caret');
    otherCaret.setAttribute('aria-haspopup', 'menu');
    other.append(otherCaret);
    document.body.append(other);
    mountMenu(['Mute @SlopBot']);
    const seen: string[] = [];
    const open = (handle: string, on: HTMLElement) => {
      const menuOf = on.onclick!;
      on.onclick = (e) => {
        seen.push(handle);
        return (menuOf as (ev: unknown) => unknown).call(on, e);
      };
    };
    open('slopbot', caret);
    const first = clicked;
    mountMenu(['Mute @OtherBot'], 0, otherCaret);
    clicked = first;
    open('otherbot', otherCaret);
    await expect(Promise.all([runMenu(article, 'slopbot', 'create', sel), runMenu(other, 'otherbot', 'create', sel)])).resolves.toEqual([true, true]);
    expect(seen).toEqual(['slopbot', 'otherbot']);
    expect(clicked).toEqual(['Mute @SlopBot', 'Mute @OtherBot']);
  });

  it('a remote config cannot widen the words: Block stays out of reach', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(404) as never);
    mountMenu(['Block @SlopBot']);
    const hostile = { ...DEFAULT_CONFIG, muteWords: ['block'], unmuteWords: ['nothing'] } as Config;
    const h = harness(() => article);
    h.instant = createInstant({
      send: async (msg) => { h.sent.push(msg); return { ok: true }; },
      config: () => hostile, articleOf: () => article, undo: () => undefined, yours: () => undefined, toast: (m) => h.toasts.push(m),
    });
    h.instant.mute('slopbot');
    await vi.waitFor(() => expect(muted(h)).toHaveLength(1));
    expect(clicked).toEqual([]);
  });

  it('gives up when no menu opens, and hides nothing after', async () => {
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(false);
    expect(menuHiddenStyle()).toBe(false);
  });

  it('leaves a menu that you opened yourself alone', async () => {
    mountMenu(['Mute @SlopBot']);
    const yours = document.createElement('div');
    yours.setAttribute('role', 'menu');
    document.body.append(yours);
    await expect(runMenu(article, 'slopbot', 'create', sel)).resolves.toBe(false);
    expect(clicked).toEqual([]);
    expect(document.querySelector(sel.menu)).toBe(yours);
  });

  it('a 404 from X runs the menu, and the result goes to the background with no id', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(404) as never);
    mountMenu(['Mute @SlopBot', 'Block @SlopBot']);
    const h = harness(() => article);
    h.instant.mute('slopbot');
    await vi.waitFor(() => expect(muted(h)).toHaveLength(1));
    expect(muted(h)[0]).toEqual({ t: 'muted', handle: 'slopbot', id: null, status: 200, code: null, via: 'menu', op: 'create' });
    expect(clicked).toEqual(['Mute @SlopBot']);
    expect(h.toasts.at(-1)).toBe('Muted @slopbot on X');
  });

  it('a 403 that is not "missing" also runs the menu', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(403, { errors: [{ code: 200 }] }) as never);
    mountMenu(['Mute @SlopBot']);
    const h = harness(() => article);
    h.instant.mute('slopbot');
    await vi.waitFor(() => expect(muted(h)).toHaveLength(1));
    expect(muted(h)[0]).toMatchObject({ via: 'menu', status: 200 });
  });

  it('a 404 with no safe item reports the X answer and says X did not accept', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(404) as never);
    mountMenu(['Block @SlopBot', 'Unfollow @SlopBot']);
    const h = harness(() => article);
    h.instant.mute('slopbot');
    await vi.waitFor(() => expect(muted(h)).toHaveLength(1));
    expect(clicked).toEqual([]);
    expect(muted(h)[0]).toEqual({ t: 'muted', handle: 'slopbot', id: null, status: 404, code: null, via: 'rest', op: 'create' });
    expect(h.toasts.at(-1)).toBe('Hidden here. X did not accept the mute.');
  });

  it('a mute made through the menu is undone through the menu, without an id', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(404) as never);
    mountMenu(['Mute @SlopBot']);
    const h = harness(() => article);
    h.instant.mute('slopbot');
    await vi.waitFor(() => expect(muted(h)).toHaveLength(1));
    fetchMock.mockClear();
    mountMenu(['Unmute @SlopBot', 'Block @SlopBot']);
    await h.instant.unmute('slopbot');
    expect(clicked).toEqual(['Unmute @SlopBot']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.sent.some((m) => m.t === 'muteRecord')).toBe(false);
    expect(muted(h).at(-1)).toEqual({ t: 'muted', handle: 'slopbot', id: null, status: 200, code: null, via: 'menu', op: 'destroy' });
    expect(h.toasts.at(-1)).toBe('Unmuted @slopbot on X');
  });

  it('a destroy that X answers 404 also runs the menu, with the unmute words only', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer(404) as never);
    mountMenu(['Mute @SlopBot', 'Unmute @SlopBot']);
    const h = harness(() => article);
    await h.instant.unmute('slopbot');
    expect(clicked).toEqual(['Unmute @SlopBot']);
    expect(fetchMock.mock.calls[0]![0]).toBe(X_DESTROY);
    expect(muted(h).at(-1)).toMatchObject({ via: 'menu', status: 200, op: 'destroy' });
  });
});

afterAll(() => hideToast());
