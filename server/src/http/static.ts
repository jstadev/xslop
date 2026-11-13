/** Static serving (section 5.7): the site, the extension zips and the extension config, read once at start and served from memory. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipLimit, type Ctx } from '../app.js';
import { sha256Hex } from '../lib/crypto.js';
import { encodeAll, etagMatches, etagOf, sendVariant, type Encoded } from '../lib/encoding.js';
import { sendError } from '../lib/http.js';

export interface Asset {
  enc: Encoded;
  etag: string;
  headers: Record<string, string>;
}

export interface StaticFiles {
  /** URL path → asset; null when site/dist is missing. */
  site: Map<string, Asset> | null;
  notFound: Asset | null;
  /** URL path → asset under /downloads/; null when extension/dist is missing. */
  downloads: Map<string, Asset> | null;
  config: Asset | null;
}

const HTML_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const TYPES: Record<string, [string, boolean]> = {
  html: ['text/html; charset=utf-8', true],
  js: ['text/javascript; charset=utf-8', true],
  mjs: ['text/javascript; charset=utf-8', true],
  css: ['text/css; charset=utf-8', true],
  json: ['application/json; charset=utf-8', true],
  map: ['application/json; charset=utf-8', true],
  webmanifest: ['application/manifest+json; charset=utf-8', true],
  svg: ['image/svg+xml', true],
  txt: ['text/plain; charset=utf-8', true],
  xml: ['application/xml; charset=utf-8', true],
  ico: ['image/x-icon', true],
  ttf: ['font/ttf', true],
  woff2: ['font/woff2', false],
  woff: ['font/woff', false],
  png: ['image/png', false],
  jpg: ['image/jpeg', false],
  jpeg: ['image/jpeg', false],
  gif: ['image/gif', false],
  webp: ['image/webp', false],
  avif: ['image/avif', false],
  zip: ['application/zip', false],
};

const ZIP_RE = /^xslop-(chrome|firefox|safari)-v([0-9]+)\.([0-9]+)\.([0-9]+)\.zip$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = { 'cache-control': 'no-cache' };
/** The pages with fixed URLs: dist file → URL paths and page headers. */
const SITE_PAGES = ['sloppers', 'how-it-works', 'rules', 'download', 'check', 'privacy', 'questions'];
const PAGES: Record<string, { paths: string[]; headers: Record<string, string> }> = {
  'index.html': { paths: ['/', '/index.html'], headers: NO_CACHE },
  ...Object.fromEntries(SITE_PAGES.map((name) => [`${name}/index.html`, { paths: [`/${name}`, `/${name}/`], headers: NO_CACHE }])),
  'admin/index.html': { paths: ['/admin', '/admin/'], headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } },
};

export function makeAsset(body: Buffer, ext: string, headers: Record<string, string>): Asset {
  const [type, text] = TYPES[ext] ?? ['application/octet-stream', false];
  const extra = ext === 'html' ? { ...HTML_HEADERS, ...headers } : headers;
  return { enc: text ? encodeAll(body) : { identity: body, gzip: null, br: null }, etag: etagOf(body), headers: { 'content-type': type, ...extra } };
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

async function loadSite(dir: string): Promise<{ site: Map<string, Asset>; notFound: Asset | null } | null> {
  if (!(await isDir(dir))) return null;
  const site = new Map<string, Asset>();
  let notFound: Asset | null = null;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const rel = relative(dir, join(e.parentPath, e.name)).split(sep).join(posix.sep);
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    const body = await readFile(join(dir, rel));
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
    const page = PAGES[rel];
    if (page) {
      const a = makeAsset(body, ext, page.headers);
      for (const path of page.paths) site.set(path, a);
    } else if (rel === '404.html') {
      notFound = makeAsset(body, ext, { 'cache-control': 'no-store' });
    } else if (rel.startsWith('assets/')) {
      site.set(`/${rel}`, makeAsset(body, ext, { 'cache-control': IMMUTABLE }));
    } else {
      site.set(`/${rel}`, makeAsset(body, ext, { 'cache-control': ext === 'html' ? 'no-cache' : 'public, max-age=3600' }));
    }
  }
  return { site, notFound };
}

const BROWSERS = ['chrome', 'firefox', 'safari'] as const;
type Browser = (typeof BROWSERS)[number];

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

async function loadDownloads(dir: string): Promise<Map<string, Asset> | null> {
  if (!(await isDir(dir))) return null;
  const out = new Map<string, Asset>();
  type Pick = { file: string; sha256: string; bytes: number; v: number[] };
  const best: Record<Browser, Pick | null> = { chrome: null, firefox: null, safari: null };
  for (const name of (await readdir(dir)).sort()) {
    const m = ZIP_RE.exec(name);
    if (!m) continue;
    const body = await readFile(join(dir, name));
    out.set(`/downloads/${name}`, makeAsset(body, 'zip', { 'cache-control': 'public, max-age=3600', 'content-disposition': `attachment; filename="${name}"` }));
    const browser = m[1] as Browser;
    const v = [Number(m[2]), Number(m[3]), Number(m[4])];
    const cur = best[browser];
    if (!cur || cmpVersion(v, cur.v) > 0) best[browser] = { file: name, sha256: sha256Hex(body), bytes: body.length, v };
  }
  const top = BROWSERS.map((b) => best[b]?.v).filter((v): v is number[] => !!v).sort(cmpVersion).at(-1);
  const info = (p: Pick | null) => (p ? { file: p.file, url: `/downloads/${p.file}`, sha256: p.sha256, bytes: p.bytes } : null);
  const latest = { version: top ? top.join('.') : null, chrome: info(best.chrome), firefox: info(best.firefox), safari: info(best.safari) };
  out.set('/downloads/latest.json', makeAsset(Buffer.from(JSON.stringify(latest)), 'json', { 'cache-control': 'public, max-age=300' }));
  return out;
}

async function loadConfig(file: string): Promise<Asset | null> {
  const body = await readFile(file).catch(() => null);
  if (!body) return null;
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
  return makeAsset(body, 'json', { 'cache-control': 'public, max-age=600' });
}

/** Loads every static file into memory once, with gzip, br and a strong ETag (section 5.7). */
export async function loadStatic(root: string, configFile: string): Promise<StaticFiles> {
  const [site, downloads, config] = await Promise.all([
    loadSite(join(root, 'site', 'dist')),
    loadDownloads(join(root, 'extension', 'dist')),
    loadConfig(configFile),
  ]);
  return { site: site?.site ?? null, notFound: site?.notFound ?? null, downloads, config };
}

export function sendAsset(req: FastifyRequest, reply: FastifyReply, a: Asset, status = 200): FastifyReply {
  reply.headers(a.headers).header('etag', a.etag);
  if (status === 200 && etagMatches(req, a.etag)) return reply.code(304).send();
  return sendVariant(req, reply.code(status), { gzip: a.enc.gzip, br: a.enc.br, identity: () => a.enc.identity });
}

function notFound(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (ctx.files.notFound && !req.url.startsWith('/api/')) return sendAsset(req, reply, ctx.files.notFound, 404);
  return sendError(reply, 404, 'not_found', 'Nothing is here.');
}

/** Site pages, assets and extension downloads, all from memory (section 5.7). */
export function registerStatic(app: FastifyInstance, ctx: Ctx): void {
  app.get('/*', { onRequest: ipLimit(ctx, ctx.limits.static) }, async (req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    if (path.startsWith('/api/')) return notFound(ctx, req, reply);
    if (path.startsWith('/downloads/')) {
      if (!ctx.files.downloads) return sendError(reply, 503, 'downloads_unavailable', 'The extension build is not available on this server.');
      const a = ctx.files.downloads.get(path);
      return a ? sendAsset(req, reply, a) : notFound(ctx, req, reply);
    }
    if (!ctx.files.site) return sendError(reply, 503, 'site_unavailable', 'The site build is not available on this server.');
    const a = ctx.files.site.get(path);
    return a ? sendAsset(req, reply, a) : notFound(ctx, req, reply);
  });
}
