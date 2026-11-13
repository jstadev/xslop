import { createHash, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leadingZeroBits, signRequest, signingInput, solvePow } from '../../src/bg/crypto';

const INSTALL = '3f8e9a8e-2b7c-4c1e-9d55-1c2b3a4d5e6f';

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
}

/** The server check of SPEC 5.1, written from the spec, not from the extension code. */
function serverVerify(jwk: object, method: string, pathWithQuery: string, raw: string, h: Record<string, string>): boolean {
  const data = `XSLOP1\n${method}\n${pathWithQuery}\n${h['x-xslop-ts']}\n${h['x-xslop-nonce']}\n${createHash('sha256').update(raw).digest('base64url')}`;
  return verify('sha256', Buffer.from(data, 'utf8'), { key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' } as never, Buffer.from(h['x-xslop-sig']!, 'base64url'));
}

describe('request signature (SPEC 5.1)', () => {
  it('verifies with the exact Node call of the spec', async () => {
    const { privateKey, jwk } = await keyPair();
    const body = JSON.stringify({ handle: 'slopbot', value: 'slop', note: 'not ASCII 🚀' });
    const h = await signRequest(privateKey, INSTALL, 'POST', '/api/v1/votes', body, 1_762_510_000_123);
    expect(h['x-xslop-install']).toBe(INSTALL);
    expect(h['x-xslop-ts']).toBe('1762510000123');
    expect(h['x-xslop-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(h['x-xslop-sig'], 'base64url')).toHaveLength(64);
    expect(serverVerify(jwk, 'POST', '/api/v1/votes', body, { ...h })).toBe(true);
  });

  it('fails when the body, path, method or time differ', async () => {
    const { privateKey, jwk } = await keyPair();
    const body = '{"handle":"slopbot"}';
    const h = { ...(await signRequest(privateKey, INSTALL, 'POST', '/api/v1/votes', body, Date.now())) };
    expect(serverVerify(jwk, 'POST', '/api/v1/votes', body + ' ', h)).toBe(false);
    expect(serverVerify(jwk, 'POST', '/api/v1/votes?x=1', body, h)).toBe(false);
    expect(serverVerify(jwk, 'DELETE', '/api/v1/votes', body, h)).toBe(false);
    expect(serverVerify(jwk, 'POST', '/api/v1/votes', body, { ...h, 'x-xslop-ts': String(Number(h['x-xslop-ts']) + 1) })).toBe(false);
    const other = await keyPair();
    expect(serverVerify(other.jwk, 'POST', '/api/v1/votes', body, h)).toBe(false);
  });

  it('hashes an empty body as SHA-256 of the empty string, and keeps the query', async () => {
    const s = await signingInput('GET', '/api/v1/me?limit=5', '1', 'AAAAAAAAAAAAAAAAAAAAAA', '');
    expect(s).toBe('XSLOP1\nGET\n/api/v1/me?limit=5\n1\nAAAAAAAAAAAAAAAAAAAAAA\n47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('uses a fresh nonce for every request', async () => {
    const { privateKey } = await keyPair();
    const a = await signRequest(privateKey, INSTALL, 'GET', '/api/v1/me', '', 1);
    const b = await signRequest(privateKey, INSTALL, 'GET', '/api/v1/me', '', 1);
    expect(a['x-xslop-nonce']).not.toBe(b['x-xslop-nonce']);
  });
});

describe('proof of work (SPEC 5.1)', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01, 0xff]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x10]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it('finds a nonce that the server check accepts', async () => {
    const challenge = 'eyJuIjoiYWJjIiwiZXhwIjoxLCJwIjoiaW5zdGFsbCJ9.c2lnbmF0dXJl';
    const nonce = await solvePow(challenge, 14);
    expect(nonce).not.toBeNull();
    expect(nonce!.length).toBeLessThanOrEqual(32);
    const h = createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest();
    expect(leadingZeroBits(h)).toBeGreaterThanOrEqual(14);
  });

  it('yields between chunks and stops when told to', async () => {
    let ticks = 0;
    const nonce = await solvePow('x.y', 22, { chunk: 16, tick: () => ++ticks < 3 });
    expect(nonce).toBeNull();
    expect(ticks).toBe(3);
  });

  it('rejects a bad difficulty', async () => {
    await expect(solvePow('x.y', 23)).rejects.toThrow('bad difficulty');
  });
});
