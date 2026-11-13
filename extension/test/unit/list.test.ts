import { describe, expect, it } from 'vitest';
import { hideReason } from '../../src/shared/hidden';
import { applyDelta, applyIds, fromMap, idMap, parseDelta, parseList, toMap } from '../../src/shared/list';
import type { StoredList } from '../../src/shared/types';

const at = '2026-11-07T10:00:00.000Z';

describe('list parse', () => {
  it('accepts the server shape and sorts by handle', () => {
    const l = parseList({ v: 1, version: 7, generatedAt: at, accounts: [['zed', 90, 2], ['abe', 50, 1]] }, '"7"');
    expect(l).toEqual({ version: 7, generatedAt: at, etag: '"7"', accounts: [['abe', 50, 1], ['zed', 90, 2]], ids: [null, null] });
  });
  it('SPEC 13.10 keeps the X user id of each row beside its row, null for none, also when it sorts the rows', () => {
    const l = parseList({ v: 1, version: 7, generatedAt: at, accounts: [['zed', 90, 2], ['abe', 50, 1], ['kim', 70, 2]], ids: ['900', null, '12345678901234567890'] }, null);
    expect(l?.accounts).toEqual([['abe', 50, 1], ['kim', 70, 2], ['zed', 90, 2]]);
    expect(l?.ids).toEqual([null, '12345678901234567890', '900']);
  });
  it.each([
    ['more ids than rows', ['1', '2', '3']],
    ['fewer ids than rows', ['1']],
    ['an id with letters', ['1', '2a']],
    ['an id of 21 digits', ['1', '1'.repeat(21)]],
    ['an empty id', ['1', '']],
    ['a number for an id', ['1', 2]],
    ['ids that are not a list', { zed: '1' }],
  ])('SPEC 13.8 drops all ids, never the list, for %s', (_, ids) => {
    const l = parseList({ v: 1, version: 7, generatedAt: at, accounts: [['zed', 90, 2], ['abe', 50, 1]], ids }, null);
    expect(l).toEqual({ version: 7, generatedAt: at, etag: null, accounts: [['abe', 50, 1], ['zed', 90, 2]], ids: [null, null] });
  });
  it.each([
    ['upper case handle', [['Zed', 90, 2]]],
    ['score over 100', [['zed', 101, 2]]],
    ['fractional score', [['zed', 9.5, 2]]],
    ['tier 0', [['zed', 90, 0]]],
    ['extra column', [['zed', 90, 2, 1]]],
    ['long handle', [['a'.repeat(16), 90, 2]]],
  ])('rejects %s', (_, accounts) => {
    expect(parseList({ v: 1, version: 7, generatedAt: at, accounts }, null)).toBeNull();
  });
  it('rejects a wrong version marker or date', () => {
    expect(parseList({ v: 2, version: 7, generatedAt: at, accounts: [] }, null)).toBeNull();
    expect(parseList({ v: 1, version: -1, generatedAt: at, accounts: [] }, null)).toBeNull();
    expect(parseList({ v: 1, version: 1, generatedAt: 'yesterday', accounts: [] }, null)).toBeNull();
  });
});

describe('list delta', () => {
  it('applies removes, then adds and changed scores', () => {
    const m = toMap([['abe', 50, 1], ['bob', 70, 2], ['cat', 99, 2]]);
    const d = parseDelta({ v: 1, from: 7, version: 9, add: [['abe', 81, 2], ['dan', 60, 1]], remove: ['bob'] });
    expect(d).not.toBeNull();
    applyDelta(m, d!);
    expect(fromMap(m)).toEqual([['abe', 81, 2], ['cat', 99, 2], ['dan', 60, 1]]);
  });
  /** The rows and ids of a stored list after delta `d`, as the list sync computes them. */
  const afterDelta = (before: StoredList, d: NonNullable<ReturnType<typeof parseDelta>>) => {
    const m = toMap(before.accounts);
    applyDelta(m, d);
    const accounts = fromMap(m);
    return { accounts, ids: applyIds(before, d, accounts) };
  };
  const before: StoredList = { version: 7, generatedAt: at, etag: null, accounts: [['abe', 50, 1], ['bob', 70, 2], ['cat', 99, 2], ['eve', 10, 2]], ids: ['1', '2', '3', null] };

  it('SPEC 13.8 reads addIds: an added row takes its new id, a changed id replaces the old one, a removed row loses its id', () => {
    const d = parseDelta({ v: 1, from: 7, version: 9, add: [['abe', 81, 2], ['dan', 60, 1], ['cat', 99, 2]], addIds: ['11', '4', null], remove: ['bob'] });
    expect(d?.ids).toEqual(['11', '4', null]);
    expect(afterDelta(before, d!)).toEqual({ accounts: [['abe', 81, 2], ['cat', 99, 2], ['dan', 60, 1], ['eve', 10, 2]], ids: ['11', null, '4', null] });
  });
  it('SPEC 13.8 a delta of an older server, or with bad addIds, keeps its rows; the added rows have no id', () => {
    for (const addIds of [undefined, ['5'], ['x5', '6'], [5, 6]]) {
      const d = parseDelta({ v: 1, from: 7, version: 9, add: [['abe', 81, 2], ['dan', 60, 1]], addIds, remove: [] });
      expect(d?.add).toEqual([['abe', 81, 2], ['dan', 60, 1]]);
      expect(afterDelta(before, d!).ids).toEqual([null, '2', '3', null, null]);
    }
  });
  it('SPEC 13.10 maps each handle to its id, and leaves out the rows without one', () => {
    expect([...idMap(before)]).toEqual([['abe', '1'], ['bob', '2'], ['cat', '3']]);
    expect(idMap({ ...before, ids: undefined }).size).toBe(0);
    expect(idMap(null).size).toBe(0);
  });
  it('rejects a delta that does not move forward or has bad rows', () => {
    expect(parseDelta({ v: 1, from: 9, version: 9, add: [], remove: [] })).toBeNull();
    expect(parseDelta({ v: 1, from: 1, version: 2, add: [['x', 1, 3]], remove: [] })).toBeNull();
    expect(parseDelta({ v: 1, from: 1, version: 2, add: [], remove: ['Bad!'] })).toBeNull();
  });
  it('is safe for handles that are also object keys', () => {
    const m = toMap([['__proto__', 90, 2], ['abe', 50, 2]]);
    expect(m.get('__proto__')).toBe(90 * 4 + 2);
    expect(hideReason('constructor', new Map(), m, 'strict')).toBeNull();
    expect(hideReason('__proto__', new Map(), m, 'balanced')).toEqual({ kind: 'global', score: 90 });
  });
});

describe('stored size (SPEC 13.10 item 9)', () => {
  /**
   * Chrome's storage.local without unlimitedStorage counts about the JSON of every value plus the length of every key.
   * Chromium 157 counted 9,600,123 bytes for the largest list below, and refused its pair form with a quota error.
   */
  const QUOTA_BYTES = 10_485_760;
  const stored = (key: string, value: unknown): number => key.length + Buffer.byteLength(JSON.stringify(value));

  it('the largest list (200,000 rows, 15-character handles, 19-digit ids, 3-digit scores) fits in storage.local', () => {
    const n = 200_000;
    const accounts = Array.from({ length: n }, (_, i) => [`h${String(i).padStart(14, '0')}`, 100, 2]);
    const ids = Array.from({ length: n }, (_, i) => `1${String(i).padStart(18, '0')}`);
    const list = parseList({ v: 1, version: 2 ** 40, generatedAt: '2026-11-12T21:00:00.000Z', accounts, ids }, '"1099511627776"')!;
    expect([list.accounts[n - 1]![0].length, list.ids![n - 1]!.length, list.ids!.every(Boolean)]).toEqual([15, 19, true]);
    const size = stored('list', list);
    expect(size).toBe(9_600_118);
    expect(size).toBeLessThan(QUOTA_BYTES);
    // The [handle, id] pairs of the 1.2.0 test build: the same list does not fit.
    const pairs = list.accounts.map((r, i) => [r[0], list.ids![i]]);
    expect(stored('list', { ...list, ids: pairs })).toBeGreaterThan(QUOTA_BYTES);
  });
});

describe('hide decision (SPEC 7.3)', () => {
  const list = toMap([['tier2', 87, 2], ['tier1', 64, 1]]);
  const votes = new Map<string, 0 | 1>([['mine', 1], ['allowed2', 0]]);
  const allowList = toMap([['allowed2', 95, 2]]);
  it.each([
    ['balanced', 'tier2', { kind: 'global', score: 87 }],
    ['balanced', 'tier1', null],
    ['strict', 'tier1', { kind: 'global', score: 64 }],
    ['strict', 'tier2', { kind: 'global', score: 87 }],
    ['off', 'tier2', null],
    ['off', 'mine', { kind: 'personal' }],
    ['balanced', 'mine', { kind: 'personal' }],
    ['balanced', 'nobody', null],
  ] as const)('%s hides %s as %j', (strictness, handle, want) => {
    expect(hideReason(handle, votes, list, strictness)).toEqual(want);
  });
  it('never hides an account on your allow list', () => {
    for (const s of ['off', 'balanced', 'strict'] as const) expect(hideReason('allowed2', votes, allowList, s)).toBeNull();
  });
});
