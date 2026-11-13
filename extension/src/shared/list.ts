// Global list (SPEC 5.4, 13.8): validation, compact lookup maps, delta apply.
import { HANDLE_RE, isInt, isIso, isObj } from './util';
import { pack, scoreOf, tierOf, type ListRow, type StoredList } from './types';

const MAX_ROWS = 200_000;
/** An X user id in the list: 1 to 20 digits. */
const LIST_ID_RE = /^[0-9]{1,20}$/;

const byHandle = (a: readonly [string, ...unknown[]], b: readonly [string, ...unknown[]]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function isRow(r: unknown): r is ListRow {
  return Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && HANDLE_RE.test(r[0]) &&
    isInt(r[1], 0, 100) && (r[2] === 1 || r[2] === 2);
}

function rows(x: unknown): ListRow[] | null {
  if (!Array.isArray(x) || x.length > MAX_ROWS) return null;
  for (const r of x) if (!isRow(r)) return null;
  return x as ListRow[];
}

/**
 * The X user ids that `x` gives `forRows`: one entry per row, each null or an id. A field that is missing or out of
 * shape gives no ids at all (null for every row): it never costs the list.
 */
function idsOf(forRows: readonly ListRow[], x: unknown): (string | null)[] {
  const none = forRows.map(() => null);
  if (!Array.isArray(x) || x.length !== forRows.length) return none;
  for (const id of x) if (id !== null && (typeof id !== 'string' || !LIST_ID_RE.test(id))) return none;
  return x as (string | null)[];
}

export function parseList(x: unknown, etag: string | null): StoredList | null {
  if (!isObj(x) || x.v !== 1 || !isInt(x.version, 0, Number.MAX_SAFE_INTEGER) || !isIso(x.generatedAt)) return null;
  const got = rows(x.accounts);
  if (!got) return null;
  const ids = idsOf(got, x.ids);
  // Sorted by handle, and each id stays beside its row.
  const order = got.map((_, i) => i).sort((a, b) => byHandle(got[a]!, got[b]!));
  return { version: x.version, generatedAt: x.generatedAt, etag, accounts: order.map((i) => got[i]!), ids: order.map((i) => ids[i] ?? null) };
}

interface Delta {
  from: number;
  version: number;
  add: ListRow[];
  /** The X user id of each added row, in the order of `add`, null for a row without one. */
  ids: (string | null)[];
  remove: string[];
}

export function parseDelta(x: unknown): Delta | null {
  if (!isObj(x) || x.v !== 1 || !isInt(x.from, 0, Number.MAX_SAFE_INTEGER) || !isInt(x.version, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (x.version <= x.from) return null;
  const add = rows(x.add);
  const remove = x.remove;
  if (!add || !Array.isArray(remove) || remove.length > MAX_ROWS) return null;
  for (const h of remove) if (typeof h !== 'string' || !HANDLE_RE.test(h)) return null;
  return { from: x.from, version: x.version, add, ids: idsOf(add, x.addIds), remove: remove as string[] };
}

/** handle -> pack(score, tier). */
export function toMap(rowsIn: readonly ListRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [h, s, t] of rowsIn) m.set(h, pack(s, t));
  return m;
}

/** Apply removes first, then adds (an add of the same handle wins). */
export function applyDelta(m: Map<string, number>, d: Pick<Delta, 'add' | 'remove'>): void {
  for (const h of d.remove) m.delete(h);
  for (const [h, s, t] of d.add) m.set(h, pack(s, t));
}

export function fromMap(m: Map<string, number>): ListRow[] {
  const out: ListRow[] = [];
  for (const [h, p] of m) out.push([h, scoreOf(p), tierOf(p)]);
  return out.sort(byHandle);
}

/** handle -> X user id of each row of a stored list that has one. */
export function idMap(list: StoredList | null): Map<string, string> {
  const m = new Map<string, string>();
  const ids = list?.ids;
  if (!ids) return m;
  list.accounts.forEach(([h], i) => {
    const id = ids[i];
    if (id) m.set(h, id);
  });
  return m;
}

/**
 * The ids beside `next`, the rows after delta `d` on `list`: a removed or added row loses its old id, and an added row
 * takes the id that the delta gives it.
 */
export function applyIds(list: StoredList, d: Pick<Delta, 'add' | 'ids' | 'remove'>, next: readonly ListRow[]): (string | null)[] {
  const m = idMap(list);
  for (const h of d.remove) m.delete(h);
  d.add.forEach(([h], i) => {
    const id = d.ids[i];
    if (id) m.set(h, id);
    else m.delete(h);
  });
  return next.map(([h]) => m.get(h) ?? null);
}
