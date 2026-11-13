/** The /sloppers view: every listed account in memory, with precomputed orders, a search index, cursors and avatars. */
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { toBuffer, type Db } from './db.js';
import type { Asset } from './http/static.js';
import { etagOf } from './lib/encoding.js';
import { HttpError } from './lib/http.js';
import { CostBoundedCache } from './lib/lru.js';
import { TRIGRAM_LENGTH, TrigramIndex } from './lib/trigram.js';

type SlopperStatus = 'confirmed' | 'flagged';
export type StatusFilter = SlopperStatus | 'all';
export type SlopperSort = 'score' | 'recent' | 'votes' | 'handle';

interface Slopper {
  handle: string;
  name: string | null;
  avatar: string | null;
  followers: number | null;
  status: SlopperStatus;
  tier: 1 | 2;
  score: number;
  seed: boolean;
  votes: { slop: number; notSlop: number };
  networks: number;
  needed: number;
  listedAt: string | null;
  reason: string;
  /** The list that gave a seed account (`x_list:<id>` or `site:<host>`); null for any other account. */
  seedSource: string | null;
  /** The crowd test for confirmed passes and a gate holds the account at flagged (section 13.8). */
  waits: boolean;
  xUserId: string | null;
}

interface SlopperPage {
  total: number;
  generatedAt: string;
  next: string | null;
  items: Slopper[];
}

interface SlopperQuery {
  q: string;
  status: StatusFilter;
  sort: SlopperSort;
  cursor: string | null;
  limit: number;
}

/** One row of the view query. Unknown JSON parts stay `unknown` until checked. */
export interface SlopperRow {
  handle: string;
  x_user_id: string | null;
  name: string | null;
  has_avatar: boolean;
  followers: number | null;
  status: SlopperStatus;
  score: number;
  seed: boolean;
  seed_source: unknown;
  listed_at: Date | null;
  reason: unknown;
  want: unknown;
  networks: unknown;
  needed: unknown;
  slop: number;
  not_slop: number;
}

/** The view holds the highest-scored accounts up to this count, and logs a warning when it reaches it. */
export const MAX_VIEW_ROWS = 200_000;
/** How often the web process looks for changed data. */
export const VIEW_CHECK_MS = 15_000;
const FETCH_SIZE = 5_000;

const VIEW_SQL = `
  select a.handle, a.x_user_id, p.name, p.avatar is not null as has_avatar, p.followers, a.status, a.score, a.seed, a.seed_source, a.listed_at,
         a.parts->'reason' as reason, a.parts->'want' as want, a.parts->'networks' as networks, a.parts->'needed' as needed,
         c.slop, c.not_slop
  from (select handle, x_user_id, status, score, seed, seed_source, listed_at, parts from accounts
        where ((status = 'confirmed' and tier = 2) or (status = 'flagged' and tier = 1)) and identity <> 'moved'
        order by score desc, handle limit ${MAX_VIEW_ROWS}) a
  left join profiles p on p.handle = a.handle
  join lateral (select count(distinct i.ip_hash) filter (where v.value = 1)::int as slop,
                       count(distinct i.ip_hash) filter (where v.value = 0)::int as not_slop
                from votes v join installs i on i.id = v.install_id
                where v.handle = a.handle and i.banned_at is null) c on true
  order by a.handle collate "C"`;

/**
 * Any change that the view can show moves this text. The count sees an admin clear, which writes no
 * list version and leaves max(updated_at) alone unless the cleared row held the maximum.
 */
const STAMP_SQL = `
  select concat((select max(version) from list_snapshots), '|',
                (select concat(count(*), '|', max(updated_at)) from accounts where tier >= 1), '|',
                (select max(fetched_at) from profiles)) as stamp`;

const FLAG_AVATAR = 1;
const FLAG_SEED = 2;
const FLAG_CONFIRMED = 4;
const FLAG_WAITS = 8;

const REASON_RE = /^[a-z0-9_]{1,40}$/;
const SEED_SOURCE_RE = /^(?:x_list:[0-9]{1,20}|site:[a-z0-9.-]{1,253})$/;
const NEVER_LISTED = 2 ** 33; // past every timestamp in seconds, so accounts with no date sort last
/** A row id is a position in the handle order; `rank * size + id` packs the sort value and the handle tie-break below 2^53. */
const SORT_RANK: Record<SlopperSort, (c: Columns, id: number) => number> = {
  score: (c, id) => 100 - c.score[id]!,
  recent: (c, id) => NEVER_LISTED - (Number.isNaN(c.listedAt[id]!) ? 0 : Math.floor(c.listedAt[id]! / 1000)),
  votes: (c, id) => 0xffffffff - c.slop[id]!,
  handle: () => 0,
};

const MAX_MATCH_IDS = 4_000_000;
const MAX_MATCH_SEARCHES = 512;
const MAX_AVATAR_BYTES = 32 * 1024 * 1024;
const MAX_AVATARS = 20_000;
const AVATAR_CACHE_CONTROL = 'public, max-age=2592000';

const asCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 0xffffffff) : 0);

interface Columns {
  handle: readonly string[];
  xUserId: readonly (string | null)[];
  name: readonly (string | null)[];
  search: readonly string[];
  reason: readonly string[];
  seedSource: readonly (string | null)[];
  flags: Uint8Array;
  score: Uint8Array;
  followers: Int32Array; // -1 = unknown
  slop: Uint32Array;
  notSlop: Uint32Array;
  networks: Uint32Array;
  needed: Uint32Array;
  listedAt: Float64Array; // milliseconds, NaN = none
}

/** The query text of a request: trimmed, without a leading @, lower case. */
export function normalizeSearch(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/** What a request selects, after normalization. */
export interface ViewFilter {
  search: string;
  status: StatusFilter;
  sort: SlopperSort;
}

const filterKey = (f: ViewFilter): string => `${f.status}\n${f.sort}\n${f.search}`;

function fingerprint(f: ViewFilter): number {
  const text = filterKey(f);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Cursor {
  viewId: number;
  offset: number;
  fingerprint: number;
}

function encodeCursor(c: Cursor): string {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(c.viewId, 0);
  b.writeUInt32BE(c.offset, 4);
  b.writeUInt32BE(c.fingerprint, 8);
  return b.toString('base64url');
}

function decodeCursor(token: string): Cursor | null {
  const b = Buffer.from(token, 'base64url');
  if (b.length !== 12 || b.toString('base64url') !== token) return null;
  return { viewId: b.readUInt32BE(0), offset: b.readUInt32BE(4), fingerprint: b.readUInt32BE(8) };
}

/** Collects rows in handle order, then freezes them into a view. */
export class ViewBuilder {
  private readonly handle: string[] = [];
  private readonly xUserId: (string | null)[] = [];
  private readonly name: (string | null)[] = [];
  private readonly search: string[] = [];
  private readonly reason: string[] = [];
  private readonly seedSource: (string | null)[] = [];
  private readonly flags: number[] = [];
  private readonly score: number[] = [];
  private readonly followers: number[] = [];
  private readonly slop: number[] = [];
  private readonly notSlop: number[] = [];
  private readonly networks: number[] = [];
  private readonly needed: number[] = [];
  private readonly listedAt: number[] = [];
  private readonly reasons = new Map<string, string>();
  private readonly seedSources = new Map<string, string>();

  get size(): number {
    return this.handle.length;
  }

  add(r: SlopperRow): void {
    this.handle.push(r.handle);
    this.xUserId.push(r.x_user_id);
    this.name.push(r.name);
    this.search.push(r.name ? `${r.handle}\n${r.name.toLowerCase()}` : r.handle);
    this.reason.push(this.intern(this.reasons, r.reason, REASON_RE, 'pending'));
    this.seedSource.push(r.seed ? this.intern(this.seedSources, r.seed_source, SEED_SOURCE_RE, null) : null);
    const waits = r.status === 'flagged' && r.want === 'confirmed';
    this.flags.push((r.has_avatar ? FLAG_AVATAR : 0) | (r.seed ? FLAG_SEED : 0) | (r.status === 'confirmed' ? FLAG_CONFIRMED : 0) | (waits ? FLAG_WAITS : 0));
    this.score.push(Math.max(0, Math.min(100, Math.round(r.score * 100))));
    this.followers.push(r.followers ?? -1);
    this.slop.push(r.slop);
    this.notSlop.push(r.not_slop);
    this.networks.push(asCount(r.networks));
    this.needed.push(asCount(r.needed));
    this.listedAt.push(r.listed_at ? r.listed_at.getTime() : Number.NaN);
  }

  /** One shared string per code (reason, seed source), so 200,000 rows hold one pointer each instead of a copy. */
  private intern<F extends string | null>(pool: Map<string, string>, raw: unknown, pattern: RegExp, fallback: F): string | F {
    if (typeof raw !== 'string' || !pattern.test(raw)) return fallback;
    const known = pool.get(raw);
    if (known) return known;
    pool.set(raw, raw);
    return raw;
  }

  /** Builds orders and the search index; yields between the heavy steps so requests keep running. */
  async build(stamp: string, generatedAt: Date): Promise<SloppersView> {
    const columns: Columns = {
      handle: this.handle,
      xUserId: this.xUserId,
      name: this.name,
      search: this.search,
      reason: this.reason,
      seedSource: this.seedSource,
      flags: new Uint8Array(this.flags),
      score: new Uint8Array(this.score),
      followers: new Int32Array(this.followers),
      slop: new Uint32Array(this.slop),
      notSlop: new Uint32Array(this.notSlop),
      networks: new Uint32Array(this.networks),
      needed: new Uint32Array(this.needed),
      listedAt: new Float64Array(this.listedAt),
    };
    await yieldToEventLoop();
    return SloppersView.create(columns, stamp, generatedAt.toISOString());
  }
}

const SORTS: readonly SlopperSort[] = ['score', 'recent', 'votes', 'handle'];
const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'confirmed', 'flagged'];

/** An immutable snapshot of the listed accounts: columns in handle order, precomputed orders and a search index. */
export class SloppersView {
  /** Random, so a cursor from before a restart can never match a new view. */
  readonly id = randomBytes(4).readUInt32BE(0);
  private readonly searches = new CostBoundedCache<Uint32Array>(MAX_MATCH_IDS, MAX_MATCH_SEARCHES);

  private constructor(
    private readonly columns: Columns,
    readonly stamp: string,
    private readonly generatedAt: string,
    private readonly index: TrigramIndex,
    private readonly orders: Record<StatusFilter, Record<SlopperSort, Uint32Array>>,
  ) {}

  static async create(columns: Columns, stamp: string, generatedAt: string): Promise<SloppersView> {
    const orders = {} as Record<StatusFilter, Record<SlopperSort, Uint32Array>>;
    for (const status of STATUS_FILTERS) {
      const ids = idsWithStatus(columns, status);
      const byStatus = {} as Record<SlopperSort, Uint32Array>;
      for (const sort of SORTS) {
        byStatus[sort] = orderIds(columns, ids, sort);
        await yieldToEventLoop();
      }
      orders[status] = byStatus;
    }
    const index = await TrigramIndex.build(columns.search);
    return new SloppersView(columns, stamp, generatedAt, index, orders);
  }

  get size(): number {
    return this.columns.handle.length;
  }

  /** Row ids for one filter in the requested order; searches are computed once and kept while the view lives. */
  private listFor(filter: ViewFilter): Uint32Array {
    if (!filter.search) return this.orders[filter.status][filter.sort];
    const key = filterKey(filter);
    const cached = this.searches.get(key);
    if (cached) return cached;
    const list = orderIds(this.columns, this.findMatches(filter), filter.sort);
    this.searches.set(key, list, list.length);
    return list;
  }

  /** Ids that match, in row order. A query too short for the index scans every row. */
  private findMatches({ search, status }: ViewFilter): number[] {
    const { search: docs, flags } = this.columns;
    const candidates = search.length >= TRIGRAM_LENGTH ? this.index.candidates(search) : null;
    const count = candidates ? candidates.length : docs.length;
    const matches: number[] = [];
    for (let k = 0; k < count; k++) {
      const id = candidates ? candidates[k]! : k;
      if (hasStatus(flags, id, status) && docs[id]!.includes(search)) matches.push(id);
    }
    return matches;
  }

  page(filter: ViewFilter, offset: number, limit: number): SlopperPage {
    const list = this.listFor(filter);
    if (offset >= list.length && offset > 0) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid.');
    const end = Math.min(offset + limit, list.length);
    const items: Slopper[] = [];
    for (let k = offset; k < end; k++) items.push(this.item(list[k]!));
    const next = end < list.length ? encodeCursor({ viewId: this.id, offset: end, fingerprint: fingerprint(filter) }) : null;
    return { total: list.length, generatedAt: this.generatedAt, next, items };
  }

  private item(id: number): Slopper {
    const c = this.columns;
    const handle = c.handle[id]!;
    const flags = c.flags[id]!;
    const confirmed = (flags & FLAG_CONFIRMED) !== 0;
    const followers = c.followers[id]!;
    const listedAt = c.listedAt[id]!;
    return {
      handle,
      name: c.name[id]!,
      avatar: (flags & FLAG_AVATAR) !== 0 ? `/api/v1/avatars/${handle}` : null,
      followers: followers < 0 ? null : followers,
      status: confirmed ? 'confirmed' : 'flagged',
      tier: confirmed ? 2 : 1,
      score: c.score[id]!,
      seed: (flags & FLAG_SEED) !== 0,
      votes: { slop: c.slop[id]!, notSlop: c.notSlop[id]! },
      networks: c.networks[id]!,
      needed: c.needed[id]!,
      listedAt: Number.isNaN(listedAt) ? null : new Date(listedAt).toISOString(),
      reason: c.reason[id]!,
      seedSource: c.seedSource[id]!,
      waits: (flags & FLAG_WAITS) !== 0,
      xUserId: c.xUserId[id]!,
    };
  }

  /** True when this account is listed and has a stored avatar. The handle column is sorted, so this is a binary search. */
  hasAvatar(handle: string): boolean {
    const c = this.columns;
    let lo = 0;
    let hi = c.handle.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = c.handle[mid]!;
      if (at === handle) return (c.flags[mid]! & FLAG_AVATAR) !== 0;
      if (at < handle) lo = mid + 1;
      else hi = mid;
    }
    return false;
  }
}

function hasStatus(flags: Uint8Array, id: number, status: StatusFilter): boolean {
  return status === 'all' || ((flags[id]! & FLAG_CONFIRMED) !== 0) === (status === 'confirmed');
}

function idsWithStatus(c: Columns, status: StatusFilter): number[] {
  const ids: number[] = [];
  for (let id = 0; id < c.handle.length; id++) if (hasStatus(c.flags, id, status)) ids.push(id);
  return ids;
}

/** Sorts row ids by the requested value and then by handle, with one native numeric sort. */
function orderIds(c: Columns, ids: ArrayLike<number>, sort: SlopperSort): Uint32Array {
  const size = c.handle.length;
  const rank = SORT_RANK[sort];
  const keys = new Float64Array(ids.length);
  for (let k = 0; k < ids.length; k++) keys[k] = rank(c, ids[k]!) * size + ids[k]!;
  keys.sort();
  const out = new Uint32Array(keys.length);
  for (let k = 0; k < keys.length; k++) out[k] = keys[k]! % size;
  return out;
}

/**
 * A cursor of the view before the last rebuild works this long after the rebuild. The old view still shows the accounts that
 * left the list (an admin clear, a pending account), so it must not serve them for hours in a quiet period.
 */
export const PREVIOUS_VIEW_MS = 10 * 60_000;

/** Serves the /sloppers view from memory. Keeps the view a cursor was issued from for one rebuild, so a walk survives a refresh. */
export class SloppersCache {
  private current: SloppersView | null = null;
  private previous: SloppersView | null = null;
  private previousAt = -Infinity;
  private checkedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private readonly avatars = new CostBoundedCache<Asset>(MAX_AVATAR_BYTES, MAX_AVATARS);

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
  ) {}

  /** The current view. A due refresh runs in the background; only a cold start waits for it. */
  private async view(): Promise<SloppersView> {
    if (this.now() - this.checkedAt >= VIEW_CHECK_MS) {
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    if (!this.current && this.refreshing) await this.refreshing;
    if (!this.current) throw new HttpError(503, 'sloppers_unavailable', 'The list is not available. Try again in a few minutes.');
    return this.current;
  }

  private async refresh(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ stamp: string }>(STAMP_SQL);
      const { stamp } = rows[0]!;
      if (stamp === this.current?.stamp) return;
      // Dropped before the build, so memory holds at most this view and the new one.
      this.previous = null;
      const view = await this.buildView(stamp);
      this.previous = this.current;
      this.previousAt = this.now();
      this.current = view;
      this.avatars.clear();
    } catch (err) {
      this.log.error({ err }, 'sloppers view refresh failed');
    } finally {
      this.checkedAt = this.now();
    }
  }

  private async buildView(stamp: string): Promise<SloppersView> {
    const builder = new ViewBuilder();
    await this.db.tx(async (q) => {
      // The cursor keeps one consistent snapshot and hands the rows over in small batches, so memory stays flat.
      await q.query(`declare sloppers_view no scroll cursor for ${VIEW_SQL}`);
      for (;;) {
        const { rows } = await q.query<SlopperRow>(`fetch ${FETCH_SIZE} from sloppers_view`);
        for (const row of rows) builder.add(row);
        if (rows.length < FETCH_SIZE) break;
      }
    });
    if (builder.size >= MAX_VIEW_ROWS) this.log.warn({ rows: builder.size }, 'sloppers view reached its row cap; lower-scored accounts are not shown');
    return builder.build(stamp, new Date(this.now()));
  }

  /** One page, either of the current view or of the view a valid cursor was issued from. */
  async page(query: SlopperQuery): Promise<SlopperPage> {
    const filter: ViewFilter = { search: normalizeSearch(query.q), status: query.status, sort: query.sort };
    if (query.cursor === null) return (await this.view()).page(filter, 0, query.limit);
    const cursor = decodeCursor(query.cursor);
    if (!cursor || cursor.offset < 1 || cursor.fingerprint !== fingerprint(filter)) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid.');
    // view() starts a due refresh, and rejects first when no view exists at all.
    const current = await this.view();
    const view =
      current.id === cursor.viewId ? current : this.previous?.id === cursor.viewId && this.now() - this.previousAt < PREVIOUS_VIEW_MS ? this.previous : null;
    if (!view) throw new HttpError(400, 'stale_cursor', 'The list changed. Start again from the top.');
    return view.page(filter, cursor.offset, query.limit);
  }

  /** The stored avatar of a listed account, or null. Only a listed account with an avatar reaches the database. */
  async avatar(handle: string): Promise<Asset | null> {
    const view = await this.view();
    if (!view.hasAvatar(handle)) return null;
    const cached = this.avatars.get(handle);
    if (cached) return cached;
    const { rows } = await this.db.query<{ avatar: unknown; avatar_type: string }>(
      'select avatar, avatar_type from profiles where handle = $1 and avatar is not null',
      [handle],
    );
    const row = rows[0];
    if (!row) return null;
    const body = toBuffer(row.avatar);
    const asset: Asset = {
      enc: { identity: body, gzip: null, br: null },
      etag: etagOf(body),
      headers: { 'content-type': row.avatar_type, 'cache-control': AVATAR_CACHE_CONTROL },
    };
    this.avatars.set(handle, asset, body.length);
    return asset;
  }
}
