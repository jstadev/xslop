import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { Db } from '../../src/db.js';
import type { AppConfig } from '../../src/env.js';
import type { StaticFiles } from '../../src/http/static.js';
import { hashPassword, parseScryptHash } from '../../src/lib/crypto.js';

export const ORIGIN = 'https://xslop.test';
export const ADMIN_USER = 'chair';
export const ADMIN_PASSWORD = 'correct horse battery staple 42';
let adminHash: Promise<string> | null = null;
const adminHashString = () => (adminHash ??= hashPassword(ADMIN_PASSWORD));

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    secret: Buffer.alloc(32, 7),
    ipSalt: Buffer.alloc(32, 9),
    powBits: 8,
    siteOrigin: ORIGIN,
    staticRoot: '/nonexistent-xslop-root',
    configFile: '/nonexistent-xslop-root/config.json',
    admin: null,
    stores: { chromeStoreUrl: null, firefoxUrl: null },
    ignored: [],
    ...over,
  };
}

export async function adminConfig(): Promise<AppConfig['admin']> {
  return { user: ADMIN_USER, hash: parseScryptHash(await adminHashString())! };
}

export const NO_FILES: StaticFiles = { site: null, notFound: null, downloads: null, config: null };

/** A clock that starts at the real time and moves only when a test says so. */
export class Clock {
  t = Date.now();
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestApp {
  app: FastifyInstance;
  clock: Clock;
}

export async function makeApp(db: Db, over: Partial<AppConfig> = {}, files: StaticFiles | undefined = NO_FILES): Promise<TestApp> {
  const clock = new Clock();
  const app = await buildApp({ db, config: testConfig(over), now: clock.now, logger: false, ...(files ? { files } : {}) });
  await app.ready();
  return { app, clock };
}

// ---- What the extension does (sections 5.1 and 7.2), written independently of the server code ----

const b64u = (b: ArrayBuffer | Uint8Array | Buffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');

export function meetsBits(challenge: string, nonce: string, bits: number): boolean {
  const h = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  for (let b = 0; b < bits; b++) if ((h[b >> 3]! >> (7 - (b & 7))) & 1) return false;
  return true;
}

export function solvePow(challenge: string, bits: number): string {
  for (let i = 0; ; i++) if (meetsBits(challenge, i.toString(36), bits)) return i.toString(36);
}

export interface Identity {
  keys: CryptoKeyPair;
  publicKey: { kty: string; crv: string; x: string; y: string };
  installId: string;
}

export async function newKeys(): Promise<{ keys: CryptoKeyPair; publicKey: Identity['publicKey'] }> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return { keys, publicKey: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! } };
}

export const randomNonce = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

export async function signHeaders(
  id: Pick<Identity, 'keys' | 'installId'>,
  method: string,
  pathWithQuery: string,
  body: string,
  ts: number,
  nonce = randomNonce(),
): Promise<Record<string, string>> {
  const enc = new TextEncoder();
  const bodyHash = b64u(await crypto.subtle.digest('SHA-256', enc.encode(body)));
  const data = `XSLOP1\n${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.keys.privateKey, enc.encode(data));
  return { 'x-xslop-install': id.installId, 'x-xslop-ts': String(ts), 'x-xslop-nonce': nonce, 'x-xslop-sig': b64u(sig) };
}

export const fromIp = (ip: string) => ({ 'x-forwarded-for': ip });

export async function getChallenge(t: TestApp, purpose: 'install' | 'appeal' = 'install', ip = '198.51.100.7'): Promise<{ challenge: string; nonce: string }> {
  const r = await t.app.inject({ method: 'GET', url: `/api/v1/challenge?purpose=${purpose}`, headers: fromIp(ip) });
  if (r.statusCode !== 200) throw new Error(`challenge failed: ${r.statusCode} ${r.body}`);
  const { challenge, difficulty } = r.json() as { challenge: string; difficulty: number };
  return { challenge, nonce: solvePow(challenge, difficulty) };
}

export async function register(t: TestApp, ip = '198.51.100.7'): Promise<Identity> {
  const { keys, publicKey } = await newKeys();
  const pow = await getChallenge(t, 'install', ip);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: { publicKey, ...pow, extVersion: '1.0.0' } });
  if (r.statusCode !== 201) throw new Error(`register failed: ${r.statusCode} ${r.body}`);
  return { keys, publicKey, installId: (r.json() as { installId: string }).installId };
}

/** A signed inject, exactly as the extension sends it. */
export async function signed(t: TestApp, id: Identity, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, opts: Partial<InjectOptions> = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = await signHeaders(id, method, url, body, t.clock.now());
  return t.app.inject({
    method,
    url,
    headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...((opts.headers as Record<string, string>) ?? {}) },
    ...(payload === undefined ? {} : { payload: body }),
  });
}

export const vote = (handle: string, value: 'slop' | 'not_slop' = 'slop', extra: Record<string, unknown> = {}) => ({
  handle,
  value,
  tweetId: '1850000000000000001',
  parentTweetId: '1850000000000000000',
  text: 'Great insight! This is a game changer for everyone.',
  postedAt: new Date().toISOString(),
  context: 'reply',
  ...extra,
});

/** A release root with site/dist, extension/dist and an extension config, for static serving tests. */
export async function makeStaticRoot(): Promise<{ root: string; configFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'xslop-static-'));
  const files: Record<string, string | Buffer> = {
    'site/dist/index.html': `<!doctype html><html><head><title>xslop</title></head><body>${'<p>Hide AI reply slop on X.</p>'.repeat(40)}</body></html>`,
    'site/dist/admin/index.html': '<!doctype html><title>admin</title>',
    'site/dist/sloppers/index.html': `<!doctype html><html><head><title>Sloppers</title></head><body>${'<p>Every listed account.</p>'.repeat(40)}</body></html>`,
    'site/dist/how-it-works/index.html': '<!doctype html><title>How it works</title><p>How xslop works.</p>',
    'site/dist/rules/index.html': '<!doctype html><title>Rules</title><p>The rules.</p>',
    'site/dist/download/index.html': '<!doctype html><title>Download</title><p>Download xslop.</p>',
    'site/dist/check/index.html': '<!doctype html><title>Check</title><p>Check a handle.</p>',
    'site/dist/privacy/index.html': '<!doctype html><title>Privacy</title><p>Privacy.</p>',
    'site/dist/questions/index.html': '<!doctype html><title>Questions</title><p>Questions.</p>',
    'site/dist/404.html': '<!doctype html><title>Not found</title><p>Nothing is here.</p>',
    'site/dist/assets/app-3f9a1c.js': `console.log(${JSON.stringify('x'.repeat(2000))});`,
    'site/dist/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>',
    'site/dist/robots.txt': 'User-agent: *\nAllow: /\n',
    'site/dist/.hidden': 'secret',
    'extension/dist/xslop-chrome-v1.0.0.zip': Buffer.from('PK\x03\x04chrome-1.0.0'),
    'extension/dist/xslop-chrome-v1.2.0.zip': Buffer.from('PK\x03\x04chrome-1.2.0'),
    'extension/dist/xslop-firefox-v1.1.0.zip': Buffer.from('PK\x03\x04firefox-1.1.0'),
    'extension/dist/xslop-safari-v1.1.0.zip': Buffer.from('PK\x03\x04safari-1.1.0'),
    'extension/dist/notes.zip': Buffer.from('not served'),
    'config/extension-config.json': JSON.stringify({ v: 1, minVersion: '1.0.0', selectors: {}, observe: { enabled: true, batchMax: 100, flushSec: 30 } }),
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  return { root, configFile: join(root, 'config/extension-config.json') };
}
