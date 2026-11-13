// The /sloppers response parsers (SPEC 12.5): the contract shape, future codes and hostile names.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../src/lib/api.ts';
import { parseCriteria, parseLatest, parseSloppersPage } from '../../src/lib/schema.ts';
import { originStory } from '../../src/sloppers/copy.ts';

const AT = '2026-11-07T10:00:00.000Z';
const slopper = {
  handle: 'ava_venture',
  name: 'Ava Fontaine',
  avatar: '/api/v1/avatars/ava_venture',
  followers: 10,
  status: 'confirmed',
  tier: 2,
  score: 93.5,
  seed: true,
  votes: { slop: 3, notSlop: 1 },
  networks: 4,
  needed: 0,
  listedAt: AT,
  reason: 'seed',
  seedSource: 'x_list:2116659176894071283',
  waits: false,
  xUserId: '1400000000000000001',
};
const envelope = (items: unknown[]) => ({ total: items.length, generatedAt: AT, next: null, items });

describe('parseSloppersPage', () => {
  test('accepts the contract shape', () => {
    const parsed = parseSloppersPage({ ...envelope([slopper]), next: 'opaque-cursor' });
    assert.deepEqual(parsed.items, [slopper]);
    assert.equal(parsed.next, 'opaque-cursor');
    const nullable = { ...slopper, name: null, avatar: null, followers: null, listedAt: null, xUserId: null, seedSource: null };
    assert.deepEqual(parseSloppersPage(envelope([nullable])).items, [nullable]);
  });

  test('keeps a valid seedSource; a missing, null or odd one gives null and keeps the row', () => {
    const source = (patch: Record<string, unknown>) => parseSloppersPage(envelope([{ ...slopper, ...patch }])).items;
    assert.equal(source({ seedSource: 'site:clankwall.vogel.dev' })[0]?.seedSource, 'site:clankwall.vogel.dev');
    assert.equal(source({ seedSource: 'x_list:1' })[0]?.seedSource, 'x_list:1');
    const { seedSource: _omitted, ...older } = slopper;
    assert.equal(parseSloppersPage(envelope([older])).items[0]?.seedSource, null);
    for (const bad of [null, 5, '', 'file:x', 'site:Evil.Example', 'site:a b', 'x_list:12a', `site:${'a'.repeat(254)}`, 'site:<b>']) {
      const items = source({ seedSource: bad });
      assert.equal(items.length, 1, String(bad));
      assert.equal(items[0]?.seedSource, null, String(bad));
    }
  });

  test('accepts a future reason code and a flagged tier', () => {
    const flagged = { ...slopper, status: 'flagged', tier: 1, needed: 0, reason: 'some_new_code_2', waits: true };
    assert.deepEqual(parseSloppersPage(envelope([flagged])).items, [flagged]);
  });

  const brokenRows: Record<string, unknown>[] = [
    { handle: 'Bad Handle' },
    { handle: 'x'.repeat(16) },
    { status: 'cleared', tier: 0 },
    { status: 'confirmed', tier: 1 },
    { status: 'flagged', tier: 2 },
    { score: 101 },
    { score: Number.NaN },
    { score: '93' },
    { seed: 'yes' },
    { votes: { slop: -1, notSlop: 0 } },
    { votes: null },
    { networks: 1.5 },
    { needed: -1 },
    { followers: 'many' },
    { avatar: 'https://evil.example/a.png' },
    { avatar: '//evil.example/a.png' },
    { avatar: '/api/v1/avatars/../../etc/passwd' },
    { avatar: 'javascript:alert(1)' },
    { listedAt: 'yesterday' },
    { reason: 'Bad Reason' },
    { reason: 'x'.repeat(41) },
    { name: 5 },
    { waits: null },
    { waits: 'yes' },
    { xUserId: undefined },
    { xUserId: 1400000000000000001 },
    { xUserId: '12a' },
    { xUserId: '1'.repeat(21) },
    { xUserId: '' },
    { status: 'pending', tier: 0 },
  ];

  for (const patch of brokenRows) {
    test(`drops only the broken row: ${JSON.stringify(patch)}`, () => {
      const parsed = parseSloppersPage(envelope([{ ...slopper, ...patch }, slopper]));
      assert.deepEqual(parsed.items, [slopper]);
    });
  }

  test('removes controls and bidi overrides from names, caps them and treats blank as none', () => {
    const name = (value: string) => parseSloppersPage(envelope([{ ...slopper, name: value }])).items[0]?.name;
    assert.equal(name('admin‮gnp.exe\u0000⁦'), 'admingnp.exe');
    assert.equal(name('x'.repeat(300))?.length, 100);
    assert.equal(name(' ‏ '), null);
  });

  const brokenEnvelopes: Record<string, unknown>[] = [
    { total: -1 },
    { total: '3' },
    { generatedAt: 'soon' },
    { next: '' },
    { next: 5 },
    { next: 'c'.repeat(513) },
    { items: 'none' },
    { items: new Array(101).fill(slopper) },
  ];

  for (const patch of brokenEnvelopes) {
    test(`refuses the envelope: ${JSON.stringify(patch).slice(0, 40)}`, () => {
      assert.throws(() => parseSloppersPage({ ...envelope([slopper]), ...patch }), ApiError);
    });
  }

  test('refuses a value that is not an object', () => {
    for (const value of [null, [], 'x', 3]) assert.throws(() => parseSloppersPage(value), ApiError);
  });
});

describe('parseCriteria', () => {
  const tier = { status: 'flagged', title: 'Flagged', summary: 'Why.', rules: ['One rule.'] };
  const criteria = { version: 2, tiers: [tier], weights: ['A weight.'], protections: ['A protection.'], appeal: 'How to appeal.' };

  test('accepts the contract shape', () => {
    assert.deepEqual(parseCriteria(criteria), criteria);
  });

  for (const patch of [{ version: -1 }, { tiers: [] }, { tiers: [{ ...tier, status: 'cleared' }] }, { tiers: [{ ...tier, rules: [1] }] }, { tiers: new Array(5).fill(tier) }, { weights: 'x' }, { protections: [''] }, { appeal: 'x'.repeat(601) }]) {
    test(`refuses ${JSON.stringify(patch).slice(0, 40)}`, () => {
      assert.throws(() => parseCriteria({ ...criteria, ...patch }), ApiError);
    });
  }
});

describe('parseLatest safari', () => {
  const download = { file: 'xslop-safari-v1.1.0.zip', sha256: 'a'.repeat(64), bytes: 10 };

  test('reads a valid entry and refuses a file for another browser', () => {
    assert.deepEqual(parseLatest({ version: '1.1.0', safari: download }).safari, download);
    assert.equal(parseLatest({ version: '1.1.0', safari: { ...download, file: 'xslop-chrome-v1.1.0.zip' } }).safari, null);
    assert.equal(parseLatest({ version: '1.1.0' }).safari, null);
  });
});

describe('originStory of a seed account', () => {
  const story = (patch: Record<string, unknown>) => originStory(parseSloppersPage(envelope([{ ...slopper, ...patch }])).items[0]!);

  test('names the list that gave the account', () => {
    const xList = 'This account was on the public X list “ai slop posters” when xslop started. Seed accounts start as confirmed and can appeal like any other.';
    assert.equal(story({ seedSource: 'x_list:2116659176894071283' }), xList);
    assert.equal(story({ seedSource: null }), xList, 'an older server answer has no source');
    assert.equal(
      story({ seedSource: 'site:clankwall.vogel.dev' }),
      'This account was on Clankwall (clankwall.vogel.dev), a public list of accounts whose replies its checker flagged as spam or AI text. At the import on 13 November 2026, Clankwall had flagged 2 or more of its replies. Seed accounts start as confirmed and can appeal like any other.',
    );
    const other = 'This account was on a public list of slop accounts at the time of its import. Seed accounts start as confirmed and can appeal like any other.';
    assert.equal(story({ seedSource: 'x_list:42' }), other);
    assert.equal(story({ seedSource: 'site:other.example' }), other);
  });

  test('leaves the sentences of the other origins alone', () => {
    assert.equal(story({ reason: 'override_confirm', seedSource: null }), 'An admin confirmed this account by hand.');
  });
});
