// WebKit cannot load an extension outside Safari. This check runs the real Safari bundles in Playwright's
// WebKit with a small stand-in for the `browser` object, so it proves only what the engine does: JavaScript
// and CSS of the package, WebCrypto and IndexedDB, signatures that the real server accepts. It proves
// nothing about Safari's extension system, its permission dialogs or its content script world.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { webkit } from 'playwright';
import { CT0, X_IDS } from './world.mjs';
import { poll, stepper } from './util.mjs';

const API = 'https://x-slop.com';
const X_STATUS = 'https://x.com/alice/status/100';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

/** Installs `browser` in the page. Runs in the page, before any of its scripts. */
function stub({ stored, sender }) {
  const hub = () => {
    const fns = [];
    return { addListener: (f) => fns.push(f), fns };
  };
  const area = (data) => ({
    get: async (keys) => {
      if (keys === null || keys === undefined) return { ...data };
      return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (o) => void Object.assign(data, o),
    remove: async (k) => [k].flat().forEach((x) => delete data[x]),
  });
  const alarms = new Map();
  const onMessage = hub();
  const events = { onInstalled: hub(), onStartup: hub(), onMessage };
  const sent = [];
  window.__sent = sent;
  window.__local = stored;
  window.__fire = (name, arg) => events[name].fns.forEach((f) => f(arg));
  /** Delivers a message to the page's listeners the way the browser does, and resolves with the reply. */
  window.__deliver = (msg) => new Promise((resolve) => {
    if (!onMessage.fns.some((f) => f(msg, sender, resolve) === true)) resolve(undefined);
  });
  window.browser = {
    runtime: {
      id: 'stand-in', onInstalled: events.onInstalled, onStartup: events.onStartup, onMessage,
      getURL: (p) => `${location.origin}/__ext/${p}`, getPlatformInfo: async () => ({ os: 'mac' }),
      sendMessage: async (m) => {
        sent.push(m);
        return m.t === 'muteRecord' ? { id: null, stays: false } : { ok: true };
      },
    },
    storage: { local: area(stored), session: area({}), onChanged: hub() },
    alarms: {
      get: async (n) => alarms.get(n), create: async (n, o) => void alarms.set(n, { name: n, ...o }),
      clear: async (n) => alarms.delete(n), getAll: async () => [...alarms.values()], onAlarm: hub(),
    },
    tabs: { create: async () => ({}), query: async () => [], sendMessage: async () => null, update: async () => ({}) },
    permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: hub(), onRemoved: hub() },
  };
}

export async function runWebkit({ world, pkg, config, shots, version, powBits, webBearer }) {
  const results = [];
  const step = stepper(results);
  const browser = await webkit.launch({ proxy: { server: `http://127.0.0.1:${world.proxyPort}` } });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const errors = [];
  const open = async (url, stored, sender = { id: 'stand-in' }) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
    await page.addInitScript(stub, { stored, sender });
    await page.goto(url);
    return page;
  };
  await context.route(`${API}/__ext/**`, (route) => {
    const file = new URL(route.request().url()).pathname.replace('/__ext/', '');
    route.fulfill({ body: readFileSync(join(pkg, file)), contentType: TYPES[extname(file)] ?? 'application/octet-stream' });
  });
  await context.route(`${API}/__blank`, (route) => route.fulfill({ body: '<!doctype html><title>background</title>', contentType: 'text/html' }));

  await step('page context only: the classic background script runs; WebKit proof of work and key reach the real server', async () => {
    const bg = await open(`${API}/__blank`, {}, { id: 'stand-in', tab: { id: 1 }, url: X_STATUS });
    await bg.addScriptTag({ path: join(pkg, 'background.js') });
    await bg.evaluate(() => window.__fire('onInstalled', { reason: 'install' }));
    const rows = await poll(async () => {
      const r = await world.sql('select id, ext_version from installs');
      return r.length ? r : null;
    }, { what: 'install row', ms: 240_000 });
    if (rows[0].ext_version !== version) throw new Error(`ext_version ${rows[0].ext_version}`);
    const key = await bg.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('xslop', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction('kv').objectStore('kv').get('device');
        get.onsuccess = () => resolve({ type: get.result.privateKey.type, extractable: get.result.privateKey.extractable, curve: get.result.privateKey.algorithm.namedCurve });
      };
    }));
    if (key.extractable !== false || key.curve !== 'P-256') throw new Error(`device key ${JSON.stringify(key)}`);
    const reply = await bg.evaluate((m) => window.__deliver(m), { t: 'vote', handle: 'webkitvote', value: 'slop', tweetId: '700', parentTweetId: '100', postedAt: '2026-11-01T10:00:00.000Z', context: 'reply' });
    if (reply?.ok !== true) throw new Error(`vote reply ${JSON.stringify(reply)}`);
    const vote = await poll(async () => (await world.sql("select value, tweet_id from votes where handle = 'webkitvote'"))[0], { what: 'vote row', ms: 20_000 });
    const denied = world.api.filter((a) => a.status === 401 || a.status === 403);
    if (denied.length) throw new Error(`rejected: ${JSON.stringify(denied)}`);
    await bg.close();
    return `install ${rows[0].id}, ${powBits}-bit proof; CryptoKey in IndexedDB non-extractable ${key.curve}; signed vote stored (tweet ${vote.tweet_id})`;
  });

  await step('page context only: content script on the X fixture under the X-like CSP, with a real click', async () => {
    const stored = { config, settings: { share: false }, votes: [], list: { version: 1, accounts: [['globalslop', 90, 2]] } };
    const x = await open(X_STATUS, stored, { id: 'stand-in' });
    await x.addStyleTag({ path: join(pkg, 'content.css') });
    await x.evaluate(readFileSync(join(pkg, 'content.js'), 'utf8'));
    await poll(async () => (await x.evaluate(() => document.querySelectorAll('.xslop-host').length)) >= 9, { what: 'xslop buttons', ms: 20_000 });
    const reply = 'article[data-testid="tweet"]:has(a[href$="/status/101"] time)';
    const box = await poll(() => x.locator(`${reply} .xslop-host`).boundingBox(), { what: 'button box', ms: 5_000 });
    const rootFont = await x.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    if (Math.abs(box.width - rootFont * 1.25) > 0.6) throw new Error(`button width ${box.width} at root font ${rootFont}: the shadow CSS did not apply`);
    await poll(() => x.evaluate(() => document.querySelector('[data-testid="cellInnerDiv"]:has(a[href$="/status/104"] time)')?.getAttribute('data-xslop-cell') === 'collapsed'), { what: 'list hide of @globalslop', ms: 10_000 });
    const from = world.x.length;
    await x.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const call = await poll(() => world.x.slice(from).find((c) => c.op === 'create'), { what: 'X create call', ms: 15_000 });
    const h = call.headers;
    if (call.body !== 'screen_name=slopbot' || h['x-csrf-token'] !== CT0 || h.authorization !== `Bearer ${webBearer}` || h.origin !== 'https://x.com') throw new Error(`X call ${JSON.stringify({ body: call.body, origin: h.origin })}`);
    if (!/(^|; )auth_token=/.test(h.cookie ?? '')) throw new Error('the X call had no session cookie');
    await poll(() => x.evaluate(() => document.querySelector('[data-testid="cellInnerDiv"]:has(a[href$="/status/101"] time)')?.getAttribute('data-xslop-cell') === 'collapsed'), { what: 'collapse after the click', ms: 8_000 });
    const sent = await poll(async () => {
      const list = await x.evaluate(() => window.__sent);
      const muted = list.find((m) => m.t === 'muted');
      return muted && list.some((m) => m.t === 'vote') ? muted : null;
    }, { what: 'vote and mute report', ms: 8_000 });
    if (sent.id !== X_IDS.slopbot) throw new Error(`mute report ${JSON.stringify(sent)}`);
    await x.screenshot({ path: join(shots, 'x-status.png') });
    await x.close();
    return `button ${box.width}px in a closed shadow root, list hide, trusted click, X call with cookies, mute id ${sent.id}`;
  });

  await step('page context only: popup and onboarding render with their CSS', async () => {
    const list = { version: 1, accounts: [['globalslop', 90, 2]] };
    const popup = await open(`${API}/__ext/popup.html`, { config, list, settings: {} });
    await poll(() => popup.evaluate(() => document.getElementById('stat-list').textContent === '1'), { what: 'list count', ms: 8_000 });
    const view = await popup.evaluate(() => ({
      headline: document.getElementById('headline').textContent,
      bg: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    if (view.headline !== 'Hiding' || view.bg === 'rgba(0, 0, 0, 0)' || view.overflow > 0) throw new Error(`popup ${JSON.stringify(view)}`);
    await popup.screenshot({ path: join(shots, 'popup.png') });
    await popup.close();
    const onboarding = await open(`${API}/__ext/onboarding.html`, { config, list, settings: {} });
    const h1 = await onboarding.evaluate(() => document.querySelector('#step-1 h1').textContent);
    await onboarding.close();
    if (h1 !== 'One click does three things') throw new Error(`onboarding heading ${h1}`);
    return `headline "${view.headline}", background ${view.bg}, text ${view.color}; onboarding "${h1}"`;
  });

  results.push({ name: 'page context only: no script error in any page', pass: errors.length === 0, evidence: errors.length ? errors.join(' | ') : 'none' });
  const engine = browser.version();
  await browser.close();
  return { results, version: `WebKit ${engine}` };
}
