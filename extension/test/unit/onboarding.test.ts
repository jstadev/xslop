// @vitest-environment happy-dom
// The onboarding tab (SPEC 12.7): three steps, the first says what a click does; the opt-ins can be declined.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/onboarding/onboarding.html'), 'utf8');
let f: FakeChrome;

beforeEach(async () => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  const body = new DOMParser().parseFromString(HTML.slice(HTML.indexOf('<body')), 'text/html').body;
  document.body.replaceChildren(...[...body.childNodes].map((n) => document.importNode(n, true)));
  await import('../../src/onboarding/onboarding');
  await vi.waitFor(() => expect((document.getElementById('mute-mark') as HTMLInputElement).checked).toBe(true));
});

const step = (n: number): HTMLElement => document.getElementById(`step-${n}`)!;
const visible = (): number[] => [1, 2, 3].filter((n) => !step(n).hidden);
const click = (el: Element | null): void => (el as HTMLElement).click();

describe('onboarding', () => {
  it('step one says what one click does: hides, mutes on X, adds one vote', () => {
    expect(visible()).toEqual([1]);
    const text = step(1).textContent!;
    expect(text).toContain('Hides it');
    expect(text).toContain('Mutes it on X');
    expect(text).toContain('Adds a vote');
    // SPEC 13.1: the votes of a new install list nothing by themselves.
    expect(text).toContain('The shared list counts it after a check.');
    expect(text).not.toContain('Enough votes put it on the shared list.');
  });

  it('moves through three steps and back, focusing each heading and filling the progress bar', () => {
    const bars = () => [...document.querySelectorAll('.progress span')].map((b) => b.classList.contains('on'));
    expect(bars()).toEqual([true, false, false]);
    click(step(1).querySelector('.next'));
    expect(visible()).toEqual([2]);
    expect(bars()).toEqual([true, true, false]);
    expect(document.activeElement).toBe(step(2).querySelector('h1'));
    expect(document.getElementById('step-now')!.textContent).toBe('2');
    click(step(2).querySelector('.next'));
    expect(visible()).toEqual([3]);
    click(step(3).querySelector('.back'));
    expect(visible()).toEqual([2]);
  });

  it('keeps every opt-in off until you turn it on, and instant mute can be declined', async () => {
    expect((document.getElementById('share') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('mute') as HTMLInputElement).checked).toBe(false);
    const mark = document.getElementById('mute-mark') as HTMLInputElement;
    mark.checked = false;
    mark.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.sent).toContainEqual({ t: 'settings', patch: { muteOnMark: false } }));
  });

  it('shows the daily mute limit of the current config', () => {
    expect(document.getElementById('mute-max')!.textContent).toBe('40');
  });

  it('R2-5, R2-6 says that the account page links to your marked posts once checked, and links to /check for an appeal', () => {
    const text = step(3).textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('The account page on x-slop.com can link these posts after the server checks the author.');
    const links = [...step(3).querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('rel')]);
    expect(links).toEqual([['https://x-slop.com/check', 'noopener']]);
    expect(HTML).not.toContain('#appeal');
  });

  it('SPEC 13.8 step 3 names every field that a signal and a vote carry, and no field of an older build; the switch hints stay one short line', () => {
    const popup = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/popup/popup.html'), 'utf8');
    const details = step(3).textContent!.replace(/\s+/g, ' ');
    // One phrase for each field of an Observation (shared/types.ts): handle, tweetId, parentTweetId.
    expect(details).toContain('For each reply on a post page you open: its handle, its post id and the id of the post it answers. The server does not store which install sent a signal.');
    for (const old of ['word fingerprint', 'wording scores', 'the length', 'verified badge', 'times']) expect(`${details} ${popup}`).not.toContain(old);
    // EXT-3 regression: one phrase for each field of a VoteBody (shared/types.ts): value, handle, tweetId, context, parentTweetId, postedAt.
    expect(details).toContain('Slop or not slop, the handle, the post id, reply or post, the id of the post it answers, and the post time. Never the text.');
    // The registration (POST /api/v1/installs) sends the public key and extVersion.
    expect(details).toContain('Registration sends its public part and the xslop version.');
    const hint = 'Reply handles and post ids. Nothing else.';
    expect(step(2).textContent).toContain(hint);
    expect(popup).toContain(hint);
  });

  it('opens x.com when you finish', () => {
    click(document.getElementById('done'));
    expect(f.tabUpdates).toEqual([{ url: 'https://x.com/home' }]);
  });
});
