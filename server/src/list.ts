/** The global list: the snapshot writer, the snapshot and delta formats, and the in-memory cache that serves the newest snapshot. */
import { gunzipSync } from 'node:zlib';
import type { Db, Queryable } from './db.js';
import { toBuffer } from './db.js';
import { compress, encodeAllAsync, type Encoded } from './lib/encoding.js';

/** One list entry: [handle, score 0..100, tier]. Rows keep 3 elements, so an extension 1.1.x reads the list as before. */
export type ListEntry = [string, number, number];
/** An entry and the X id of its account (SPEC 13.8): the list compares and stores both. */
type ListRow = [string, number, number, string | null];

export interface ListDelta {
  from: number | null;
  add: ListEntry[];
  addIds: (string | null)[];
  remove: string[];
}

interface Snapshot {
  version: number;
  etag: string;
  generatedAt: Date;
  gzip: Buffer;
  br: Buffer;
  identity: Buffer | null;
}

const LIST_CHECK_MS = 15_000;
/** pg_advisory_xact_lock key. The second key is the schema, so staging and prod, which share one database, do not block each other. One publish at a time in a schema: versions follow the commit order and each delta starts at the version before it. The lock ends when the transaction ends. */
const LIST_LOCK = 0x7a510004;

const entryOf = (r: ListRow): ListEntry => [r[0], r[1], r[2]];
const byHandle = (a: { 0: string }, b: { 0: string }) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** add = new handles and handles whose values changed (score, tier and, in a ListRow, the X id); remove = handles that left the list. */
export function diffLists<E extends readonly [string, ...unknown[]]>(prev: ReadonlyMap<string, E>, next: readonly E[]): { add: E[]; remove: string[] } {
  const add: E[] = [];
  const seen = new Set<string>();
  for (const e of next) {
    seen.add(e[0]);
    const p = prev.get(e[0]);
    if (!p || p.length !== e.length || p.some((x, i) => x !== e[i])) add.push(e);
  }
  const remove: string[] = [];
  for (const h of prev.keys()) if (!seen.has(h)) remove.push(h);
  remove.sort();
  return { add, remove };
}

/** The rows of the newest stored snapshot, or null when there is none. A snapshot from before the X ids has null ids. */
export async function loadLatestEntries(q: Queryable): Promise<{ version: number; entries: Map<string, ListRow> } | null> {
  const { rows } = await q.query<{ version: number; body_gzip: unknown }>('select version, body_gzip from list_snapshots order by version desc limit 1');
  const row = rows[0];
  if (!row) return null;
  const body = JSON.parse(gunzipSync(toBuffer(row.body_gzip)).toString('utf8')) as { accounts: ListEntry[]; ids?: (string | null)[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  return { version: Number(row.version), entries: new Map(body.accounts.map((e, i): [string, ListRow] => [e[0], [e[0], e[1], e[2], ids[i] ?? null]])) };
}

/**
 * Writes a new snapshot from the account rows, only when an entry joined, left, or changed its score, tier or X id.
 * Call it inside the transaction that changed the rows, after the last row write: the score job and every admin
 * confirm and clear do. Only flagged and confirmed accounts are in the list, and never a moved one: its handle has
 * another X id now (SPEC 13.10 item 10: an account that the source does not find stays).
 */
export async function publishList(q: Queryable, now: Date): Promise<{ version: number | null; changed: boolean; listed: number }> {
  await q.query('select pg_advisory_xact_lock($1::int, hashtext(current_schema()))', [LIST_LOCK]);
  const { rows: listed } = await q.query<{ handle: string; score: number; tier: number; x_user_id: string | null }>(
    "select handle, score, tier, x_user_id from accounts where tier >= 1 and status in ('flagged', 'confirmed') and identity <> 'moved'",
  );
  const next = listed.map((a): ListRow => [a.handle, Math.round(a.score * 100), a.tier, a.x_user_id]).sort(byHandle);
  const prev = await loadLatestEntries(q);
  const { add, remove } = diffLists(prev?.entries ?? new Map<string, ListRow>(), next);
  if (prev && add.length === 0 && remove.length === 0) return { version: prev.version, changed: false, listed: next.length };

  const { rows } = await q.query<{ v: number }>("select nextval(pg_get_serial_sequence('list_snapshots', 'version')) as v");
  const version = Number(rows[0]!.v);
  const body = Buffer.from(JSON.stringify({ v: 1, version, generatedAt: now.toISOString(), accounts: next.map(entryOf), ids: next.map((r) => r[3]) }));
  const { gzip, br } = compress(body);
  const delta: ListDelta = { from: prev?.version ?? null, add: add.map(entryOf), addIds: add.map((r) => r[3]), remove };
  await q.query(
    'insert into list_snapshots (version, generated_at, count, body_gzip, body_br, delta, etag) values ($1, $2, $3, $4, $5, $6::jsonb, $7)',
    [version, now, next.length, gzip, br, JSON.stringify(delta), `"${version}"`],
  );
  return { version, changed: true, listed: next.length };
}

type DeltaResult = { kind: 'same' } | { kind: 'gone' } | { kind: 'ok'; body: Encoded };

/** Newest snapshot in memory; checks max(version) at most every 15 s (section 5.4). */
export class ListCache {
  private snap: Snapshot | null = null;
  private checkedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private deltas = new Map<number, Encoded>();
  private readonly building = new Map<string, Promise<DeltaResult>>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly onError: (err: unknown) => void,
  ) {}

  async current(): Promise<Snapshot | null> {
    if (this.now() - this.checkedAt >= LIST_CHECK_MS) {
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = null;
      });
      await this.refreshing;
    }
    return this.snap;
  }

  private async refresh(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ v: number | null }>('select max(version) as v from list_snapshots');
      const raw = rows[0]?.v;
      const v = raw == null ? null : Number(raw);
      if (v !== null && v !== this.snap?.version) {
        const r = await this.db.query<{ generated_at: Date; etag: string; body_gzip: unknown; body_br: unknown }>(
          'select generated_at, etag, body_gzip, body_br from list_snapshots where version = $1',
          [v],
        );
        const row = r.rows[0];
        if (row) {
          this.snap = { version: v, etag: row.etag, generatedAt: row.generated_at, gzip: toBuffer(row.body_gzip), br: toBuffer(row.body_br), identity: null };
          this.deltas.clear();
        }
      } else if (v === null) {
        this.snap = null;
      }
      this.checkedAt = this.now();
    } catch (err) {
      // Keep serving the last good snapshot when the database is briefly unreachable.
      if (!this.snap) throw err;
      this.onError(err);
      this.checkedAt = this.now();
    }
  }

  identity(s: Snapshot): Buffer {
    s.identity ??= gunzipSync(s.gzip);
    return s.identity;
  }

  /** Composes the stored deltas after `since` into one delta to the newest version. */
  async delta(s: Snapshot, since: number): Promise<DeltaResult> {
    if (since === s.version) return { kind: 'same' };
    if (since > s.version) return { kind: 'gone' };
    const cached = this.deltas.get(since);
    if (cached) return { kind: 'ok', body: cached };
    // Requests that want the same delta share one build.
    const key = `${s.version}:${since}`;
    let build = this.building.get(key);
    if (!build) {
      build = this.buildDelta(s, since).finally(() => this.building.delete(key));
      this.building.set(key, build);
    }
    return build;
  }

  private async buildDelta(s: Snapshot, since: number): Promise<DeltaResult> {
    // Read the kept deltas only when the first one starts at `since`: else the answer is 410 and costs one index row.
    const { rows } = await this.db.query<{ version: number; delta: ListDelta | null }>(
      `select version, delta from list_snapshots where version > $1 and version <= $2
         and (select delta->'from' from list_snapshots where version > $1 order by version limit 1) = to_jsonb($1::bigint)
       order by version`,
      [since, s.version],
    );
    let prev = since;
    const merged = new Map<string, ListRow | null>();
    for (const row of rows) {
      const d = row.delta;
      // A delta from before the X ids cannot give them: the client fetches the full list once.
      if (!d || d.from !== prev || !Array.isArray(d.addIds) || d.addIds.length !== d.add.length) return { kind: 'gone' };
      d.add.forEach((e, i) => merged.set(e[0], [e[0], e[1], e[2], d.addIds[i] ?? null]));
      for (const h of d.remove) merged.set(h, null);
      prev = Number(row.version);
    }
    if (prev !== s.version) return { kind: 'gone' };

    const add: ListRow[] = [];
    const remove: string[] = [];
    for (const [h, e] of merged) (e ? add.push(e) : remove.push(h));
    add.sort(byHandle);
    remove.sort();
    const body = await encodeAllAsync(Buffer.from(JSON.stringify({ v: 1, from: since, version: s.version, add: add.map(entryOf), addIds: add.map((r) => r[3]), remove })));
    // A refresh may have replaced the snapshot while this delta was built; cache only current results.
    if (s === this.snap) {
      if (this.deltas.size >= 64) this.deltas.delete(this.deltas.keys().next().value!);
      this.deltas.set(since, body);
    }
    return { kind: 'ok', body };
  }
}
