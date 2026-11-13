// The real build: every target's manifest, the zips, and the Safari convert script (SPEC 12.6).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { X_MATCHES } from '../../src/shared/hosts';

const ext = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const repo = resolve(ext, '..');
const version = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8')).version as string;
const X = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*'];
const API = 'https://x-slop.com';
const targets = ['chrome', 'firefox', 'safari'] as const;
const dirs: string[] = [];
let outA: string;
let outB: string;
const build = (out: string, tz: string): string => execFileSync(process.execPath, ['build.mjs', '--out', out], { cwd: ext, env: { ...process.env, TZ: tz, XSLOP_API: '' }, encoding: 'utf8' });
const manifest = (t: string, out = outA) => JSON.parse(readFileSync(join(out, t, 'manifest.json'), 'utf8'));
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'xslop-build-'));
  dirs.push(d);
  return d;
};
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

beforeAll(() => {
  outA = mk();
  outB = mk();
  build(outA, 'UTC');
  build(outB, 'Pacific/Auckland');
}, 180_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('manifests', () => {
  const golden: Record<(typeof targets)[number], string[]> = {
    chrome: ['action', 'background', 'content_scripts', 'content_security_policy', 'description', 'homepage_url', 'host_permissions', 'icons', 'manifest_version', 'minimum_chrome_version', 'name', 'permissions', 'version'],
    firefox: ['action', 'background', 'browser_specific_settings', 'content_scripts', 'content_security_policy', 'description', 'homepage_url', 'host_permissions', 'icons', 'manifest_version', 'name', 'permissions', 'version'],
    safari: ['action', 'background', 'browser_specific_settings', 'content_scripts', 'content_security_policy', 'description', 'homepage_url', 'host_permissions', 'icons', 'manifest_version', 'name', 'permissions', 'version'],
  };
  it.each(targets)('%s has exactly the expected keys and the shared values', (t) => {
    const m = manifest(t);
    expect(Object.keys(m).sort()).toEqual(golden[t]);
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe(version);
    expect(m.permissions).toEqual(t === 'safari' ? ['storage', 'alarms', 'unlimitedStorage'] : ['storage', 'alarms']);
    expect(m.host_permissions).toEqual([...X, `${API}/*`]);
    expect(m.content_scripts).toEqual([{ matches: X, js: ['content.js'], css: ['content.css'], run_at: 'document_idle' }]);
    expect(m.content_security_policy.extension_pages).toBe(
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${API}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(JSON.stringify(m)).not.toMatch(/unsafe-(eval|inline)|wasm-unsafe/);
  });
  it('every X host in the code is the one in the manifests', () => {
    expect(X_MATCHES).toEqual(X);
  });
  it('chrome runs a module service worker from 120', () => {
    const m = manifest('chrome');
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(m.minimum_chrome_version).toBe('120');
  });
  it('firefox runs a module event page, with gecko keys for desktop and Android', () => {
    const m = manifest('firefox');
    expect(m.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(m.browser_specific_settings).toEqual({
      gecko: {
        id: 'xslop@koglabs.com', strict_min_version: '140.0',
        data_collection_permissions: { required: ['websiteContent'], optional: ['browsingActivity'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    });
  });
  it('safari runs a non-persistent classic event page and carries no Chrome or gecko keys', () => {
    const m = manifest('safari');
    expect(m.background).toEqual({ scripts: ['background.js'], persistent: false });
    expect(m.browser_specific_settings).toEqual({ safari: { strict_min_version: '16.4' } });
    const bg = readFileSync(join(outA, 'safari', 'background.js'), 'utf8');
    expect(bg.startsWith('import ')).toBe(false);
    expect(bg).not.toMatch(/^export\s/m);
    expect(bg).not.toContain('import.meta');
  });
});

describe('packages', () => {
  it.each(targets)('%s package has every page, script, stylesheet and icon', (t) => {
    const names = walk(join(outA, t)).map((f) => relative(join(outA, t), f)).sort();
    expect(names).toEqual([
      'background.js', 'content.css', 'content.js', 'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png',
      'manifest.json', 'mark.svg', 'onboarding.html', 'onboarding.js', 'popup.html', 'popup.js', 'tokens.css', 'ui.css', 'wordmark.svg',
    ]);
  });
  it.each(targets)('%s zip is deterministic across builds and time zones, and matches the folder', (t) => {
    const name = `xslop-${t}-v${version}.zip`;
    const zipA = readFileSync(join(outA, name));
    const zipB = readFileSync(join(outB, name));
    expect(zipA.equals(zipB)).toBe(true);
    const files = unzipSync(new Uint8Array(zipA));
    for (const f of walk(join(outA, t))) {
      const rel = relative(join(outA, t), f);
      expect(Buffer.from(files[rel]!).equals(readFileSync(f)), rel).toBe(true);
    }
    expect(JSON.parse(Buffer.from(files['manifest.json']!).toString()).version).toBe(version);
  });
});

describe('test/browsers/run.mjs', () => {
  it('EXT-4 regression: runs only tools of a fixed version, and checks the geckodriver download against a pinned SHA-256', () => {
    const src = readFileSync(join(ext, 'test/browsers/run.mjs'), 'utf8');
    const npx = [...src.matchAll(/run\('npx', \[([^\]]*)\]/g)].map((m) => m[1]!);
    expect(npx.length).toBeGreaterThan(0);
    for (const args of npx) expect(args).toMatch(/'@puppeteer\/browsers@\d+\.\d+\.\d+'/);
    expect(src).toMatch(/const GECKODRIVER_SHA256 = '[0-9a-f]{64}';/);
    expect(src).toMatch(/createHash\('sha256'\)\.update\(data\)\.digest\('hex'\) !== GECKODRIVER_SHA256/);
  });
});

describe('scripts/safari/convert.sh', () => {
  const script = join(repo, 'scripts/safari/convert.sh');
  let bin: string;
  let args: string;
  const run = (env: NodeJS.ProcessEnv, ...a: string[]) => execFileSync('/bin/sh', [script, ...a], { encoding: 'utf8', stdio: 'pipe', env });

  beforeAll(() => {
    bin = mk();
    args = join(bin, 'args');
    writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\n[ "$1" = --find ] && exit 1\nfor a in "$@"; do printf '%s\\n' "$a" >> ${args}; done\n`);
    chmodSync(join(bin, 'xcrun'), 0o755);
  });

  it('runs Apple\'s converter on the built folder with the right options', () => {
    run({ ...process.env, PATH: `${bin}:${process.env.PATH}` }, join(outA, 'safari'), join(bin, 'out'));
    const seen = readFileSync(args, 'utf8').trim().split('\n');
    expect(seen[0]).toBe('safari-web-extension-converter');
    expect(seen[1]).toBe(join(outA, 'safari'));
    expect(seen).toEqual(expect.arrayContaining(['--project-location', join(bin, 'out'), '--app-name', 'xslop', '--bundle-identifier', 'com.koglabs.xslop', '--swift', '--no-open', '--no-prompt']));
  });
  it('unpacks the published zip before it runs the converter', () => {
    rmSync(args, { force: true });
    const zip = join(outA, `xslop-safari-v${version}.zip`);
    writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\n[ "$1" = --find ] && exit 1\nfor a in "$@"; do printf '%s\\n' "$a" >> ${args}; done\ntest -f "$2/manifest.json" && echo found-manifest >> ${args}\n`);
    run({ ...process.env, PATH: `${bin}:${process.env.PATH}` }, zip, join(bin, 'out2'));
    const seen = readFileSync(args, 'utf8').trim().split('\n');
    expect(seen[0]).toBe('safari-web-extension-converter');
    expect(seen[1]).not.toBe(zip);
    expect(seen).toContain('found-manifest');
  });
  it('prefers the current tool name when this Xcode has it', () => {
    rmSync(args, { force: true });
    writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\n[ "$1" = --find ] && exit 0\nprintf '%s\\n' "$1" >> ${args}\n`);
    run({ ...process.env, PATH: `${bin}:${process.env.PATH}` }, join(outA, 'safari'), join(bin, 'out3'));
    expect(readFileSync(args, 'utf8').trim()).toBe('safari-web-extension-packager');
  });
  it('explains itself when the folder has no manifest', () => {
    expect(() => run({ ...process.env, PATH: `${bin}:${process.env.PATH}` }, join(bin, 'nothing'), join(bin, 'out'))).toThrow(/has no manifest\.json\. Build the extension first/);
  });
  it('explains itself on a machine without xcrun', () => {
    expect(() => run({ ...process.env, PATH: '/nonexistent' }, join(outA, 'safari'), join(bin, 'out'))).toThrow(/xcrun is missing\. Run this script on a Mac with Xcode/);
  });
});
