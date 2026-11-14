// End to end (SPEC 7.8): Playwright Chromium loads the unpacked extension, x.com is routed to fixture
// pages, and XSLOP_API points at the local mock API (or at a real server with XSLOP_E2E_API=<origin>).
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { MockApi, defaultConfig } from '../mock-server';
import { CT0, X_IDS, cellOf, launchExtension, openPage, routeX, tweet, type Extension, type XAnswer, type XCallLog } from './support';

const REAL = process.env.XSLOP_E2E_API ?? '';
const BEARER = (defaultConfig().mute as { webBearer: string }).webBearer;
/** Mute pace for the test: 2 s apart (+30% jitter), 5 calls a day. Observations flush every 5 s. */
const FAST = { minIntervalSec: 2, jitter: 0.3, maxPerDay: 5 };

interface ObsPost { status: number; items: Record<string, unknown>[] }

let api: MockApi | null = null;
let base = '';
let extension: Extension;
let ctx: BrowserContext;
let sw: Worker;
let extId = '';
let globalHandle = 'globalslop';
const xcalls: XCallLog[] = [];
/** Answers for the next mute or unmute calls, oldest first; the default is a success with the user's id. */
const xAnswers: XAnswer[] = [];
/** Every observation batch that the extension posted, with the status that the API answered. */
const obsPosts: ObsPost[] = [];

test.describe.configure({ mode: 'serial' });

/** Pass the API through, but record observation posts; against a real server, flush observations every 5 s. */
async function routeApi(c: BrowserContext): Promise<void> {
  await c.route(`${base}/api/v1/observations`, async (route) => {
    const res = await route.fetch();
    obsPosts.push({ status: res.status(), items: (route.request().postDataJSON() as { items: Record<string, unknown>[] }).items });
    await route.fulfill({ response: res });
  });
  if (!REAL) return;
  await c.route(`${base}/api/v1/config`, async (route) => {
    const res = await route.fetch();
    if (res.status() !== 200) return route.fulfill({ response: res });
    const config = (await res.json()) as { observe: object };
    config.observe = { ...config.observe, flushSec: 5 };
    return route.fulfill({ status: 200, json: config });
  });
}

/** Read storage.local in the background. */
const bg = <T>(key: string): Promise<T> => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;

const openX = (path: string): Promise<Page> => openPage(ctx, path);

const radio = (page: Page, name: string, value: string) => page.locator(`label:has(input[name="${name}"][value="${value}"])`);

/** Instant mutes have their own spec. Off here, so every X call in this file comes from the paced queue and its daily cap stays exact. */
async function turnOffInstantMute(): Promise<void> {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await expect(popup.locator('#mute-mark')).toBeChecked();
  await popup.locator('label.switch:has(#mute-mark)').click();
  await expect.poll(async () => (await bg<{ muteOnMark: boolean }>('settings')).muteOnMark).toBe(false);
  await popup.close();
}

async function serverVotes(handle: string): Promise<{ slop: number; notSlop: number }> {
  if (api) {
    const all = api.votesFor(handle);
    return { slop: all.filter((v) => v.value === 'slop').length, notSlop: all.filter((v) => v.value === 'not_slop').length };
  }
  const res = await fetch(`${base}/api/v1/accounts/${handle}`);
  return ((await res.json()) as { votes: { slop: number; notSlop: number } }).votes;
}

test.beforeAll(async () => {
  if (REAL) {
    base = new URL(REAL).origin;
    const list = (await (await fetch(`${base}/api/v1/list`)).json()) as { accounts: [string, number, number][] };
    const top = list.accounts.find((a) => a[2] === 2);
    if (!top) throw new Error('the real server list has no tier 2 account');
    globalHandle = top[0];
  } else {
    const config = defaultConfig();
    config.mute = { ...(config.mute as object), ...FAST };
    config.observe = { ...(config.observe as object), flushSec: 5 };
    api = new MockApi({
      difficulty: 12,
      config,
      list: [['globalslop', 87, 2], ['flaggedone', 64, 1], ['bot2', 80, 2], ['bot3', 70, 2], ['xslop_demo_wrid', 60, 2]],
      // SPEC 13.8: the list carries the X user id of a listed account. flaggedone has none. xslop_demo_wrid carries the id of
      // @globalslop, which you mark not slop below (SPEC 13.10 item 9).
      ids: { globalslop: X_IDS.globalslop!, bot2: X_IDS.bot2!, bot3: X_IDS.bot3!, xslop_demo_wrid: X_IDS.globalslop! },
    });
    base = await api.start();
  }
  extension = await launchExtension(base);
  ctx = extension.ctx;
  sw = extension.sw;
  extId = extension.extId;
  await routeX(ctx, xcalls, xAnswers, (html) => (globalHandle === 'globalslop' ? html : html.replaceAll('globalslop', globalHandle)));
  await routeApi(ctx);
});

test.afterAll(async () => {
  await extension?.close();
  await api?.close();
});

test('install registers with proof of work, onboarding opens, list and config sync', async () => {
  await expect.poll(() => bg<{ installId: string } | null>('identity'), { timeout: 60_000 }).toMatchObject({ installId: expect.any(String) });
  if (api) expect(api.installs.size).toBe(1);
  await expect.poll(() => ctx.pages().some((p) => p.url() === `chrome-extension://${extId}/onboarding.html`)).toBe(true);
  await expect.poll(async () => (await bg<{ accounts: unknown[] } | null>('list'))?.accounts.length ?? 0).toBeGreaterThan(0);
  // SPEC 13.10: the ids are stored beside the rows, in their order.
  if (api) {
    expect(await bg('list')).toMatchObject({
      accounts: [['bot2', 80, 2], ['bot3', 70, 2], ['flaggedone', 64, 1], ['globalslop', 87, 2], ['xslop_demo_wrid', 60, 2]],
      ids: [X_IDS.bot2, X_IDS.bot3, null, X_IDS.globalslop, X_IDS.globalslop],
    });
  }
  if (REAL) {
    // The worker fetched the config before the test routes existed. The popup syncs again on open, through the routes.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.close();
  }
  await expect.poll(async () => (await bg<{ observe: { flushSec: number } } | null>('config'))?.observe.flushSec).toBe(5);
  if (api) await expect.poll(async () => (await bg<{ mute: { minIntervalSec: number } } | null>('config'))?.mute.minIntervalSec).toBe(2);
  await turnOffInstantMute();
});

test('the button appears on posts, replies and the focal post; never on your own tweet, an ad or a quoted tweet', async () => {
  const page = await openX('/alice/status/100');
  await expect(tweet(page, '101').locator('.xslop-host')).toHaveCount(1);
  for (const id of ['99', '100', '102', '103', '105', '108', '109']) await expect(tweet(page, id).locator('.xslop-host')).toHaveCount(1);
  await expect(tweet(page, '106').locator('.xslop-host')).toHaveCount(0);
  await expect(page.locator('[data-testid="placementTracking"] .xslop-host')).toHaveCount(0);
  await expect(tweet(page, '108').locator('div[role="link"] .xslop-host')).toHaveCount(0);
  const button = tweet(page, '101').locator('.xslop-host button');
  await expect(button).toHaveAttribute('aria-label', 'Mark @slopbot as slop');
  // The quote reply belongs to @quoter, not to the quoted @slopbot.
  await expect(tweet(page, '108').locator('.xslop-host button')).toHaveAttribute('aria-label', 'Mark @quoter as slop');
  // A global tier 2 account of a list with ids is hidden for you at once.
  await expect(cellOf(page, '104').locator('.xslop-bar')).toContainText(/Hidden by xslop \(score \d+\)/);
  await expect(tweet(page, '104')).toBeHidden();
  await page.close();
});

test('click collapses the reply and all replies of that account; the vote reaches the server signed', async () => {
  const page = await openX('/alice/status/100');
  await tweet(page, '101').locator('.xslop-host button').click();
  const bar = cellOf(page, '101').locator('.xslop-bar');
  await expect(bar).toContainText('Hidden reply from @slopbot');
  await expect(bar.getByRole('button', { name: 'Show' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Undo' })).toBeFocused();
  await expect(tweet(page, '101')).toBeHidden();
  await expect(tweet(page, '103')).toBeHidden();
  await expect(cellOf(page, '103').locator('.xslop-bar')).toContainText('Hidden reply from @slopbot');
  await expect(tweet(page, '102')).toBeVisible();
  await expect.poll(() => serverVotes('slopbot')).toEqual({ slop: 1, notSlop: 0 });
  if (api) {
    expect(api.rejected).toEqual([]);
    const vote = api.votesFor('slopbot')[0]!.body;
    // These six fields and nothing else: no post text.
    expect(vote).toEqual({ handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: '100', context: 'reply', postedAt: '2026-11-07T09:10:12.000Z' });
  }
  // Show reveals one reply; the home timeline hides the same account through "Replying to".
  await bar.getByRole('button', { name: 'Show' }).click();
  await expect(tweet(page, '101')).toBeVisible();
  await expect(tweet(page, '103')).toBeHidden();
  const home = await openX('/home');
  await expect(cellOf(home, '202').locator('.xslop-bar')).toContainText('Hidden reply from @slopbot');
  for (const id of ['201', '203']) await expect(tweet(home, id).locator('.xslop-host')).toHaveCount(1);
  for (const id of ['204', '206']) await expect(tweet(home, id).locator('.xslop-host')).toHaveCount(0);
  await home.close();
  await page.close();
});

test('undo removes the vote; not slop puts a global account on your allow list', async () => {
  const page = await openX('/alice/status/100');
  await tweet(page, '102').locator('.xslop-host button').click();
  await expect.poll(() => serverVotes('human_dev')).toEqual({ slop: 1, notSlop: 0 });
  await cellOf(page, '102').locator('.xslop-bar').getByRole('button', { name: 'Undo' }).click();
  await expect(tweet(page, '102')).toBeVisible();
  await expect.poll(() => serverVotes('human_dev')).toEqual({ slop: 0, notSlop: 0 });

  await cellOf(page, '104').locator('.xslop-bar').getByRole('button', { name: 'Not slop' }).click();
  await expect(tweet(page, '104')).toBeVisible();
  await expect.poll(() => serverVotes(globalHandle)).toMatchObject({ notSlop: 1 });
  await page.close();
});

test('popup toggles strictness, display and shows your list', async () => {
  const page = await openX('/alice/status/100');
  await expect(tweet(page, '105')).toBeVisible();
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 700 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await expect(popup.locator('#headline')).toHaveText('Hiding');
  // SPEC 13.8: the popup asks /api/v1/me through the background; a new install has no standing yet, so no tag shows.
  if (api) await expect.poll(async () => (await bg<{ standing: boolean | null }>('status')).standing).toBe(false);
  await expect(popup.locator('#standing')).toBeHidden();
  await expect(popup.locator('#stat-mine')).toHaveText('1');
  if (api) await expect(popup.locator('#stat-list')).toHaveText('5');
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await expect(popup.locator('#votes li')).toHaveCount(2);
  await expect(popup.locator('#votes')).toContainText('@slopbot');
  // Chrome caps a popup at 600 px: with 4 marks and no notice, the whole popup fits without a scroll bar.
  const height = await popup.evaluate(() => {
    const row = document.querySelector('#votes li')!.getBoundingClientRect().height;
    return document.body.getBoundingClientRect().height + 2 * row;
  });
  expect(height).toBeLessThanOrEqual(600);
  // The search field shows from 7 marks.
  await expect(popup.locator('#search')).toBeHidden();

  if (api) {
    await radio(popup, 'strictness', 'strict').click();
    await expect(tweet(page, '105')).toBeHidden();
    await expect(cellOf(page, '105').locator('.xslop-bar')).toContainText('Hidden by xslop (score 64)');
  }
  await radio(popup, 'display', 'remove').click();
  await expect(cellOf(page, '103').locator('.xslop-bar')).toHaveCount(0);
  await expect(tweet(page, '103')).toBeHidden();
  await radio(popup, 'display', 'collapse').click();
  await expect(cellOf(page, '103').locator('.xslop-bar')).toContainText('Hidden reply from @slopbot');

  await radio(popup, 'strictness', 'balanced').click();
  await expect(tweet(page, '105')).toBeVisible();
  expect((await bg<{ strictness: string; display: string }>('settings'))).toMatchObject({ strictness: 'balanced', display: 'collapse' });

  // Remove from your list, then undo.
  await popup.locator('#votes li', { hasText: '@slopbot' }).getByRole('button', { name: 'Undo your mark on @slopbot' }).click();
  await expect(tweet(page, '103')).toBeVisible();
  await popup.locator('#toast-undo').click();
  await expect(tweet(page, '103')).toBeHidden();
  await expect.poll(() => serverVotes('slopbot')).toEqual({ slop: 1, notSlop: 0 });
  await popup.close();
  await page.close();
});

test('signal sharing sends observations of three fields, only after you opt in', async () => {
  expect(obsPosts).toEqual([]);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('label.switch', { hasText: 'Share anonymous signals' }).click();
  await expect.poll(async () => (await bg<{ share: boolean }>('settings')).share).toBe(true);
  const page = await openX('/alice/status/100');
  await expect.poll(() => obsPosts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.close();
  // The API validates every item against its schema: 202 is the proof that the batch landed.
  expect(obsPosts.map((p) => p.status)).toEqual(obsPosts.map(() => 202));
  const items = obsPosts.flatMap((p) => p.items);
  if (api) expect(api.observations).toEqual(items);
  const byId = new Map(items.map((o) => [o.tweetId as string, o]));
  expect([...byId.keys()].sort()).toEqual(['101', '102', '103', '104', '105', '108', '109']);
  // SPEC 13.8: the account, the post id and the id of the post that it answers. Nothing else.
  expect(byId.get('101')).toEqual({ handle: 'slopbot', tweetId: '101', parentTweetId: '100' });
  expect(byId.get('109')).toEqual({ handle: 'photoguy', tweetId: '109', parentTweetId: '100' });
  for (const o of items) expect(Object.keys(o).sort()).toEqual(['handle', 'parentTweetId', 'tweetId']);
  await popup.locator('label.switch', { hasText: 'Share anonymous signals' }).click();
  await expect.poll(async () => (await bg<{ share: boolean }>('settings')).share).toBe(false);
  await popup.close();
});

test('mute sync calls the X mute endpoint with your session headers, by the X id of the list, at the right pace, undoes at once a mute that X answers with an account on your allow list, and undoes only its own mutes', async () => {
  test.skip(!api, 'the real server config paces mutes 90 s apart');
  test.setTimeout(120_000);
  const page = await openX('/home');
  xcalls.length = 0;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('label.switch', { hasText: 'Mute the shared list' }).click();
  // Targets: your slop vote first, then global tier 2 by score; globalslop is on your allow list, flaggedone is tier 1.
  await expect.poll(() => xcalls.filter((c) => c.op === 'create').length, { timeout: 30_000 }).toBe(4);
  const creates = xcalls.filter((c) => c.op === 'create');
  // SPEC 13.6: a listed account by the X user id of the list; your own mark of an account that the list does not carry by handle.
  expect(creates.map((c) => c.body)).toEqual(['screen_name=slopbot', `user_id=${X_IDS.bot2}`, `user_id=${X_IDS.bot3}`, `user_id=${X_IDS.globalslop}`]);
  // SPEC 13.10 item 9: X answers the mute of xslop_demo_wrid with @GlobalSlop, which you marked not slop. xslop unmutes it at once, by that id.
  await expect.poll(() => xcalls.filter((c) => c.op === 'destroy').length, { timeout: 10_000 }).toBe(1);
  const undone = xcalls.find((c) => c.op === 'destroy')!;
  expect(undone.body).toBe(`user_id=${X_IDS.globalslop}`);
  expect(undone.at - creates[3]!.at).toBeLessThan(FAST.minIntervalSec * 1000);
  expect(xcalls[0]!.op).toBe('ids');
  for (const c of creates) {
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://x.com/i/api/1.1/mutes/users/create.json');
    expect(c.headers).toMatchObject({
      authorization: `Bearer ${BEARER}`, 'x-csrf-token': CT0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
      'content-type': 'application/x-www-form-urlencoded',
    });
  }
  for (let i = 1; i < creates.length; i++) expect(creates[i]!.at - creates[i - 1]!.at).toBeGreaterThanOrEqual(FAST.minIntervalSec * 1000 - 50);
  await expect(popup.locator('#mute-state')).toContainText('2 accounts muted by xslop');
  const record = await bg<{ muted: [string, unknown][]; skipped: [string, string][]; wrongIds: [string, string][] }>('mute');
  expect(record.muted.map((m) => m[0])).toEqual(['slopbot', 'bot3']);
  expect(record.skipped).toEqual([['bot2', 'own']]);
  expect(record.wrongIds).toEqual([['xslop_demo_wrid', X_IDS.globalslop]]);
  // xslop does not mute by that id again while the list gives it to that handle: one mute of today is left, and two paces bring no call.
  await page.waitForTimeout(FAST.minIntervalSec * 1300 * 2 + 500);
  expect(xcalls.filter((c) => c.op !== 'ids').length).toBe(5);

  await popup.getByRole('button', { name: 'Undo all xslop mutes' }).click();
  await expect.poll(() => xcalls.filter((c) => c.op === 'destroy').length, { timeout: 30_000 }).toBe(3);
  const destroys = xcalls.filter((c) => c.op === 'destroy');
  // Unmute by the user id that X returned for the mute, never by the handle.
  expect(destroys.map((c) => c.body)).toEqual([`user_id=${X_IDS.globalslop}`, `user_id=${X_IDS.slopbot}`, `user_id=${X_IDS.bot3}`]);
  for (const c of destroys) expect(c.url).toBe('https://x.com/i/api/1.1/mutes/users/destroy.json');
  // Your own mutes are read again right before each create.
  expect(xcalls.slice(0, 9).map((c) => c.op)).toEqual(['ids', 'create', 'ids', 'create', 'ids', 'create', 'ids', 'create', 'destroy']);
  expect(destroys[2]!.at - destroys[1]!.at).toBeGreaterThanOrEqual(FAST.minIntervalSec * 1000 - 50);
  // 4 creates and 3 destroys. Nothing more today, and bot2 (your own mute) was never touched.
  await page.waitForTimeout(FAST.minIntervalSec * 1300 + 500);
  expect(xcalls.filter((c) => c.op !== 'ids').length).toBe(7);
  expect(destroys.some((c) => c.body.includes(X_IDS.bot2!))).toBe(false);
  expect((await bg<{ muted: unknown[] }>('mute')).muted).toEqual([]);
  expect((await bg<{ mute: boolean }>('settings')).mute).toBe(false);
  await popup.close();
  await page.close();
});
