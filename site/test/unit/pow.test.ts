import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { leadingZeroBits, solve } from '../../src/lib/pow.ts';

test('leadingZeroBits counts across bytes', () => {
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x01])), 7);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x0f])), 12);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0])), 24);
});

test('solve finds a nonce that Node crypto accepts (cross-implementation round trip)', async () => {
  const challenge = 'eyJuIjoiYWJjIiwiZXhwIjoxLCJwIjoiYXBwZWFsIn0.c2lnbmF0dXJlc2ln';
  const bits = 14;
  let progress = 0;
  const { nonce, tries } = await solve(challenge, bits, { batch: 512, onProgress: (n) => (progress = n) });
  assert.ok(nonce.length >= 1 && nonce.length <= 32);
  assert.ok(tries >= 1);
  const digest = createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest();
  assert.ok(leadingZeroBits(digest) >= bits, 'digest must start with the required zero bits');
  assert.ok(progress === 0 || progress < tries + 512);
});

test('solve stops at the try limit and on cancel', async () => {
  await assert.rejects(solve('x.y', 28, { maxTries: 1024, batch: 256 }), /try limit/);
  await assert.rejects(solve('x.y', 20, { isCancelled: () => true }), /cancelled/);
});

test('solve refuses out-of-range difficulty', async () => {
  await assert.rejects(solve('x.y', 0), RangeError);
  await assert.rejects(solve('x.y', 29), RangeError);
  await assert.rejects(solve('x.y', 1.5), RangeError);
});
