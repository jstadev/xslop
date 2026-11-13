import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { loadStatic } from '../src/http/static.js';
import { makeApp, makeStaticRoot, NO_FILES, type TestApp } from './helpers/app.js';

// Static serving never touches the database.
const noDb: Db = {
  query: () => Promise.reject(new Error('no database in static tests')),
  tx: () => Promise.reject(new Error('no database')),
  session: () => Promise.reject(new Error('no database')),
  close: async () => undefined,
};

describe('static files from memory', () => {
  let t: TestApp;
  beforeAll(async () => {
    const { root, configFile } = await makeStaticRoot();
    t = await makeApp(noDb, {}, await loadStatic(root, configFile));
  });
  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ url, headers });

  it('serves the landing page with the security headers, a strong ETag and 304', async () => {
    const r = await get('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Hide AI reply slop on X.');
    expect(r.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
    expect(r.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const nm = await get('/', { 'if-none-match': r.headers.etag as string });
    expect([nm.statusCode, nm.body]).toEqual([304, '']);
    const br = await get('/', { 'accept-encoding': 'br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(r.body);
    expect((await get('/', { 'accept-encoding': 'gzip' })).headers['content-encoding']).toBe('gzip');
    const head = await t.app.inject({ method: 'HEAD', url: '/' });
    expect([head.statusCode, head.body]).toEqual([200, '']);
  });

  it('serves hashed assets as immutable and root files for an hour', async () => {
    const js = await get('/assets/app-3f9a1c.js');
    expect(js.headers).toMatchObject({ 'cache-control': 'public, max-age=31536000, immutable', 'content-type': 'text/javascript; charset=utf-8' });
    expect(js.headers['content-security-policy']).toBeUndefined();
    expect((await get('/favicon.svg')).headers).toMatchObject({ 'cache-control': 'public, max-age=3600', 'content-type': 'image/svg+xml' });
    expect((await get('/robots.txt')).body).toContain('User-agent');
  });

  it('serves the admin page as noindex and no-store', async () => {
    for (const url of ['/admin', '/admin/']) {
      const r = await get(url);
      expect(r.statusCode).toBe(200);
      expect(r.headers).toMatchObject({ 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    }
  });

  it('serves the sloppers page at /sloppers and /sloppers/ with the HTML headers and no-cache', async () => {
    for (const url of ['/sloppers', '/sloppers/', '/sloppers?q=gpt']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain('Every listed account.');
      expect(r.headers, url).toMatchObject({ 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'content-type': 'text/html; charset=utf-8' });
      expect(r.headers['content-security-policy'], url).toContain("default-src 'self'");
    }
  });

  it('serves each site page at its own path, with and without the trailing slash', async () => {
    const pages = { 'how-it-works': 'How xslop works.', rules: 'The rules.', download: 'Download xslop.', check: 'Check a handle.', privacy: 'Privacy.', questions: 'Questions.' };
    for (const [name, text] of Object.entries(pages)) {
      for (const url of [`/${name}`, `/${name}/`, `/${name}?appeal=handle`]) {
        const r = await get(url);
        expect(r.statusCode, url).toBe(200);
        expect(r.body, url).toContain(text);
        expect(r.headers, url).toMatchObject({ 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'content-type': 'text/html; charset=utf-8' });
      }
    }
    expect((await get('/downloads')).statusCode).toBe(404);
  });

  it('serves extension zips as attachments and latest.json with their sha256', async () => {
    const latest = await get('/downloads/latest.json');
    const info = latest.json();
    expect(info).toMatchObject({
      version: '1.2.0',
      chrome: { file: 'xslop-chrome-v1.2.0.zip', url: '/downloads/xslop-chrome-v1.2.0.zip', bytes: 16 },
      firefox: { file: 'xslop-firefox-v1.1.0.zip', bytes: 17 },
      safari: { file: 'xslop-safari-v1.1.0.zip', url: '/downloads/xslop-safari-v1.1.0.zip', bytes: 16 },
    });
    const safari = await get(info.safari.url);
    expect(safari.headers).toMatchObject({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="xslop-safari-v1.1.0.zip"' });
    expect(createHash('sha256').update(safari.rawPayload).digest('hex')).toBe(info.safari.sha256);
    const zip = await get(info.chrome.url);
    expect(zip.headers).toMatchObject({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="xslop-chrome-v1.2.0.zip"' });
    expect(zip.headers['content-encoding']).toBeUndefined();
    expect(createHash('sha256').update(zip.rawPayload).digest('hex')).toBe(info.chrome.sha256);
    expect((await get('/downloads/xslop-chrome-v1.0.0.zip')).statusCode).toBe(200);
    expect((await get('/downloads/notes.zip')).statusCode).toBe(404);
  });

  it('answers unknown, hidden and traversal paths with the 404 page, and API paths with JSON', async () => {
    for (const url of ['/nope', '/.hidden', '/assets/../404.html', '/%2e%2e/etc/passwd', '/downloads/../site/dist/index.html']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body).toContain('Nothing is here.');
    }
    expect((await get('/nope')).headers['content-type']).toBe('text/html; charset=utf-8');
    const api = await get('/api/v1/nothing');
    expect([api.statusCode, api.json().error.code, api.headers['cache-control']]).toEqual([404, 'not_found', 'no-store']);
    const post = await t.app.inject({ method: 'POST', url: '/somewhere' });
    expect(post.json().error.code).toBe('not_found');
  });

  it('answers 503 JSON when site/dist or extension/dist is missing', async () => {
    const empty = await makeApp(noDb, {}, NO_FILES);
    for (const url of ['/', '/admin', '/assets/a.js']) {
      const r = await empty.app.inject({ url });
      expect([r.statusCode, r.json().error.code], url).toEqual([503, 'site_unavailable']);
    }
    const d = await empty.app.inject({ url: '/downloads/latest.json' });
    expect([d.statusCode, d.json().error.code]).toEqual([503, 'downloads_unavailable']);
    const boot = await loadStatic('/nonexistent-root', '/nonexistent-root/c.json');
    expect(boot).toEqual(NO_FILES);
  });
});
