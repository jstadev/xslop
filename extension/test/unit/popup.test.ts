// @vitest-environment happy-dom
// The popup (SPEC 12.7): state at a glance, your accounts with one-tap undo, plain settings, honest notices.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { DEFAULT_SETTINGS, EMPTY_MUTE, type Vote } from '../../src/shared/types';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/popup/popup.html'), 'utf8');
const vote = (h: string, at: number, v: 0 | 1 = 1): Vote => ({ h, v, at, tweetId: '1', parentTweetId: null, postedAt: null, context: 'reply' });
let f: FakeChrome;

async function open(setup: (f: FakeChrome) => void = () => undefined): Promise<void> {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  setup(f);
  // Only the body: the head links stylesheets that happy-dom does not load.
  const body = new DOMParser().parseFromString(HTML.slice(HTML.indexOf('<body')), 'text/html').body;
  document.body.replaceChildren(...[...body.childNodes].map((n) => document.importNode(n, true)));
  await import('../../src/popup/popup');
  await vi.waitFor(() => expect(document.getElementById('headline')!.textContent).not.toBe(''));
}

const text = (id: string): string => document.getElementById(id)!.textContent ?? '';
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#votes li')];
const unvotes = (): unknown[] => f.sent.filter((m) => (m as { t: string }).t === 'unvote');

beforeEach(() => open());

describe('state at a glance', () => {
  it('shows what xslop did today from storage, and hides the notices when all is well', async () => {
    await open((x) => {
      x.local.set('stats', { day: new Date().toLocaleDateString('sv'), hidden: 3 });
      x.local.set('list', { version: 7, generatedAt: '', etag: null, accounts: [['a', 90, 2], ['b', 80, 2]] });
      x.local.set('votes', [vote('x', 1), vote('y', 2), vote('z', 3, 0)]);
    });
    expect(text('headline')).toBe('Hiding');
    expect(text('stat-hidden')).toBe('3');
    expect(text('stat-list')).toBe('2');
    expect(text('stat-mine')).toBe('2');
    expect(rows().length).toBe(3);
    expect(document.getElementById('notices')!.children.length).toBe(0);
  });

  it('says X login missing when the last X call found no session', async () => {
    await open((x) => {
      x.local.set('list', { version: 1, generatedAt: '', etag: null, accounts: [] });
      x.local.set('mute', { ...EMPTY_MUTE, waiting: 'login' });
    });
    expect(text('headline')).toBe('X login missing');
    expect(text('notices')).toContain('not logged in to x.com');
  });

  it('names a running pause and when it ends', async () => {
    await open((x) => {
      x.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
      x.local.set('mute', { ...EMPTY_MUTE, pausedUntil: Date.now() + 3_600_000, reason: 'X answered 429 (too many requests).' });
    });
    expect(text('mute-state')).toContain('X answered 429');
    expect(text('mute-state')).toContain('It starts again at');
  });

  it('R2-6 says that an unmute runs now when the mutes of today are used up, and that a mute waits', async () => {
    const day = new Date().toLocaleDateString('sv');
    await open((x) => {
      x.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
      x.local.set('votes', [vote('a', 1)]);
      x.local.set('mute', { ...EMPTY_MUTE, day, count: 40, muted: [['gone', { at: 1, id: '7' }]] });
    });
    expect(text('mute-state')).toBe('1 account muted by xslop. 0 mutes left today. Next unmute now.');
    await open((x) => {
      x.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
      x.local.set('votes', [vote('a', 1)]);
      x.local.set('mute', { ...EMPTY_MUTE, day, count: 39 });
    });
    expect(text('mute-state')).toBe('1 mute left today. Next mute now.');
    await open((x) => {
      x.local.set('settings', { ...DEFAULT_SETTINGS, mute: true });
      x.local.set('votes', [vote('a', 1)]);
      x.local.set('mute', { ...EMPTY_MUTE, day, count: 40 });
    });
    expect(text('mute-state')).toMatch(/^0 mutes left today\. Next mute at \d/);
  });

  it('asks for a tab when work waits for one', async () => {
    await open((x) => x.local.set('mute', { ...EMPTY_MUTE, waiting: 'tab' }));
    expect(text('mute-state')).toBe('Open x.com in a tab so that xslop can finish the change on X.');
  });

  it('says why mute sync stopped and counts the mutes that xslop could not undo', async () => {
    await open((x) => {
      x.local.set('votes', [vote('a', 1)]);
      x.local.set('mute', {
        ...EMPTY_MUTE, lost: 2, muted: [['a', { at: 1, id: '7' }]],
        reason: 'You mute too many accounts on X for xslop to check them all, so mute sync is off.',
      });
    });
    expect(text('mute-state')).toBe(
      'You mute too many accounts on X for xslop to check them all, so mute sync is off. 1 account muted by xslop. ' +
      'xslop could not undo 2 mutes because it has no X user id for them. Check your muted accounts in the X settings.',
    );
  });
});

describe('your standing (SPEC 13.8)', () => {
  const status = (o: object) => ({ banned: false, updateNeeded: false, installError: null, listAt: 0, standing: null, meAt: 0, ...o });
  const line = (): HTMLElement => document.getElementById('standing')!;

  it('says that your marks count once the server says that you have standing', async () => {
    await open((x) => x.local.set('status', status({ standing: true })));
    expect(line().hidden).toBe(false);
    expect(line().textContent).toBe('Your marks count for the shared list.');
  });

  it('says what your marks do without standing, and states no number', async () => {
    await open((x) => x.local.set('status', status({ standing: false })));
    expect(line().textContent).toBe(
      'Your marks hide and mute for you now. They count for the shared list after a check, or once your install is old enough and has enough approved marks.',
    );
    expect(line().textContent).not.toMatch(/[0-9]/);
    await open((x) => {
      x.local.set('status', status({ standing: false }));
      x.local.set('settings', { ...DEFAULT_SETTINGS, muteOnMark: false });
    });
    expect(line().textContent).toMatch(/^Your marks hide for you now\. /);
  });

  it('says nothing until the server answered, on an older server, and for a banned install', async () => {
    for (const o of [{}, { standing: null }, { standing: true, banned: true }]) {
      await open((x) => x.local.set('status', status(o)));
      expect([o, line().hidden, line().textContent]).toEqual([o, true, '']);
    }
  });

  it('follows a change of standing while the popup is open', async () => {
    await open((x) => x.local.set('status', status({ standing: false })));
    await f.api.storage.local.set({ status: status({ standing: true }) });
    await vi.waitFor(() => expect(line().textContent).toBe('Your marks count for the shared list.'));
  });
});

describe('links', () => {
  it('R2-6 the appeal link goes to the /check page, not to the old /#appeal anchor', () => {
    const links = [...document.querySelectorAll('footer a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['How xslop works', 'onboarding.html'], ['Appeal a listing', 'https://x-slop.com/check']]);
    expect(HTML).not.toContain('#appeal');
  });
});

describe('your accounts', () => {
  const setup = (x: FakeChrome): void => {
    x.local.set('votes', [vote('newest', 3), vote('older', 2), vote('friend', 1, 0)]);
    x.local.set('mute', { ...EMPTY_MUTE, muted: [['newest', { at: 3, id: '7' }]], retry: [['older', Date.now()]] });
  };

  it('lists your accounts newest first, with the state of each mute', async () => {
    await open(setup);
    expect(rows().map((r) => r.querySelector('a')!.textContent)).toEqual(['@newest', '@older', '@friend']);
    expect(rows().map((r) => r.querySelector('.tag')!.textContent)).toEqual(['Muted on X', 'Mute waits', 'Not slop']);
  });

  it('one tap undoes a mark, offers to take the undo back, and moves focus', async () => {
    await open(setup);
    rows()[0]!.querySelector('button')!.click();
    await vi.waitFor(() => expect(unvotes()).toEqual([{ t: 'unvote', handle: 'newest' }]));
    expect(text('toast-msg')).toBe('Removed @newest.');
    expect(document.activeElement?.id).toBe('toast-undo');
    document.getElementById('toast-undo')!.click();
    await vi.waitFor(() => expect(f.sent.some((m) => (m as { t: string }).t === 'restore')).toBe(true));
    expect((document.getElementById('toast') as HTMLElement).hidden).toBe(true);
  });

  it('every row button has an accessible name', async () => {
    await open(setup);
    expect(rows()[0]!.querySelector('button')!.getAttribute('aria-label')).toBe('Undo your mark on @newest');
  });

  it('filters by search and keeps focus while a storage change updates a row', async () => {
    await open(setup);
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = '@old';
    search.dispatchEvent(new Event('input'));
    expect(rows().map((r) => r.dataset.handle)).toEqual(['older']);
    const button = rows()[0]!.querySelector('button')!;
    button.focus();
    f.local.set('mute', { ...EMPTY_MUTE, muted: [['older', { at: 3, id: '8' }]] });
    await f.api.storage.local.set({ mute: { ...EMPTY_MUTE, muted: [['older', { at: 3, id: '8' }]] } });
    await vi.waitFor(() => expect(rows()[0]!.querySelector('.tag')!.textContent).toBe('Muted on X'));
    expect(document.activeElement).toBe(button);
  });

  it('says so when nothing matches, and when the list is empty', async () => {
    expect(text('empty')).toContain('Your list is empty');
    await open(setup);
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = 'nobody';
    search.dispatchEvent(new Event('input'));
    expect(text('empty')).toBe('No account on your list matches.');
  });
});

describe('settings', () => {
  it('sends the switches and the radios as settings patches', async () => {
    const mark = document.getElementById('mute-mark') as HTMLInputElement;
    expect(mark.checked).toBe(true);
    mark.checked = false;
    mark.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.sent).toContainEqual({ t: 'settings', patch: { muteOnMark: false } }));
    const strict = document.querySelector<HTMLInputElement>('input[name="strictness"][value="strict"]')!;
    strict.checked = true;
    strict.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.sent).toContainEqual({ t: 'settings', patch: { strictness: 'strict' } }));
  });

  it('keeps both updates when two storage changes overlap, so a switch never shows a stale value', async () => {
    void f.api.storage.local.set({ settings: { ...DEFAULT_SETTINGS, muteOnMark: false } });
    void f.api.storage.local.set({ votes: [vote('a', 1)] });
    await vi.waitFor(() => expect(rows().length).toBe(1));
    expect((document.getElementById('mute-mark') as HTMLInputElement).checked).toBe(false);
  });

  it('explains each hide level in plain words', async () => {
    expect(text('strict-hint')).toBe('Hides confirmed slop accounts and the accounts that you marked.');
    expect(text('display-hint')).toBe('A hidden post stays as one line that you can open.');
  });

  it('asks once for host access when the browser left it off, with a real button', async () => {
    await open((x) => {
      x.granted = false;
    });
    const box = document.getElementById('access')!;
    await vi.waitFor(() => expect(box.hidden).toBe(false));
    const request = vi.fn(async () => true);
    (f.api.permissions as unknown as { request: typeof request }).request = request;
    document.getElementById('access-grant')!.click();
    await vi.waitFor(() => expect(box.hidden).toBe(true));
    expect(request.mock.calls[0]![0 as never]).toEqual({ origins: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'http://127.0.0.1:9/*'] });
  });

  it('tells you to use the browser settings when the browser cannot ask', async () => {
    await open((x) => {
      x.granted = false;
    });
    await vi.waitFor(() => expect(document.getElementById('access')!.hidden).toBe(false));
    (f.api.permissions as unknown as { request: () => Promise<boolean> }).request = () => Promise.reject(new Error('not supported'));
    document.getElementById('access-grant')!.click();
    await vi.waitFor(() => expect(document.getElementById('access-help')!.hidden).toBe(false));
  });
});
