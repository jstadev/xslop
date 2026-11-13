// The real parts of the system test: a frozen release build, a throwaway Postgres, the manifest's own
// commands, the real server process, and one reverse proxy per network. Product code stays unchanged.

import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { cp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const hex = (bytes) => randomBytes(bytes).toString('hex');
export const pg = createRequire(join(ROOT, 'server/package.json'))('pg');

const execFileAsync = promisify(execFile);

export async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
    return stdout;
  } catch (err) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${err.stdout ?? ''}\n${err.stderr ?? err.message}`);
  }
}

/** Polls until `check` gives a truthy value and returns that value. */
export async function until(check, what, timeoutMs = 30_000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let last;
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms: ${what}; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(stepMs);
  }
}

export async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const SKIP_IN_COPY = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.e2e']);

/** Copies the sources into `dir` and builds there with each package's own build script, so no shared dist folder changes. */
export async function buildRelease(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const part of ['brand', 'seed']) await cp(join(ROOT, part), join(dir, part), { recursive: true });
  for (const part of ['server', 'site', 'extension']) {
    await cp(join(ROOT, part), join(dir, part), { recursive: true, filter: (src) => !SKIP_IN_COPY.has(basename(src)) });
    await symlink(join(ROOT, part, 'node_modules'), join(dir, part, 'node_modules'));
  }
  await Promise.all(['server', 'site', 'extension'].map((part) => run('npm', ['run', 'build'], { cwd: join(dir, part) })));
}

/** A disposable Postgres in Docker, published on 127.0.0.1 only, with a role whose search_path selects the schema as in production. */
export class Postgres {
  static async start() {
    const pgres = new Postgres();
    pgres.container = `xslop-r-system-${process.pid}`;
    pgres.superPassword = hex(24);
    pgres.appPassword = hex(24);
    // The password travels in the environment of the docker client, so it never shows in a process list.
    await run('docker', ['run', '-d', '--rm', '--name', pgres.container, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', 'postgres:15-alpine'], {
      env: { ...process.env, POSTGRES_PASSWORD: pgres.superPassword },
    });
    pgres.port = Number((await run('docker', ['port', pgres.container, '5432/tcp'])).trim().split(':').at(-1));
    await until(() => pgres.superQuery('postgres', 'select 1').then(() => true), 'postgres accepts connections', 60_000, 250);
    await pgres.superQuery('postgres', `create role xslop_app login password '${pgres.appPassword}'; alter role xslop_app set search_path = xslop`);
    return pgres;
  }

  async superQuery(database, sql) {
    const client = new pg.Client({ host: '127.0.0.1', port: this.port, user: 'postgres', password: this.superPassword, database });
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async createDatabase(name, { schema = true } = {}) {
    await this.superQuery('postgres', `create database ${name} owner xslop_app`);
    if (schema) await this.superQuery(name, 'create schema xslop authorization xslop_app');
    return `postgres://xslop_app:${this.appPassword}@127.0.0.1:${this.port}/${name}`;
  }

  /** Loads a gzipped pg_dump file as the application role, so the schema belongs to the role that serves it. */
  async restore(database, file) {
    await run('sh', ['-c', 'gunzip -c "$2" | docker exec -i "$0" psql -q -v ON_ERROR_STOP=1 -U xslop_app -d "$1"', this.container, database, file]);
  }

  async stop() {
    await run('docker', ['rm', '-f', this.container]).catch(() => undefined);
  }
}

export async function hashPassword(release, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/dist/scripts/hash-password.js'], { cwd: release, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`hash-password exited ${code}`))));
    child.stdin.end(password);
  });
}

/** The variables that deploy/units sets and .env.example documents, nothing else, so a hidden dependency on the caller's environment fails here. */
export function serverEnv({ release, databaseUrl, port, siteOrigin, powBits, adminUser, adminHash, adminTotp, salt, secret }) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    XSLOP_STATIC_ROOT: release,
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    XSLOP_SECRET: secret,
    XSLOP_IP_SALT: salt,
    XSLOP_ADMIN_USER: adminUser,
    XSLOP_ADMIN_HASH: adminHash,
    XSLOP_ADMIN_TOTP: adminTotp,
    XSLOP_POW_BITS: String(powBits),
    XSLOP_SITE_ORIGIN: siteOrigin,
  };
}

/** The web process from the build, exactly as the unit starts it. `log` holds every line it wrote. */
export class Server {
  static async start(release, env, origin) {
    const server = new Server();
    server.log = '';
    server.child = spawn(process.execPath, ['server/dist/main.js'], { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.child.stdout, server.child.stderr]) stream.on('data', (chunk) => (server.log += chunk));
    server.exited = new Promise((resolve) => server.child.once('exit', resolve));
    await until(async () => (await fetch(`${origin}/api/health`)).status !== 502, 'the server answers', 30_000, 100);
    return server;
  }

  async stop() {
    this.child.kill('SIGTERM');
    await this.exited;
  }
}

/** One network: a reverse proxy that does what Caddy does in production. It replaces X-Forwarded-For with this network's client address and forwards from loopback, the only address the server trusts. */
export class NetworkProxy {
  static async start(serverPort, ip) {
    const proxy = new NetworkProxy();
    proxy.ip = ip;
    proxy.log = [];
    proxy.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const entry = { method: req.method, url: req.url, headers: req.headers, body, status: 0 };
        proxy.log.push(entry);
        const upstream = http.request(
          { host: '127.0.0.1', port: serverPort, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host } },
          (answer) => {
            entry.status = answer.statusCode;
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
          },
        );
        upstream.on('error', () => {
          entry.status = 502;
          res.writeHead(502).end();
        });
        upstream.end(body);
      });
    });
    await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    proxy.origin = `http://127.0.0.1:${proxy.server.address().port}`;
    return proxy;
  }

  close() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

export function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function solveProof(challenge, difficulty) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest()) >= difficulty) return nonce;
  }
}

const b64url = (buffer) => buffer.toString('base64url');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new TOTP secret in RFC 4648 base32 without padding (32 characters for 20 bytes). */
export function totpSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g).map((chunk) => BASE32[parseInt(chunk, 2)]).join('');
}

/** The RFC 6238 code (SHA-1, 30 s, 6 digits) of `secret` for time step `step`, written here apart from the server's code. */
export function totpCode(secret, step) {
  const bits = [...secret].map((c) => BASE32.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const at = mac[19] & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The post text that an older extension build sends with each vote. The server accepts it and stores none of it. */
export const OLD_VOTE_TEXT = 'future of productivity';

/** A client that speaks the signed protocol with its own P-256 key: proof of work, install, signed requests. It stands in for an older extension build when a step needs volume. */
export class Bot {
  constructor(proxy) {
    this.proxy = proxy;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
    this.jwk = { kty, crv, x, y };
    this.id = null;
  }

  /** Returns the HTTP status of POST /api/v1/installs. */
  async install() {
    const { challenge, difficulty } = await (await fetch(`${this.proxy.origin}/api/v1/challenge?purpose=install`)).json();
    const res = await fetch(`${this.proxy.origin}/api/v1/installs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: this.jwk, challenge, nonce: solveProof(challenge, difficulty), extVersion: '1.1.0' }),
    });
    if (res.status === 201) this.id = (await res.json()).installId;
    return res.status;
  }

  signed(method, pathWithQuery, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now();
    const nonce = b64url(randomBytes(16));
    const digest = b64url(createHash('sha256').update(raw).digest());
    const data = `XSLOP1\n${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${digest}`;
    const headers = {
      'x-xslop-install': this.id,
      'x-xslop-ts': String(timestamp),
      'x-xslop-nonce': nonce,
      'x-xslop-sig': b64url(sign('sha256', Buffer.from(data, 'utf8'), { key: this.key, dsaEncoding: 'ieee-p1363' })),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    return fetch(`${this.proxy.origin}${pathWithQuery}`, { method, headers, body: body === undefined ? undefined : raw });
  }

  vote(handle, value, tweetId) {
    return this.signed('POST', '/api/v1/votes', { handle, value, tweetId, parentTweetId: null, text: OLD_VOTE_TEXT, postedAt: null, context: 'reply' });
  }
}

export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
