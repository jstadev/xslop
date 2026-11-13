// Proof of work from SPEC 5.1: find `nonce` (<= 32 chars) so that
// SHA-256(utf8(challenge + ":" + nonce)) starts with `bits` zero bits. Uses WebCrypto only.

export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

interface SolveOptions {
  /** Digests in flight per round. WebCrypto is async, so batching keeps the worker busy. */
  batch?: number;
  /** Stop after this many tries. Defaults to 2^(bits + 8), far past the expected 2^bits. */
  maxTries?: number;
  onProgress?: (tries: number) => void;
  isCancelled?: () => boolean;
  subtle?: SubtleCrypto;
}

interface Solution {
  nonce: string;
  tries: number;
}

export async function solve(challenge: string, bits: number, opts: SolveOptions = {}): Promise<Solution> {
  if (!Number.isInteger(bits) || bits < 1 || bits > 28) throw new RangeError('difficulty out of range');
  const subtle = opts.subtle ?? globalThis.crypto.subtle;
  const batch = opts.batch ?? 2048;
  const maxTries = opts.maxTries ?? 2 ** (bits + 8);
  const prefix = new TextEncoder().encode(`${challenge}:`);
  let next = 0;
  while (next < maxTries) {
    if (opts.isCancelled?.()) throw new Error('cancelled');
    const start = next;
    const round: Promise<ArrayBuffer>[] = [];
    for (let i = 0; i < batch; i++) {
      const nonce = (start + i).toString(36);
      const input = new Uint8Array(prefix.length + nonce.length);
      input.set(prefix);
      for (let j = 0; j < nonce.length; j++) input[prefix.length + j] = nonce.charCodeAt(j);
      round.push(subtle.digest('SHA-256', input));
    }
    const digests = await Promise.all(round);
    for (let i = 0; i < digests.length; i++) {
      const digest = digests[i];
      if (digest && leadingZeroBits(new Uint8Array(digest)) >= bits) {
        return { nonce: (start + i).toString(36), tries: start + i + 1 };
      }
    }
    next = start + batch;
    opts.onProgress?.(next);
  }
  throw new Error('no solution within the try limit');
}
