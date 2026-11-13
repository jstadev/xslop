#!/usr/bin/env node
// Runs the release packages in real browsers against the real server and prints a matrix. See README.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright';
import { ChromiumDriver } from './lib/chromium.mjs';
import { firefoxIdle } from './lib/firefox-idle.mjs';
import { firefoxPanel } from './lib/firefox-panel.mjs';
import { firefoxSteps } from './lib/firefox-steps.mjs';
import { FirefoxDriver } from './lib/firefox.mjs';
import { finalChecks, runScenario } from './lib/scenario.mjs';
import { runWebkit } from './lib/webkit.mjs';
import { prepareServer, startWorld } from './lib/world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../..');
const repo = resolve(extension, '..');
const RUN_LIMIT_MS = 12 * 60_000;
const GECKODRIVER = 'https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz';
const GECKODRIVER_SHA256 = 'e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e';

const DEB = {
  edge: { root: 'https://packages.microsoft.com/repos/edge/', list: 'dists/stable/main/binary-amd64/Packages.gz', pkg: 'microsoft-edge-stable', bin: 'opt/microsoft/msedge/msedge' },
  brave: { root: 'https://brave-browser-apt-release.s3.brave.com/', list: 'dists/stable/main/binary-amd64/Packages.gz', pkg: 'brave-browser', bin: 'opt/brave.com/brave/brave' },
  opera: { root: 'https://deb.opera.com/opera-stable/', list: 'dists/stable/non-free/binary-amd64/Packages.gz', pkg: 'opera-stable', bin: 'usr/lib/x86_64-linux-gnu/opera-stable/opera' },
  vivaldi: { root: 'https://repo.vivaldi.com/stable/deb/', list: 'dists/stable/main/binary-amd64/Packages.gz', pkg: 'vivaldi-stable', bin: 'opt/vivaldi/vivaldi' },
};

const MATRIX = [
  { name: 'firefox', kind: 'gecko', spec: 'firefox@stable' },
  { name: 'firefox-panel', kind: 'panel', spec: 'firefox@stable' },
  { name: 'firefox-esr', kind: 'gecko', spec: 'firefox@esr' },
  { name: 'firefox-140', kind: 'gecko', spec: 'firefox@esr_140.0esr', note: 'oldest version that the manifest allows' },
  { name: 'chrome', kind: 'blink', spec: 'chrome@stable' },
  { name: 'chrome-120', kind: 'blink', spec: 'chrome@120.0.6099.109', note: 'oldest version that the manifest allows' },
  { name: 'chromium', kind: 'blink', playwright: true },
  ...Object.keys(DEB).map((name) => ({ name, kind: 'blink', deb: DEB[name] })).map((m) => (m.name === 'vivaldi' ? { ...m, onboardingTab: false, note: 'headless Vivaldi keeps the tab from tabs.create out of the debugger, so the test opens that page itself' } : m)),
  { name: 'webkit', kind: 'webkit', note: 'page context only: no extension system' },
  { name: 'firefox-idle', kind: 'gecko', spec: 'firefox@stable', idle: true, optional: true, note: 'only with --only: 16 page loads, about 9 minutes' },
];

const { values: opt } = parseArgs({
  options: {
    only: { type: 'string' }, dir: { type: 'string' }, pow: { type: 'string', default: '18' }, jobs: { type: 'string', default: '2' },
    keep: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
  },
});
if (opt.list) {
  for (const m of MATRIX) console.log(m.note ? `${m.name} (${m.note})` : m.name);
  process.exit(0);
}
const only = opt.only?.split(',');
const unknown = only?.filter((n) => !MATRIX.some((m) => m.name === n)) ?? [];
if (unknown.length) throw new Error(`unknown browser: ${unknown.join(', ')}. Use --list.`);
const wanted = MATRIX.filter((m) => (only ? only.includes(m.name) : !m.optional));
const powBits = Number(opt.pow);
if (!Number.isInteger(powBits) || powBits < 8 || powBits > 24) throw new Error('--pow must be a whole number from 8 to 24');

const dir = resolve(opt.dir ?? mkdtempSync(join(tmpdir(), 'xslop-browsers-')));
const browsersDir = join(dir, 'browsers');
const say = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const run = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, env: { ...process.env, ...env } });

/** Each download gets its own empty folder. A browser named twice is fetched once. */
const fetching = new Map();
function browserPath(m) {
  const key = m.spec ?? m.name;
  if (!fetching.has(key)) fetching.set(key, Promise.resolve().then(() => download(m)));
  return fetching.get(key);
}

async function download(m) {
  if (m.playwright) {
    const path = chromium.executablePath();
    if (!existsSync(path)) throw new Error(`Playwright has no Chromium at ${path}. Run npx playwright install chromium.`);
    return path;
  }
  const into = join(browsersDir, m.spec?.replace('@', '-') ?? m.name);
  mkdirSync(into, { recursive: true });
  if (m.spec) return run('npx', ['-y', '@puppeteer/browsers@3.2.7', 'install', m.spec, '--path', into]).trim().split('\n').pop().split(' ').slice(1).join(' ');
  return debBinary(m.deb, into);
}

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const versionParts = (v) => v.replace(/^\d+:/, '').replace(/-.*/, '').split('.').map(Number);
function newer(a, b) {
  const [x, y] = [versionParts(a.version), versionParts(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The newest package of a vendor's apt index, checked against the SHA-256 in that index, unpacked without an install. */
async function debBinary(deb, into) {
  const binary = join(into, 'root', deb.bin);
  if (existsSync(binary)) return binary;
  const index = gunzipSync(await bytes(deb.root + deb.list)).toString('utf8');
  const field = (s, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(s)?.[1];
  const found = index.split('\n\n').filter((s) => field(s, 'Package') === deb.pkg).map((s) => ({ version: field(s, 'Version'), file: field(s, 'Filename'), sha: field(s, 'SHA256') }));
  if (!found.length) throw new Error(`${deb.pkg} is not in the vendor index`);
  const latest = found.reduce((a, b) => (newer(b, a) ? b : a));
  const data = await bytes(deb.root + latest.file);
  if (createHash('sha256').update(data).digest('hex') !== latest.sha) throw new Error(`${deb.pkg}: the SHA-256 does not match the vendor index`);
  const file = join(into, 'package.deb');
  writeFileSync(file, data);
  run('dpkg-deb', ['-x', file, join(into, 'root')]);
  rmSync(file);
  return binary;
}

async function geckodriverPath() {
  const into = join(browsersDir, 'geckodriver');
  const binary = join(into, 'geckodriver');
  if (!existsSync(binary)) {
    mkdirSync(into, { recursive: true });
    const data = await bytes(GECKODRIVER);
    if (createHash('sha256').update(data).digest('hex') !== GECKODRIVER_SHA256) throw new Error('geckodriver: the SHA-256 does not match the pinned value');
    writeFileSync(join(into, 'g.tar.gz'), data);
    run('tar', ['-xzf', join(into, 'g.tar.gz'), '-C', into]);
    rmSync(join(into, 'g.tar.gz'));
  }
  return binary;
}

/** Builds the release packages and unpacks the zips: the test runs what users get, not the build folders. */
function buildPackages(version) {
  const out = join(dir, 'build');
  run(process.execPath, [join(extension, 'build.mjs'), '--out', out], { XSLOP_API: '' });
  const zips = {};
  for (const target of ['chrome', 'firefox', 'safari']) {
    const zip = join(out, `xslop-${target}-v${version}.zip`);
    const folder = join(dir, 'packages', target);
    rmSync(folder, { recursive: true, force: true });
    for (const [name, data] of Object.entries(unzipSync(readFileSync(zip)))) {
      if (name.endsWith('/')) continue;
      const file = join(folder, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    zips[target] = { zip, folder };
  }
  return zips;
}

async function runBrowser(m, ctx) {
  const shots = join(dir, 'shots', m.name);
  mkdirSync(shots, { recursive: true });
  const work = join(dir, 'work', m.name);
  mkdirSync(work, { recursive: true });
  let d = null;
  let world = null;
  try {
    const binary = m.kind === 'webkit' ? null : await browserPath(m);
    world = await startWorld({ repo, work: join(dir, 'work'), powBits });
    if (m.kind === 'webkit') {
      const r = await runWebkit({ world, pkg: ctx.pkgs.safari.folder, config: ctx.config, shots, version: ctx.version, powBits, webBearer: ctx.webBearer });
      return { version: r.version, loaded: 'page context, stand-in API', results: r.results };
    }
    if (m.kind === 'panel') return await firefoxPanel({ binary, geckodriver: ctx.geckodriver, world, work, addon: ctx.pkgs.firefox.zip, shots });
    d = m.kind === 'gecko'
      ? await FirefoxDriver.launch({ binary, geckodriver: ctx.geckodriver, proxyPort: world.proxyPort, work, addonPath: ctx.pkgs.firefox.zip })
      : await ChromiumDriver.launch({ binary, proxyPort: world.proxyPort, work, extDir: ctx.pkgs.chrome.folder, name: m.name });
    if (m.idle) return { version: d.version, loaded: 'temporary add-on', results: await firefoxIdle({ d, world }) };
    const r = await runScenario({ d, world, shots, version: ctx.version, powBits, webBearer: ctx.webBearer, onboardingTab: m.onboardingTab });
    if (m.kind === 'gecko') await firefoxSteps({ d, world, popup: r.popup(), x: r.x(), results: r.results });
    await finalChecks({ d, world, results: r.results });
    return { version: d.version, loaded: d.loadedVia || 'temporary add-on', results: r.results };
  } catch (e) {
    return { version: d?.version ?? 'unknown', loaded: d?.loadedVia ?? '', results: [{ name: 'the run started and finished', pass: false, evidence: e.message ?? String(e) }] };
  } finally {
    await d?.quit().catch(() => undefined);
    await world?.close().catch(() => undefined);
  }
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const version = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8')).version;
const config = JSON.parse(readFileSync(join(repo, 'server/config/extension-config.json'), 'utf8'));
say(`folder ${dir}`);
mkdirSync(browsersDir, { recursive: true });
const pkgs = buildPackages(version);
say(`release packages ${version} built and unpacked`);
await prepareServer(repo, join(dir, 'work'));
const needsGecko = wanted.some((m) => m.kind === 'gecko' || m.kind === 'panel');
const ctx = { pkgs, version, config, webBearer: config.mute.webBearer, geckodriver: needsGecko ? await geckodriverPath() : null };

const rows = await pool(wanted, Math.max(1, Number(opt.jobs) || 1), async (m) => {
  say(`start ${m.name}`);
  const started = Date.now();
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no result after ${RUN_LIMIT_MS / 60_000} minutes`)), RUN_LIMIT_MS);
  });
  const r = await Promise.race([runBrowser(m, ctx), limit]).catch((e) => ({ version: 'unknown', loaded: '', results: [{ name: 'the run finished in time', pass: false, evidence: e.message }] })).finally(() => clearTimeout(timer));
  const ok = r.results.every((s) => s.pass);
  const seconds = Math.round((Date.now() - started) / 1000);
  say(`${ok ? 'PASS' : 'FAIL'} ${m.name} ${r.version} (${r.results.filter((s) => s.pass).length}/${r.results.length} steps, ${seconds} s)`);
  return { ...m, ...r, ok, seconds };
});

const block = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ');
const lines = [`# Browser matrix for xslop ${version}`, '', `Run ${new Date().toISOString()} with ${powBits}-bit proof of work.`, '', '| Browser | Version | Package loaded by | Steps | Result | Note |', '| --- | --- | --- | --- | --- | --- |'];
for (const r of rows) lines.push(`| ${r.name} | ${block(r.version)} | ${block(r.loaded)} | ${r.results.filter((s) => s.pass).length}/${r.results.length} | ${r.ok ? 'PASS' : 'FAIL'} | ${block(r.note ?? '')} |`);
lines.push('');
for (const r of rows) {
  lines.push(`## ${r.name}`, '');
  for (const s of r.results) lines.push(`- ${s.pass ? 'PASS' : 'FAIL'}: ${block(s.name)}. ${block(s.evidence)}`);
  lines.push('');
}
const report = lines.join('\n');
writeFileSync(join(dir, 'report.md'), report);
console.log(`\n${report}`);
const failed = rows.filter((r) => !r.ok).map((r) => r.name);
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : `All ${rows.length} runs passed.`);
if (!opt.dir && !opt.keep) rmSync(dir, { recursive: true, force: true });
else console.log(`Report, screenshots and browsers stay in ${dir}.`);
process.exit(failed.length ? 1 : 0);
