// One click, end to end: a real Chromium with the extension loaded. x.com and its API are routed here;
// X's menu is a stand-in with X's markup. No test calls the real x.com or uses a real X account.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MockApi, defaultConfig } from '../mock-server';
import { CT0, LIMIT_PAGE_TWEETS, X_IDS, cellOf, fixturePage, launchExtension, openPage, routeX, tweet, type Extension, type XAnswer, type XCallLog } from './support';

const BEARER = (defaultConfig().mute as { webBearer: string }).webBearer;
const REPLY_STATUS = '/alice/status/100';
/** X's own atomic rules for the tweet column and the action cells. The fixture's short style sheet leaves both content-sized. */
const X_ROW_RULES = `.css-175oi2r { min-width: 0; position: relative; z-index: 0 } .r-16y2uox { flex-grow: 1 } .r-13awgt0 { flex: 1 1 0 }
  .r-1udh08x { overflow: hidden } .r-1xvli5t { height: 1.25em }`;

let api: MockApi;
let extension: Extension;
let ctx: BrowserContext;
const calls: XCallLog[] = [];
const answers: XAnswer[] = [];

const creates = (screenName: string) => calls.filter((c) => c.op === 'create' && new URLSearchParams(c.body).get('screen_name') === screenName);
const button = (page: Page, id: string) => tweet(page, id).locator('.xslop-host button');
const toast = (page: Page) => page.locator('.xslop-toast [role="status"]');
const toastUndo = (page: Page) => page.locator('.xslop-toast button');
const menuClicks = (page: Page) => page.evaluate(() => (window as unknown as { __xMenuClicks: string[] }).__xMenuClicks);
const stored = <T>(key: string): Promise<T> => extension.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
const open = (path: string): Promise<Page> => openPage(ctx, path);

/** The status page as X's phone layout draws it: no profile link, only your avatar in the header. */
async function openPhone(avatar: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 800 });
  const body = await fixturePage('status.html', (html) => html.replace(
    /<a [^>]*AppTabBar_Profile_Link[^>]*>.*?<\/a>/s,
    `<button type="button" data-testid="DashButton_ProfileIcon_Link"><div data-testid="UserAvatar-Container-${avatar}"></div></button>`,
  ));
  await page.route(`https://x.com${REPLY_STATUS}`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
  await page.goto(`https://x.com${REPLY_STATUS}`);
  return page;
}

test.beforeAll(async () => {
  api = new MockApi({ difficulty: 12, list: [['globalslop', 87, 2]] });
  extension = await launchExtension(await api.start());
  ctx = extension.ctx;
  await routeX(ctx, calls, answers);
  await expect.poll(() => stored<{ installId: string } | null>('identity'), { timeout: 60_000 }).toMatchObject({ installId: expect.any(String) });
});

test.afterAll(async () => {
  await extension?.close();
  await api?.close();
});

test('a click hides at once and calls X with the right form body and headers', async () => {
  const page = await open(REPLY_STATUS);
  await button(page, '101').click();
  await expect(tweet(page, '101')).toBeHidden();
  await expect(tweet(page, '103')).toBeHidden();
  await expect(cellOf(page, '101').locator('.xslop-bar')).toContainText('Hidden reply from @slopbot');
  await expect.poll(() => creates('slopbot').length).toBe(1);
  const [create] = creates('slopbot');
  expect(create!.method).toBe('POST');
  expect(create!.url).toBe('https://x.com/i/api/1.1/mutes/users/create.json');
  expect(create!.body).toBe('screen_name=slopbot');
  expect(create!.headers).toMatchObject({
    authorization: `Bearer ${BEARER}`, 'x-csrf-token': CT0, 'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes', 'content-type': 'application/x-www-form-urlencoded',
  });
  await expect(toast(page)).toHaveText(/Muted @slopbot on X/);
  await expect.poll(() => api.votesFor('slopbot').length).toBe(1);
  await expect.poll(async () => (await stored<{ muted: [string, { id: string | null }][] }>('mute')).muted.find((m) => m[0] === 'slopbot')?.[1].id).toBe(X_IDS.slopbot);
  await page.close();
});

test('Undo in the toast unmutes by the recorded id and shows the tweet again', async () => {
  const page = await open('/home');
  await button(page, '203').click();
  await expect.poll(() => creates('erin').length).toBe(1);
  await expect(toast(page)).toHaveText(/Muted @erin on X/);
  const before = calls.filter((c) => c.op === 'destroy').length;
  await toastUndo(page).click();
  await expect(tweet(page, '203')).toBeVisible();
  await expect.poll(() => calls.filter((c) => c.op === 'destroy').length).toBe(before + 1);
  expect(calls.filter((c) => c.op === 'destroy').at(-1)!.body).toBe('user_id=1999');
  expect(calls.filter((c) => c.op === 'destroy').at(-1)!.url).toBe('https://x.com/i/api/1.1/mutes/users/destroy.json');
  await expect.poll(() => api.votesFor('erin').length).toBe(0);
  await page.close();
});

test('a click on the focal post marks it and leaves it open', async () => {
  const page = await open(REPLY_STATUS);
  await button(page, '100').click();
  await expect(button(page, '100')).toHaveAttribute('aria-pressed', 'true');
  await expect(tweet(page, '100')).toBeVisible();
  await expect.poll(() => creates('alice').length).toBe(1);
  await page.close();
});

test('a double click marks once and does not take the mark back', async () => {
  const page = await open(REPLY_STATUS);
  await expect(button(page, '100')).toHaveAttribute('aria-pressed', 'true');
  await button(page, '100').click();
  await expect(button(page, '100')).toHaveAttribute('aria-pressed', 'false');
  await expect(toast(page)).toHaveText(/Unmuted @alice on X/);
  const destroys = calls.filter((c) => c.op === 'destroy').length;
  await button(page, '100').dblclick();
  await expect(button(page, '100')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => creates('alice').length).toBe(2);
  await expect(toast(page)).toHaveText(/Muted @alice on X/);
  expect(calls.filter((c) => c.op === 'destroy')).toHaveLength(destroys);
  await page.close();
});

test('in X\'s phone layout xslop finds you by your avatar: your own tweet gets no button', async () => {
  const page = await openPhone('me_user');
  await expect(button(page, '101')).toBeAttached();
  await expect(tweet(page, '106').locator('.xslop-host')).toHaveCount(0);
  await page.close();
});

test('when xslop cannot tell who you are and you click your own tweet, X says so and xslop takes the mark back', async () => {
  const page = await openPhone('unknown');
  await expect(button(page, '106')).toBeAttached();
  answers.push({ status: 403, json: { errors: [{ code: 271 }] } });
  await button(page, '106').click();
  await expect(toast(page)).toHaveText(/You cannot mark your own account\./);
  await expect(tweet(page, '106')).toBeVisible();
  await expect(tweet(page, '106').locator('.xslop-host')).toHaveCount(0);
  await expect.poll(() => api.votesFor('me_user').length).toBe(0);
  await expect.poll(async () => (await stored<{ skipped: [string, string][] }>('mute')).skipped).toContainEqual(['me_user', 'rejected']);
  expect(await menuClicks(page)).toEqual([]);
  await page.close();
});

test('a 404 from X runs X\'s own menu: it clicks Mute, hides nothing visible, and Undo goes through the menu', async () => {
  answers.push({ status: 404, json: { errors: [{ code: 34 }] } });
  const page = await open(REPLY_STATUS);
  await button(page, '102').click();
  await expect(toast(page)).toHaveText(/Muted @human_dev on X/);
  expect(await menuClicks(page)).toEqual(['Mute @human_dev']);
  expect(await page.locator('[role="menu"]').count()).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('role="menu"')))).toBe(false);
  await expect.poll(async () => (await stored<{ muted: [string, { id: string | null }][] }>('mute')).muted.find((m) => m[0] === 'human_dev')?.[1]).toMatchObject({ id: null });
  await toastUndo(page).click();
  await expect(tweet(page, '102')).toBeVisible();
  await expect.poll(() => menuClicks(page)).toEqual(['Mute @human_dev', 'Unmute @human_dev']);
  await page.close();
});

test('the menu path clicks nothing when only Block and Unfollow are on offer, and says X did not accept', async () => {
  answers.push({ status: 404, json: {} });
  const page = await open(REPLY_STATUS);
  await page.evaluate(() => {
    (window as unknown as { __xMenuItems: (h: string) => string[] }).__xMenuItems = (h) => [`Unfollow @${h}`, `Block @${h}`, `Add or remove @${h} from Lists`];
  });
  await button(page, '105').click();
  await expect(toast(page)).toHaveText(/Hidden here\. X did not accept the mute\./);
  expect(await menuClicks(page)).toEqual([]);
  expect(await page.locator('[role="menu"]').count()).toBe(0);
  await expect(tweet(page, '105')).toBeHidden();
  await page.close();
});

test('X answers 429: instant mutes stop and the toast says so; the next click makes no X call', async () => {
  answers.push({ status: 429, json: { errors: [{ code: 88 }] } });
  const page = await open(REPLY_STATUS);
  await button(page, '108').click();
  await expect(toast(page)).toHaveText(/X limits mutes\. Instant mute stops for 15 minutes/);
  await button(page, '109').click();
  await expect(toast(page)).toHaveText(/The mute on X comes later/);
  expect(creates('photoguy')).toEqual([]);
  await expect(tweet(page, '109')).toBeHidden();
  await page.close();
});

test('past 30 mutes in a minute the click still hides and votes, and the mute goes to the paced queue', async () => {
  const page = await open('/limit');
  const handles = Array.from({ length: LIMIT_PAGE_TWEETS }, (_, i) => `lim${i}`);
  for (const h of handles) {
    await page.locator('article', { has: page.locator(`a[href="/${h}"]`) }).locator('.xslop-host button').click();
  }
  await expect(toast(page)).toHaveText(/The mute on X comes later/);
  await expect.poll(() => calls.filter((c) => /screen_name=lim\d/.test(c.body)).length).toBe(30);
  expect(creates('lim30')).toEqual([]);
  for (const h of handles) await expect.poll(() => api.votesFor(h).length).toBe(1);
  await expect.poll(async () => (await stored<{ retry: [string, number][] }>('mute')).retry.some((r) => r[0] === 'lim30')).toBe(true);
  await expect(page.locator('article', { has: page.locator('a[href="/lim30"]') })).toBeHidden();
  await page.close();
});

test('a page script cannot trigger a mute with a fake click', async () => {
  const page = await open('/home');
  await expect(button(page, '201')).toBeAttached();
  await page.evaluate(() => {
    const host = [...document.querySelectorAll('article')].find((a) => a.querySelector('a[href="/dave"]'))!.querySelector('.xslop-host')!;
    const b = host.shadowRoot!.querySelector('button')!;
    b.click();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  expect(creates('dave')).toEqual([]);
  expect(api.votesFor('dave')).toEqual([]);
  await expect(tweet(page, '201')).toBeVisible();
  await page.close();
});

test('muteOnMark off: a click hides and votes, and xslop makes no X call', async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extension.extId}/popup.html`);
  const toggle = popup.locator('label.switch:has(#mute-mark)');
  const input = popup.locator('#mute-mark');
  await expect(input).toBeChecked();
  await toggle.click();
  await expect.poll(async () => (await stored<{ muteOnMark: boolean }>('settings')).muteOnMark).toBe(false);
  const page = await open(REPLY_STATUS);
  const before = calls.length;
  await button(page, '99').click();
  await expect(tweet(page, '99')).toBeHidden();
  await expect(cellOf(page, '99').locator('.xslop-bar')).toContainText('Hidden post from @bob');
  await expect.poll(() => api.votesFor('bob').length).toBe(1);
  expect(calls.slice(before).filter((c) => c.op === 'create' || c.op === 'destroy')).toEqual([]);
  await expect(input).not.toBeChecked();
  await toggle.click();
  await expect.poll(async () => (await stored<{ muteOnMark: boolean }>('settings')).muteOnMark).toBe(true);
  await page.close();
  await popup.close();
});

test('the toast stays clear of a composer, is still read out behind two, and leaves no dead spot when it closes', async () => {
  const page = await open('/timeline/toast_a');
  const host = page.locator('.xslop-toast');
  const addComposer = (testId: string, edge: 'top' | 'bottom') => page.evaluate(([id, side]) => {
    const composer = document.createElement('textarea');
    composer.setAttribute('data-testid', id!);
    composer.style.cssText = `position:fixed;left:0;right:0;${side}:0;height:90px`;
    document.body.append(composer);
    composer.focus();
  }, [testId, edge]);
  await button(page, '5000').click();
  await expect(toast(page)).toHaveText(/Muted @toast_a on X/);
  await expect(host).toHaveAttribute('data-place', 'bottom');
  await addComposer('tweetTextarea_0', 'bottom');
  await expect(host).toHaveAttribute('data-place', 'top');
  await addComposer('dmComposerTextInput', 'top');
  await expect(host).toHaveAttribute('data-place', 'none');
  await expect(toast(page)).toHaveText(/Muted @toast_a on X/);
  await expect(toastUndo(page)).toBeHidden();
  await expect(page.locator('.xslop-toast .toast')).not.toHaveAttribute('data-open', '');
  const caught = await host.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  });
  expect(caught).toBe(false);
  await page.close();
});

test('the button looks native: size, colour per X theme, and on a phone it fits the row and leaves X\'s icon alone', async () => {
  const page = await open(REPLY_STATUS);
  const icon = (id: string) => button(page, id).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, color: getComputedStyle(el).color };
  });
  await expect(button(page, '101')).toBeAttached();
  expect(await icon('102')).toMatchObject({ w: 18.75, h: 18.75, color: 'rgb(113, 118, 123)' });
  expect(await icon('100')).toMatchObject({ w: 22.5, h: 22.5 });
  for (const [bg, want] of [['rgb(255, 255, 255)', 'rgb(83, 100, 113)'], ['rgb(21, 32, 43)', 'rgb(139, 152, 165)'], ['rgb(0, 0, 0)', 'rgb(113, 118, 123)']] as const) {
    await page.evaluate((c) => document.body.setAttribute('style', `background-color: ${c};`), bg);
    await expect.poll(async () => (await icon('102')).color, { message: `theme ${bg}` }).toBe(want);
  }
  await page.addStyleTag({ content: X_ROW_RULES });
  for (const width of [320, 360, 414]) {
    await page.setViewportSize({ width, height: 800 });
    await button(page, '102').scrollIntoViewIfNeeded();
    const row = await tweet(page, '102').locator('[role="group"]').evaluate((g) => {
      const host = g.querySelector('.xslop-host')!;
      const box = host.getBoundingClientRect();
      const neighbour = host.previousElementSibling!.getBoundingClientRect();
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      const onHost = (x: number, y: number): boolean => document.elementFromPoint(x, y) === host;
      return {
        right: g.getBoundingClientRect().right,
        items: [...g.children].map((c) => c.getBoundingClientRect().right),
        touch: {
          overNeighbour: onHost(neighbour.right - 1, midY),
          above: onHost(midX, midY - 21),
          below: onHost(midX, midY + 21),
          gap: onHost(box.left - 9, midY),
          edge: onHost(box.right + 15, midY),
        },
      };
    });
    for (const r of row.items) expect(r).toBeLessThanOrEqual(row.right + 0.5);
    expect(row.touch, `touch target at ${width} px`).toEqual({ overNeighbour: false, above: true, below: true, gap: true, edge: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await icon('102')).w).toBe(18.75);
  }
  await page.close();
});

test('the collapse animates, and not with reduced motion', async () => {
  const running = (page: Page, id: string) => cellOf(page, id).locator('.xslop-bar').evaluate((el) => el.getAnimations().length);
  const motion = await open('/home');
  // A slow animation clock: the 180 ms collapse still runs when the test looks, however busy the machine is.
  const cdp = await ctx.newCDPSession(motion);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.02 });
  await button(motion, '201').click();
  expect(await running(motion, '201')).toBeGreaterThan(0);
  await motion.close();
  const reduced = await ctx.newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await reduced.goto('https://x.com/home');
  await button(reduced, '203').click();
  await expect(cellOf(reduced, '203').locator('.xslop-bar')).toBeAttached();
  expect(await running(reduced, '203')).toBe(0);
  await reduced.close();
});

// Last in this file: it reloads the extension, so the worker handle of the other tests goes stale.
test('after an update of the extension an open tab makes no X call and tells you to reload', async () => {
  const page = await open(REPLY_STATUS);
  await expect(button(page, '102')).toHaveAttribute('aria-pressed', 'false');
  const before = calls.length;
  const unloaded = new Promise<void>((resolve) => extension.sw.once('close', () => resolve()));
  await extension.sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await unloaded;
  await page.waitForTimeout(500);
  await button(page, '102').click();
  await expect(toast(page)).toHaveText(/xslop was updated\. Reload this page\./);
  await expect(tweet(page, '102')).toBeVisible();
  expect(calls.slice(before).filter((c) => c.op === 'create' || c.op === 'destroy')).toEqual([]);
  await page.close();
});
