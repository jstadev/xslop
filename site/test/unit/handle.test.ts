import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHandle, normalizeHandle, postUrl, profileUrl } from '../../src/lib/handle.ts';

test('normalizeHandle trims, drops one @ and lower-cases', () => {
  assert.equal(normalizeHandle('  @Dillon_Mulroy '), 'dillon_mulroy');
  assert.equal(normalizeHandle('abc123'), 'abc123');
  assert.equal(normalizeHandle('a'), 'a');
  assert.equal(normalizeHandle('a'.repeat(15)), 'a'.repeat(15));
});

test('normalizeHandle rejects bad input', () => {
  for (const bad of ['', '@', '@@abc', 'a'.repeat(16), 'has space', 'dash-name', 'ünï', 'abc/def', '../etc', 'a.b', '<script>']) {
    assert.equal(normalizeHandle(bad), null, bad);
  }
});

test('isHandle accepts only normalized handles', () => {
  assert.equal(isHandle('ok_1'), true);
  assert.equal(isHandle('Upper'), false);
  assert.equal(isHandle(42), false);
});

test('profile and post links only for valid parts', () => {
  assert.equal(profileUrl('abc'), 'https://x.com/abc');
  assert.equal(postUrl('1850000000000000001'), 'https://x.com/i/status/1850000000000000001');
  assert.equal(postUrl('18a'), null);
  assert.equal(postUrl('1'.repeat(21)), null);
  assert.equal(postUrl('1/../../home'), null);
  assert.equal(postUrl(''), null);
});
