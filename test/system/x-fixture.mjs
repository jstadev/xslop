// A real built extension in real Chromium, on an X-shaped fixture. Fixture pages and X's menu come from the
// extension's own test folder. X's web API is answered here, the two public fact sources of the server are answered
// by `XWorld.listen`, and every other host is cut off. Both answer from one `XWorld`, so the browser and the server
// see the same accounts, X ids and posts.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { chromium } from '../../extension/node_modules/@playwright/test/index.mjs';
import { X_MENU_SCRIPT } from '../../extension/test/mock-server.ts';
import { ROOT, run } from './harness.mjs';

export const CT0 = 'system0test0csrf0value';
/** The ms epoch of X post ids: the time of a post is in its id. */
const POST_EPOCH_MS = 1288834974657n;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** What X knows: which X id each handle has now, and who wrote each post. */
export class XWorld {
  constructor() {
    this.ids = new Map();
    this.posts = new Map();
    this.avatars = new Set();
    this.nextId = 1_880_000_000_000_000_000n;
    this.nextPost = 0n;
    /** Every request of the server: `{ host, path }`. */
    this.requests = [];
  }

  /** The X id of a handle; a new handle gets a new id. */
  idOf(handle) {
    if (!this.ids.has(handle)) this.ids.set(handle, String(this.nextId++));
    return this.ids.get(handle);
  }

  /** The handle that has this X id now, or null. */
  handleOf(id) {
    for (const [handle, x] of this.ids) if (x === id) return handle;
    return null;
  }

  /** A new post id with the time of now in it, written by `authorId`. */
  post(authorId, inReplyTo = '100') {
    const id = String(((BigInt(Date.now()) - POST_EPOCH_MS) << 22n) + this.nextPost++);
    this.posts.set(id, { authorId, inReplyTo });
    return id;
  }

  /** The stand-in of cdn.syndication.twimg.com, api.fxtwitter.com and pbs.twimg.com, on this machine over real HTTP. */
  async listen() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://stand.in');
      const [, host, ...rest] = url.pathname.split('/');
      const path = `/${rest.join('/')}`;
      this.requests.push({ host, path: `${path}${url.search}` });
      const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const missing = () => res.writeHead(404, { 'content-type': 'application/json' }).end('{"code":404}');
      if (host === 'pbs.twimg.com') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (host === 'cdn.syndication.twimg.com') {
        const id = url.searchParams.get('id');
        const p = this.posts.get(id);
        if (!p) return json({ __typename: 'TweetTombstone' });
        return json({ __typename: 'Tweet', id_str: id, in_reply_to_status_id_str: p.inReplyTo, user: { id_str: p.authorId, screen_name: this.handleOf(p.authorId) } });
      }
      if (host === 'api.fxtwitter.com' && path.startsWith('/status/')) {
        const id = path.slice('/status/'.length);
        const p = this.posts.get(id);
        if (!p) return missing();
        return json({ code: 200, tweet: { id, replying_to_status: p.inReplyTo, author: { id: p.authorId, screen_name: this.handleOf(p.authorId) } } });
      }
      if (host === 'api.fxtwitter.com') {
        const handle = path.slice(1);
        if (!this.ids.has(handle)) return missing();
        const avatar = this.avatars.has(handle) ? `https://pbs.twimg.com/profile_images/1/${handle}_normal.png` : null;
        return json({ code: 200, user: { screen_name: handle, id: this.ids.get(handle), name: `Name of ${handle}`, followers: 120, avatar_url: avatar } });
      }
      return res.writeHead(404).end();
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
  }

  /** The fetch of the X facts job: the real URL goes to the stand-in, the host becomes the first path part. */
  fetch = (url, init) => {
    const target = new URL(url);
    return fetch(`${this.origin}/${target.hostname}${target.pathname}${target.search}`, init);
  };

  close() {
    this.server?.closeAllConnections();
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }
}

async function fixturePage(file, rewrite) {
  const html = rewrite(await readFile(join(ROOT, 'extension/test/fixtures', file), 'utf8'));
  return html.replace('</body>', `<script>${X_MENU_SCRIPT}</script></body>`);
}

/** Cuts every host except this machine, so a test run can never reach the internet. */
export async function cutOffInternet(ctx) {
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:' ? route.continue() : route.abort();
  });
}

/** The fixture thread with the reply of `handle` as post `postId` (the fixture's reply 105 of @flaggedone). */
export const replyBy = (handle, postId) => (html) => html.replaceAll('flaggedone/status/105', `${handle}/status/${postId}`).replaceAll('flaggedone', handle);

/** One extension install: its own build for its own network, its own browser profile, its own view of X. */
export class Extension {
  static async launch(release, proxy, workDir, world) {
    const ext = new Extension();
    ext.proxy = proxy;
    ext.world = world;
    ext.calls = [];
    ext.pages = new Map();
    ext.gate = null;
    ext.out = await mkdtemp(join(workDir, 'ext-'));
    await run(process.execPath, ['build.mjs', '--out', ext.out, '--test'], { cwd: join(release, 'extension'), env: { ...process.env, XSLOP_API: proxy.origin } });
    const dir = join(ext.out, 'chrome');
    ext.profile = await mkdtemp(join(workDir, 'profile-'));
    ext.ctx = await chromium.launchPersistentContext(ext.profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    await ext.ctx.addCookies([{ name: 'ct0', value: CT0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' }]);
    await cutOffInternet(ext.ctx);
    await ext.ctx.route('https://x.com/**', (route) => ext.answerX(route));
    ext.sw = ext.ctx.serviceWorkers()[0] ?? (await ext.ctx.waitForEvent('serviceworker'));
    ext.id = new URL(ext.sw.url()).host;
    return ext;
  }

  /** X's web API as the logged-in user sees it: a mute answers with the account that X muted, by its current handle. */
  async answerX(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/i/api/')) {
      const op = url.pathname.includes('/create.') ? 'create' : url.pathname.includes('/destroy.') ? 'destroy' : 'ids';
      const body = request.postData() ?? '';
      this.calls.push({ op, method: request.method(), url: request.url(), headers: request.headers(), body });
      if (op === 'ids') return route.fulfill({ json: { ids: [], next_cursor: 0, next_cursor_str: '0', previous_cursor_str: '0' } });
      await this.gate;
      const form = new URLSearchParams(body);
      const name = form.get('screen_name');
      const id = name ? this.world.idOf(name) : form.get('user_id');
      return route.fulfill({ json: { id_str: id, screen_name: name ?? this.world.handleOf(id) } });
    }
    const page = this.pages.get(url.pathname + url.search);
    if (page) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await page() });
    return route.fulfill({ status: 404, body: 'not routed' });
  }

  /** While held, X receives each mute but does not answer it. Returns the function that lets X answer. */
  holdX() {
    let release;
    this.gate = new Promise((resolve) => (release = resolve));
    return () => {
      this.gate = null;
      release();
    };
  }

  async open(path, file, rewrite = (html) => html) {
    this.pages.set(path, () => fixturePage(file, rewrite));
    const page = await this.ctx.newPage();
    await page.goto(`https://x.com${path}`);
    return page;
  }

  /** The thread of the fixture with a reply of `handle` as post `postId`. */
  openReply(handle, postId) {
    return this.open(`/alice/status/100?r=${postId}`, 'status.html', replyBy(handle, postId));
  }

  stored(key) {
    return this.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
  }

  /** Fires the real list alarm now, so the worker runs the same sync as on its timer. */
  fireListAlarm() {
    return this.sw.evaluate(() => chrome.alarms.create('list', { when: Date.now() + 10 }));
  }

  /** Turns on "Mute the shared list" in the real popup page. */
  async muteSharedList() {
    const popup = await this.ctx.newPage();
    await popup.goto(`chrome-extension://${this.id}/popup.html`);
    const toggle = popup.locator('#mute');
    await toggle.waitFor({ state: 'attached' });
    if (!(await toggle.isChecked())) await popup.locator('label.switch', { has: toggle }).click();
    await popup.waitForFunction(() => document.querySelector('#mute').checked);
    await popup.close();
  }

  creates(body) {
    return this.calls.filter((c) => c.op === 'create' && c.body === body);
  }

  async close() {
    await this.ctx.close();
    await rm(this.profile, { recursive: true, force: true });
    await rm(this.out, { recursive: true, force: true });
  }
}

export const tweetOf = (page, id) => page.locator(`article[data-testid="tweet"]:has(a[href$="/status/${id}"] time)`);
export const barOf = (page, id) => page.locator(`[data-testid="cellInnerDiv"]:has(a[href$="/status/${id}"] time) .xslop-bar`);
/** The bar keeps its words in a shadow root, which innerText on the host does not read. */
export const barText = (page, id) => barOf(page, id).evaluate((bar) => bar.shadowRoot?.textContent ?? bar.textContent);
export const buttonOf = (page, id) => tweetOf(page, id).locator('.xslop-host button');
export const toastOf = (page) => page.locator('.xslop-toast [role="status"]');
