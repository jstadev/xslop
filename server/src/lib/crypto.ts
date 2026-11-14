/** Hashes and tokens: the network hash of an address, proof-of-work challenges, admin password hashes, constant-time compare. */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url');
export const sha256 = (data: string | Buffer | Uint8Array): Buffer => createHash('sha256').update(data).digest();
export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

// ---- IP hash (section 5.1) ----

/** Four decimal octets, 0 to 255. A leading zero is decimal, not octal. */
function parseV4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = [0, 0, 0, 0] as [number, number, number, number];
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function expandIPv6(addr: string): number[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const part = (s: string | undefined) => (s ? s.split(':') : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const out = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** Eight groups. A trailing dotted quad becomes the last two groups first, so every spelling parses. */
function parseIPv6(ip: string): number[] | null {
  const zone = ip.indexOf('%');
  let addr = zone >= 0 ? ip.slice(0, zone) : ip;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  return expandIPv6(addr);
}

function v4prefix(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.0/24`;
}

function zeros(g: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (g[i] !== 0) return false;
  return true;
}

/** The /24 of an embedded IPv4, or null when this address is an ordinary IPv6 network. */
function embeddedV4(g: number[]): string | null {
  // IPv4-mapped ::ffff:0:0/96, dotted or hex.
  if (zeros(g, 0, 5) && g[5] === 0xffff) return v4prefix(g[6]!, g[7]!);
  // IPv4-translated ::ffff:0:0:0/96. This is not the mapped form: ffff sits one group earlier.
  if (zeros(g, 0, 4) && g[4] === 0xffff && g[5] === 0) return v4prefix(g[6]!, g[7]!);
  // IPv4-compatible ::/96. :: and ::1 stay one IPv6 network.
  if (zeros(g, 0, 6) && !(g[6] === 0 && (g[7] === 0 || g[7] === 1))) return v4prefix(g[6]!, g[7]!);
  // 6to4 2002::/16. The IPv4 is the next 32 bits, so one /24 is one network.
  if (g[0] === 0x2002) return v4prefix(g[1]!, g[2]!);
  // Teredo 2001:0::/32. The client IPv4 is the last 32 bits with each bit flipped.
  if (g[0] === 0x2001 && g[1] === 0) return v4prefix(g[6]! ^ 0xffff, g[7]! ^ 0xffff);
  // NAT64 well-known 64:ff9b::/96.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(g, 2, 6)) return v4prefix(g[6]!, g[7]!);
  // NAT64 local 64:ff9b:1::/48 (RFC 6052, prefix length 48). The u byte must be 0.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1 && (g[4]! >> 8) === 0) {
    return `${g[3]! >> 8}.${g[3]! & 0xff}.${g[4]! & 0xff}.0/24`;
  }
  return null;
}

/** IPv4 /24, or the embedded IPv4 /24 of a transition address, or the IPv6 /48. A zone id is ignored. */
export function ipPrefix(ip: string): string {
  const zone = ip.indexOf('%');
  const bare = zone >= 0 ? ip.slice(0, zone) : ip;
  if (!bare.includes(':')) {
    const v4 = parseV4(bare);
    return v4 ? `${v4[0]}.${v4[1]}.${v4[2]}.0/24` : 'unknown';
  }
  const g = parseIPv6(bare);
  if (!g) return 'unknown';
  return embeddedV4(g) ?? `${g[0]!.toString(16)}:${g[1]!.toString(16)}:${g[2]!.toString(16)}::/48`;
}

export function ipHash(salt: Buffer, ip: string): string {
  return createHmac('sha256', salt).update(ipPrefix(ip)).digest('hex').slice(0, 32);
}

// ---- Proof-of-work challenges (section 5.1) ----

export type Purpose = 'install' | 'appeal';
const CHALLENGE_TTL_SEC = 600;

export function issueChallenge(secret: Buffer, purpose: Purpose, nowMs: number): { token: string; exp: number } {
  const exp = Math.floor(nowMs / 1000) + CHALLENGE_TTL_SEC;
  const payload = b64url(Buffer.from(JSON.stringify({ n: randomBytes(16).toString('hex'), exp, p: purpose })));
  const mac = b64url(createHmac('sha256', secret).update(payload).digest());
  return { token: `${payload}.${mac}`, exp };
}

type ChallengeCheck = { ok: true; exp: number } | { ok: false; reason: 'invalid_challenge' | 'challenge_expired' | 'bad_proof' };

function leadingZeroBits(buf: Buffer, bits: number): boolean {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (buf[i] !== 0) return false;
  const rest = bits & 7;
  return rest === 0 || (buf[full]! >> (8 - rest)) === 0;
}

function solves(token: string, nonce: string, bits: number): boolean {
  return leadingZeroBits(sha256(`${token}:${nonce}`), bits);
}

/** Checks MAC, purpose, expiry and the proof. Single use is enforced by the caller (used_challenges). */
export function checkChallenge(secret: Buffer, token: string, nonce: string, purpose: Purpose, bits: number, nowMs: number): ChallengeCheck {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'invalid_challenge' };
  const payload = token.slice(0, dot);
  // Compare the canonical base64url text, so a token has exactly one accepted spelling.
  const mac = Buffer.from(token.slice(dot + 1), 'utf8');
  const want = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'), 'utf8');
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return { ok: false, reason: 'invalid_challenge' };
  let body: { n?: unknown; exp?: unknown; p?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_challenge' };
  }
  if (body.p !== purpose || typeof body.exp !== 'number') return { ok: false, reason: 'invalid_challenge' };
  if (body.exp * 1000 <= nowMs) return { ok: false, reason: 'challenge_expired' };
  if (!solves(token, nonce, bits)) return { ok: false, reason: 'bad_proof' };
  return { ok: true, exp: body.exp };
}

// ---- Admin password hashes (section 5.6) ----

export interface ScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

function scryptAsync(password: string | Buffer, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function parseScryptHash(s: string): ScryptHash | null {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/_-]+={0,2})\$([A-Za-z0-9+/_-]+={0,2})$/.exec(s);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const salt = Buffer.from(m[4]!, 'base64');
  const hash = Buffer.from(m[5]!, 'base64');
  const pow2 = N >= 1024 && N <= 1 << 20 && (N & (N - 1)) === 0;
  if (!pow2 || r < 1 || r > 32 || p < 1 || p > 16 || salt.length < 16 || hash.length < 32) return null;
  return { N, r, p, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, N, r, p, keylen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, h: ScryptHash): Promise<boolean> {
  const got = await scryptAsync(password, h.salt, h.N, h.r, h.p, h.hash.length);
  return timingSafeEqual(got, h.hash);
}

/** Constant-time string equality over SHA-256 digests (no length leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

// ---- Admin second factor (section 13.8): TOTP of RFC 6238 with HMAC-SHA-1, 30 s steps, 6 digits ----

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SEC = 30;
const TOTP_DIGITS = 6;

/** RFC 4648 base32 without padding, upper or lower case; null when a character is outside the alphabet. */
export function base32Decode(text: string): Buffer | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    // At most 12 bits wait for the next byte, so 13 bits of `value` are enough.
    value = ((value << 5) | v) & 0x1fff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The 6-digit HOTP value of one counter (RFC 4226, dynamic truncation). */
export function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const bin = mac.readUInt32BE(mac[mac.length - 1]! & 0xf) & 0x7fffffff;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The time step whose code is `code`, with one step of drift each way, or null. All three candidates are compared. */
export function totpStep(key: Buffer, code: string, nowMs: number): number | null {
  const step = Math.floor(nowMs / 1000 / TOTP_STEP_SEC);
  let found: number | null = null;
  for (const s of [step - 1, step, step + 1]) if (safeEqual(hotp(key, s), code)) found = s;
  return found;
}
