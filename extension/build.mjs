// Build the Chrome, Firefox and Safari MV3 packages and their deterministic zips (SPEC 7.1, 12.6).
//   node build.mjs                       release build in dist/ for https://x-slop.com
//   XSLOP_API=<origin> node build.mjs    another API origin (https, or http on 127.0.0.1 / localhost)
//   node build.mjs --out <dir> --test    test build (e2e only): mute interval floor 1 s, open shadow roots, no zips
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('.', import.meta.url));
const brand = resolve(root, '../brand');
const DEFAULT_API = 'https://x-slop.com';
const X_HOSTS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*'];
const ICON_SIZES = [16, 32, 48, 128];
const TARGETS = ['chrome', 'firefox', 'safari'];
const PAGES = ['src/popup/popup.html', 'src/onboarding/onboarding.html', 'src/popup/ui.css', 'src/content/content.css'];
// DOS time has no zone: a local-time date gives the same bytes in every time zone.
const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);

const fail = (msg) => {
  console.error(`build: ${msg}`);
  process.exit(1);
};

function apiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`XSLOP_API ${value} is not a URL.`);
  }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) fail('XSLOP_API must use https, or http on 127.0.0.1 or localhost.');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('XSLOP_API must be an origin with no path.');
  return url.origin;
}

/** The mark is parsed into the page at run time, so it must be plain shapes only. */
function checkSvg(svg, file) {
  if (/<script|<foreignObject|<!ENTITY|<!DOCTYPE|<iframe|<image|javascript:|\son[a-z]+\s*=/i.test(svg)) fail(`${file} has active content.`);
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) if (!m[1].startsWith('#')) fail(`${file} links outside itself.`);
  for (const m of svg.matchAll(/url\(\s*["']?([^)"']*)/gi)) if (!m[1].startsWith('#')) fail(`${file} loads an external resource.`);
  return svg.trim();
}

async function icons(out) {
  await mkdir(join(out, 'icons'), { recursive: true });
  const pngs = ICON_SIZES.map((n) => join(brand, `icon-${n}.png`));
  if (pngs.every(existsSync)) {
    await Promise.all(pngs.map((p, i) => copyFile(p, join(out, 'icons', `icon-${ICON_SIZES[i]}.png`))));
    return;
  }
  const svg = join(brand, 'mark.svg');
  if (!existsSync(svg)) fail('brand/icon-{16,32,48,128}.png and brand/mark.svg are missing.');
  for (const n of ICON_SIZES) {
    try {
      execFileSync('rsvg-convert', ['-w', String(n), '-h', String(n), '-o', join(out, 'icons', `icon-${n}.png`), svg], { stdio: 'pipe' });
    } catch (e) {
      fail(`rsvg-convert could not render brand/mark.svg (${e.message.split('\n')[0]}).`);
    }
  }
}

function manifests(version, api) {
  const hosts = [...X_HOSTS, `${DEFAULT_API}/*`];
  if (api !== DEFAULT_API) hosts.push(`${api}/*`);
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", `connect-src ${api}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  const iconSet = Object.fromEntries(ICON_SIZES.map((n) => [String(n), `icons/icon-${n}.png`]));
  const common = {
    manifest_version: 3,
    name: 'xslop',
    version,
    description: 'Hide AI reply slop on X. Mark a reply as slop in one click. A shared list hides confirmed slop accounts.',
    homepage_url: DEFAULT_API,
    icons: iconSet,
    action: { default_title: 'xslop', default_popup: 'popup.html', default_icon: { 16: iconSet[16], 32: iconSet[32] } },
    permissions: ['storage', 'alarms'],
    host_permissions: hosts,
    content_scripts: [{ matches: X_HOSTS, js: ['content.js'], css: ['content.css'], run_at: 'document_idle' }],
    content_security_policy: { extension_pages: csp },
  };
  return {
    chrome: { ...common, minimum_chrome_version: '120', background: { service_worker: 'background.js', type: 'module' } },
    firefox: {
      ...common,
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: 'xslop@koglabs.com',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['websiteContent'], optional: ['browsingActivity'] },
        },
        gecko_android: { strict_min_version: '142.0' },
      },
    },
    // Safari: a non-persistent event page runs on macOS and iOS; its service worker support is newer and less reliable.
    safari: {
      ...common,
      permissions: [...common.permissions, 'unlimitedStorage'],
      background: { scripts: ['background.js'], persistent: false },
      browser_specific_settings: { safari: { strict_min_version: '16.4' } },
    },
  };
}

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

async function zip(dir, file) {
  const entries = {};
  for (const f of await files(dir)) entries[relative(dir, f).split('\\').join('/')] = [await readFile(f), { mtime: ZIP_TIME }];
  const data = zipSync(entries, { level: 9, mtime: ZIP_TIME });
  await writeFile(file, data);
  return data.length;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, test: { type: 'boolean' } } });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) fail(`package.json version ${version} is not x.y.z.`);
  const api = apiOrigin(process.env.XSLOP_API || DEFAULT_API);
  const out = resolve(root, values.out ?? 'dist');
  const markFile = ['mark-mono.svg', 'mark.svg'].map((f) => join(brand, f)).find(existsSync);
  const pageLogos = ['mark.svg', 'wordmark.svg'];
  const tokens = join(brand, 'tokens.css');
  for (const f of pageLogos) if (!existsSync(join(brand, f))) fail(`brand/${f} is missing.`);
  if (!existsSync(tokens)) fail('brand/tokens.css is missing.');
  const markSvg = checkSvg(await readFile(markFile, 'utf8'), relative(root, markFile));
  for (const f of pageLogos) checkSvg(await readFile(join(brand, f), 'utf8'), `brand/${f}`);

  const common = {
    absWorkingDir: root,
    bundle: true,
    write: false,
    outdir: 'out',
    target: ['chrome120', 'firefox140', 'safari16.4'],
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      __XSLOP_API__: JSON.stringify(api),
      __XSLOP_VERSION__: JSON.stringify(version),
      __MIN_MUTE_SEC__: values.test ? '1' : '90',
      __SHADOW__: JSON.stringify(values.test ? 'open' : 'closed'),
      __MARK_SVG__: JSON.stringify(markSvg),
    },
  };
  const results = await Promise.all([
    build({ ...common, format: 'esm', entryPoints: { background: 'src/background.ts', popup: 'src/popup/popup.ts', onboarding: 'src/onboarding/onboarding.ts' } }),
    // Content scripts cannot be modules.
    build({ ...common, format: 'iife', entryPoints: { content: 'src/content/main.ts' } }),
    // Safari's event page is a classic script.
    build({ ...common, format: 'iife', entryPoints: { 'background-safari': 'src/background.ts' } }),
  ]);
  const { 'background-safari.js': safariBackground, ...bundles } = Object.fromEntries(
    results.flatMap((r) => r.outputFiles).map((f) => [relative(join(root, 'out'), f.path), f.text]),
  );

  await rm(out, { recursive: true, force: true });
  const sizes = {};
  const m = manifests(version, api);
  for (const target of TARGETS) {
    const dir = join(out, target);
    await mkdir(dir, { recursive: true });
    const files = target === 'safari' ? { ...bundles, 'background.js': safariBackground } : bundles;
    await Promise.all([
      ...Object.entries(files).map(([name, text]) => writeFile(join(dir, name), text)),
      ...PAGES.map((p) => copyFile(join(root, p), join(dir, p.split('/').pop()))),
      copyFile(tokens, join(dir, 'tokens.css')),
      ...pageLogos.map((f) => copyFile(join(brand, f), join(dir, f))),
      writeFile(join(dir, 'manifest.json'), JSON.stringify(m[target], null, 2) + '\n'),
      icons(dir),
    ]);
    if (!values.test) sizes[target] = await zip(dir, join(out, `xslop-${target}-v${version}.zip`));
  }
  const where = relative(process.cwd(), out) || '.';
  console.log(`build: xslop ${version} for ${api} in ${where}${values.test ? ' (test build)' : ''}`);
  for (const [t, n] of Object.entries(sizes)) console.log(`build: ${where}/xslop-${t}-v${version}.zip ${n} bytes`);
}

await main();
