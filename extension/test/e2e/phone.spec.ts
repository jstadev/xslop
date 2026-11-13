// Phones (Firefox for Android, Safari on iPhone): the popup and the onboarding open as pages, and x.com draws
// its phone layout. A real Chromium with a touch screen, at the four common phone widths, upright and on its side.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MockApi } from '../mock-server';
import { cellOf, fixturePage, launchExtension, routeX, tweet, type Extension } from './support';

const WIDTHS = [320, 360, 390, 430];
const SCREENS = WIDTHS.flatMap((w) => [{ width: w, height: 760 }, { width: Math.round(w * 2.16), height: w }]);
const TAP = 44;
/** X's phone layout: a tab bar along the bottom edge and the round post button above its right end. */
const X_PHONE_CHROME = `<nav data-testid="BottomBar" style="position:fixed;left:0;right:0;bottom:0;height:53px"></nav>
<a data-testid="FloatingActionButtons_Tweet_Button" href="/compose/post" style="position:fixed;right:20px;bottom:73px;width:56px;height:56px"></a>`;

let api: MockApi;
let extension: Extension;
let ctx: BrowserContext;

/**
 * Headless Chromium keeps a mouse as its pointer, also with a touch screen, and no tool can change that.
 * So the rules that ui.css keeps for a touch device are switched on by hand. Returns how many it found.
 */
const asTouchDevice = (page: Page) => page.evaluate(() => {
  const rules = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText === '(hover: none) and (pointer: coarse)');
  for (const r of rules) r.media.mediaText = 'all';
  return rules.length;
});

/** A notch on each side and a home bar, as an iPhone on its side has them. */
const INSETS = { top: 0, left: 47, bottom: 21, right: 47 };

/** What a thumb meets on an extension page: each control with its size, the text size of each field, and the sideways overflow. */
const audit = (page: Page, inset = { left: 0, right: 0, bottom: 0 }) => page.evaluate((safe) => {
  const seen = (el: Element): boolean => el.getClientRects().length > 0;
  const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
  const controls = [...document.querySelectorAll('a, button, input[type="search"], label.switch, .seg label')].filter(seen)
    .map((el) => ({ el: name(el), box: el.getBoundingClientRect() }));
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    controls: controls.length,
    small: controls.filter((c) => c.box.width < 44 || c.box.height < 44).map((c) => `${c.el} ${Math.round(c.box.width)}x${Math.round(c.box.height)}`),
    clipped: controls.filter((c) => c.box.left < safe.left || c.box.right > document.documentElement.clientWidth - safe.right ||
      // scrollHeight is a whole number and the boxes are not: one pixel of slack.
      c.box.bottom + scrollY > document.documentElement.scrollHeight - safe.bottom + 1).map((c) => c.el),
    zooms: [...document.querySelectorAll('input:not([type="radio"], [type="checkbox"]), select, textarea')].filter(seen)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map(name),
  };
}, inset);

/** The same audit on a phone on its side with a notch and a home bar. */
async function auditNotched(page: Page): Promise<Awaited<ReturnType<typeof audit>>> {
  const cdp = await ctx.newCDPSession(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSETS });
  const found = await audit(page, INSETS);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  await cdp.detach();
  return found;
}

const clean = (controls: number) => ({ overflow: 0, controls, small: [], clipped: [], zooms: [] });
const stored = <T>(key: string): Promise<T> => extension.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
const box = async (target: ReturnType<Page['locator']>) => (await target.boundingBox())!;
const tap = async (page: Page, target: ReturnType<Page['locator']>): Promise<void> => {
  await target.scrollIntoViewIfNeeded();
  const b = await box(target);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};

test.beforeAll(async () => {
  api = new MockApi({ difficulty: 12, list: [['globalslop', 87, 2]] });
  extension = await launchExtension(await api.start(), true);
  ctx = extension.ctx;
  await routeX(ctx, [], []);
  await ctx.route('https://x.com/alice/status/100', async (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: (await fixturePage('status.html', (html) => html.replace(
      /<a [^>]*AppTabBar_Profile_Link[^>]*>.*?<\/a>/s,
      '<button type="button" data-testid="DashButton_ProfileIcon_Link"><div data-testid="UserAvatar-Container-me_user"></div></button>',
    ))).replace('</body>', `${X_PHONE_CHROME}</body>`),
  }));
  await expect.poll(() => stored<{ installId: string } | null>('identity'), { timeout: 60_000 }).toMatchObject({ installId: expect.any(String) });
});

test.afterAll(async () => {
  await extension?.close();
  await api?.close();
});

for (const width of WIDTHS) {
  test(`x.com at ${width} px: a tap marks, the bar and the toast fit, clear of X's tab bar and post button, and a tap undoes`, async () => {
    const page = await ctx.newPage();
    await page.setViewportSize({ width, height: 760 });
    await page.goto('https://x.com/alice/status/100');
    await tap(page, tweet(page, '102').locator('.xslop-host button'));
    const bar = cellOf(page, '102').locator('.xslop-bar');
    await expect(bar).toContainText('Hidden reply from @human_dev');
    const toast = page.locator('.xslop-toast .toast');
    await expect(toast).toHaveText(/Muted @human_dev on X/);
    await expect(toast).toHaveCSS('opacity', '1');

    const cell = await box(cellOf(page, '102'));
    const barBox = await box(bar);
    expect(barBox.x).toBeGreaterThanOrEqual(cell.x);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
    for (const label of ['Show', 'Undo']) {
      const link = await box(bar.getByRole('button', { name: label }));
      expect(Math.min(link.width, link.height), `${label} in the bar`).toBeGreaterThanOrEqual(TAP);
      expect(link.x + link.width).toBeLessThanOrEqual(width);
    }
    const toastBox = await box(toast);
    const tabBar = await box(page.getByTestId('BottomBar'));
    const post = await box(page.getByTestId('FloatingActionButtons_Tweet_Button'));
    expect(toastBox.x).toBeGreaterThanOrEqual(0);
    expect(toastBox.x + toastBox.width, 'the toast ends left of the post button').toBeLessThanOrEqual(post.x);
    expect(toastBox.y + toastBox.height, 'the toast ends above the tab bar').toBeLessThanOrEqual(tabBar.y);
    const undo = page.locator('.xslop-toast button');
    const undoBox = await box(undo);
    expect(Math.min(undoBox.width, undoBox.height), 'Undo in the toast').toBeGreaterThanOrEqual(TAP);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await tap(page, bar.getByRole('button', { name: 'Show' }));
    await expect(tweet(page, '102')).toBeVisible();
    await tap(page, undo);
    await expect(tweet(page, '102').locator('.xslop-host button')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => api.votesFor('human_dev').length).toBe(0);
    await page.close();
  });
}

test('the popup fits every phone screen: no sideways scroll, 44 px controls, no zoom on the search field', async () => {
  const x = await ctx.newPage();
  await x.goto('https://x.com/alice/status/100');
  await tap(x, tweet(x, '101').locator('.xslop-host button'));
  await expect.poll(async () => (await stored<{ muted: unknown[] }>('mute')).muted.length).toBe(1);
  await x.close();
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extension.extId}/popup.html`);
  await expect(popup.locator('#votes li')).toHaveCount(1);
  await expect(popup.locator('#undo-mutes')).toBeVisible();
  expect(await asTouchDevice(popup)).toBe(2);
  // Three numbers of six digits: the widest that the glance row can show.
  await popup.evaluate(() => {
    for (const id of ['stat-hidden', 'stat-list', 'stat-mine']) document.getElementById(id)!.textContent = '200,000';
  });
  for (const screen of SCREENS) {
    await popup.setViewportSize(screen);
    // search, row link, row Undo, 5 segments, 3 switches, Undo all, 2 footer links
    expect(await audit(popup), `${screen.width}x${screen.height}`).toEqual(clean(14));
  }
  expect(await auditNotched(popup), 'with a notch').toEqual(clean(14));
  await popup.setViewportSize({ width: 320, height: 760 });
  await tap(popup, popup.getByRole('button', { name: 'Undo your mark on @slopbot' }));
  await expect(popup.locator('#toast-undo')).toBeVisible();
  expect((await audit(popup)).small).toEqual([]);
  await tap(popup, popup.locator('#toast-undo'));
  await expect(popup.locator('#votes li')).toHaveCount(1);
  await popup.close();
});

test('the onboarding fits every phone screen on each of its three steps, and the first step stacks its boxes', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extension.extId}/onboarding.html`);
  // Controls per step: switch + Next; 2 switches + Back + Next; the appeal link + Back + Open x.com.
  const steps = [2, 4, 3];
  expect(await asTouchDevice(page)).toBe(2);
  for (const [i, controls] of steps.entries()) {
    await expect(page.locator(`#step-${i + 1}`)).toBeVisible();
    for (const screen of SCREENS) {
      await page.setViewportSize(screen);
      expect(await audit(page), `step ${i + 1} at ${screen.width}x${screen.height}`).toEqual(clean(controls));
    }
    expect(await auditNotched(page), `step ${i + 1} with a notch`).toEqual(clean(controls));
    if (i === 0) {
      const lefts = async () => new Set(await page.locator('.steps li').evaluateAll((items) => items.map((li) => Math.round(li.getBoundingClientRect().left))));
      await page.setViewportSize({ width: 430, height: 760 });
      expect((await lefts()).size).toBe(1);
      await page.setViewportSize({ width: 700, height: 430 });
      expect((await lefts()).size).toBe(3);
    }
    if (i < 2) await tap(page, page.locator(`#step-${i + 1} button.next`));
  }
  await page.close();
});
