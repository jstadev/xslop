// A hostile answer of /api/v1/config in a real browser. The config stays data: its selectors cannot add a
// style rule to x.com, its keys cannot name an endpoint, and its pacing cannot leave the fixed band.
import { expect, test } from '@playwright/test';
import { MockApi, defaultConfig } from '../mock-server';
import { launchExtension, openPage, routeX, tweet, type XAnswer, type XCallLog } from './support';

test('selectors that carry style rules fall back to the built-in ones, the menu path still clicks Mute only, and every X call keeps its endpoint', async () => {
  const config = defaultConfig() as { selectors: Record<string, string>; mute: Record<string, unknown> };
  config.selectors = {
    ...config.selectors,
    menu: '[role="menu"]{} body{display:none!important} x',
    menuItem: '@import "https://example.com/x.css"; [role="menuitem"]',
    caret: '[data-testid="caret"]{} *{visibility:hidden}',
  };
  config.mute = { ...config.mute, maxPerDay: 500, minIntervalSec: 0, jitter: 1, createPath: '/i/api/1.1/blocks/create.json' };
  const api = new MockApi({ difficulty: 12, config });
  const extension = await launchExtension(await api.start());
  const calls: XCallLog[] = [];
  const answers: XAnswer[] = [{ status: 404, json: {} }];
  try {
    await routeX(extension.ctx, calls, answers);
    const stored = () => extension.sw.evaluate(async () => (await chrome.storage.local.get('config')).config as { selectors: Record<string, string>; mute: Record<string, unknown> } | undefined);
    await expect.poll(async () => (await stored())?.selectors.menu, { timeout: 60_000 }).toBe(config.selectors.menu);
    expect((await stored())!.mute).toEqual({ ...defaultConfig().mute as object, maxPerDay: 40, minIntervalSec: 1, jitter: 0.5 });

    const page = await openPage(extension.ctx, '/alice/status/100');
    // X's stand-in menu asks for its items while xslop's hide rule is in the page: read the page then.
    await page.evaluate(() => {
      const w = window as unknown as { __xMenuItems: (h: string) => string[]; __during: unknown };
      const items = w.__xMenuItems;
      w.__xMenuItems = (h) => {
        w.__during = { body: getComputedStyle(document.body).display, rules: [...document.querySelectorAll('style')].map((s) => s.textContent).filter((t) => t?.includes('opacity:0')) };
        return items(h);
      };
    });
    await tweet(page, '102').locator('.xslop-host button').click();
    await expect(page.locator('.xslop-toast [role="status"]')).toHaveText(/Muted @human_dev on X/);
    expect(await page.evaluate(() => (window as unknown as { __xMenuClicks: string[] }).__xMenuClicks)).toEqual(['Mute @human_dev']);
    expect(await page.evaluate(() => (window as unknown as { __during: unknown }).__during)).toEqual({
      body: 'block', rules: ['[role="menu"]{opacity:0!important;pointer-events:none!important}'],
    });
    expect(calls.filter((c) => c.op !== 'ids').map((c) => c.url)).toEqual(['https://x.com/i/api/1.1/mutes/users/create.json']);
  } finally {
    await extension.close();
    await api.close();
  }
});
