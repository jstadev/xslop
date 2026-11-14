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

/** A visitor who chose `theme` before: the choice is in localStorage, and the system setting is the other theme, so only the choice can decide. */
export function chosenTheme(url: string, theme: 'dark' | 'light'): BrowserContextOptions {
  return {
    colorScheme: theme === 'dark' ? 'light' : 'dark',
    storageState: { cookies: [], origins: [{ origin: new URL(url).origin, localStorage: [{ name: 'xslop-theme', value: theme }] }] },
  };
}

// Software WebGL, the renderer that exists on a server without a GPU. The scene needs a real context.
export const WEBGL_ARGS = ['--use-angle=swiftshader', '--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

/** How many colours the GL canvas itself holds. A screenshot cannot tell: it also shows the page over the canvas. Read in a frame callback, after the scene drew and before the browser clears the buffer. */
export function sceneColours(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          const copy = document.createElement('canvas');
          copy.width = copy.height = 64;
          const ctx = copy.getContext('2d')!;
          ctx.drawImage(document.querySelector<HTMLCanvasElement>('.scene-canvas')!, 0, 0, 64, 64);
          const data = ctx.getImageData(0, 0, 64, 64).data;
          const colours = new Set<number>();
          for (let i = 0; i < data.length; i += 4) colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
          resolve(colours.size);
        });
      }),
  );
}
