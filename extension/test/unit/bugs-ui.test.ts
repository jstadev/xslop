// @vitest-environment happy-dom
// Bugs in the content script, the popup pages and the onboarding. Each test names one user-visible fault
// or one path that was checked and found sound.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const parsedArticles = vi.hoisted(() => ({ all: [] as Element[] }));
vi.mock('../../src/content/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/content/parse')>();
  return {
    ...actual,
    parseTweet: (...args: Parameters<typeof actual.parseTweet>): ReturnType<typeof actual.parseTweet> => {
      parsedArticles.all.push(args[0]);
      return actual.parseTweet(...args);
    },
  };
});
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { deliver, fakeChrome, trustedClick, type FakeChrome } from '../helpers/chrome';
import { articleOf, barButton, barText, cellOf, frames, isHidden, markButton, mountFixture, rootOf } from '../helpers/dom';

const ONBOARDING = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/onboarding/onboarding.html'), 'utf8');

let f: FakeChrome;
const bg = { id: 'xslop-test-id' };
const sentOf = (t: string) => f.sent.filter((m) => (m as { t: string }).t === t) as Record<string, unknown>[];

const addedListeners: string[] = [];
let observers = 0;
const origAdd = document.addEventListener.bind(document);
document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  addedListeners.push(type);
  return origAdd(type, listener, options);
}) as typeof document.addEventListener;
const RealObserver = globalThis.MutationObserver;
globalThis.MutationObserver = class extends RealObserver {
  constructor(cb: MutationCallback) {
    super(cb);
    observers += 1;
  }
};

function toastRoot(): ShadowRoot {
  return rootOf(document.querySelector('.xslop-toast'))!;
}
const toastText = (): string => toastRoot().querySelector('[role="status"] span')?.textContent ?? '';
const toastUndo = (): HTMLButtonElement => toastRoot().querySelector('button')!;

/** Point one tweet at another author and another id. The @ line change is a child-list mutation. */
function rewriteTweet(id: string, handle: string, tweetId: string): void {
  const article = articleOf(id);
  const header = article.querySelector('[data-testid="User-Name"]')!;
  for (const a of header.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (href.includes('/status/')) a.setAttribute('href', `/${handle}/status/${tweetId}`);
    else if (href.startsWith('/')) a.setAttribute('href', `/${handle}`);
    if ((a.textContent ?? '').includes('@')) a.textContent = `@${handle}`;
  }
  const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"] a');
  if (avatar) avatar.setAttribute('href', `/${handle}`);
}

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('list', {
    version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"1"',
    accounts: [['globalslop', 87, 2]],
  });
  f.onRuntimeMessage = async () => ({ ok: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id_str: '123', screen_name: 'x' }), { status: 200 })));
  mountFixture('home.html', 'https://x.com/home');
  document.cookie = 'ct0=token; path=/';
  await import('../../src/content/main');
  await frames();
});

describe('timeline re-render', () => {
  it('hides the post again when X removes the cell and puts the same node back', async () => {
    const cell = cellOf('205');
    const parent = cell.parentElement!;
    const next = cell.nextSibling;
    cell.remove();
    await frames();
    parent.insertBefore(cell, next);
    await frames();
    expect(isHidden('205')).toBe(true);
    expect(barText('205')).toBe('Hidden by xslop (score 87)·Show·Not slop');
    expect(articleOf('205').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('puts the collapsed bar back when X drops it and paints something else', async () => {
    expect(isHidden('205')).toBe(true);
    const cell = cellOf('205');
    cell.querySelector(':scope > .xslop-bar')!.remove();
    cell.removeAttribute('data-xslop-cell');
    document.body.append(document.createElement('span'));
    await frames();
    expect(cell.getAttribute('data-xslop-cell')).toBe('collapsed');
    expect(barText('205')).toBe('Hidden by xslop (score 87)·Show·Not slop');
    expect(articleOf('205').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('puts the collapsed bar back when X removes it and adds nothing', async () => {
    const cell = cellOf('205');
    cell.querySelector(':scope > .xslop-bar')!.remove();
    cell.removeAttribute('data-xslop-cell');
    await frames();
    expect(cell.getAttribute('data-xslop-cell')).toBe('collapsed');
    expect(barText('205')).toBe('Hidden by xslop (score 87)·Show·Not slop');
  });

  it('follows the new post when X reuses the article, including a listed account and its quote', async () => {
    expect(isHidden('203')).toBe(false);
    expect(articleOf('203').querySelector('div[role="link"] .xslop-host')).toBeNull();
    await deliver(f, { t: 'votes', set: [['erin', 1]], del: [] }, bg);
    expect(markButton('203')!.getAttribute('aria-pressed')).toBe('true');
    rewriteTweet('203', 'globalslop', '399');
    await frames();
    const button = markButton('399')!;
    expect(articleOf('399').querySelectorAll('.xslop-host')).toHaveLength(1);
    expect(button.getAttribute('aria-label')).toBe('Mark @globalslop as slop');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(isHidden('399')).toBe(true);
    expect(barText('399')).toBe('Hidden by xslop (score 87)·Show·Not slop');
    expect(articleOf('399').querySelector('div[role="link"] .xslop-host')).toBeNull();
  });

  it('keeps one button when a cloned cell still carries the previous button', async () => {
    const live = cellOf('201');
    const cell = live.cloneNode(true) as HTMLElement;
    for (const a of cell.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      if (href.includes('/status/')) a.setAttribute('href', href.replace('/status/201', '/status/401').replace('/dave', '/nina'));
      else if (href === '/dave') a.setAttribute('href', '/nina');
    }
    const at = [...cell.querySelectorAll('[data-testid="User-Name"] a')].find((a) => (a.textContent ?? '').includes('@'));
    if (at) at.textContent = '@nina';
    live.parentElement!.append(cell);
    await frames();
    expect(articleOf('401').querySelectorAll('.xslop-host')).toHaveLength(1);
    expect(markButton('401')!.getAttribute('aria-label')).toBe('Mark @nina as slop');
    expect(articleOf('201').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('adds the button when the time link arrives after many failed reads', async () => {
    const cell = cellOf('201').cloneNode(true) as HTMLElement;
    cell.querySelectorAll('.xslop-host, .xslop-bar').forEach((el) => el.remove());
    cell.removeAttribute('data-xslop-cell');
    const link = cell.querySelector('time')!.closest('a')!;
    link.removeAttribute('href');
    document.querySelector('section')!.append(cell);
    for (let i = 0; i < 31; i++) {
      cell.append(document.createElement('i'));
      await frames(1);
    }
    expect(cell.querySelector('.xslop-host')).toBeNull();
    for (const a of cell.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      if (href.includes('/status/201')) a.setAttribute('href', href.replace('/status/201', '/status/801'));
    }
    link.setAttribute('href', '/dave/status/801');
    cell.append(document.createElement('i'));
    await frames();
    expect(articleOf('801').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('gives no button to a post with no time link, an ad, your own post, or a node that is not a tweet', async () => {
    expect(articleOf('204').querySelector('.xslop-host')).toBeNull();
    expect(articleOf('206').querySelector('.xslop-host')).toBeNull();
    const cell = cellOf('201').cloneNode(true) as HTMLElement;
    cell.querySelectorAll('.xslop-host, .xslop-bar').forEach((el) => el.remove());
    cell.removeAttribute('data-xslop-cell');
    cell.querySelector('time')!.remove();
    const bare = document.createElement('article');
    bare.textContent = 'not a tweet';
    document.body.append(cell, bare);
    await frames();
    expect(cell.querySelector('.xslop-host')).toBeNull();
    expect(bare.querySelector('.xslop-host')).toBeNull();
  });

  it('puts a button on a tweet inside a dialog', async () => {
    const cell = cellOf('201').cloneNode(true) as HTMLElement;
    cell.querySelectorAll('.xslop-host, .xslop-bar').forEach((el) => el.remove());
    cell.removeAttribute('data-xslop-cell');
    for (const a of cell.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      if (href.includes('/status/')) a.setAttribute('href', href.replace('/status/201', '/status/501'));
    }
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.append(cell);
    document.body.append(dialog);
    await frames();
    expect(articleOf('501').querySelectorAll('.xslop-host')).toHaveLength(1);
  });

  it('parses each known article at most once across unrelated updates', async () => {
    const parent = cellOf('201').parentElement!;
    const made: HTMLElement[] = [];
    const mine = new Set<Element>();
    for (let i = 0; i < 40; i++) {
      const id = String(3100 + i);
      const cell = cellOf('201').cloneNode(true) as HTMLElement;
      cell.querySelectorAll('.xslop-host, .xslop-bar').forEach((el) => el.remove());
      cell.removeAttribute('data-xslop-cell');
      for (const a of cell.querySelectorAll('a')) {
        const href = a.getAttribute('href') ?? '';
        if (href.includes('/status/')) a.setAttribute('href', href.replace(/\/status\/\d+/, `/status/${id}`));
      }
      mine.add(cell.querySelector('article')!);
      parent.append(cell);
      made.push(cell);
    }
    const reads = (): number => parsedArticles.all.filter((a) => mine.has(a)).length;
    await frames();
    const knownAt = reads();
    expect(knownAt).toBeLessThanOrEqual(40);
    const buttons = made.map((cell) => {
      const button = cell.querySelector('.xslop-host');
      expect(button).not.toBeNull();
      return button!;
    });
    const origAll = Element.prototype.querySelectorAll;
    let hostScans = 0;
    Element.prototype.querySelectorAll = function (this: Element, selectors: string) {
      if (selectors === ':scope > .xslop-host') hostScans += 1;
      return origAll.call(this, selectors);
    };
    try {
      for (let n = 0; n < 50; n++) {
        const stray = document.createElement('div');
        document.body.append(stray);
        stray.remove();
        made[n % 40]!.append(document.createElement('i'));
        await frames(2);
      }
    } finally {
      Element.prototype.querySelectorAll = origAll;
    }
    expect(reads()).toBe(knownAt);
    expect(reads()).toBeLessThanOrEqual(40);
    expect(hostScans).toBe(0);
    for (const button of buttons) expect(button.isConnected).toBe(true);
    for (const cell of made) cell.remove();
    await frames();
  });
});

describe('page listeners', () => {
  it('keeps one observer and the same page listeners after a long scroll', async () => {
    const hosts = (): number => document.querySelectorAll('.xslop-host').length;
    const beforeHosts = hosts();
    const vis = addedListeners.filter((t) => t === 'visibilitychange').length;
    const focus = addedListeners.filter((t) => t === 'focusin').length;
    const mo = observers;
    const parent = cellOf('201').parentElement!;
    const made: HTMLElement[] = [];
    for (let i = 0; i < 40; i++) {
      const cell = cellOf('201').cloneNode(true) as HTMLElement;
      cell.querySelectorAll('.xslop-host, .xslop-bar').forEach((el) => el.remove());
      cell.removeAttribute('data-xslop-cell');
      const id = String(1100 + i);
      for (const a of cell.querySelectorAll('a')) {
        const href = a.getAttribute('href') ?? '';
        if (href.includes('/status/')) a.setAttribute('href', href.replace(/\/status\/\d+/, `/status/${id}`));
        if (href === '/dave' || href.startsWith('/dave/')) a.setAttribute('href', href.replace('/dave', '/scrollbot'));
      }
      const at = [...cell.querySelectorAll('[data-testid="User-Name"] a')].find((a) => (a.textContent ?? '').includes('@'));
      if (at) at.textContent = '@scrollbot';
      parent.append(cell);
      made.push(cell);
    }
    await frames(2);
    expect(hosts()).toBe(beforeHosts + 40);
    for (const cell of made) cell.remove();
    await frames(2);
    expect(hosts()).toBe(beforeHosts);
    expect(document.querySelectorAll('.xslop-bar').length).toBe(document.querySelectorAll('[data-xslop-cell="collapsed"], [data-xslop-article="collapsed"]').length);
    expect(observers).toBe(mo);
    expect(addedListeners.filter((t) => t === 'visibilitychange').length).toBe(vis);
    expect(addedListeners.filter((t) => t === 'focusin').length).toBe(focus);
  });
});

describe('vote stamps', () => {
  it('sends a lost vote again before the next vote, and the first send starts in the click', async () => {
    const votes: { n: number; handle: string }[] = [];
    let failOnce = true;
    const runtime = f.api.runtime;
    const orig = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (async (msg: unknown) => {
      const m = msg as { t?: string; n?: number; handle?: string };
      if (m.t === 'vote' || m.t === 'unvote') votes.push({ n: m.n ?? -1, handle: String(m.handle) });
      if (m.t === 'vote' && failOnce) {
        failOnce = false;
        throw new Error('asleep');
      }
      return orig(msg);
    }) as typeof runtime.sendMessage;
    try {
      trustedClick(markButton('201')!);
      expect(votes.map((v) => v.handle)).toEqual(['dave']);
      // The lost answer is seen on the next task. A second click is that later task.
      await Promise.resolve();
      await Promise.resolve();
      trustedClick(markButton('202')!);
      expect(votes.map((v) => v.handle)).toEqual(['dave']);
      await new Promise((r) => setTimeout(r, 500));
      expect(votes.map((v) => v.handle)).toEqual(['dave', 'dave', 'slopbot']);
      expect(votes[0]!.n).toBe(votes[1]!.n);
      expect(votes[2]!.n).toBeGreaterThan(votes[0]!.n);
      expect(barText('202')).toBe('Hidden reply from @slopbot·Show·Undo');
    } finally {
      runtime.sendMessage = orig;
    }
  });

  it('Show keeps that post open, and the marked button undoes the mark', () => {
    trustedClick(barButton('201', 'Show'));
    expect(isHidden('201')).toBe(false);
    expect(markButton('201')!.getAttribute('aria-pressed')).toBe('true');
    const before = sentOf('unvote').length;
    trustedClick(markButton('201')!);
    expect(isHidden('201')).toBe(false);
    expect(sentOf('unvote').length).toBe(before + 1);
    expect(markButton('201')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('toasts', () => {
  it('a second toast replaces the first, and only the new Undo runs', async () => {
    const { showToast } = await import('../../src/content/toast');
    let first = 0;
    let second = 0;
    showToast('Muted @one on X', () => { first += 1; });
    showToast('Muted @two on X', () => { second += 1; });
    expect(toastText()).toBe('Muted @two on X');
    trustedClick(toastUndo());
    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('Undo on the toast does nothing after it hides while the tab is in the background', async () => {
    const { showToast } = await import('../../src/content/toast');
    let ran = 0;
    showToast('Muted @dave on X', () => { ran += 1; });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 6200));
    trustedClick(toastUndo());
    expect(ran).toBe(0);
    expect(toastText()).toBe('');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
});

describe('onboarding', () => {
  async function open(setup: (x: FakeChrome) => void = () => undefined): Promise<void> {
    vi.resetModules();
    const g = fakeChrome();
    (globalThis as { chrome?: typeof chrome }).chrome = g.api;
    setup(g);
    const body = new DOMParser().parseFromString(ONBOARDING.slice(ONBOARDING.indexOf('<body')), 'text/html').body;
    document.body.replaceChildren(...[...body.childNodes].map((n) => document.importNode(n, true)));
    await import('../../src/onboarding/onboarding');
    await vi.waitFor(() => expect(document.getElementById('step-now')!.textContent).toBe('1'));
  }

  it('a reload keeps the consent you stored and starts again at step 1', async () => {
    await open((x) => x.local.set('settings', { ...DEFAULT_SETTINGS, share: true, muteOnMark: false }));
    expect((document.getElementById('mute-mark') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('share') as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById('step-2')!.hidden).toBe(true);
    document.querySelector('#step-1 .next')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('step-2')!.hidden).toBe(false);
    expect(document.getElementById('step-now')!.textContent).toBe('2');
    await open((x) => x.local.set('settings', { ...DEFAULT_SETTINGS, share: true, muteOnMark: false }));
    expect(document.getElementById('step-1')!.hidden).toBe(false);
    expect(document.getElementById('step-now')!.textContent).toBe('1');
    expect((document.getElementById('share') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('mute-mark') as HTMLInputElement).checked).toBe(false);
  });

  it('step 2 does not say both extras are off when you already turned one on', async () => {
    await open((x) => x.local.set('settings', { ...DEFAULT_SETTINGS, share: true }));
    document.querySelector('#step-1 .next')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect((document.getElementById('share') as HTMLInputElement).checked).toBe(true);
    const heading = document.querySelector('#step-2 h1')!.textContent ?? '';
    expect(heading.toLowerCase()).not.toContain('both off');
  });
});
