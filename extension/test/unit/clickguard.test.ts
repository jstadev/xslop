// @vitest-environment happy-dom
// The page cannot read or steal xslop's controls (finding 7): closed shadow roots, and a click
// counts only when it is real, the button is in its own action bar, and the button is visible.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeChrome, trustedClick, type FakeChrome } from '../helpers/chrome';
import { articleOf, barButton, cellOf, frames, isHidden, markButton, mountFixture } from '../helpers/dom';

let f: FakeChrome;
const votesFor = (h: string) => f.sent.filter((m) => (m as { t: string; handle?: string }).t === 'vote' && (m as { handle: string }).handle === h);
const hostOf = (id: string) => articleOf(id).querySelector<HTMLElement>('.xslop-host')!;

beforeAll(async () => {
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  f.local.set('list', { version: 1, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"1"', accounts: [['globalslop', 87, 2]] });
  f.local.set('votes', [{ h: 'slopbot', v: 1, at: 1, tweetId: '101', parentTweetId: null, postedAt: null, context: 'reply' }]);
  mountFixture('status.html', 'https://x.com/alice/status/100');
  await import('../../src/content/main');
  await frames();
});

describe('xslop controls in the page', () => {
  it('F7 regression: page scripts cannot open the shadow roots or read your votes', () => {
    const hosts = [...document.querySelectorAll('.xslop-host, .xslop-bar')];
    expect(hosts.length).toBeGreaterThan(5);
    for (const h of hosts) expect(h.shadowRoot).toBeNull();
    expect(isHidden('101')).toBe(true);
    expect(document.body.textContent).not.toContain('Hidden reply from @slopbot');
    expect(document.body.textContent).not.toContain('Unmark @');
  });

  it('F7 regression: ignores a real click on a button that the page moved out of its action bar', () => {
    const host = hostOf('102');
    const button = markButton('102')!;
    const bar = host.parentElement!;
    document.body.append(host);
    trustedClick(button);
    expect(votesFor('human_dev')).toEqual([]);
    bar.append(host);
    trustedClick(button);
    expect(votesFor('human_dev')).toHaveLength(1);
  });

  it('F7 regression: ignores a real click on a button hidden by opacity or visibility inside the tweet', () => {
    const host = hostOf('105');
    const button = markButton('105')!;
    articleOf('105').style.opacity = '0.1';
    trustedClick(button);
    host.parentElement!.style.visibility = 'hidden';
    articleOf('105').style.opacity = '';
    trustedClick(button);
    host.parentElement!.style.visibility = '';
    host.style.opacity = '0';
    trustedClick(button);
    expect(votesFor('flaggedone')).toEqual([]);
    host.style.opacity = '';
    trustedClick(button);
    expect(votesFor('flaggedone')).toHaveLength(1);
  });

  it('F5 regression: ignores a real click when the page makes an ancestor of the tweet invisible', () => {
    const cell = cellOf('109');
    cell.style.opacity = '0';
    trustedClick(markButton('109')!);
    expect(votesFor('photoguy')).toEqual([]);
    cell.style.opacity = '';
    trustedClick(markButton('109')!);
    expect(votesFor('photoguy')).toHaveLength(1);
  });

  it('F7 regression: ignores a real click on a button without a size', () => {
    vi.spyOn(hostOf('108'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0));
    trustedClick(markButton('108')!);
    expect(votesFor('quoter')).toEqual([]);
  });

  it('F7 regression: ignores "Not slop" on a bar that the page made invisible', () => {
    const cell = cellOf('104');
    cell.style.opacity = '0';
    trustedClick(barButton('104', 'Not slop'));
    expect(votesFor('globalslop')).toEqual([]);
    cell.style.opacity = '';
    trustedClick(barButton('104', 'Not slop'));
    expect(votesFor('globalslop')).toMatchObject([{ value: 'not_slop' }]);
  });
});
