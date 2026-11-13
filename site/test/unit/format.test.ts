import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listFrom, num, str } from '../../src/admin/rows.ts';
import { formatBytes, formatRelative, formatStat, retryMinutes } from '../../src/lib/format.ts';

test('formatStat keeps full digits below a million', () => {
  assert.equal(formatStat(402113), '402,113');
  assert.equal(formatStat(1_402_113), '1.4M');
  assert.equal(formatStat(0), '0');
});

test('formatBytes and retryMinutes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(86016), '84 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(retryMinutes(0), 1);
  assert.equal(retryMinutes(61), 2);
});

test('formatRelative uses the injected clock', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(formatRelative('2026-11-07T11:59:50Z', now), 'just now');
  assert.equal(formatRelative('2026-11-07T11:57:00Z', now), '3 minutes ago');
  assert.equal(formatRelative('2026-11-07T09:00:00Z', now), '3 hours ago');
  assert.equal(formatRelative('2026-11-06T12:00:00Z', now), 'yesterday');
});

test('a date ahead of the device clock reads as just now', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(formatRelative('2026-11-07T12:05:00Z', now), 'just now');
  assert.equal(formatRelative('2026-11-07T11:58:00Z', now), '2 minutes ago');
});

test('admin rows accept arrays, named lists and both key styles', () => {
  assert.equal(listFrom([{ a: 1 }, 2, null], 'x').length, 1);
  assert.equal(listFrom({ appeals: [{ a: 1 }] }, 'appeals').length, 1);
  assert.equal(listFrom({ items: [{ a: 1 }, { b: 2 }] }, 'appeals').length, 2);
  assert.deepEqual(listFrom({ nothing: true }, 'appeals'), []);
  assert.equal(str({ created_at: 'x' }, 'createdAt', 'created_at'), 'x');
  assert.equal(num({ score: Number.NaN }, 'score'), null);
  assert.equal(num({ score: 0.5 }, 'score'), 0.5);
});
