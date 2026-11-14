// The dark and light theme of the landing pages: dark for every visitor first, also on a system set to light.
// Covers the switch, the saved choice, the keyboard, the CSP and the scene after a switch.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { open, sceneColours, serve, WEBGL_ARGS, type Watched } from './helpers.ts';

const PAGES = ['/', '/rules', '/check', '/sloppers', '/no-such-page'] as const;
const DARK = { theme: 'dark', paper: 'rgb(0, 0, 0)', bar: '#000000', label: 'Switch to light theme' };
const LIGHT = { theme: 'light', paper: 'rgb(255, 255, 255)', bar: '#ffffff', label: 'Switch to dark theme' };
// Records every CSP violation from the first byte of the page.
const WATCH_CSP = "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));";

let browser: Browser;
let webgl: Browser;
let server: Awaited<ReturnType<typeof serve>>;

before(async () => {
  // Without WebGL2 the landing page shows its static layout, so the switch checks stay fast. The scene test gets a real GL.
  browser = await chromium.launch({ args: ['--disable-webgl2'] });
  webgl = await chromium.launch({ args: WEBGL_ARGS });
  server = await serve();
});

after(async () => {
  await browser.close();
  await webgl.close();
  await server.close();
});

/** Opens `path` on a system set to light, with no saved choice. The first navigation only gives the page watcher the origin. */
async function visit(path: string, engine = browser, options: BrowserContextOptions = {}): Promise<Watched> {
  const watched = await open(engine, `${server.url}/favicon.svg`, { colorScheme: 'light', ...options }, [/404/]);
  // Chromium reports a failed GL call as a warning, not as an error.
  watched.page.on('console', (m) => {
    if (/GL_INVALID|CONTEXT_LOST|WebGL: INVALID/.test(m.text())) watched.errors.push(m.text());
  });
  await watched.page.addInitScript(WATCH_CSP);
  await watched.page.goto(`${server.url}${path}`, { waitUntil: 'load' });
  return watched;
}

/** The theme as a visitor sees it: the root attribute, the page colour, the colour of the browser bar and the label of every switch. */
function shown(page: Page): Promise<typeof DARK> {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const labels = new Set([...document.querySelectorAll('[data-theme-toggle]')].map((el) => el.getAttribute('aria-label')));
    return {
      theme: document.documentElement.dataset.theme ?? '',
      paper: `rgb(${r}, ${g}, ${b})`,
      bar: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
      label: [...labels].join(' | '),
    };
  });
}

const violations = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const visibleSwitch = (page: Page) => page.locator('[data-theme-toggle]').filter({ visible: true }).first();

for (const path of PAGES) {
  test(`${path}: dark on a light system; the switch works by keyboard and by click, and the choice stays after a reload`, async () => {
    const { page, errors } = await visit(path);
    try {
      assert.deepEqual(await shown(page), DARK, 'dark first, also on a light system');
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok((await page.locator('[data-theme-toggle]').filter({ visible: true }).count()) >= 1, `a switch shows at ${width} px`);
      }

      for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement?.hasAttribute('data-theme-toggle'))); i++) await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-theme-toggle')), true, 'Tab reaches the switch');
      await page.keyboard.press('Enter');
      assert.deepEqual(await shown(page), LIGHT, 'Enter switches');
      await page.keyboard.press('Space');
      assert.deepEqual(await shown(page), DARK, 'Space switches');

      await visibleSwitch(page).click();
      assert.deepEqual(await shown(page), LIGHT, 'a click switches');
      assert.deepEqual(await violations(page), []);
      await page.reload({ waitUntil: 'load' });
      assert.deepEqual(await shown(page), LIGHT, 'the choice stays after a reload');
      await visibleSwitch(page).click();
      assert.deepEqual(await shown(page), DARK, 'a second click returns to dark');
      assert.deepEqual(await violations(page), []);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test('/: the scene still draws after each switch, with no WebGL error', async () => {
  // A phone screen: the GL on the CPU draws it in half the time of a desktop screen.
  const { page, errors } = await visit('/', webgl, { viewport: { width: 390, height: 844 } });
  try {
    await page.waitForSelector('.scene-canvas', { timeout: 45_000, state: 'attached' });
    for (const next of [LIGHT, DARK]) {
      await visibleSwitch(page).click();
      assert.equal((await shown(page)).theme, next.theme);
      assert.ok((await sceneColours(page)) > 8, `the scene draws in the ${next.theme} theme`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
