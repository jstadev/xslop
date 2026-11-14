// Landing page and its pages end to end: real build, real CSP, mocked API. Covers layout, live data, the scene, its
// new starts and the static page, the thread, the download page, error states, the handle lookup and a full appeal round trip with proof of work.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { chromium, webkit, type Browser, type BrowserContextOptions } from 'playwright';
import { chosenTheme, DIST, horizontalOverflow, open, sceneColours, serve, WEBGL_ARGS, type Watched } from './helpers.ts';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_UA = `${CHROME_UA} Edg/130.0.0.0`;
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
/** The listing that the mock latest.json names in its `store` scenario. */
const STORE_URL = 'https://chromewebstore.google.com/detail/xslop/abcdefghijklmnopabcdefghijklmnop';

// The page starts a GL on the CPU at its lowest resolution. Only the name that this GL reports changes; the GL stays real.
const REPORT_GPU = `{
  const real = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (name) {
    return name === 0x9246 ? 'Test GPU' : real.call(this, name);
  };
}`;
// A browser with no WebGL2 until the test sets window.glOff to false.
const NO_WEBGL = 'window.glOff = true; HTMLCanvasElement.prototype.getContext = ((real) => function (kind, ...rest) { return window.glOff && kind.startsWith("webgl") ? null : real.call(this, kind, ...rest); })(HTMLCanvasElement.prototype.getContext);';
// Every start of the scene fails until the test sets window.failStarts to false: the scene reads a lost context while it builds.
const FAIL_STARTS = 'window.failStarts = true; WebGL2RenderingContext.prototype.isContextLost = ((real) => function () { return window.failStarts || real.call(this); })(WebGL2RenderingContext.prototype.isContextLost);';
// Records a static layout at any time of the visit.
const WATCH_LAYOUT = `addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  const note = () => {
    if (root.classList.contains('no-scene')) root.dataset.wentStatic = 'true';
  };
  note();
  new MutationObserver(note).observe(root, { attributes: true, attributeFilter: ['class'] });
});`;
// What Brave, Firefox with fingerprint protection and a data saver report. None of it says anything about the GPU.
const LOW_POWER = 'for (const [name, value] of [["hardwareConcurrency", 2], ["deviceMemory", 0.5], ["connection", { saveData: true }]]) Object.defineProperty(navigator, name, { value });';
// The page must behave the same in an automated browser. A build that reads navigator.webdriver fails the slow device test.
const NOT_WEBDRIVER = 'Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });';
// Counts the GL contexts that the page makes. A second getContext call on one canvas returns the same context.
const COUNT_GL = `{
  const seen = new Set();
  window.glContexts = 0;
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const context = real.call(this, kind, ...rest);
    if (context && String(kind).startsWith('webgl') && !seen.has(context)) {
      seen.add(context);
      window.glContexts++;
    }
    return context;
  };
}`;

let browser: Browser;
let webgl: Browser;

before(async () => {
  // The static page is only for a browser with no WebGL2, so the tests of that page run in one.
  browser = await chromium.launch({ args: ['--disable-webgl2'] });
  webgl = await chromium.launch({ args: WEBGL_ARGS });
});

after(async () => {
  await browser.close();
  await webgl.close();
});

/** Opens the page in a browser that reports a GPU. The first navigation only gives the page watcher the right origin. */
async function openScene(url: string, options: BrowserContextOptions = {}, prepare?: (page: Watched['page']) => Promise<unknown>): Promise<Watched> {
  const watched = await open(webgl, `${url}/favicon.svg`, options);
  await watched.page.addInitScript(REPORT_GPU);
  await prepare?.(watched.page);
  await watched.page.goto(`${url}/`, { waitUntil: 'load' });
  return watched;
}

async function sceneRunning(page: Watched['page']): Promise<void> {
  await page.waitForSelector('.scene-canvas', { timeout: 45_000, state: 'attached' });
}

/** Closes every page of the scene browser, then the server. A failed check then cannot leave a page open, which keeps the server from closing. */
async function closeScene(server: { close: () => Promise<unknown> }): Promise<void> {
  for (const context of webgl.contexts()) await context.close();
  await server.close();
}

const hasScene = (page: Watched['page']): Promise<boolean> => page.evaluate(() => document.documentElement.classList.contains('has-scene'));
const wentStatic = (page: Watched['page']): Promise<boolean> => page.evaluate(() => document.documentElement.dataset.wentStatic === 'true');
const canvasWidth = (page: Watched['page']): Promise<number> => page.locator('.scene-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width);

/** Scrolls from the end of the bridge into the drain act, 8 px per frame, and returns the largest move of the picture between two frames, as a share of
 * the screen height. The place of the picture is the centre of its light on the GL canvas, on the dark page. */
function largestPictureStep(page: Watched['page']): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const SIZE = 96;
        const top = document.querySelector('.drain-track')!.getBoundingClientRect().top + window.scrollY;
        const end = top + window.innerHeight * 0.25;
        const copy = document.createElement('canvas');
        copy.width = copy.height = SIZE;
        const ctx = copy.getContext('2d', { willReadFrequently: true })!;
        let y = top - window.innerHeight * 0.8;
        // The scene follows the scroll with a delay, so it gets frames to arrive at the start.
        let settle = 40;
        let last = NaN;
        let worst = 0;
        window.scrollTo(0, y);
        const tick = (): void => {
          if (settle-- > 0) {
            requestAnimationFrame(tick);
            return;
          }
          ctx.drawImage(document.querySelector<HTMLCanvasElement>('.scene-canvas')!, 0, 0, SIZE, SIZE);
          const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
          let light = 0;
          let weighted = 0;
          for (let i = 0; i < data.length; i += 4) {
            const value = data[i]! + data[i + 1]! + data[i + 2]!;
            light += value;
            weighted += value * Math.floor(i / 4 / SIZE);
          }
          const centre = weighted / light / SIZE;
          if (Number.isFinite(centre) && Number.isFinite(last)) worst = Math.max(worst, Math.abs(centre - last));
          last = centre;
          if (y >= end) {
            resolve(worst);
            return;
          }
          y = Math.min(end, y + 8);
          window.scrollTo(0, y);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** A tall page in a software renderer: each step gets time to draw, so scroll-driven code really runs. */
async function walkPage(page: Watched['page']): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 800) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
}

/** The box that the words of the end statement cover, in viewport px. The element itself is as high as the last screen. */
function statementWords(page: Watched['page']): Promise<{ x: number; y: number; top: number; bottom: number }> {
  return page.locator('#end-statement .end-part').evaluateAll((parts) => {
    const boxes = parts.map((part) => part.getBoundingClientRect());
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return { x: (Math.min(...boxes.map((box) => box.left)) + Math.max(...boxes.map((box) => box.right))) / 2, y: (top + bottom) / 2, top, bottom };
  });
}

describe('layout', () => {
  for (const width of [375, 1440]) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${width} px ${theme}: no horizontal scroll, no console errors, no outside requests`, async () => {
        const server = await serve();
        try {
          const { page, errors, outside } = await open(browser, `${server.url}/`, { viewport: { width, height: 900 }, ...chosenTheme(server.url, theme) });
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'the saved choice decides, not the system');
          await page.locator('#stats dd[data-stat="confirmed"]').filter({ hasText: '812' }).waitFor();
          await walkPage(page);
          assert.equal(await horizontalOverflow(page), 0, 'page must not scroll sideways');
          assert.deepEqual(errors, []);
          assert.deepEqual(outside, []);
          await page.context().close();
        } finally {
          await server.close();
        }
      });
    }
  }

  test('the numbers are the first thing on the page, above the headline', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { viewport: { width: 375, height: 812 } });
      await page.locator('#stats dd[data-stat="confirmed"]').filter({ hasText: '812' }).waitFor();
      const strip = await page.locator('.pulse').boundingBox();
      const title = await page.locator('#hero-title').boundingBox();
      assert.ok(strip && title);
      assert.ok(strip.y + strip.height <= title.y, 'numbers above the headline');
      assert.ok(strip.y + strip.height <= 812, 'numbers in the first screen');
      for (const key of ['confirmed', 'flagged', 'votes', 'installs']) {
        assert.equal(await page.locator(`#stats dd[data-stat="${key}"]`).isVisible(), true, key);
      }
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  for (const width of [375, 1000, 1440]) {
    test(`${width} px: a failed stats call keeps the strip height, so the headline does not move`, async () => {
      const tops: number[] = [];
      for (const stats of ['ok', 'down', 'limited'] as const) {
        const server = await serve({ stats });
        try {
          const { page } = await open(browser, `${server.url}/`, { viewport: { width, height: 900 } }, [/503|429/]);
          if (stats === 'ok') await page.locator('#stats dd[data-stat="confirmed"]').filter({ hasText: '812' }).waitFor();
          else await page.locator('#stats-updated', { hasText: 'unavailable' }).waitFor();
          tops.push((await page.locator('#hero-title').boundingBox())?.y ?? -1);
          await page.context().close();
        } finally {
          await server.close();
        }
      }
      for (const top of tops) assert.ok(Math.abs(top - (tops[0] ?? 0)) <= 2, `headline moved: ${tops.join(' vs ')}`);
    });
  }

  test('320 px: the headline keeps its two lines', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { viewport: { width: 320, height: 700 } });
      const heights = await page.locator('.title-line').evaluateAll((lines) => lines.map((line) => line.getBoundingClientRect().height));
      assert.equal(heights.length, 2);
      assert.equal(heights[0], heights[1], `line heights: ${heights.join(', ')}`);
      assert.equal(await horizontalOverflow(page), 0);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the page links to the Sloppers list', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`);
      assert.ok((await page.locator('a[href="/sloppers"]').count()) >= 3);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

const FOOTER_PAGES = [
  ['How it works', '/how-it-works'],
  ['The rules', '/rules'],
  ['Download', '/download'],
  ['Check a handle', '/check'],
  ['Privacy', '/privacy'],
  ['Questions', '/questions'],
  ['Sloppers', '/sloppers'],
] as const;

describe('pages', () => {
  test('the landing page ends with the footer: no section nav, the pages are linked only from the footer', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      assert.equal(await page.locator('.clean-nav, #how, #rules, #install, #appeal, #privacy, #faq').count(), 0, 'the sections left the landing page');
      const links = page.locator('footer nav[aria-label="Footer"] a');
      assert.deepEqual(await links.allTextContents(), FOOTER_PAGES.map(([text]) => text));
      assert.deepEqual(await links.evaluateAll((els) => els.map((el) => el.getAttribute('href'))), FOOTER_PAGES.map(([, href]) => href));
      for (const [, href] of FOOTER_PAGES.filter(([, href]) => href !== '/sloppers' && href !== '/download')) assert.equal(await page.locator(`a[href="${href}"]`).count(), 1, `${href} is linked once, from the footer`);
      assert.equal(await page.locator('a[href="/download"]').count(), 3, 'the header button, the install button of the last act and the footer: the hero and the thread head have no button');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the install buttons lead to the download page', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      assert.deepEqual(await page.locator('a.btn-primary').evaluateAll((els) => els.map((el) => [el.textContent?.trim(), el.getAttribute('href')])), [['Install', '/download'], ['Install xslop', '/download']]);
      await page.locator('a.btn-primary').first().click();
      await page.waitForURL('**/download');
      await page.locator('#install-version', { hasText: 'Version' }).waitFor();
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  for (const [text, href] of FOOTER_PAGES.filter(([, href]) => href !== '/sloppers')) {
    for (const width of [375, 1440]) {
      test(`${href} at ${width} px: one heading, the footer, no horizontal scroll, no errors, no outside requests`, async () => {
        const server = await serve();
        try {
          const { page, errors, outside } = await open(browser, `${server.url}${href}`, { viewport: { width, height: 900 } });
          assert.equal(await page.locator('h1').count(), 1);
          assert.equal(await page.locator('footer nav[aria-label="Footer"] a').count(), FOOTER_PAGES.length);
          assert.equal(await horizontalOverflow(page), 0, 'page must not scroll sideways');
          assert.equal(await page.locator('.brand').getAttribute('href'), '/');
          assert.equal((await page.title()).length > 0, true, `${text} has a title`);
          assert.deepEqual(errors, []);
          assert.deepEqual(outside, []);
          await page.context().close();
        } finally {
          await server.close();
        }
      });
    }
  }

  test('old links with the anchors of the moved sections land on their new pages', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      for (const [from, to] of [
        ['/#appeal', '/check'],
        ['/?appeal=somebody#appeal', '/check?appeal=somebody'],
        ['/#install', '/download'],
        ['/#how', '/how-it-works'],
        ['/#rules', '/rules'],
        ['/#privacy', '/privacy'],
        ['/#faq', '/questions'],
      ] as const) {
        await page.goto('about:blank');
        await page.goto(`${server.url}${from}`);
        const target = new URL(to, server.url);
        await page.waitForURL((url) => url.pathname === target.pathname && url.search === target.search, { timeout: 10_000 });
      }
      await page.goto('about:blank');
      await page.goto(`${server.url}/#unknown`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      assert.equal(new URL(page.url()).pathname, '/', 'an unknown anchor stays on the landing page');
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('the first paint stays small', () => {
  test('three.js is one lazy chunk, and first-paint JS is under 60 KB gzip', () => {
    const assets = join(DIST, 'assets');
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const entries = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]!);
    assert.ok(entries.length > 0, 'the page has entry scripts');
    for (const name of entries) assert.doesNotMatch(readFileSync(join(assets, name), 'utf8'), /WebGLRenderer/, `${name} carries three.js`);
    const gzip = entries.reduce((total, name) => total + gzipSync(readFileSync(join(assets, name))).length, 0);
    assert.ok(gzip <= 60 * 1024, `first-paint JS is ${gzip} bytes gzip`);
    const lazy = readdirSync(assets).filter((name) => name.endsWith('.js') && !entries.includes(name) && readFileSync(join(assets, name), 'utf8').includes('WebGLRenderer'));
    assert.equal(lazy.length, 1, `three.js chunks: ${lazy.join(', ')}`);
  });
});

describe('live data', () => {
  test('stats come from the API', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`);
      assert.equal(await page.locator('dd[data-stat="installs"]').textContent(), '1,904');
      assert.equal(await page.locator('#stats dd[data-stat="sightings"]').count(), 0, 'no replies observed stat');
      assert.equal(await page.locator('dd[data-stat="votes"]').textContent(), '15,230');
      assert.equal(await page.locator('#stats-updated').textContent(), '', 'the status line says nothing while the numbers are fine');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the rules come from /api/v1/criteria', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/rules`);
      await page.locator('#criteria-body dt', { hasText: 'Which votes count more' }).waitFor();
      assert.equal(await page.locator('#criteria-body dt', { hasText: 'Appeals' }).count(), 1);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('without the criteria the plain rules in the HTML stay', async () => {
    const server = await serve({ criteria: 'down' });
    try {
      const { page, errors } = await open(browser, `${server.url}/rules`, {}, [/503/]);
      await page.locator('#criteria-body dt', { hasText: 'Standing and checks decide' }).waitFor();
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  // SPEC 13: a new install's mark hides and mutes at once and counts for the shared list after a person or standing;
  // reply timing is checked by the server and changes no status; a signal carries one handle and two post ids.
  test('the public pages state the v2 rules and drop the v1 ones', async () => {
    const server = await serve({ criteria: 'down' });
    try {
      const { page, errors } = await open(browser, `${server.url}/rules`, {}, [/503/]);
      const text = async (path: string) => {
        await page.goto(`${server.url}${path}`, { waitUntil: 'networkidle' });
        for (const details of await page.locator('details').all()) await details.evaluate((el) => ((el as HTMLDetailsElement).open = true));
        return page.locator('main').innerText();
      };
      const rules = await text('/rules');
      assert.match(rules, /A mark from a new install hides and mutes the account for you at once\. It counts for the shared list after a person approves it, or after your install earns standing/);
      assert.match(rules, /The server checks the posts on X and reads the reply time from the ids\. Reply timing never changes the status of an account\./);
      assert.doesNotMatch(rules, /same text under many posts|generic wording|confirmed only when raters/i);
      assert.equal(await page.locator('meta[name="description"]').getAttribute('content'), 'How an account gets on the xslop list: voters with standing, posts that the server checks, and a person who decides the rest and reads every appeal.');

      const privacy = await text('/privacy');
      assert.match(privacy, /for each reply on a post page that you open: the handle of the account that replied, the id of the reply and the id of the post it answers\./);
      assert.doesNotMatch(privacy, /fingerprint|wording scores|text length|verified badge/);

      const questions = await text('/questions');
      assert.match(questions, /Marks from new installs wait for a person, and an automatic listing also needs voters with standing and posts that the server checked\./);
      assert.doesNotMatch(questions, /have to agree first/);

      assert.match(await text('/how-it-works'), /it gets added to the drain after a check\./);
      await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
      assert.match((await page.locator('meta[name="description"]').getAttribute('content')) ?? '', /Accounts that a person or voters with a track record confirm join a shared list\.$/);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('real accounts lead to /sloppers, as links with their handle', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      const links = page.locator('#drain-accounts a');
      await links.first().waitFor({ state: 'attached' });
      assert.equal(await links.count(), 14);
      const href = (await links.first().getAttribute('href')) ?? '';
      assert.match(href, /^\/sloppers\?q=[a-z0-9_]{1,15}$/);
      assert.match((await links.first().textContent()) ?? '', /^@[a-z0-9_]{1,15}$/);
      const letters = await page.locator('#drain-accounts .drain-monogram').evaluateAll((els) => els.map((el) => [el.textContent, el.getAttribute('data-initial')]));
      assert.ok(letters.length > 0, 'the mock list has an account without a picture');
      for (const [text, initial] of letters) {
        assert.equal(text, '', 'a letter inside the link would have to be part of its accessible name');
        assert.match(initial ?? '', /^[A-Z0-9_]$/);
      }
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('an empty or failing list shows no accounts and no error', async () => {
    for (const sloppers of ['empty', 'down'] as const) {
      const server = await serve({ sloppers });
      try {
        const { page, errors } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' }, [/503/]);
        assert.equal(await page.locator('#drain-accounts a').count(), 0);
        assert.equal(await page.locator('#drain-accounts').isVisible(), false);
        assert.deepEqual(errors, []);
        await page.context().close();
      } finally {
        await server.close();
      }
    }
  });

  test('API down: clear text, no invented numbers', async () => {
    const server = await serve({ stats: 'down', latest: 'down' });
    try {
      const { page, errors } = await open(browser, `${server.url}/`, {}, [/503/]);
      assert.match((await page.locator('#stats-updated').textContent()) ?? '', /^Live numbers are unavailable right now\. The xslop server has a problem right now\./);
      assert.equal(await page.locator('#stats').isVisible(), false);
      assert.equal(await page.locator('#stats-updated').isVisible(), true);
      assert.deepEqual(errors, []);
      await page.goto(`${server.url}/download`, { waitUntil: 'networkidle' });
      assert.match((await page.locator('#install-version').textContent()) ?? '', /^The download list did not load\./);
      assert.equal(await page.locator('#install-now a').count(), 0);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('rate limited: the page names the wait time', async () => {
    const server = await serve({ stats: 'limited' });
    try {
      const { page } = await open(browser, `${server.url}/`, {}, [/429/]);
      assert.match((await page.locator('#stats-updated').textContent()) ?? '', /Try again in 2 minutes\.$/);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('download', () => {
  test('the latest version comes from latest.json', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/download`);
      assert.equal(await page.locator('#install-version').textContent(), 'Version 1.0.0');
      assert.equal(await page.locator('h1').textContent(), 'Download xslop');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  async function detected(options: BrowserContextOptions, overrides: Parameters<typeof serve>[0] = {}, setup?: (page: Watched['page']) => Promise<unknown>): Promise<{ text: string; page: Watched['page']; errors: string[]; close: () => Promise<void> }> {
    const server = await serve(overrides);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await setup?.(page);
    await page.goto(`${server.url}/download`, { waitUntil: 'networkidle' });
    await page.locator('#install-version', { hasText: 'Version' }).waitFor();
    return {
      text: (await page.locator('#install-now').textContent()) ?? '',
      page,
      errors,
      close: async () => {
        await context.close();
        await server.close();
      },
    };
  }

  /** The cards of one list: the name of each browser and whether the card is marked as the visitor's browser. */
  const cards = (page: Watched['page'], list: 'supported' | 'soon') =>
    page.locator(`#${list}-list > li`).evaluateAll((els) => els.map((el) => [el.querySelector('h3')?.textContent, el.classList.contains('is-yours') && el.textContent?.includes('Your browser')]));

  test('Chrome without a store URL: the zip is the main way, with its SHA-256, and nothing names the Chrome Web Store', async () => {
    const { text, page, errors, close } = await detected({ userAgent: CHROME_UA });
    try {
      assert.match(text, /You are on Chrome\./);
      assert.match(text, /chrome:\/\/extensions/);
      assert.match(text, /Load unpacked/);
      const zip = page.locator('#install-now a[download]');
      assert.equal(await zip.getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip');
      assert.match((await zip.getAttribute('class')) ?? '', /btn-primary/, 'the zip is the main action');
      assert.match((await page.locator('#install-now .sha').textContent()) ?? '', /^SHA-256 [0-9a-f]{64}$/);
      assert.equal(await page.locator('#install-now button', { hasText: 'Copy SHA-256' }).count(), 1);
      assert.equal(await page.locator('#install-now li', { hasText: 'chrome://extensions' }).locator('button', { hasText: 'Copy' }).count(), 1);
      assert.equal(await page.locator('.store-badge, a[href*="chromewebstore"], a[href*="addons.mozilla.org"]').count(), 0, 'no store button without a store URL');
      assert.doesNotMatch(await page.locator('main').innerText(), /Web Store/);
      assert.deepEqual(await cards(page, 'supported'), [['Chrome', true], ['Brave', false], ['Vivaldi', false], ['Arc', false], ['Edge', false], ['Opera', false]]);
      assert.deepEqual(await cards(page, 'soon'), [['Firefox', false], ['Firefox for Android', false], ['Safari', false]]);
      // Each card holds its zip, and its steps and SHA-256 one click away.
      const edge = page.locator('#browser-edge');
      assert.equal(await edge.locator('a[download]').getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip');
      assert.match((await edge.locator('a[download]').getAttribute('class')) ?? '', /btn-quiet/, 'the hero has the one main action');
      await edge.locator('summary', { hasText: 'How to install' }).click();
      await edge.locator('code', { hasText: 'edge://extensions' }).waitFor();
      assert.match((await edge.locator('.sha').textContent()) ?? '', /^SHA-256 [0-9a-f]{64}$/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });

  test('Chrome with a store URL: the official badge links to the listing, and the zip is the second way', async () => {
    const { text, page, close } = await detected({ userAgent: CHROME_UA }, { latest: 'store' });
    try {
      const badge = page.locator('#install-now a.store-badge');
      assert.equal(await badge.getAttribute('href'), STORE_URL);
      assert.equal(await badge.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await badge.getAttribute('aria-label'), 'Available in the Chrome Web Store');
      assert.equal(await badge.evaluate((el) => getComputedStyle(el).backgroundImage.includes('chrome-web-store')), true, 'the official badge picture');
      assert.match(text, /Or install the zip yourself/);
      const zip = page.locator('#install-now a[download]');
      assert.equal(await zip.getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip');
      assert.match((await zip.getAttribute('class')) ?? '', /btn-quiet/, 'the zip is the quiet second way');
      const [badgeBox, zipBox] = await Promise.all([badge.boundingBox(), zip.boundingBox()]);
      assert.ok(badgeBox && zipBox && badgeBox.y + badgeBox.height <= zipBox.y, 'the store first, the zip below');
      // The cards of the browsers that install from the Chrome Web Store show the badge; Edge and Opera keep the zip.
      for (const id of ['chrome', 'brave', 'vivaldi', 'arc']) {
        assert.equal(await page.locator(`#browser-${id} a.store-badge`).getAttribute('href'), STORE_URL, id);
        await page.locator(`#browser-${id} summary`, { hasText: 'Or install the zip yourself' }).click();
        assert.equal(await page.locator(`#browser-${id} a[download]`).getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip', id);
      }
      for (const id of ['edge', 'opera']) {
        assert.equal(await page.locator(`#browser-${id} .store-badge`).count(), 0, id);
        assert.equal(await page.locator(`#browser-${id} a[download]`).getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip', id);
      }
    } finally {
      await close();
    }
  });

  test('Brave is told apart from Chrome by navigator.brave', async () => {
    const { text, page, close } = await detected({ userAgent: CHROME_UA }, {}, (page) => page.addInitScript('Object.defineProperty(navigator, "brave", { value: {} })'));
    try {
      assert.match(text, /You are on Brave\./);
      assert.match(text, /brave:\/\/extensions/);
      assert.deepEqual((await cards(page, 'supported')).filter(([, yours]) => yours), [['Brave', true]]);
    } finally {
      await close();
    }
  });

  test('Edge: the zip with edge://extensions, and no Chrome Web Store badge even with a store URL', async () => {
    const { text, page, close } = await detected({ userAgent: EDGE_UA }, { latest: 'store' });
    try {
      assert.match(text, /You are on Edge\./);
      assert.match(text, /edge:\/\/extensions/);
      assert.equal(await page.locator('#install-now a[href*="chromewebstore"], #install-now .store-badge').count(), 0, 'Edge has a store of its own');
      assert.equal(await page.locator('#install-now a[download]').getAttribute('href'), '/downloads/xslop-chrome-v1.0.0.zip');
      assert.deepEqual((await cards(page, 'supported')).filter(([, yours]) => yours), [['Edge', true]]);
    } finally {
      await close();
    }
  });

  test('Firefox without a listing: coming soon, with the temporary zip as a small option and its restart warning', async () => {
    const { text, page, close } = await detected({ userAgent: FIREFOX_UA });
    try {
      assert.match(text, /You are on Firefox\./);
      assert.match(text, /listing is not live yet/);
      assert.match(text, /about:debugging/);
      assert.match(text, /removes a temporary add-on when it restarts/);
      assert.equal(await page.locator('#install-now a[download]').getAttribute('href'), '/downloads/xslop-firefox-v1.0.0.zip');
      assert.deepEqual(await cards(page, 'soon'), [['Firefox', true], ['Firefox for Android', false], ['Safari', false]]);
      assert.equal(await page.locator('#supported-list h3', { hasText: 'Firefox' }).count(), 0);
      const card = page.locator('#browser-firefox');
      assert.equal(await card.locator('a[download]').isVisible(), false, 'the zip is folded away');
      await card.locator('summary', { hasText: 'Try it now' }).click();
      assert.equal(await card.locator('a[download]').getAttribute('href'), '/downloads/xslop-firefox-v1.0.0.zip');
      assert.match((await card.textContent()) ?? '', /removes a temporary add-on when it restarts/);
      assert.equal(await page.locator('a[href*="addons.mozilla.org"]').count(), 0);
    } finally {
      await close();
    }
  });

  test('Firefox with a listing in latest.json: supported, with the store button and no zip', async () => {
    const { page, close } = await detected({ userAgent: FIREFOX_UA }, { latest: 'store' });
    try {
      const add = page.locator('#install-now a', { hasText: 'Add to Firefox' });
      assert.equal(await add.getAttribute('href'), 'https://addons.mozilla.org/firefox/addon/xslop/');
      assert.equal(await add.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await page.locator('#install-now a[download]').count(), 0, 'no zip when the store is live');
      assert.deepEqual(await cards(page, 'supported'), [['Chrome', false], ['Brave', false], ['Vivaldi', false], ['Arc', false], ['Edge', false], ['Opera', false], ['Firefox', true], ['Firefox for Android', false]]);
      assert.deepEqual(await cards(page, 'soon'), [['Safari', false]]);
      assert.equal(await page.locator('#browser-firefox-android a').getAttribute('href'), 'https://addons.mozilla.org/firefox/addon/xslop/');
    } finally {
      await close();
    }
  });

  test('Firefox Android says that the listing is not live, without a store link, and points to the computer browsers', async () => {
    const { text, page, close } = await detected({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0' });
    try {
      assert.match(text, /the xslop listing is not live yet/);
      assert.match(text, /turn on mute sync/);
      assert.deepEqual(await page.locator('#install-now a').evaluateAll((els) => els.map((el) => el.getAttribute('href'))), ['#supported']);
    } finally {
      await close();
    }
  });

  test('a phone browser without extensions: install on a computer and turn on mute sync', async () => {
    const { text, page, close } = await detected({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
    try {
      assert.match(text, /This browser cannot load extensions\. Install xslop on a computer and turn on mute sync/);
      assert.deepEqual(await page.locator('#install-now a').evaluateAll((els) => els.map((el) => el.getAttribute('href'))), ['#supported']);
      assert.equal(await page.locator('.is-yours').count(), 0);
    } finally {
      await close();
    }
  });

  test('Safari: coming soon, with the package and the route through Xcode', async () => {
    const { text, page, close } = await detected({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' });
    try {
      assert.match(text, /You are on Safari\./);
      assert.match(text, /Xcode/);
      assert.match(text, /App Store has no xslop listing/);
      assert.equal(await page.locator('#install-now a[download]').getAttribute('href'), '/downloads/xslop-safari-v1.0.0.zip');
      await page.locator('#browser-safari summary', { hasText: 'Build it yourself on a Mac' }).click();
      assert.equal(await page.locator('#browser-safari a[download]').getAttribute('href'), '/downloads/xslop-safari-v1.0.0.zip');
    } finally {
      await close();
    }
  });

  test('the open source section links to the repository and its issues', async () => {
    const { page, close } = await detected({ userAgent: CHROME_UA });
    try {
      const links = page.locator('#open-source a');
      assert.deepEqual(await links.evaluateAll((els) => els.map((el) => [el.textContent?.trim(), el.getAttribute('href'), el.getAttribute('rel')])), [
        ['Star on GitHub', 'https://github.com/jstadev/xslop', 'noopener noreferrer'],
        ['Download from GitHub', 'https://github.com/jstadev/xslop/releases/latest', 'noopener noreferrer'],
        ['Read the code', 'https://github.com/jstadev/xslop', 'noopener noreferrer'],
        ['Report a bug', 'https://github.com/jstadev/xslop/issues', 'noopener noreferrer'],
      ]);
      assert.equal(await page.locator('#open-source a svg use[href="#gh-mark"]').count(), 1, 'the GitHub mark from the page sprite');
      assert.match((await page.locator('#open-source').textContent()) ?? '', /open source under the MIT licence/);
    } finally {
      await close();
    }
  });

  test('a paint before the page script shows only the head, and the first drawing shifts nothing on screen', async () => {
    const server = await serve();
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, userAgent: CHROME_UA });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        const w = window as unknown as { shift: number };
        w.shift = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as { value: number }[]) w.shift += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(/\/assets\/download-[^/]*\.js$/, async (route) => {
        await held;
        await route.continue();
      });
      // A held module script also holds DOMContentLoaded, so the test waits for the first bytes and the painted title.
      await page.goto(`${server.url}/download`, { waitUntil: 'commit' });
      await page.locator('#install-title').waitFor();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.equal(await page.locator('#install-title').isVisible(), true);
      for (const part of ['#install-now', '#supported', '#soon', '#open-source', 'footer']) assert.equal(await page.locator(part).isVisible(), false, `${part} waits for the script`);
      release();
      await page.locator('#install-version', { hasText: 'Version' }).waitFor();
      for (const part of ['#install-now', '#supported', '#open-source']) await page.locator(part).waitFor();
      await page.waitForTimeout(300);
      assert.ok((await page.evaluate(() => (window as unknown as { shift: number }).shift)) < 0.01, 'no layout shift');
    } finally {
      await context.close();
      await server.close();
    }
  });

  test('nothing moves while latest.json loads, and a failed list leaves a finished page', async () => {
    for (const [latest, width] of [['ok', 375], ['ok', 1440], ['down', 1440]] as const) {
      const server = await serve({ latest });
      const context = await browser.newContext({ viewport: { width, height: 900 }, userAgent: CHROME_UA });
      try {
        const page = await context.newPage();
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => (release = resolve));
        await page.route('**/downloads/latest.json', async (route) => {
          await held;
          await route.continue();
        });
        await page.goto(`${server.url}/download`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        // Layout boxes: the entrance of the hero panel is a transform, and a transform moves no layout.
        const boxes = () => page.locator('#install-now, #supported, #soon, #open-source, footer').evaluateAll((els) => els.map((el) => { const e = el as HTMLElement; return [e.offsetTop, e.offsetLeft, e.offsetWidth, e.offsetHeight]; }));
        const before = await boxes();
        assert.equal(await page.locator('#install-now a[href]').count(), 0, 'no link before the list says where the zip is');
        release();
        await page.locator('#install-version', { hasText: latest === 'ok' ? 'Version' : 'did not load' }).waitFor();
        if (latest === 'ok') {
          assert.deepEqual(await boxes(), before, `${width} px: the answer moves nothing`);
        } else {
          assert.equal(await page.locator('#install-now a').count(), 0);
          assert.match((await page.locator('#install-now').textContent()) ?? '', /Reload the page to try again/);
          assert.equal(await page.locator('#supported-list > li').count(), 6, 'the browsers and their steps stay');
        }
      } finally {
        await context.close();
        await server.close();
      }
    }
  });
});

describe('the install links of the landing page', () => {
  test('Chrome with a store URL: every Install link leads to /download, and nothing on the page links to the Chrome Web Store', async () => {
    const server = await serve({ latest: 'store' });
    try {
      const { page, errors } = await open(browser, `${server.url}/`, { userAgent: CHROME_UA });
      await page.waitForTimeout(300);
      assert.deepEqual(await page.locator('a.btn-primary').evaluateAll((els) => els.map((el) => [el.textContent?.trim(), el.getAttribute('href')])), [['Install', '/download'], ['Install xslop', '/download']]);
      assert.equal(await page.locator('a[href*="chromewebstore"], .store-badge, [data-store-link]').count(), 0);
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/downloads/latest.json'))), false, 'the landing page does not ask for the download list');
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('the scene', () => {
  for (const width of [375, 1440]) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${width} px ${theme}: it runs in a real WebGL context with no errors and no outside requests`, async () => {
        const server = await serve();
        try {
          const { page, errors, outside } = await openScene(server.url, { viewport: { width, height: 900 }, ...chosenTheme(server.url, theme) });
          await sceneRunning(page);
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'the saved choice decides, not the system');
          assert.equal(await page.evaluate(() => document.documentElement.classList.contains('has-scene')), true);
          const bytes = await page.locator('.scene-canvas').screenshot();
          assert.ok(bytes.length > 4000, `the canvas drew something: ${bytes.length} bytes`);
          await walkPage(page);
          assert.equal(await horizontalOverflow(page), 0);
          assert.deepEqual(errors, []);
          assert.deepEqual(outside, []);
          await page.context().close();
        } finally {
          await server.close();
        }
      });
    }
  }

  test('the page has no pause control', async () => {
    const server = await serve();
    try {
      const { page } = await openScene(server.url);
      await sceneRunning(page);
      assert.equal(await page.locator('#motion-toggle').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^(Pause|Play)$/ }).count(), 0);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('a hit on a reply in the thread leaves the scene running with no error', async () => {
    const server = await serve();
    try {
      const { page, errors } = await openScene(server.url);
      await sceneRunning(page);
      await takeTheSwitch(page);
      await page.getByRole('button', { name: 'Mark @growth_mindset_daily as slop' }).click();
      await sceneRunning(page);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the switch clears the flood, and the flood comes back', async () => {
    const server = await serve();
    try {
      const { page, errors } = await openScene(server.url);
      await sceneRunning(page);
      await takeTheSwitch(page);
      await page.locator('#hero-switch').click();
      await page.waitForSelector('#scene[data-clean="true"]');
      await page.locator('#hero-switch').click();
      await page.waitForSelector('#scene[data-clean="false"]');
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('a switch flipped before the scene has loaded still counts when it arrives', async () => {
    const server = await serve();
    try {
      let release = (): void => undefined;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const { page } = await openScene(server.url, {}, (p) =>
        p.route('**/assets/scene-*.js', async (route) => {
          await held;
          await route.continue();
        }),
      );
      // The first press ends the demo. On a slow host the demo has already turned the switch on by then.
      await page.mouse.click(5, 5);
      if ((await page.locator('#hero-switch').getAttribute('aria-checked')) !== 'true') await page.locator('#hero-switch').click();
      release();
      await page.waitForSelector('#scene[data-clean="true"]', { timeout: 45_000 });
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('a lost GL context: the scene comes back on a new canvas and the page never shows the static layout', async () => {
    const server = await serve();
    try {
      const { page, errors } = await openScene(server.url, {}, (p) => p.addInitScript(COUNT_GL));
      await sceneRunning(page);
      assert.equal(await page.evaluate(() => (window as unknown as { glContexts: number }).glContexts), 1, 'one GL context: no second one to test the browser');
      // No restoreContext follows: this is also the context that a browser drops for good (sleep, GPU reset, too many contexts).
      await page.evaluate(() => {
        const root = document.documentElement;
        new MutationObserver(() => {
          if (root.classList.contains('no-scene')) root.dataset.wentStatic = 'true';
        }).observe(root, { attributes: true, attributeFilter: ['class'] });
        const canvas = document.querySelector<HTMLCanvasElement>('.scene-canvas')!;
        canvas.dataset.first = 'true';
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      });
      await page.waitForSelector('.scene-canvas:not([data-first])', { timeout: 45_000, state: 'attached' });
      assert.equal(await page.locator('.scene-canvas').count(), 1, 'the old canvas is gone');
      assert.equal(await hasScene(page), true);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.wentStatic), undefined, 'the layout never changed');
      assert.equal(await page.locator('#bridge-figure').isVisible(), false);
      assert.ok((await sceneColours(page)) > 8, 'the new canvas draws');
      assert.equal(await page.evaluate(() => (window as unknown as { glContexts: number }).glContexts), 2, 'one new context for the new start');
      assert.deepEqual(errors.filter((e) => !/context lost/i.test(e)), []);
    } finally {
      await closeScene(server);
    }
  });

  test('a slow device keeps the scene and gets a lower resolution, with the frame watchdog that a visitor has', async () => {
    const server = await serve();
    try {
      // A GL on the CPU at 1440 px draws a few frames per second: this is a real slow device.
      const { page } = await openScene(server.url, {}, (p) => p.addInitScript(NOT_WEBDRIVER));
      await sceneRunning(page);
      assert.equal(await canvasWidth(page), 1440, 'the scene starts at full resolution');
      await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.scene-canvas')?.width === 720 || document.documentElement.classList.contains('no-scene'), undefined, { timeout: 120_000 });
      // The lowest resolution is still slow here. The scene must stay.
      await page.waitForTimeout(8000);
      assert.equal(await hasScene(page), true, 'no static page for a slow device');
      assert.equal(await canvasWidth(page), 720, 'half the resolution is the floor');
      assert.ok((await sceneColours(page)) > 8, 'the scene still draws');
    } finally {
      await closeScene(server);
    }
  });

  test('the GPU is gone after a lost context: the scene comes back on the CPU at the lowest resolution, and the layout stays', async () => {
    const server = await serve();
    try {
      const { page } = await openScene(server.url);
      await sceneRunning(page);
      assert.equal(await canvasWidth(page), 1440);
      // A browser whose GPU process failed gives the next context a GL on the CPU.
      await page.evaluate(() => {
        const reported = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (name) {
          return name === 0x9246 ? 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' : reported.call(this, name);
        };
        const canvas = document.querySelector<HTMLCanvasElement>('.scene-canvas')!;
        canvas.dataset.first = 'true';
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      });
      await page.waitForSelector('.scene-canvas:not([data-first])', { timeout: 45_000, state: 'attached' });
      assert.equal(await canvasWidth(page), 720, 'the scene on the CPU starts at half the resolution');
      assert.equal(await hasScene(page), true);
    } finally {
      await closeScene(server);
    }
  });

  test('a browser that reports 2 cores, little memory and data saving gets the scene', async () => {
    const server = await serve();
    try {
      const { page, errors } = await openScene(server.url, {}, (p) => p.addInitScript(LOW_POWER));
      await sceneRunning(page);
      assert.equal(await hasScene(page), true);
      assert.deepEqual(errors, []);
    } finally {
      await closeScene(server);
    }
  });

  test('the scene file fails to load twice: the scene comes back on a new URL, with no reload and no static page', async () => {
    const server = await serve();
    try {
      const requests: string[] = [];
      const { page } = await openScene(server.url, {}, async (p) => {
        await p.addInitScript(WATCH_LAYOUT);
        await p.route('**/assets/scene-*.js*', (route) => (requests.push(new URL(route.request().url()).search) <= 2 ? route.abort() : route.continue()));
      });
      await page.evaluate(() => (document.documentElement.dataset.sameDocument = 'true'));
      await sceneRunning(page);
      // A second import() of one URL makes no request in any browser, so each new try has its own URL.
      assert.deepEqual(requests, ['', '?retry=1', '?retry=2']);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.sameDocument), 'true', 'no reload');
      assert.equal(await hasScene(page), true);
      assert.equal(await wentStatic(page), false, 'the layout never changed');
    } finally {
      await closeScene(server);
    }
  });

  test('the scene file never loads: the page keeps the layout of the scene and keeps trying with a growing wait', async () => {
    const server = await serve();
    try {
      const times: number[] = [];
      const { page } = await openScene(server.url, {}, async (p) => {
        await p.addInitScript(WATCH_LAYOUT);
        await p.route('**/assets/scene-*.js*', (route) => {
          times.push(Date.now());
          return route.abort();
        });
      });
      await page.evaluate(() => (document.documentElement.dataset.sameDocument = 'true'));
      // Tries at 0, 1, 3 and 7 seconds, then one every 8 seconds.
      await page.waitForTimeout(9000);
      assert.ok(times.length >= 3 && times.length <= 5, `${times.length} tries in 9 seconds`);
      const waits = times.slice(1).map((time, i) => time - times[i]!);
      for (let i = 1; i < waits.length; i++) assert.ok(waits[i]! > waits[i - 1]!, `the wait grows: ${waits.join(', ')} ms`);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.sameDocument), 'true', 'no reload');
      assert.equal(await hasScene(page), true);
      assert.equal(await wentStatic(page), false, 'no static page');
    } finally {
      await closeScene(server);
    }
  });

  test('a scene that fails 5 starts in a row keeps the layout, keeps trying and runs when a start works', async () => {
    const server = await serve();
    try {
      let failed = 0;
      const { page } = await openScene(server.url, {}, async (p) => {
        await p.addInitScript(WATCH_LAYOUT);
        await p.addInitScript(FAIL_STARTS);
        p.on('console', (message) => {
          if (message.text().includes('the scene did not start')) failed++;
        });
      });
      // Waits of 1, 2, 4 and 8 seconds lie between the 5 starts.
      for (let waited = 0; failed < 5 && waited < 90; waited++) await page.waitForTimeout(1000);
      assert.ok(failed >= 5, `${failed} failed starts`);
      assert.equal(await hasScene(page), true);
      assert.equal(await page.locator('.scene-canvas').count(), 0, 'no canvas of a failed start stays');
      await page.evaluate(() => ((window as unknown as { failStarts: boolean }).failStarts = false));
      await sceneRunning(page);
      assert.ok((await sceneColours(page)) > 8, 'the scene draws');
      assert.equal(await wentStatic(page), false, 'no static page at any time');
    } finally {
      await closeScene(server);
    }
  });

  test('the flood runs behind the intro box: the scene cuts no hole behind a pane of glass', async () => {
    const server = await serve();
    try {
      const { page } = await openScene(server.url, { viewport: { width: 1440, height: 778 }, colorScheme: 'dark' });
      await sceneRunning(page);
      const box = await page.locator('.flood-step').first().boundingBox();
      assert.ok(box);
      // Only the canvas stays, so the picture shows what the scene draws behind the box.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('main, .strip')) el.style.visibility = 'hidden';
      });
      await page.waitForTimeout(1500);
      const bytes = await page.screenshot({ clip: { x: box.x + 24, y: box.y + 16, width: box.width - 48, height: box.height - 32 } });
      assert.ok(bytes.length > 6000, `cards behind the box: ${bytes.length} bytes (a hole of one colour is under 1000)`);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('a visitor who asks for reduced motion gets the same page: the scene, the word change and the switch demo', async () => {
    const server = await serve();
    try {
      const context = await webgl.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.addInitScript(REPORT_GPU);
      await page.goto(`${server.url}/`, { waitUntil: 'load' });
      await sceneRunning(page);
      assert.equal(await hasScene(page), true);
      assert.equal(await page.locator('#bridge-figure').isVisible(), false, 'no static diagram');
      await page.locator('#hero-title .swap-word.is-swapped').waitFor({ timeout: 30_000 });
      const checked = await page.locator('#hero-switch').getAttribute('aria-checked');
      await page.waitForFunction((first) => document.querySelector('#hero-switch')?.getAttribute('aria-checked') !== first, checked, { timeout: 30_000 });
      // The setting can also change during the visit. Nothing follows it.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(1000);
      assert.equal(await page.locator('.scene-canvas').count(), 1);
      assert.equal(await hasScene(page), true);
    } finally {
      await closeScene(server);
    }
  });

  test('1356 x 626: a scroll into the drain act moves the picture without a jump', async () => {
    const server = await serve();
    try {
      const { page } = await openScene(server.url, { viewport: { width: 1356, height: 626 }, colorScheme: 'dark' });
      await sceneRunning(page);
      const step = await largestPictureStep(page);
      // The old camera changed its formula at one stage: the picture moved 59 px of 626 (0.09) between two frames.
      assert.ok(step < 0.04, `the picture moved ${(step * 626).toFixed(0)} px between two frames`);
    } finally {
      await closeScene(server);
    }
  });

  for (const [width, height] of [[1440, 778], [390, 844]] as const) {
    test(`${width} px: at the end of the scroll the statement stands in the centre of the last screen`, async () => {
      const server = await serve();
      let watched: Watched | undefined;
      try {
        watched = await openScene(server.url, { viewport: { width, height } });
        const { page, errors } = watched;
        await sceneRunning(page);
        assert.equal(await page.locator('#end-statement').textContent(), 'X is for the people, not bots');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - 2 * window.innerHeight));
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#end-statement')?.style.opacity === '0', undefined, { timeout: 45_000 });
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#end-statement')!).opacity === '1', undefined, { timeout: 45_000 });

        const words = await statementWords(page);
        const screen = await page.evaluate(() => {
          const strip = document.querySelector('.strip')!;
          return { top: getComputedStyle(strip).position === 'sticky' ? strip.getBoundingClientRect().bottom : 0, bottom: document.querySelector('#clean')!.getBoundingClientRect().top };
        });
        assert.ok(Math.abs(words.x - width / 2) <= 2, `centre x ${words.x}`);
        assert.ok(Math.abs(words.y - (screen.top + screen.bottom) / 2) <= 2, `centre y ${words.y}, the screen above the footer is ${screen.top} to ${screen.bottom}`);
        const button = await page.locator('.drain-link').boundingBox();
        assert.ok(button && words.bottom < button.y, 'the statement stays clear of the buttons');
        const logo = await page.locator('#end-statement .x-logo svg').boundingBox();
        assert.ok(logo && logo.width > 20, 'the X of the statement is the X logo');
        assert.doesNotMatch((await page.locator('footer').textContent()) ?? '', /for the people/);
        assert.equal(await horizontalOverflow(page), 0);
        assert.deepEqual(errors, []);
      } finally {
        await watched?.page.context().close();
        await server.close();
      }
    });
  }

  test('the drain: an account that cannot be seen is out of the tab order, and the button stays clickable', async () => {
    const server = await serve();
    try {
      const { page, errors } = await openScene(server.url, { viewport: { width: 375, height: 812 } });
      await sceneRunning(page);
      const first = page.locator('#drain-accounts li').first();
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#drain-accounts li')?.style.visibility === 'hidden', undefined, { timeout: 45_000 });
      await first.locator('a').evaluate((link: HTMLElement) => link.focus());
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'A', 'a hidden account takes no focus');

      await page.evaluate(() => {
        const track = document.querySelector<HTMLElement>('.drain-track')!;
        window.scrollTo(0, track.getBoundingClientRect().top + window.scrollY + track.offsetHeight * 0.12);
      });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#drain-accounts li')?.style.visibility === 'visible', undefined, { timeout: 45_000 });
      assert.equal(await first.locator('a').getAttribute('aria-label')?.then((name) => name?.startsWith('@')), true, 'a face alone still has a name');
      for (const link of await page.locator('.drain-link a').all()) await link.click({ trial: true, timeout: 15_000 });
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('phones', () => {
  const SIZES = [[320, 568], [360, 740], [390, 844], [430, 932], [667, 375], [844, 390]] as const;
  let safari: Browser;

  before(async () => {
    safari = await webkit.launch();
  });

  after(async () => {
    await safari.close();
  });

  async function phone(engine: 'Chromium' | 'WebKit', url: string, width: number, height: number): Promise<Watched['page']> {
    const context = await (engine === 'WebKit' ? safari : webgl).newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.addInitScript(REPORT_GPU);
    await page.goto(`${url}/`, { waitUntil: 'load' });
    await sceneRunning(page);
    return page;
  }

  for (const engine of ['Chromium', 'WebKit'] as const) {
    for (const [width, height] of SIZES) {
      test(`${engine} ${width} x ${height}: the scene runs, the page does not scroll sideways and each control is a 44 px target`, async () => {
        const server = await serve();
        try {
          const page = await phone(engine, server.url, width, height);
          await walkPage(page);
          assert.equal(await hasScene(page), true);
          assert.equal(await horizontalOverflow(page), 0, 'no sideways scroll');
          assert.notEqual(await page.locator('.strip').evaluate((el) => getComputedStyle(el).position), 'sticky', 'no strip over the pinned acts');
          assert.equal(await page.locator('.strip-nav .btn-primary').isVisible(), true, 'the Install button shows on the narrowest phone too');
          // The walk turned xslop on in the thread, so the folded rows show their buttons too. The footer has its own tests.
          // The size is the laid-out one: an account that falls into the drain shrinks on its way.
          const small = await page
            .locator('main')
            .locator('a, button')
            .filter({ visible: true })
            .evaluateAll((els: HTMLElement[]) =>
              els.filter((el) => !el.closest('footer') && (el.offsetWidth < 44 || el.offsetHeight < 44)).map((el) => `${el.className || el.textContent}: ${el.offsetWidth} x ${el.offsetHeight}`),
            );
          assert.deepEqual(small, []);
        } finally {
          for (const context of [...webgl.contexts(), ...safari.contexts()]) await context.close();
          await server.close();
        }
      });
    }
  }

  test('a phone that turns: the canvas takes the new screen and the caption of the bridge stays in step with the scroll', async () => {
    const server = await serve();
    try {
      const page = await phone('Chromium', server.url, 390, 844);
      // The caption that the scroll position asks for, from the layout of the page (story.ts and story-page.ts hold the same numbers).
      const captionInStep = (): Promise<unknown> =>
        page.waitForFunction(() => {
          const track = document.querySelector('.bridge-track')!.getBoundingClientRect();
          const vh = document.querySelector('.bridge-pin')!.getBoundingClientRect().height;
          const progress = (-track.top - vh * 0.25) / (track.height - vh * 1.15);
          const shown = [...document.querySelectorAll('[data-step-text]')].findIndex((el) => el.classList.contains('is-active'));
          return shown === [0.1, 0.46, 0.86].filter((at) => progress >= at).length;
        });
      await page.evaluate(() => window.scrollTo(0, document.querySelector('.bridge-track')!.getBoundingClientRect().top + window.scrollY + window.innerHeight * 2));
      await page.locator('[data-step-text="2"].is-active').waitFor();
      await captionInStep();
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.scene-canvas')?.width === 844, undefined, { timeout: 45_000 });
      assert.equal(await page.locator('.scene-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.height), 390);
      await captionInStep();
      assert.equal(await horizontalOverflow(page), 0);
    } finally {
      await closeScene(server);
    }
  });
});

describe('fallbacks', () => {
  async function staticPage(reason: string, opened: (url: string) => Promise<Watched>): Promise<void> {
    const server = await serve();
    try {
      const { page, errors } = await opened(server.url);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('no-scene')), true, reason);
      assert.equal(await page.locator('.scene-canvas').count(), 0, `${reason}: no canvas`);
      assert.equal(await page.locator('#bridge-figure').isVisible(), true, `${reason}: the diagram replaces the scene`);
      for (const text of ['Each dot represents an xslop user', 'Accounts are being marked on one end', 'Consensus has been reached']) {
        assert.equal(await page.getByText(text).isVisible(), true, `${reason}: ${text}`);
      }
      assert.equal(await page.locator('#end-statement').evaluate((el) => getComputedStyle(el).opacity), '1', `${reason}: the end statement shows`);
      assert.ok(Math.abs((await statementWords(page)).x - 720) <= 2, `${reason}: the end statement is centred`);
      const threeLoaded = await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /\/assets\/scene-/.test(r.name)));
      assert.equal(threeLoaded, false, `${reason}: three.js stays unloaded`);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  }

  test('no WebGL2 gets the static page and never loads three.js', () => staticPage('no WebGL2', (url) => openScene(url, {}, (page) => page.addInitScript(NO_WEBGL))));

  test('no WebGL2 at load, WebGL2 later in the visit: the static page changes to the scene', async () => {
    const server = await serve();
    try {
      const { page } = await openScene(server.url, {}, (p) => p.addInitScript(NO_WEBGL));
      await page.waitForFunction(() => document.documentElement.classList.contains('no-scene'));
      assert.equal(await page.locator('#bridge-figure').isVisible(), true);
      await page.evaluate(() => ((window as unknown as { glOff: boolean }).glOff = false));
      await sceneRunning(page);
      assert.equal(await hasScene(page), true);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('no-scene')), false);
      assert.equal(await page.locator('#bridge-figure').isVisible(), false, 'the scene replaces the diagram');
    } finally {
      await closeScene(server);
    }
  });

  test('a GL on the CPU at load runs the scene, at the lowest resolution', async () => {
    const server = await serve();
    try {
      // No REPORT_GPU: the page reads the real name of the software GL.
      const { page, errors } = await open(webgl, `${server.url}/`);
      await sceneRunning(page);
      assert.equal(await hasScene(page), true);
      assert.equal(await canvasWidth(page), 720, 'half the resolution');
      assert.ok((await sceneColours(page)) > 8, 'the scene draws');
      assert.deepEqual(errors, []);
    } finally {
      await closeScene(server);
    }
  });

  test('the diagram switches between both cases', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      await page.getByRole('button', { name: 'One side piles on' }).click();
      assert.equal(await page.locator('#bridge-verdict').textContent(), 'Only one side votes. The account stays off the list.');
      await page.getByRole('button', { name: 'Both sides mark it' }).click();
      assert.equal(await page.locator('#bridge-verdict').textContent(), 'Both sides call it slop. The account is confirmed.');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('without JavaScript every word is there and no dead control shows', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
      assert.equal(await page.locator('h1').textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim()), 'Hide AI slop on X');
      assert.equal(await page.locator('#hero-title .x-logo svg').isVisible(), true);
      assert.equal(await page.locator('#thread .rcard').filter({ visible: true }).count(), 11);
      assert.equal(await page.locator('#hero-switch').isVisible(), false);
      assert.equal(await page.locator('#thread-control').isVisible(), false);
      assert.equal(await page.locator('.pulse').isVisible(), false, 'no numbers that can never load');
      await page.goto(`${server.url}/download`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('#install noscript').count(), 1);
      await page.goto(`${server.url}/check`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('#appeal noscript').count(), 1);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('landing page polish', () => {
  async function landing(options: BrowserContextOptions = {}): Promise<{ page: Watched['page']; close: () => Promise<void> }> {
    const server = await serve();
    const { page } = await open(browser, `${server.url}/`, { viewport: { width: 1440, height: 778 }, reducedMotion: 'reduce', colorScheme: 'dark', ...options });
    await page.locator('#stats dd[data-stat="confirmed"]').filter({ hasText: '812' }).waitFor();
    return {
      page,
      close: async () => {
        await page.context().close();
        await server.close();
      },
    };
  }

  const scrollTo = (page: Watched['page'], selector: string, offset: number): Promise<void> =>
    page.evaluate(([sel, extra]) => window.scrollTo(0, document.querySelector(sel as string)!.getBoundingClientRect().top + window.scrollY + (extra as number)), [selector, offset]);

  test('the tagline reads "Think Community Notes, but for slop."; the status line, the contract list and the hide button are gone', async () => {
    const { page, close } = await landing();
    try {
      assert.equal(await page.locator('.flood-tag').textContent(), 'Think Community Notes, but for slop.');
      assert.equal(await page.locator('#flood-status, .contract, #flood-hide, #clean-rail').count(), 0);
    } finally {
      await close();
    }
  });

  test('the intro is three boxes, each with a rounded edge at low opacity and a soft inner shadow', async () => {
    const { page, close } = await landing();
    try {
      const styles = await page.locator('.flood-lead > .flood-step').evaluateAll((els) =>
        els.map((el) => {
          const css = getComputedStyle(el);
          return { width: css.borderTopWidth, radius: parseFloat(css.borderTopLeftRadius), color: css.borderTopColor, shadow: css.boxShadow, top: el.getBoundingClientRect().top };
        }),
      );
      assert.equal(styles.length, 3);
      for (const style of styles) {
        assert.equal(style.width, '1px');
        assert.ok(style.radius >= 16, `radius ${style.radius}`);
        assert.match(style.color, /\/ 0?\.\d+\)$|rgba\(.*0\.\d+\)$/, `the edge is translucent: ${style.color}`);
        assert.match(style.shadow, /inset/, `an inner shadow: ${style.shadow}`);
      }
      assert.ok(Math.abs((styles[0]?.top ?? 0) - (styles[2]?.top ?? 99)) < 1, 'a desktop shows the three boxes side by side');
    } finally {
      await close();
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: every box is a pane of glass with a soft blue edge and a soft shadow, and none has an opaque fill`, async () => {
      // The system asks for the other theme; a light page comes only from the visitor's click on the switch.
      const { page, close } = await landing({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
      try {
        if (theme === 'light') await page.locator('[data-theme-toggle]').filter({ visible: true }).first().click();
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
        // The colours move to the new theme in a CSS transition; read them when it ends.
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)));
        const panes =await page.locator('.flood-step, #hero-switch, .river-head, .column, .bridge-toggle, .drain-link .btn-quiet').evaluateAll((els) =>
          els.map((el) => {
            const css = getComputedStyle(el);
            return { name: el.className, radius: parseFloat(css.borderTopLeftRadius), edge: css.borderTopColor, fill: css.backgroundColor, blur: css.backdropFilter, shadow: css.boxShadow };
          }),
        );
        assert.equal(panes.length, 8);
        for (const pane of panes) {
          assert.ok(pane.radius >= 16, `${pane.name}: radius ${pane.radius}`);
          assert.match(pane.edge, / 26[45](?:\.\d+)? \/ 0?\.\d+\)$/, `${pane.name}: the edge is the accent blue (hue 265) at low opacity: ${pane.edge}`);
          assert.match(pane.fill, /\/ 0?\.\d+\)$/, `${pane.name}: the fill lets the scene through: ${pane.fill}`);
          assert.match(pane.blur, /blur\(/, `${pane.name}: ${pane.blur}`);
          // A shadow can have layers (pin 331: contact, fade, top light). Each outer layer drops straight down; the widest one is soft.
          const outer = pane.shadow.split(/,(?![^(]*\))/).filter((layer) => !layer.includes('inset')).map((layer) => [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])));
          assert.ok(outer.length > 0 && outer.every(([x]) => x === 0) && Math.max(...outer.map(([, , blur]) => blur ?? 0)) >= 12, `${pane.name}: a soft drop shadow: ${pane.shadow}`);
        }
        const tag = await page.locator('.flood-tag').evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.equal(tag, 'rgba(0, 0, 0, 0)', 'the tagline has no fill');
        // Pin 355: the bridge captions are only text, with no box. The caption styles apply while the scene runs.
        await page.evaluate(() => document.documentElement.classList.add('has-scene'));
        const captions = await page.locator('[data-step-text]').evaluateAll((els) =>
          els.map((el) => {
            const css = getComputedStyle(el);
            return [css.backgroundColor, css.borderTopWidth, css.backdropFilter, css.boxShadow, css.paddingTop].join(' | ');
          }),
        );
        assert.deepEqual(captions, Array(4).fill('rgba(0, 0, 0, 0) | 0px | none | none | 0px'), 'the bridge captions have no box');
      } finally {
        await close();
      }
    });
  }

  test('the strip shows no status text while the numbers are fine', async () => {
    const { page, close } = await landing();
    try {
      assert.equal(await page.locator('#stats-updated').textContent(), '');
      assert.equal(await page.locator('#stats-updated').evaluate((el) => el.getBoundingClientRect().height), 0);
    } finally {
      await close();
    }
  });

  test('the strip sticks at the top from 1400 px and scrolls away on a narrow screen', async () => {
    for (const [width, sticks] of [[1440, true], [1000, false], [390, false]] as const) {
      const { page, close } = await landing({ viewport: { width, height: 778 } });
      try {
        await page.evaluate(() => window.scrollTo(0, 1500));
        assert.equal(await page.locator('.strip').evaluate((el) => getComputedStyle(el).position), sticks ? 'sticky' : 'relative', `${width} px`);
        const box = await page.locator('.strip').boundingBox();
        assert.ok(box);
        if (sticks) {
          assert.equal(box.y, 0, 'the strip stays at the top');
          assert.ok(box.height <= 64, `strip height ${box.height}`);
          assert.notEqual(await page.locator('.strip').evaluate((el) => getComputedStyle(el).backdropFilter), 'none', 'content that scrolls under it is blurred');
        } else {
          assert.ok(box.y < 0, `${width} px: the strip scrolled away`);
        }
      } finally {
        await close();
      }
    }
  });

  test('the thread head is a glass card with a rounded low-opacity edge, and it stays beside the column', async () => {
    const { page, close } = await landing();
    try {
      const style = await page.locator('.river-head').evaluate((el) => {
        const css = getComputedStyle(el);
        return { radius: parseFloat(css.borderTopLeftRadius), blur: css.backdropFilter, position: css.position, width: css.borderTopWidth };
      });
      assert.ok(style.radius >= 16);
      assert.match(style.blur, /blur/);
      assert.equal(style.position, 'sticky');
      assert.equal(style.width, '1px');
      // With xslop on the folded column is lower than the head card, so the card has no room to stick. The open column is the case to test.
      await takeTheSwitch(page);
      await scrollTo(page, '#thread-replies', 120);
      const head = await page.locator('.river-head').boundingBox();
      assert.ok(head && head.y >= 60 && head.y <= 120, `the head stays in view under the strip: y ${head?.y}`);
    } finally {
      await close();
    }
  });

  test('the middle of the screen in the thread turns xslop on, and the visitor keeps their own choice', async () => {
    const { page, close } = await landing();
    try {
      const hero = page.locator('#hero-switch');
      assert.equal(await hero.getAttribute('aria-checked'), 'false');
      await scrollTo(page, '#thread', 300);
      await page.waitForFunction(() => document.querySelector('#hero-switch')?.getAttribute('aria-checked') === 'true');
      assert.equal(await page.locator('#thread .hidden-bar').filter({ visible: true }).count(), 7, 'the template replies are folded');
      await page.locator('#thread-switch').click();
      assert.equal(await hero.getAttribute('aria-checked'), 'false', 'the visitor turned it off');
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollTo(page, '#thread', 300);
      await page.waitForTimeout(600);
      assert.equal(await hero.getAttribute('aria-checked'), 'false', 'it does not turn itself on again');
    } finally {
      await close();
    }
  });

  test('the demo does not turn xslop off again while the screen middle is in the thread', async () => {
    const server = await serve();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
      await page.locator('#hero-switch').waitFor();
      await scrollTo(page, '#thread', 300);
      await page.waitForFunction(() => document.querySelector('#hero-switch')?.getAttribute('aria-checked') === 'true');
      await page.waitForTimeout(9000);
      assert.equal(await page.locator('#hero-switch').getAttribute('aria-checked'), 'true');
    } finally {
      await context.close();
      await server.close();
    }
  });

  test('the account on the bridge has a default picture and a rounded edge at low opacity', async () => {
    const { page, close } = await landing();
    try {
      await page.evaluate(() => document.documentElement.classList.add('has-scene'));
      const account = await page.locator('#bridge-account').evaluate((el) => {
        const css = getComputedStyle(el);
        return { radius: parseFloat(css.borderTopLeftRadius), width: css.borderTopWidth, pfp: el.querySelectorAll('.avatar-default svg use').length, letters: el.querySelector('.avatar')?.textContent?.trim() };
      });
      assert.equal(account.pfp, 1);
      assert.equal(account.letters, '');
      assert.equal(account.width, '1px');
      assert.ok(account.radius >= 16);
    } finally {
      await close();
    }
  });

  test('each profile in the drain sits in a pill with a rounded edge at low opacity', async () => {
    const { page, close } = await landing();
    try {
      await page.locator('#drain-accounts a').first().waitFor({ state: 'attached' });
      const pills = await page.locator('#drain-accounts a').evaluateAll((els) =>
        els.map((el) => {
          const css = getComputedStyle(el);
          return { width: css.borderTopWidth, radius: parseFloat(css.borderTopLeftRadius), fill: css.backgroundColor };
        }),
      );
      assert.equal(pills.length, 14);
      for (const pill of pills) {
        assert.equal(pill.width, '1px');
        assert.ok(pill.radius >= 22, `radius ${pill.radius}`);
        assert.notEqual(pill.fill, 'rgba(0, 0, 0, 0)', 'each pill has a fill');
      }
    } finally {
      await close();
    }
  });

  test('the landing page ends with the footer, with no clean thread and no statement in it', async () => {
    const { page, close } = await landing();
    try {
      assert.equal(await page.locator('.clean-thread, .clean-person').count(), 0);
      const foot = await page.locator('#clean .site-foot').boundingBox();
      assert.ok(foot && foot.height <= 200, `the footer is ${foot?.height} px high`);
      assert.doesNotMatch((await page.locator('footer').textContent()) ?? '', /for the people/);
      const [nav, legal] = await Promise.all([page.locator('.clean .foot-nav').boundingBox(), page.locator('.clean .foot-meta > p').boundingBox()]);
      assert.ok(nav && legal);
      assert.ok(nav.y + nav.height <= legal.y, 'the links sit above the X Corp line');
      assert.equal(await horizontalOverflow(page), 0);
    } finally {
      await close();
    }
  });

  for (const [width, height] of [[1440, 778], [390, 844]] as const) {
    test(`${width} px without the scene: the statement stands at the end of the page, centred, between the drain and the footer`, async () => {
      const { page, close } = await landing({ viewport: { width, height } });
      try {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const statement = page.locator('#end-statement');
        assert.equal(await statement.textContent(), 'X is for the people, not bots');
        assert.equal(await statement.evaluate((el) => getComputedStyle(el).opacity), '1');
        assert.ok((await statement.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 28, 'a display line');
        const words = await statementWords(page);
        assert.ok(Math.abs(words.x - width / 2) <= 2, `centre x ${words.x}`);
        const [button, foot] = await Promise.all([page.locator('.drain-link').boundingBox(), page.locator('#clean .site-foot').boundingBox()]);
        assert.ok(button && foot);
        assert.ok(button.y + button.height <= words.top && words.bottom <= foot.y, 'below the drain, above the footer');
        assert.ok(words.top >= 0 && foot.y + foot.height <= height + 1, 'on the last screen of the page');
        const logo = await statement.locator('.x-logo svg').boundingBox();
        assert.ok(logo && logo.width > 20, 'the X of the statement is the X logo');
        assert.equal(await horizontalOverflow(page), 0);
      } finally {
        await close();
      }
    });
  }

  test('the statement is on the landing page once, and no footer of the site has it', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      const count = (): Promise<number> => page.evaluate(() => (document.body.textContent ?? '').split('for the people').length - 1);
      assert.equal(await count(), 1);
      assert.equal(await page.locator('footer #end-statement, .foot-statement').count(), 0);
      for (const [, href] of FOOTER_PAGES) {
        await page.goto(`${server.url}${href}`, { waitUntil: 'networkidle' });
        assert.equal(await count(), 0, href);
      }
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

/** The page turns xslop on by itself when the screen middle reaches the thread. Do that first, then turn it off as a visitor: from then on the switch only follows the visitor. */
async function takeTheSwitch(page: Watched['page']): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#thread-replies')!.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2));
  await page.waitForFunction(() => document.querySelector('#thread-switch')?.getAttribute('aria-checked') === 'true');
  await page.locator('#thread-switch').click();
  await page.waitForFunction(() => document.querySelector('#thread-switch')?.getAttribute('aria-checked') === 'false');
}

describe('thread', () => {
  test('the xslop switch folds the template replies and keeps the replies from people', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/`, { viewport: { width: 375, height: 812 } });
      const thread = page.locator('#thread');
      const toggle = page.locator('#thread-switch');
      const bars = thread.locator('.hidden-bar').filter({ visible: true });
      const cards = thread.locator('.rcard').filter({ visible: true });
      await takeTheSwitch(page);
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await cards.count(), 11);
      assert.equal(await bars.count(), 0);
      assert.match((await thread.locator('.river-count').textContent()) ?? '', /31 of 35 replies say nothing/);

      await toggle.focus();
      await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('#hero-switch').getAttribute('aria-checked'), 'true', 'both switches follow one state');
      assert.equal(await toggle.locator('.xs-switch-state').textContent(), 'On');
      assert.equal(await bars.count(), 7);
      for (const text of await bars.locator('.bar-label').allTextContents()) assert.match(text, /^Hidden reply from @[a-z0-9_]{16,}$/);
      assert.equal(await cards.count(), 4, 'the 4 replies from people stay open');
      for (const text of await cards.locator('.rcard-text').allTextContents()) assert.ok(text.trim(), 'each open reply has text');
      assert.deepEqual(await cards.locator('.post-handle').allTextContents(), ['@devon_debugs_offline_sync', '@priya_on_conflict_bugs', '@marco_ships_mobile_apps', '@aiko_reads_the_source'], 'the open replies are the 4 from people');
      assert.equal(await page.locator('#thread-more-text').textContent(), '24 more template replies, hidden');
      assert.equal(await page.locator('#thread-status').textContent(), 'xslop is on. 31 template replies fold to one line each. The 4 replies from people stay open.');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('is-clean')), true);

      // The light round the switch runs for ever, so only the fold counts.
      await page.waitForFunction(() => document.getAnimations().every((a) => a instanceof CSSAnimation || a.playState !== 'running'));
      const boxes = await thread.locator('#thread-replies > li, #thread-more').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
      for (let i = 1; i < boxes.length; i++) assert.ok((boxes[i]?.[0] ?? 0) >= (boxes[i - 1]?.[1] ?? 0) - 1, `row ${i} overlaps the row above`);

      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await cards.count(), 11);
      assert.equal(await bars.count(), 0);
      assert.equal(await page.locator('#thread-more-text').textContent(), '+ 24 more template replies');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'thread-switch', 'focus stays on the switch');
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the headline reads "Hide AI slop on X" with the X logo, and the hero switch folds the thread', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`);
      const title = page.locator('#hero-title');
      assert.equal(await title.textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim()), 'Hide AI slop on X', 'the name of the heading stays X');
      const logo = await title.locator('.x-logo svg').boundingBox();
      assert.ok(logo && logo.width > 40 && logo.height > 40, 'the X logo is drawn at the size of the letters');
      await page.locator('#hero-switch').click();
      assert.equal(await title.textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim()), 'Hide AI slop on X', 'the switch leaves the headline alone');
      assert.equal(await page.locator('#thread .hidden-bar').filter({ visible: true }).count(), 7);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('the headline word pixelates into "bots" and back, and the heading still reads "Hide AI slop on X"', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/`, { colorScheme: 'dark' });
      const word = page.locator('#hero-title .swap-word');
      const inked = () => page.locator('#hero-title .swap-canvas').evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
      await page.locator('#hero-title .swap-word.is-swapped').waitFor({ timeout: 6_000 });
      assert.equal(await inked(), true, 'the canvas draws the change over the hidden word');
      // A new size while "bots" shows draws it again in the heading colour, never in the hidden word's transparent one.
      await page.waitForTimeout(1_100);
      await page.setViewportSize({ width: 1440, height: 820 });
      await page.waitForTimeout(400);
      const light = await page.locator('#hero-title .swap-canvas').evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200) (sum += Math.max(d[i]!, d[i + 1]!, d[i + 2]!), n++);
        return n ? sum / n : -1;
      });
      assert.ok(light > 128, `dark page, light word on the canvas: ${light}`);
      await page.getByRole('heading', { level: 1, name: 'Hide AI slop on X' }).waitFor();
      assert.equal(await page.locator('h1').textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim()), 'Hide AI slop on X');
      await page.waitForFunction(() => !document.querySelector('#hero-title .swap-word')?.classList.contains('is-swapped'), null, { timeout: 8_000 });
      assert.equal(await inked(), false, 'back on "slop", the HTML word shows and the canvas is empty');
      assert.equal(await word.evaluate((el) => getComputedStyle(el).color === getComputedStyle(el.parentElement!).color), true);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('"bots" in the last line pixelates into "AI" and back, and the line still reads "X is for the people, not bots"', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/`);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const inked = () => page.locator('#end-statement .swap-canvas').evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
      await page.locator('#end-statement .swap-word.is-swapped').waitFor({ timeout: 8_000 });
      assert.equal(await inked(), true, 'the canvas draws the change over the hidden word');
      assert.equal(await page.locator('#end-statement').textContent(), 'X is for the people, not bots');
      await page.waitForFunction(() => !document.querySelector('#end-statement .swap-word')?.classList.contains('is-swapped'), null, { timeout: 8_000 });
      assert.equal(await inked(), false, 'back on "bots", the HTML word shows and the canvas is empty');
      assert.equal(await horizontalOverflow(page), 0);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  describe('the hero demo', () => {
    // Records the time of every change of the hero switch, from the first paint on, in real time.
    const RECORD_FLIPS = `window.__flips = []; addEventListener('DOMContentLoaded', () => new MutationObserver(() => window.__flips.push(performance.now())).observe(document.querySelector('#hero-switch'), { attributes: true, attributeFilter: ['aria-checked'] }));`;

    async function demoPage(options: BrowserContextOptions = {}): Promise<{ page: Watched['page']; flips: () => Promise<number[]>; close: () => Promise<void> }> {
      const server = await serve();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      const page = await context.newPage();
      await page.addInitScript(RECORD_FLIPS);
      await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
      await page.locator('#hero-switch').waitFor();
      return {
        page,
        flips: () => page.evaluate(() => (window as unknown as { __flips: number[] }).__flips),
        close: async () => {
          await context.close();
          await server.close();
        },
      };
    }

    test('the switch turns on and off every 4 seconds, and the other switch and the thread follow', async () => {
      const { page, flips, close } = await demoPage();
      try {
        await page.waitForFunction(() => (window as unknown as { __flips: number[] }).__flips.length >= 2, null, { timeout: 15_000 });
        const [first = 0, second = 0] = await flips();
        assert.ok(second - first > 3700 && second - first < 4600, `flips ${second - first} ms apart`);
        assert.equal(await page.locator('#hero-switch').getAttribute('aria-checked'), 'false', 'on, then off again');
        await page.waitForFunction(() => (window as unknown as { __flips: number[] }).__flips.length >= 3, null, { timeout: 8000 });
        assert.equal(await page.locator('#hero-switch').getAttribute('aria-checked'), 'true');
        assert.equal(await page.locator('#thread-switch').getAttribute('aria-checked'), 'true');
        assert.equal(await page.locator('#thread .hidden-bar').filter({ visible: true }).count(), 7);
      } finally {
        await close();
      }
    });

    test('a key press or a click ends it, and the visitor keeps the switch they chose', async () => {
      for (const take of [(page: Watched['page']) => page.keyboard.press('Tab'), (page: Watched['page']) => page.mouse.click(700, 120)]) {
        const { page, flips, close } = await demoPage();
        try {
          await page.waitForFunction(() => (window as unknown as { __flips: number[] }).__flips.length >= 1, null, { timeout: 10_000 });
          await take(page);
          const count = (await flips()).length;
          await page.waitForTimeout(5000);
          assert.equal((await flips()).length, count, 'no more flips after the visitor took over');
        } finally {
          await close();
        }
      }
    });

    test('it stops while the hero is off screen and starts again when the hero returns', async () => {
      const { page, flips, close } = await demoPage();
      try {
        await page.evaluate(() => window.scrollTo(0, 2400));
        await page.waitForFunction(() => window.scrollY > 1200);
        const count = (await flips()).length;
        await page.waitForTimeout(6000);
        assert.ok((await flips()).length - count <= 1, 'at most the flip that was due when the hero left');
        const frozen = (await flips()).length;
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForFunction((n) => (window as unknown as { __flips: number[] }).__flips.length > n, frozen, { timeout: 10_000 });
      } finally {
        await close();
      }
    });

    test('reduced motion: the demo runs the same', async () => {
      const { page, close } = await demoPage({ reducedMotion: 'reduce' });
      try {
        await page.waitForFunction(() => (window as unknown as { __flips: number[] }).__flips.length >= 1, null, { timeout: 10_000 });
      } finally {
        await close();
      }
    });
  });

  test('the x hides one reply, Show opens it, Undo restores it and moves focus', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/`);
      await takeTheSwitch(page);
      const row = page.locator('#thread li[data-handle="devon_debugs_offline_sync"]');
      await page.getByRole('button', { name: 'Mark @devon_debugs_offline_sync as slop' }).click();
      const bar = row.locator('.hidden-bar');
      await bar.waitFor();
      assert.match((await bar.textContent()) ?? '', /Hidden reply from @devon_debugs_offline_sync/);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Undo');
      assert.equal(await page.locator('#thread-status').textContent(), 'Hidden: @devon_debugs_offline_sync');

      await bar.getByRole('button', { name: 'Show' }).click();
      assert.equal(await row.locator('.rcard').isVisible(), true);
      await bar.getByRole('button', { name: 'Hide' }).click();
      assert.equal(await row.locator('.rcard').isVisible(), false);
      await bar.getByRole('button', { name: 'Undo' }).click();
      assert.equal(await bar.isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Mark @devon_debugs_offline_sync as slop');
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('Not slop keeps a template reply open when the switch is on', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`);
      await takeTheSwitch(page);
      await page.locator('#thread-switch').click();
      const row = page.locator('#thread li[data-handle="growth_mindset_daily"]');
      await row.getByRole('button', { name: 'Not slop' }).click();
      assert.equal(await row.locator('.rcard').isVisible(), true);
      assert.equal(await row.locator('.hidden-bar').isVisible(), false);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('reduced motion: the fold plays the same animation', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      await takeTheSwitch(page);
      await page.locator('#thread-switch').click();
      const moving = await page.locator('#thread').evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length);
      assert.ok(moving > 0, 'the rows move to their new places');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('every demo handle on the page but the ordered one is longer than X allows, so none is a real account', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      const handles = await page.locator('.post-handle').allTextContents();
      const data = await page.locator('[data-handle]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.handle ?? ''));
      assert.ok(handles.length >= 13, `only ${handles.length} handles found`);
      // The post of the thread has this one ordered handle. It is 13 characters, so it is the one exception to the rule.
      assert.equal(handles[0], '@i_am_original');
      for (const h of [...handles.slice(1).map((t) => t.replace(/^@/, '')), ...data]) assert.ok(h.length > 15, `handle too short: ${h}`);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('copy', () => {
  test('no first person and no em-dash on any page', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      for (const [, href] of FOOTER_PAGES) {
        await page.goto(`${server.url}${href}`, { waitUntil: 'networkidle' });
        // The maintainer wrote this one note on /check in the first person. It is the one exception to the rule.
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').replace('(we will never ask for your password)', '');
        assert.doesNotMatch(text, /\b(we|our|ours|us)\b/i, href);
        assert.equal(text.includes('\u2014'), false, href);
      }
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('no first person and no em-dash on the landing page', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
      // The quoted X replies of the demo thread are other people's words, as in check-build.
      let text = await page.locator('body').innerText();
      for (const quote of await page.locator('.rcard-text').allInnerTexts()) text = text.replace(quote, '');
      text = text.replace(/\s+/g, ' ');
      assert.doesNotMatch(text, /\b(we|our|ours|us)\b/i);
      assert.equal(text.includes('—'), false);
      assert.match(text, /clicking the X on a slop post or reply/, 'the reader learns what to do');
      const key = page.locator('.flood-lead .lead-key');
      const keyBox = await key.boundingBox();
      assert.ok(keyBox && keyBox.width > 20 && keyBox.width === keyBox.height, 'the real button shows in its circle');
      assert.match(text, /That account disappears for you and is muted on X/, 'the reader learns what comes out');
      assert.match(text, /Contribute to the global sloppers list and start engaging with real humans again/, 'and what their click adds');
      assert.equal(await page.locator('.flood-step:nth-child(3) strong:not(.flood-step-title)').innerText(), 'humans', 'humans is bold');
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

describe('lookup and appeal', () => {
  test('the X handle label says in small grey letters that no password is asked', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/check`);
      const note = page.locator('label[for="lookup-handle"] .field-note');
      assert.equal(await note.innerText(), '(we will never ask for your password)');
      const look = (sel: string) => page.locator(sel).evaluate((el) => { const cs = getComputedStyle(el); return { size: parseFloat(cs.fontSize), color: cs.color }; });
      const [label, aside] = [await look('label[for="lookup-handle"]'), await look('label[for="lookup-handle"] .field-note')];
      assert.ok(aside.size < label.size, `note ${aside.size}px, label ${label.size}px`);
      assert.notEqual(aside.color, label.color);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('bad handle: error text and no request', async () => {
    const server = await serve();
    try {
      const { page } = await open(browser, `${server.url}/check`);
      await page.fill('#lookup-handle', 'not a handle!');
      await page.click('#lookup-form button[type="submit"]');
      assert.equal(await page.locator('#lookup-error').textContent(), 'Type a handle of 1 to 15 letters, digits or underscores.');
      assert.equal(await page.locator('#lookup-handle').getAttribute('aria-invalid'), 'true');
      assert.equal(server.state.log.filter((l) => l.path.startsWith('/api/v1/accounts')).length, 0);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('confirmed account: facts and a link to each marked post, never the text of a vote', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/check`);
      await page.fill('#lookup-handle', '  @GrowthHacker42 ');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#account-result .account-handle').waitFor();
      assert.equal(await page.inputValue('#lookup-handle'), 'growthhacker42');
      assert.equal(await page.locator('#account-result .status').first().textContent(), 'Confirmed');
      assert.match((await page.locator('#account-result .facts').textContent()) ?? '', /Score93 of 100/);
      // The first item of the mock is an answer of the old API, with the text of the voter. The second is a new one.
      const links = await page.locator('#account-result .evidence li a').evaluateAll((els) => els.map((el) => [el.getAttribute('href'), el.getAttribute('rel'), el.getAttribute('target')]));
      assert.deepEqual(links, [
        ['https://x.com/i/status/1850000000000000001', 'noopener noreferrer', null],
        ['https://x.com/i/status/1850000000000000002', 'noopener noreferrer', null],
      ]);
      for (const item of await page.locator('#account-result .evidence li').allTextContents()) assert.match(item, /\d{4}, .* UTC/, 'each post shows its date');
      assert.equal(await page.locator('#account-result blockquote, #account-result script').count(), 0);
      assert.doesNotMatch((await page.locator('#account-result').textContent()) ?? '', /Great insight|alert/, 'the text that a voter sent never reaches the page');
      assert.equal(await page.locator('#account-result .sub-title').first().textContent(), 'Reply timing');
      assert.deepEqual(await page.locator('#account-result .signal > span:not(.signal-bar)').allTextContents(), ['Replies within a minute, of 14 that the server checked', '82%']);
      assert.equal(await page.locator('#appeal-form').isVisible(), true);
      assert.deepEqual(errors, []);

      await page.fill('#lookup-handle', 'nobody_here');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#account-result .status', { hasText: 'Not on the list' }).waitFor();
      assert.equal(await page.locator('#appeal-form').isVisible(), false, 'no appeal for an account that is not listed');

      await page.fill('#lookup-handle', 'pendingperson');
      await page.click('#lookup-form button[type="submit"]');
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('an account that is not listed shows no numbers, also when an answer carries some', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/check`);
      // A pending account: the server answers none with zeros (13.8).
      await page.fill('#lookup-handle', 'xs_pending_demo');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#account-result .status', { hasText: 'Not on the list' }).waitFor();
      const shown = async () => ({
        text: (await page.locator('#account-result').innerText()).replace('@xs_pending_demo', ''),
        parts: await page.locator('#account-result .facts, #account-result .signals, #account-result .evidence').count(),
      });
      const before = await shown();
      assert.equal(before.parts, 0);
      assert.match(before.text, /Not on the list\. xslop hides it only for people who marked it themselves\./);
      assert.doesNotMatch(before.text, /\d/, 'the page shows no number of a pending account');

      // A wrong answer with numbers for an account that is not listed: the page still shows none of them.
      await page.route(/\/api\/v1\/accounts\//, (route) =>
        route.fulfill({ json: { handle: 'xs_pending_demo', status: 'none', tier: 0, score: 71, seed: false, votes: { slop: 9, notSlop: 1 }, sightings: 12, signals: { fastReplyShare: 0.9, replies: 12 }, evidence: [{ tweetId: '1850000000000000003', at: new Date().toISOString() }], appealOpen: false } }),
      );
      await page.click('#lookup-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#lookup-form button[type="submit"]')?.getAttribute('aria-busy') === null);
      const after = await shown();
      assert.equal(after.parts, 0);
      assert.doesNotMatch(after.text, /\d/, 'no number of an unlisted account reaches the page');
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('an open appeal from another network does not lock the owner out: the form stays and the appeal goes through', async () => {
    const server = await serve();
    try {
      const { page, errors } = await open(browser, `${server.url}/check`);
      await page.fill('#lookup-handle', 'pendingperson');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#account-result', { hasText: 'An appeal for @pendingperson is open. An admin checks it by hand. If you did not send it, send your own below.' }).waitFor();
      assert.equal(await page.locator('#appeal-form').isVisible(), true);
      assert.equal(await page.locator('#appeal-form-title').textContent(), 'Appeal for @pendingperson');
      await page.fill('#appeal-message', 'This is my account. A person writes every reply.');
      await page.click('#appeal-submit');
      await page.locator('#appeal-done .appeal-code').waitFor({ timeout: 60_000 });
      assert.deepEqual(server.state.appeals.filter((a) => a.handle === 'pendingperson').map((a) => [a.network, a.status]), [['elsewhere', 'open'], ['here', 'open']]);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });

  test('appeal round trip: validation, proof of work, code, status, reload, duplicate', async () => {
    const server = await serve({ powBits: 14 });
    try {
      const { page, errors } = await open(browser, `${server.url}/check`, {}, [/409/]);
      await page.fill('#lookup-handle', 'growthhacker42');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#appeal-form').waitFor();

      await page.fill('#appeal-message', 'too short');
      await page.click('#appeal-submit');
      assert.equal(await page.locator('#appeal-message-error').textContent(), 'Write at least 20 characters (now 9).');
      await page.fill('#appeal-message', 'I write every reply myself, see my timeline.');
      await page.fill('#appeal-email', 'not-an-email');
      await page.click('#appeal-submit');
      assert.equal(await page.locator('#appeal-email-error').textContent(), 'Type a full email address, or leave the field empty.');
      assert.equal(server.state.log.filter((l) => l.path.startsWith('/api/v1/challenge')).length, 0, 'invalid input sends nothing');

      await page.fill('#appeal-email', 'owner@example.com');
      await page.click('#appeal-submit');
      const code = page.locator('#appeal-done .appeal-code');
      await code.waitFor({ timeout: 60_000 });
      const shown = (await code.textContent()) ?? '';
      assert.match(shown, /^xslop-[0-9A-F]{6}$/);
      const stored = server.state.appeals.find((a) => a.code === shown);
      assert.ok(stored, 'the server stored the appeal after verifying the proof');
      assert.equal(stored.handle, 'growthhacker42');
      assert.equal(stored.email, 'owner@example.com');
      assert.equal(stored.message, 'I write every reply myself, see my timeline.');
      await page.locator('#appeal-done .appeal-state', { hasText: 'Status: open.' }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3');

      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#appeal-done .appeal-code').textContent(), shown, 'this browser remembers the appeal');
      stored.status = 'accepted';
      stored.decidedAt = new Date().toISOString();
      await page.getByRole('button', { name: 'Check status' }).click();
      await page.locator('#appeal-done .appeal-state', { hasText: 'Status: accepted on' }).waitFor();

      await page.getByRole('button', { name: 'Forget this appeal' }).click();
      assert.equal(await page.locator('#appeal-done').isVisible(), false);
      stored.status = 'open';
      await page.fill('#lookup-handle', 'growthhacker42');
      await page.click('#lookup-form button[type="submit"]');
      await page.locator('#appeal-form').waitFor();
      await page.fill('#appeal-message', 'Second try for the same handle, please.');
      await page.click('#appeal-submit');
      await page.locator('#appeal-progress', { hasText: 'An appeal for @growthhacker42 is already open.' }).waitFor({ timeout: 60_000 });
      assert.equal(server.state.appeals.filter((a) => a.handle === 'growthhacker42').length, 1);
      assert.deepEqual(errors, []);
      await page.context().close();
    } finally {
      await server.close();
    }
  });
});

test('unknown path: 404 status and the 404 page', async () => {
  const server = await serve();
  try {
    const { page, errors } = await open(browser, `${server.url}/`, { reducedMotion: 'reduce' });
    const res = await page.goto(`${server.url}/no-such-page`, { waitUntil: 'networkidle' });
    assert.equal(res?.status(), 404);
    assert.equal(await page.locator('h1').textContent(), 'Nothing here.');
    assert.equal(await horizontalOverflow(page), 0);
    assert.deepEqual(errors.filter((e) => !/404/.test(e)), []);
    await page.context().close();
  } finally {
    await server.close();
  }
});
