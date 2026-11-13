// Shared Playwright helpers: one browser per test file, a page watcher for console errors, page errors and outside requests.

import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { resolve } from 'node:path';
import { defaultState, startServer, type MockState, type Scenario } from './server.ts';

export const DIST = resolve(import.meta.dirname, '../../dist');

export interface Watched {
  page: Page;
  errors: string[];
  outside: string[];
}

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

export async function serve(overrides: Partial<Scenario> = {}): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  return startServer(DIST, defaultState(overrides));
}

/** Opens a page and records console errors, uncaught errors and every request that leaves the test origin. */
export async function open(browser: Browser, url: string, options: BrowserContextOptions = {}, allow: RegExp[] = []): Promise<Watched> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  const outside: string[] = [];
  const origin = new URL(url).origin;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url ?? '';
    const text = `${m.text()} ${where}`;
    if (!allow.some((re) => re.test(text))) errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) outside.push(u);
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // A key press is a visitor taking over: the hero switch then stops flipping on its own, so a test sees a steady page.
  await page.keyboard.press('Shift');
  return { page, errors, outside };
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
}
