// Drives a real Firefox through geckodriver: classic WebDriver for tabs and real input, Marionette's chrome
// context for the things a page cannot see (the console service, permission prompts, stopping the event page).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { poll, sleep } from './util.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export const ADDON_ID = 'xslop@koglabs.com';
const KEYS = { Enter: '\uE007', Tab: '\uE004', Escape: '\uE00C' };
/** Firefox logs these itself when a tab closes or navigates with a message or a listener under way. The page is gone by then. */
const TEARDOWN = /^(Promise (resolved|rejected) after context unloaded|sendRemoveListener on closed conduit)/;

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

export class FirefoxDriver {
  engine = 'gecko';
  constructor(base, session, child, uuid, addonPath) {
    Object.assign(this, { base, session, child, uuid, addonPath, tab: null });
    this.origin = `moz-extension://${uuid}`;
  }

  static async launch({ binary, geckodriver, proxyPort, work, addonPath, headless = true, env = process.env, prefs = {} }) {
    const port = await freePort();
    const root = join(work, `ff-profile-${port}`);
    mkdirSync(root, { recursive: true });
    const log = openSync(join(work, `geckodriver-${port}.log`), 'a');
    const child = spawn(geckodriver, ['--host', '127.0.0.1', '--port', String(port), '--profile-root', root, '--allow-system-access', '--log', 'info'], { stdio: ['ignore', log, log], env });
    const base = `http://127.0.0.1:${port}`;
    await poll(async () => (await fetch(`${base}/status`).then((r) => r.json()).catch(() => null))?.value?.ready, { what: 'geckodriver', ms: 15_000 });
    const uuid = randomUUID();
    const started = await post(base, '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          acceptInsecureCerts: true,
          timeouts: { script: 120_000, pageLoad: 60_000 },
          'moz:firefoxOptions': {
            binary,
            args: [...(headless ? ['-headless'] : []), '-width', '1280', '-height', '900'],
            prefs: {
              // A fixed internal id, so that the test knows moz-extension://<uuid>/popup.html.
              'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: uuid }),
              'network.proxy.type': 1,
              'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': proxyPort,
              'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': proxyPort,
              'network.proxy.no_proxies_on': '', 'network.proxy.allow_hijacking_localhost': true,
              // The profile is throwaway. These keep Firefox's own update and telemetry traffic out of the proxy log.
              'app.update.enabled': false, 'datareporting.policy.dataSubmissionEnabled': false, 'browser.safebrowsing.malware.enabled': false,
              'browser.safebrowsing.phishing.enabled': false, 'extensions.getAddons.cache.enabled': false, 'network.captive-portal-service.enabled': false,
              ...prefs,
            },
          },
        },
      },
    });
    const d = new FirefoxDriver(base, started.sessionId, child, uuid, addonPath);
    d.version = started.capabilities.browserVersion;
    await d.call('/moz/addon/install', { path: addonPath, temporary: true });
    return d;
  }

  async call(path, body) {
    return post(`${this.base}/session/${this.session}`, path, body);
  }

  async get(path) {
    const j = await (await fetch(`${this.base}/session/${this.session}${path}`)).json();
    if (j.value?.error) throw new Error(`${path}: ${j.value.message}`);
    return j.value;
  }

  async tabs() {
    const out = [];
    const handles = await this.get('/window/handles');
    for (const h of handles) {
      await this.call('/window', { handle: h });
      out.push({ tab: h, url: await this.get('/url') });
    }
    this.tab = null;
    return out;
  }

  async use(tab) {
    if (tab !== this.tab) {
      await this.call('/window', { handle: tab });
      this.tab = tab;
    }
  }

  async open(url) {
    const { handle } = await this.call('/window/new', { type: 'tab' });
    await this.use(handle);
    await this.call('/url', { url });
    return handle;
  }

  async goto(tab, url) {
    await this.use(tab);
    await this.call('/url', { url });
  }

  async closeTab(tab) {
    await this.use(tab);
    const left = (await (await fetch(`${this.base}/session/${this.session}/window`, { method: 'DELETE' })).json()).value;
    this.tab = null;
    await this.use(left[0]);
  }

  /** Brings a tab to the front (only the front tab runs requestAnimationFrame). */
  async front(tab) {
    this.tab = null;
    await this.use(tab);
  }

  /** Runs `fn(ext, ...args)` in the tab. On extension pages `ext` is the page's `browser` object. */
  async run(tab, fn, ...args) {
    await this.use(tab);
    const script = `
      const args = JSON.parse(arguments[0]); const done = arguments[arguments.length - 1];
      const ext = window.browser;
      (async () => (${fn.toString()})(ext, ...args))().then(
        (v) => done({ ok: v === undefined ? null : JSON.parse(JSON.stringify(v)) }),
        (e) => done({ err: String(e) + ' ' + (e && e.stack || '') }));`;
    const r = await this.call('/execute/async', { script, args: [JSON.stringify(args)] });
    if (r.err) throw new Error(`in page: ${r.err}`);
    return r.ok;
  }

  /** Real mouse input at the centre of the first element that matches. */
  async click(tab, selector) {
    await this.use(tab);
    const el = (await this.call('/element', { using: 'css selector', value: selector }))[ELEMENT];
    await this.call('/execute/sync', { script: "arguments[0].scrollIntoView({block:'center'})", args: [{ [ELEMENT]: el }] });
    await this.call('/actions', { actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: { [ELEMENT]: el }, x: 0, y: 0 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
      ],
    }] });
    await fetch(`${this.base}/session/${this.session}/actions`, { method: 'DELETE' });
  }

  /** Real key press in the focused element of the tab. */
  async press(tab, key) {
    await this.use(tab);
    const v = KEYS[key] ?? key;
    await this.call('/actions', { actions: [{ type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }] }] });
    await fetch(`${this.base}/session/${this.session}/actions`, { method: 'DELETE' });
  }

  async shot(tab, file) {
    await this.use(tab);
    writeFileSync(file, Buffer.from(await this.get('/screenshot'), 'base64'));
  }

  /** Runs async code in the browser's own (privileged) scope. `done` is the callback argument of the script. */
  async chrome(script, ...args) {
    await this.call('/moz/context', { context: 'chrome' });
    this.tab = null;
    try {
      return await this.call('/execute/async', { script, args });
    } finally {
      await this.call('/moz/context', { context: 'content' });
    }
  }

  /** Every script error and CSP report that names this add-on, from the console service of all processes. */
  async errors() {
    const raw = await this.chrome(`
      const done = arguments[arguments.length - 1];
      done(Services.console.getMessageArray().flatMap((m) => {
        try { m.QueryInterface(Ci.nsIScriptError); } catch { return []; }
        return [{ source: m.sourceName, line: m.lineNumber, flags: m.flags, category: m.category, text: m.errorMessage }];
      }));`);
    const mine = raw.filter((m) => `${m.source} ${m.text}`.includes(this.uuid) || /xslop/i.test(m.text));
    const faults = mine.filter((m) => (m.flags & 1) === 0 && (m.flags & 8) === 0);
    this.teardownNotices = faults.filter((m) => TEARDOWN.test(m.text)).length;
    return faults.filter((m) => !TEARDOWN.test(m.text)).map((m) => `${m.category}: ${m.text} (${m.source}:${m.line})`);
  }

  /** Stops the event page the way Firefox does when it idles. The next event must wake it. */
  async stopBackground() {
    const r = await this.chrome(`
      const done = arguments[arguments.length - 1];
      const ext = WebExtensionPolicy.getByID('${ADDON_ID}').extension;
      ext.terminateBackground({ ignoreDevToolsAttached: true, disableResetIdleForTest: true }).then(() => done('stopped'), (e) => done('failed: ' + e));`);
    if (r !== 'stopped') throw new Error(`stopBackground: ${r}`);
  }

  async quit() {
    await fetch(`${this.base}/session/${this.session}`, { method: 'DELETE' }).catch(() => undefined);
    this.child.kill('SIGTERM');
    await sleep(200);
  }

  /** Waits for the extension permission prompt, then answers it. Returns the text that the user reads. */
  answerPrompt(allow) {
    return this.chrome(`
      const allow = arguments[0]; const done = arguments[arguments.length - 1];
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const end = Date.now() + 15000;
      const look = () => {
        const n = win.document.getElementById('addon-webext-permissions-notification');
        if (n && win.PopupNotifications.panel.state === 'open') {
          const lines = [...n.querySelectorAll('.popup-notification-description, li')].map((x) => x.textContent.trim()).filter(Boolean);
          (allow ? n.button : n.secondaryButton).click();
          done({ text: lines.join(' | ') });
        } else if (Date.now() > end) done({ error: 'no permission prompt within 15 s' });
        else win.setTimeout(look, 100);
      };
      look();`, allow);
  }
}

async function post(base, path, body) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (j.value?.error) throw new Error(`${path}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
