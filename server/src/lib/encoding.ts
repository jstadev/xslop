/** Response bodies: strong ETags, precomputed gzip and brotli, and the choice of a coding for a request. */
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync, type BrotliOptions } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from './crypto.js';

/** A strong ETag derived from the exact bytes. */
export function etagOf(body: Buffer): string {
  return `"${sha256(body).toString('base64url').slice(0, 27)}"`;
}

export interface Encoded {
  identity: Buffer;
  gzip: Buffer | null;
  br: Buffer | null;
}

const MIN_COMPRESSED_BYTES = 256;
const GZIP_OPTIONS = { level: 9 };
const gzipAsync = promisify(gzip);
const brotliAsync = promisify<Buffer, BrotliOptions, Buffer>(brotliCompress);

function brotliOptions(bytes: number): BrotliOptions {
  return {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes,
    },
  };
}

export function compress(body: Buffer): { gzip: Buffer; br: Buffer } {
  return { gzip: gzipSync(body, GZIP_OPTIONS), br: brotliCompressSync(body, brotliOptions(body.length)) };
}

/** Keeps a variant only when it is smaller. */
const smallerVariants = (identity: Buffer, gzip: Buffer, br: Buffer): Encoded => ({
  identity,
  gzip: gzip.length < identity.length ? gzip : null,
  br: br.length < identity.length ? br : null,
});

/** Precomputes gzip and br for a text body. Blocks the event loop: for startup only. */
export function encodeAll(identity: Buffer): Encoded {
  if (identity.length < MIN_COMPRESSED_BYTES) return { identity, gzip: null, br: null };
  const { gzip, br } = compress(identity);
  return smallerVariants(identity, gzip, br);
}

/** encodeAll on the thread pool, for a body built on the request path: brotli 11 takes seconds on a large body. */
export async function encodeAllAsync(identity: Buffer): Promise<Encoded> {
  if (identity.length < MIN_COMPRESSED_BYTES) return { identity, gzip: null, br: null };
  const [gzip, br] = await Promise.all([gzipAsync(identity, GZIP_OPTIONS), brotliAsync(identity, brotliOptions(identity.length))]);
  return smallerVariants(identity, gzip, br);
}

/** Which stored codings the client accepts (q=0 refuses a coding; `*` covers the unnamed ones). */
export function acceptedCodings(header: string | undefined): { br: boolean; gzip: boolean } {
  if (!header) return { br: false, gzip: false };
  let br = -1;
  let gzip = -1;
  let star = -1;
  for (const part of header.split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (name === 'br') br = q;
    else if (name === 'gzip' || name === 'x-gzip') gzip = q;
    else if (name === '*') star = q;
  }
  return { br: (br < 0 ? star : br) > 0, gzip: (gzip < 0 ? star : gzip) > 0 };
}

/** True when If-None-Match lists this ETag (weak comparison, RFC 9110 13.1.2). */
export function etagMatches(req: FastifyRequest, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  if (inm.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return inm.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
}

/** Sends br, then gzip, then identity. `identity` may be built lazily (the list stores only gzip and br). */
export function sendVariant(
  req: FastifyRequest,
  reply: FastifyReply,
  v: { gzip: Buffer | null; br: Buffer | null; identity: () => Buffer },
): FastifyReply {
  reply.header('vary', 'Accept-Encoding');
  const ok = acceptedCodings(req.headers['accept-encoding']);
  if (ok.br && v.br) return reply.header('content-encoding', 'br').send(v.br);
  if (ok.gzip && v.gzip) return reply.header('content-encoding', 'gzip').send(v.gzip);
  return reply.send(v.identity());
}
