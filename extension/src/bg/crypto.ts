// SPEC 5.1: request signatures (ECDSA P-256, IEEE P1363) and proof of work (SHA-256 leading zero bits).
import { b64url } from '../shared/util';

const enc = new TextEncoder();

async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** The exact signed string: "XSLOP1\n" METHOD \n pathWithQuery \n ts \n nonce \n base64url(SHA-256(rawBody)). */
export async function signingInput(method: string, pathWithQuery: string, ts: string, nonce: string, rawBody: string): Promise<string> {
  return `XSLOP1\n${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${b64url(await sha256(rawBody))}`;
}

interface SignedHeaders {
  'x-xslop-install': string;
  'x-xslop-ts': string;
  'x-xslop-nonce': string;
  'x-xslop-sig': string;
}

export async function signRequest(
  key: CryptoKey, installId: string, method: string, pathWithQuery: string, rawBody: string, nowMs: number,
): Promise<SignedHeaders> {
  const ts = String(Math.round(nowMs));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const data = enc.encode(await signingInput(method, pathWithQuery, ts, nonce, rawBody));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));
  return { 'x-xslop-install': installId, 'x-xslop-ts': ts, 'x-xslop-nonce': nonce, 'x-xslop-sig': b64url(sig) };
}

export function leadingZeroBits(h: Uint8Array): number {
  let n = 0;
  for (const b of h) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** The hardest proof of work that xslop does: 2^22 hashes on average, well under a minute. */
export const POW_MAX = 22;

interface PowOptions {
  /** Called between chunks; return false to stop. */
  tick?: (tried: number) => boolean | Promise<boolean>;
  chunk?: number;
}

/**
 * Find nonce (base36 counter, at most 32 chars) so that SHA-256(challenge + ":" + nonce) starts with
 * `difficulty` zero bits. Runs in chunks of async digests, so the event loop stays free.
 */
export async function solvePow(challenge: string, difficulty: number, opts: PowOptions = {}): Promise<string | null> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > POW_MAX) throw new Error('bad difficulty');
  const chunk = opts.chunk ?? 64;
  const prefix = challenge + ':';
  for (let n = 0; n < Number.MAX_SAFE_INTEGER; n += chunk) {
    const hashes = await Promise.all(
      Array.from({ length: chunk }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(prefix + (n + i).toString(36)))),
    );
    for (let i = 0; i < chunk; i++) {
      if (leadingZeroBits(new Uint8Array(hashes[i]!)) >= difficulty) return (n + i).toString(36);
    }
    if (opts.tick && !(await opts.tick(n + chunk))) return null;
  }
  return null;
}
