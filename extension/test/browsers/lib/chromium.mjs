// Drives a real Chromium-family browser over the DevTools pipe. No WebDriver and no Playwright, so the same
// code runs Chrome for Testing, Chromium, Edge, Brave, Opera and Vivaldi and sees service worker errors too.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { poll, sleep } from './util.mjs';

/** The id that Chromium derives from the folder of an unpacked extension: SHA-256 of the path, in the letters a to p. */
const unpackedId = (path) => [...createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 32)].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');

export class ChromiumDriver {
  engine = 'blink';
  targets = new Map();
  raw = [];
  /** How the extension got into the browser: the DevTools call, or the --load-extension switch. */
  loadedVia = '';
  #next = 1;
  #pending = new Map();
  #buffer = '';

  constructor(child, flagsAtLaunch) {
    this.child = child;
    this.flags = flagsAtLaunch;
    child.stdio[4].on('data', (chunk) => this.#onData(chunk));
    child.stdio[4].on('error', () => undefined);
    child.stdio[3].on('error', () => undefined);
  }

  static start(binary, flags, work, name) {
    const child = spawn(binary, flags, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const log = createWriteStream(join(work, `browser-${name}.log`));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    return new ChromiumDriver(child, flags);
  }

  static async launch({ binary, proxyPort, work, extDir, name }) {
    mkdirSync(work, { recursive: true });
    const profile = () => mkdtempSync(join(work, `profile-${name}-`));
    const flags = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
      '--disable-component-update', '--password-store=basic', '--use-mock-keychain', '--window-size=1280,900',
      `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    ];
    let d = ChromiumDriver.start(binary, [...flags, `--user-data-dir=${profile()}`], work, name);
    await d.#attach();
    const loaded = await d.send('Extensions.loadUnpacked', { path: extDir }).catch((e) => e);
    if (loaded instanceof Error) {
      await d.quit();
      d = ChromiumDriver.start(binary, [...flags, `--user-data-dir=${profile()}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`], work, name);
      await d.#attach();
      d.loadedVia = '--load-extension';
      d.extId = unpackedId(extDir);
    } else {
      d.loadedVia = 'Extensions.loadUnpacked';
      d.extId = loaded.id;
    }
    d.origin = `chrome-extension://${d.extId}`;
    // The browser's own component extensions run service workers too.
    await poll(() => [...d.targets.values()].some((t) => t.type === 'service_worker' && t.url.startsWith(`${d.origin}/`)), { what: 'extension service worker', ms: 20_000 });
    const info = await d.send('Browser.getVersion');
    d.version = `${info.product} (Chromium ${/Chrome\/(\d+)/.exec(info.userAgent)?.[1] ?? 'unknown'})`;
    return d;
  }

  async #attach() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      this.#pending.set(id, { resolve, reject, method });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8');
    let at;
    while ((at = this.#buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(this.#buffer.slice(0, at));
      this.#buffer = this.#buffer.slice(at + 1);
      if (msg.id) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (p) msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else this.#onEvent(msg);
    }
  }

  #onEvent({ method, params, sessionId }) {
    if (method === 'Target.attachedToTarget') {
      const { targetInfo: i, sessionId: sid } = params;
      this.targets.set(i.targetId, { id: i.targetId, type: i.type, url: i.url, session: sid });
      for (const domain of ['Runtime.enable', 'Log.enable']) void this.send(domain, {}, sid).catch(() => undefined);
      if (i.type === 'page') void this.send('Page.enable', {}, sid).catch(() => undefined);
      void this.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined);
    } else if (method === 'Target.targetInfoChanged') {
      const t = this.targets.get(params.targetInfo.targetId);
      if (t) t.url = params.targetInfo.url;
    } else if (method === 'Target.detachedFromTarget') {
      for (const [id, t] of this.targets) if (t.session === params.sessionId) this.targets.delete(id);
    } else if (method === 'Target.targetDestroyed') {
      this.targets.delete(params.targetId);
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      this.raw.push({ url: d.url ?? '', text: `${d.text} ${d.exception?.description ?? ''}`, session: sessionId });
    } else if (method === 'Log.entryAdded' && (params.entry.level === 'error' || params.entry.level === 'warning')) {
      this.raw.push({ url: params.entry.url ?? '', text: `${params.entry.level}: ${params.entry.text}`, session: sessionId });
    }
  }

  #sessionOf(tab) {
    const t = this.targets.get(tab);
    if (!t) throw new Error(`no target ${tab}`);
    return t.session;
  }

  /** Reads each URL from its page: Vivaldi reports no URL for a tab that an extension opened. */
  async tabs() {
    const pages = [...this.targets.values()].filter((t) => t.type === 'page');
    const hrefOf = (t) => Promise.race([this.run(t.id, () => location.href).catch(() => t.url), sleep(2000).then(() => t.url)]);
    return Promise.all(pages.map(async (t) => ({ tab: t.id, url: await hrefOf(t) })));
  }

  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    await poll(() => this.targets.get(targetId), { what: 'new tab', ms: 10_000 });
    await this.goto(targetId, url);
    return targetId;
  }

  async goto(tab, url) {
    const s = this.#sessionOf(tab);
    await this.send('Page.navigate', { url }, s);
    await poll(async () => (await this.run(tab, () => document.readyState).catch(() => '')) === 'complete' && this.targets.get(tab).url.split('#')[0] === url.split('#')[0],
      { what: `load of ${url}`, ms: 30_000 });
  }

  async closeTab(tab) {
    await this.send('Target.closeTarget', { targetId: tab });
  }

  async front(tab) {
    await this.send('Target.activateTarget', { targetId: tab });
    await this.send('Page.bringToFront', {}, this.#sessionOf(tab));
    // Vivaldi lays out a tab only after it comes to the front, and a click before that misses.
    await poll(() => this.run(tab, () => innerWidth > 0), { what: 'a page with a layout', ms: 5_000 });
  }

  /** Runs `fn(ext, ...args)` in the tab's main world. On extension pages `ext` is the extension API. */
  async run(tab, fn, ...args) {
    const expression = `(async () => (${fn.toString()})(globalThis.browser ?? globalThis.chrome, ...${JSON.stringify(args)}))().then((v) => JSON.stringify(v === undefined ? null : v))`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.#sessionOf(tab));
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return JSON.parse(r.result.value);
  }

  async click(tab, selector) {
    const at = await this.run(tab, (_, sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector);
    if (!at) throw new Error(`nothing matches ${selector}`);
    const s = this.#sessionOf(tab);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s);
  }

  async press(tab, key) {
    const s = this.#sessionOf(tab);
    const codes = { Enter: 13, Tab: 9, Escape: 27 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }, s);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s);
  }

  async shot(tab, file) {
    await this.front(tab);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.#sessionOf(tab));
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  /** Stops the service worker: closes its target and detaches, because a worker with a debugger on it stays alive. The next event must wake it. */
  async stopBackground() {
    const sw = [...this.targets.values()].find((t) => t.type === 'service_worker' && t.url.startsWith(this.origin));
    if (!sw) throw new Error('no service worker is running');
    await this.send('Target.closeTarget', { targetId: sw.id });
    await this.send('Target.detachFromTarget', { sessionId: sw.session }).catch(() => undefined);
    await poll(() => !this.targets.has(sw.id), { what: 'service worker stop', ms: 10_000 });
  }

  /** Script errors and warnings from this extension's own code. */
  async errors() {
    return this.raw.filter((e) => `${e.url} ${e.text}`.includes(this.extId) || /xslop/i.test(e.text)).map((e) => `${e.text} (${e.url})`);
  }

  async quit() {
    await this.send('Browser.close').catch(() => undefined);
    await sleep(200);
    this.child.kill('SIGKILL');
  }
}
