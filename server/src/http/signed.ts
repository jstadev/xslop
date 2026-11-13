/** The guard of every signed route (section 5.1): header shape, clock window, ECDSA signature, ban, nonce replay. */
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../app.js';
import { b64url, sha256 } from '../lib/crypto.js';
import { sendError, UUID_RE } from '../lib/http.js';

interface SignedInstall {
  id: string;
  createdAt: Date;
  reputation: number;
  ipHash: string;
  trusted: boolean;
  /** Stored by the score job (section 13.2): it chooses the stored-vote limit of the install. */
  standing: boolean;
  goodMarks: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    install?: SignedInstall;
  }
}

const MAX_SKEW_MS = 300_000;
const NONCE_TTL_MS = 600_000;
const LAST_SEEN_EVERY_MS = 3_600_000;
const EMPTY = Buffer.alloc(0);

const INSTALL_RE = new RegExp(UUID_RE);
const TS_RE = /^[0-9]{1,16}$/;
// Canonical base64url only: the last character of 16 and 64 bytes carries unused bits, which must be zero,
// so each nonce and signature has exactly one accepted spelling.
const NONCE_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

/**
 * Per-install nonces of the last 10 minutes. Insertion order is time order, so expiry prunes from the front.
 * A nonce lives through its last millisecond: a request stays inside the clock window for exactly that long.
 */
export class NonceCache {
  private readonly byInstall = new Map<string, Map<string, number>>();
  private lastSweep = 0;

  constructor(
    private readonly ttlMs = NONCE_TTL_MS,
    private readonly maxPerInstall = 1000,
  ) {}

  private static prune(m: Map<string, number>, now: number): void {
    for (const [k, exp] of m) {
      if (exp >= now) break;
      m.delete(k);
    }
  }

  check(install: string, nonce: string, now: number): 'ok' | 'replay' | 'full' {
    this.sweep(now);
    let m = this.byInstall.get(install);
    if (!m) {
      m = new Map();
      this.byInstall.set(install, m);
    }
    const exp = m.get(nonce);
    if (exp !== undefined && exp >= now) return 'replay';
    if (m.size >= this.maxPerInstall) NonceCache.prune(m, now);
    if (m.size >= this.maxPerInstall) return 'full';
    m.delete(nonce);
    m.set(nonce, now + this.ttlMs);
    return 'ok';
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, m] of this.byInstall) {
      NonceCache.prune(m, now);
      if (m.size === 0) this.byInstall.delete(id);
    }
  }
}

/** The exact string that the extension signs (section 5.1). */
function signingString(method: string, pathWithQuery: string, ts: string, nonce: string, rawBody: Buffer): string {
  return `XSLOP1\n${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${b64url(sha256(rawBody))}`;
}

interface InstallRow {
  public_key: JsonWebKey;
  created_at: Date;
  reputation: number;
  banned_at: Date | null;
  last_seen_at: Date | null;
  ip_hash: string;
  trusted: boolean;
  standing: boolean;
  good_marks: number;
}

export function createSignedGuard(ctx: Ctx) {
  const nonces = new NonceCache();
  // Public keys never change for an install; parse each JWK once.
  const keys = new Map<string, KeyObject>();
  const keyFor = (id: string, jwk: JsonWebKey): KeyObject => {
    let k = keys.get(id);
    if (!k) {
      k = createPublicKey({ key: jwk, format: 'jwk' });
      if (keys.size >= 10_000) keys.delete(keys.keys().next().value!);
      keys.set(id, k);
    }
    return k;
  };

  return async function verifySigned(req: FastifyRequest, reply: FastifyReply) {
    const h = req.headers;
    const id = h['x-xslop-install'];
    const ts = h['x-xslop-ts'];
    const nonce = h['x-xslop-nonce'];
    const sig = h['x-xslop-sig'];
    if (typeof id !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
      return sendError(reply, 401, 'missing_signature', 'This request needs the x-xslop-install, x-xslop-ts, x-xslop-nonce and x-xslop-sig headers.');
    }
    if (!INSTALL_RE.test(id) || !TS_RE.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) {
      return sendError(reply, 401, 'bad_signature', 'The signature headers are malformed.');
    }
    const now = ctx.now();
    if (Math.abs(Number(ts) - now) > MAX_SKEW_MS) {
      return sendError(reply, 401, 'clock_skew', 'The request time is more than 300 seconds from the server time.');
    }
    const { rows } = await ctx.db.query<InstallRow>(
      'select public_key, created_at, reputation, banned_at, last_seen_at, ip_hash, trusted, standing, good_marks from installs where id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return sendError(reply, 401, 'unknown_install', 'This install is not registered.');

    const data = Buffer.from(signingString(req.method, req.url, ts, nonce, req.rawBody ?? EMPTY), 'utf8');
    let valid = false;
    try {
      valid = verify('sha256', data, { key: keyFor(id, row.public_key), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) return sendError(reply, 401, 'bad_signature', 'The request signature is not valid.');
    // Checked after the signature, so only the key holder learns that the install is banned.
    if (row.banned_at) return sendError(reply, 403, 'banned', 'This install is banned.');

    const seen = nonces.check(id, nonce, now);
    if (seen === 'replay') return sendError(reply, 401, 'replay', 'This nonce was already used.');
    if (seen === 'full') {
      reply.header('retry-after', '60');
      return sendError(reply, 429, 'rate_limited', 'Too many signed requests. Try again later.');
    }

    if (!row.last_seen_at || now - row.last_seen_at.getTime() >= LAST_SEEN_EVERY_MS) {
      await ctx.db.query('update installs set last_seen_at = now() where id = $1', [id]);
    }
    req.install = { id, createdAt: row.created_at, reputation: row.reputation, ipHash: row.ip_hash, trusted: row.trusted, standing: row.standing, goodMarks: row.good_marks };
  };
}
