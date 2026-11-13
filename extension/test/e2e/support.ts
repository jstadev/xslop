// Shared e2e setup: build the extension, open it in Chromium, route x.com to fixture pages and answer the X calls.
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X_MENU_SCRIPT } from '../mock-server';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const CT0 = 'e2e0csrf0token0value';
/** X user ids for the mute endpoint answers. bot2 is an account that you muted yourself before. */
export const X_IDS: Record<string, string> = { slopbot: '1001', bot2: '1002', bot3: '1003', bot4: '1004', globalslop: '1005' };
/** The handle of each id as X writes it in its answers: in the letter case that the account chose. */
const X_NAMES: Record<string, string> = {
  [X_IDS.slopbot!]: 'SlopBot', [X_IDS.bot2!]: 'Bot2', [X_IDS.bot3!]: 'Bot3', [X_IDS.bot4!]: 'Bot4', [X_IDS.globalslop!]: 'GlobalSlop',
};

export interface XCallLog { at: number; op: string; method: string; headers: Record<string, string>; body: string; url: string }
export interface XAnswer { status: number; json: unknown }

export interface Extension {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  close(): Promise<void>;
}

/** Builds the extension for this API origin and loads it in a fresh Chromium profile, with an X login cookie. `phone`: a touch screen, as a phone browser has. */
export async function launchExtension(apiOrigin: string, phone = false): Promise<Extension> {
  const out = await mkdtemp(join(tmpdir(), 'xslop-e2e-build-'));
  execFileSync(process.execPath, ['build.mjs', '--out', out, '--test'], { cwd: root, env: { ...process.env, XSLOP_API: apiOrigin }, stdio: 'pipe' });
  const profile = await mkdtemp(join(tmpdir(), 'xslop-e2e-'));
  const dir = join(out, 'chrome');
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: phone,
    isMobile: phone,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  await ctx.addCookies([{ name: 'ct0', value: CT0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' }]);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  return {
    ctx,
    sw,
    extId: new URL(sw.url()).host,
    async close() {
      await ctx.close();
      await rm(profile, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    },
  };
}

/** The fixture page with the stand-in for X's own menu script added, optionally with handles renamed. */
export async function fixturePage(name: string, rewrite: (html: string) => string = (h) => h): Promise<string> {
  const html = rewrite(await readFile(join(root, 'test/fixtures', name), 'utf8'));
  return html.replace('</body>', `<script>${X_MENU_SCRIPT}</script></body>`);
}

/** A timeline of minimal tweets with ids 5000, 5001, ..., one for each handle. */
function timeline(handles: string[]): string {
  const cell = (h: string, i: number): string =>
    `<div data-testid="cellInnerDiv"><article data-testid="tweet"><div data-testid="User-Name"><a href="/${h}">${h}</a></div>` +
    `<a href="/${h}/status/${5000 + i}"><time datetime="2026-11-07T09:10:00.000Z"></time></a>` +
    `<div data-testid="tweetText">post ${i}</div><div role="group"><button>x</button></div></article></div>`;
  return `<!DOCTYPE html><html><body style="background-color: rgb(0, 0, 0);"><div id="layers"></div>${handles.map(cell).join('')}</body></html>`;
}

export const LIMIT_PAGE_TWEETS = 31;

/** Routes x.com: API calls are logged and answered, /home and the status page come from the fixtures, /limit and /timeline/<a,b> are generated. */
export async function routeX(ctx: BrowserContext, calls: XCallLog[], answers: XAnswer[], rewrite?: (html: string) => string): Promise<void> {
  await ctx.route('https://x.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith('/i/api/')) {
      const op = url.pathname.includes('/create.') ? 'create' : url.pathname.includes('/destroy.') ? 'destroy' : 'ids';
      calls.push({ at: Date.now(), op, method: req.method(), headers: req.headers(), body: req.postData() ?? '', url: req.url() });
      if (op === 'ids') return route.fulfill({ json: { ids: [X_IDS.bot2], next_cursor: 0, next_cursor_str: '0', previous_cursor_str: '0' } });
      const answer = answers.shift();
      if (answer) return route.fulfill({ status: answer.status, json: answer.json });
      // X answers with the account that it muted: the user id that the call names, else the id of the handle.
      const form = new URLSearchParams(req.postData() ?? '');
      const name = form.get('screen_name') ?? '';
      const id = form.get('user_id') ?? X_IDS[name] ?? '1999';
      return route.fulfill({ json: { id_str: id, screen_name: X_NAMES[id] ?? name } });
    }
    const html = (body: string) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    if (url.pathname === '/limit') return html(timeline(Array.from({ length: LIMIT_PAGE_TWEETS }, (_, i) => `lim${i}`)));
    if (url.pathname.startsWith('/timeline/')) return html(timeline(url.pathname.slice('/timeline/'.length).split(',')));
    if (url.pathname === '/home') return html(await fixturePage('home.html', rewrite));
    if (url.pathname.startsWith('/alice/status/100')) return html(await fixturePage('status.html', rewrite));
    return route.fulfill({ status: 404, body: 'not routed' });
  });
}

export const openPage = async (ctx: BrowserContext, path: string): Promise<Page> => {
  const page = await ctx.newPage();
  await page.goto(`https://x.com${path}`);
  return page;
};

/** The article of a tweet id. */
export const tweet = (page: Page, id: string) => page.locator(`article[data-testid="tweet"]:has(a[href$="/status/${id}"] time)`);
export const cellOf = (page: Page, id: string) => page.locator(`[data-testid="cellInnerDiv"]:has(a[href$="/status/${id}"] time)`);
