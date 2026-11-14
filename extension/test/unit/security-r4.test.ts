// @vitest-environment happy-dom
// Security round 4. Each test below failed on the code it names, then passed after the fix.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTweet } from '../../src/content/parse';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import type { Vote, VoteBody } from '../../src/shared/types';
import { deliver, fakeChrome, trustedClick, type FakeChrome } from '../helpers/chrome';
import { articleOf, barButton, frames, markButton, mountFixture, parseFixture } from '../helpers/dom';

const sel = DEFAULT_CONFIG.selectors;
const page = parseFixture('status.html');

function reply(): HTMLElement {
  const all = [...page.querySelectorAll<HTMLElement>(sel.article)];
  const found = all.find((a) => [...a.querySelectorAll('time')].some((t) => t.closest('a[href$="/status/101"]')))!;
  return found.cloneNode(true) as HTMLElement;
}

function headerOf(a: HTMLElement): HTMLElement {
  return a.querySelector('[data-testid="User-Name"]')!;
}

describe('a planted profile link cannot name the author', () => {
  it('skips a hidden profile link planted in front of the real @handle', () => {
    const a = reply();
    headerOf(a).insertAdjacentHTML('afterbegin', '<a href="/victim" style="display:none">@victim</a>');
    expect(parseTweet(a, sel)?.handle).toBe('slopbot');
    const hidden = reply();
    headerOf(hidden).insertAdjacentHTML('afterbegin', '<a href="/victim" hidden>@victim</a>');
    expect(parseTweet(hidden, sel)?.handle).toBe('slopbot');
    const wrapped = reply();
    headerOf(wrapped).insertAdjacentHTML('afterbegin', '<span style="visibility:hidden"><a href="/victim">@victim</a></span>');
    expect(parseTweet(wrapped, sel)?.handle).toBe('slopbot');
  });

  it('returns no author when a second visible @handle disagrees', () => {
    const a = reply();
    headerOf(a).insertAdjacentHTML('afterbegin', '<a href="/victim">@victim</a>');
    expect(parseTweet(a, sel)).toBeNull();
  });

  it('returns no author when the outer avatar names a different account', () => {
    const a = reply();
    const avatar = a.querySelector('[data-testid="Tweet-User-Avatar"] a');
    expect(avatar).not.toBeNull();
    avatar!.setAttribute('href', '/victim');
    expect(parseTweet(a, sel)).toBeNull();
  });

  it('reads a header whose link text is the handle with no @ sign', () => {
    const a = document.createElement('article');
    a.innerHTML = '<div data-testid="User-Name"><a href="/lim0">lim0</a></div><a href="/lim0/status/5000"><time datetime="2026-11-07T09:10:00.000Z"></time></a>';
    expect(parseTweet(a, sel)?.handle).toBe('lim0');
  });

  it('skips an @handle whose text does not match its href', () => {
    const a = reply();
    headerOf(a).insertAdjacentHTML('afterbegin', '<a href="/slopbot">@victim</a>');
    expect(parseTweet(a, sel)?.handle).toBe('slopbot');
  });
});

describe('storage.local writes of one key land in order', () => {
  let f: FakeChrome;

  beforeEach(async () => {
    vi.resetModules();
    f = fakeChrome();
    (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  });

  it('keeps the later votes when an earlier write of that key finishes last', async () => {
    const { save, state } = await import('../../src/bg/store');
    await state();
    const slots: Array<() => void> = [];
    const orig = f.api.storage.local.set.bind(f.api.storage.local);
    f.api.storage.local.set = (obj: Record<string, unknown>) => new Promise<void>((resolve) => {
      slots.push(() => {
        void orig(obj).then(() => resolve());
      });
    });
    const vote: Vote = { h: 'slopbot', v: 1, at: 1, tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' };
    const first = save('votes', [vote]);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const second = save('votes', []);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    if (slots.length >= 2) {
      slots[1]!();
      await Promise.resolve();
      slots[0]!();
    } else {
      expect(slots).toHaveLength(1);
      slots[0]!();
      for (let i = 0; i < 8 && slots.length < 2; i++) await Promise.resolve();
      expect(slots).toHaveLength(2);
      slots[1]!();
    }
    await Promise.all([first, second]);
    expect(f.local.get('votes')).toEqual([]);
  });
});

describe('a resent vote does not undo an undo', () => {
  let f: FakeChrome;
  const content = { id: 'xslop-test-id', tab: { id: 4 } as chrome.tabs.Tab, url: 'https://x.com/alice/status/100' };
  const popup = { id: 'xslop-test-id', url: 'chrome-extension://xslop-test-id/popup.html' };
  const S = '11111111-1111-4111-8111-111111111111';
  const vote = (n: number) => ({
    t: 'vote', handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply', n, s: S,
  });
  const unvote = (n: number) => ({ t: 'unvote', handle: 'slopbot', n, s: S });
  const queued: string[] = [];

  async function boot(): Promise<void> {
    vi.resetModules();
    vi.doMock('../../src/bg/idb', () => ({
      idbGet: async () => undefined,
      idbSet: async () => undefined,
    }));
    vi.doMock('../../src/bg/outbox', () => ({
      OUTBOX_ALARM: 'outbox',
      enqueueVote: async (b: VoteBody) => {
        queued.push(`vote:${b.handle}`);
      },
      enqueueDelete: async (h: string) => {
        queued.push(`del:${h}`);
      },
      enqueueObservations: async () => undefined,
      flush: async () => undefined,
      flushDue: async () => undefined,
      obsConsent: async () => true,
    }));
    await import('../../src/background');
  }

  beforeEach(async () => {
    queued.length = 0;
    f = fakeChrome();
    (globalThis as { chrome?: typeof chrome }).chrome = f.api;
    await boot();
  });

  const votes = () => ((f.local.get('votes') as Vote[] | undefined) ?? []).map((v) => v.h);

  it('drops a resent mark after the undo from the same script', async () => {
    expect(await deliver(f, vote(1), content)).toEqual({ ok: true });
    expect(await deliver(f, unvote(2), content)).toEqual({ ok: true });
    expect(await deliver(f, vote(1), content)).toEqual({ ok: true });
    expect(votes()).toEqual([]);
    expect(queued.filter((q) => q === 'vote:slopbot')).toEqual(['vote:slopbot']);
    expect(await deliver(f, vote(3), content)).toEqual({ ok: true });
    expect(votes()).toEqual(['slopbot']);
  });

  it('drops that resent mark after the worker restarts', async () => {
    await deliver(f, vote(1), content);
    await deliver(f, unvote(2), content);
    expect(votes()).toEqual([]);
    f.messageListeners.length = 0;
    await boot();
    expect(await deliver(f, vote(1), content)).toEqual({ ok: true });
    expect(votes()).toEqual([]);
    expect(queued.filter((q) => q === 'vote:slopbot')).toEqual(['vote:slopbot']);
  });

  it('still applies an unvote from the popup, which has no action stamp', async () => {
    await deliver(f, vote(1), content);
    expect(await deliver(f, { t: 'unvote', handle: 'slopbot' }, popup)).toEqual({ ok: true });
    expect(votes()).toEqual([]);
  });
});

describe('the content script resends one action with the same stamp', () => {
  let f: FakeChrome;

  beforeAll(async () => {
    vi.resetModules();
    f = fakeChrome();
    (globalThis as { chrome?: typeof chrome }).chrome = f.api;
    let rejected = false;
    f.onRuntimeMessage = async (msg: { t?: string }) => {
      if (msg.t === 'vote' && !rejected) {
        rejected = true;
        throw new Error('Receiving end does not exist');
      }
      return { ok: true };
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id_str: '123', screen_name: 'x' }), { status: 200 })));
    mountFixture('status.html', 'https://x.com/alice/status/100');
    document.cookie = 'ct0=abc; path=/';
    await import('../../src/content/main');
    await frames();
  });
  afterAll(() => vi.unstubAllGlobals());

  it('keeps n and s when Firefox drops the answer, and the undo uses a higher n', async () => {
    vi.useFakeTimers();
    trustedClick(markButton('101')!);
    trustedClick(barButton('101', 'Undo'));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    const votes = f.sent.filter((m) => (m as { t: string }).t === 'vote') as { n: number; s: string }[];
    const unvotes = f.sent.filter((m) => (m as { t: string }).t === 'unvote') as { n: number; s: string }[];
    expect(votes).toHaveLength(2);
    expect(votes[0]).toBe(votes[1]);
    expect(votes[0]!.n).toBeGreaterThanOrEqual(1);
    expect(votes[0]!.s).toMatch(/^[0-9a-f-]{36}$/i);
    expect(unvotes[0]!.s).toBe(votes[0]!.s);
    expect(unvotes[0]!.n).toBeGreaterThan(votes[0]!.n);
  });
});

describe('a stored outbox of the wrong shape does not throw', () => {
  let f: FakeChrome;

  beforeEach(async () => {
    vi.resetModules();
    f = fakeChrome();
    (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  });

  it('reads a non-array ops or obs as empty and skips a non-object entry', async () => {
    f.local.set('outbox', { ops: 'nope', obs: {}, attempt: 1, nextAt: 0, seq: 3, lastError: null });
    const { readStored } = await import('../../src/shared/storage');
    const broken = await readStored(['outbox']);
    expect(broken.outbox.ops).toEqual([]);
    expect(broken.outbox.obs).toEqual([]);
    expect(broken.outbox.seq).toBe(3);
    const kept = { seq: 2, h: 'gone', k: 'del' };
    f.local.set('outbox', { ops: [1, kept], obs: [4, { handle: 'slopbot', tweetId: '101', parentTweetId: '100' }], attempt: 0, nextAt: 0, seq: 2, lastError: null });
    const mixed = await readStored(['outbox']);
    expect(mixed.outbox.ops).toEqual([kept]);
    expect(mixed.outbox.obs).toEqual([{ handle: 'slopbot', tweetId: '101', parentTweetId: '100' }]);
  });
});

describe('action stamps', () => {
  it('accepts a vote with both fields and rejects a stamp that is only half present', async () => {
    const { parseContentMsg, parsePageMsg } = await import('../../src/shared/messages');
    const vote = { t: 'vote', handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: null, postedAt: null, context: 'reply' };
    const s = '11111111-1111-4111-8111-111111111111';
    expect(parseContentMsg({ ...vote, n: 1, s })).toMatchObject({ t: 'vote', handle: 'slopbot', n: 1, s });
    expect(parseContentMsg(vote)).toMatchObject({ t: 'vote', handle: 'slopbot' });
    expect(parseContentMsg({ ...vote, n: 1 })).toBeNull();
    expect(parseContentMsg({ ...vote, s })).toBeNull();
    expect(parseContentMsg({ ...vote, n: 0, s })).toBeNull();
    expect(parseContentMsg({ ...vote, n: 1, s: 'nope' })).toBeNull();
    expect(parsePageMsg({ t: 'unvote', handle: 'slopbot', n: 1, s })).toBeNull();
  });
});
