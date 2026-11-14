/**
 * The activity feed of the admin console (SPEC 14.2): one newest-first stream over the admin log, the job events, the list
 * versions, appeals, failed job runs, votes and installs. It pages with an opaque cursor on (at desc, key desc): each source
 * reads at most one page from its own index, and the merge keeps the newest page.
 */
import type { Queryable } from '../db.js';
import { HttpError, UUID_RE } from '../lib/http.js';
import type { ListDelta, ListEntry } from '../list.js';

export const ACTIVITY_KINDS = ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run', 'vote', 'install'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** Without `kinds`: every kind except votes and installs, the two sources that grow with every user. */
export const DEFAULT_KINDS: readonly ActivityKind[] = ACTIVITY_KINDS.filter((k) => k !== 'vote' && k !== 'install');
const EVENT_KINDS: readonly ActivityKind[] = ['status', 'identity', 'standing'];

/** The network label of the console (SPEC 14.1): the first 8 hex characters of sha256(ip_hash). No answer holds ip_hash. */
export const networkOf = (col: string): string => `substr(encode(sha256(convert_to(${col}, 'UTF8')), 'hex'), 1, 8)`;

export interface Activity {
  key: string;
  at: string;
  kind: ActivityKind;
  source: string;
  subject: string | null;
  data: unknown;
}

export interface Subject {
  kind: 'handle' | 'install';
  value: string;
}

interface Cursor {
  at: string;
  key: string;
}

const UUID = UUID_RE.slice(1, -1);
const UUID_TEST = new RegExp(UUID_RE);
/** A subject of the querystring: a handle or an install id. */
export const SUBJECT_RE = `^(?:[a-z0-9_]{1,15}|${UUID})$`;
export const subjectOf = (s: string): Subject => ({ kind: UUID_TEST.test(s) ? 'install' : 'handle', value: s });

// A key names its source and its row: an id padded to 19 digits (so the order of the text is the order of the ids), an
// appeal or install id, or the install and handle of a vote. The cursor is the time of the last item in microseconds and its key.
const CURSOR_MAX = 120;
const CURSOR_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z)([aelr]:\\d{19}|[pi]:${UUID}|v:${UUID}:[a-z0-9_]{1,15})$`);
const pad = (col: string) => `lpad(${col}::text, 19, '0')`;

/** A cursor of `next`, or 400 bad_request. */
export function parseCursor(s: string): Cursor {
  const m = s.length <= CURSOR_MAX ? CURSOR_RE.exec(s) : null;
  // A date that the parser moves (February 30) is not a time that a row can have.
  if (!m || Number.isNaN(Date.parse(m[1]!)) || new Date(m[1]!).toISOString().slice(0, 23) !== m[1]!.slice(0, 23)) {
    throw new HttpError(400, 'bad_request', 'The cursor is not valid.');
  }
  return { at: m[1]!, key: m[2]! };
}

/** A list version as the console shows it: each array holds at most `cap` items, with the full counts beside it. */
export function listVersion(version: number, count: number, delta: ListDelta | null, cap: number) {
  const add: ListEntry[] = Array.isArray(delta?.add) ? delta.add : [];
  const remove: string[] = Array.isArray(delta?.remove) ? delta.remove : [];
  return { version: Number(version), count, from: delta?.from ?? null, added: add.slice(0, cap), addedCount: add.length, removed: remove.slice(0, cap), removedCount: remove.length };
}
const LIST_ITEMS = 20;

interface Row {
  key: string;
  at: Date;
  cursor_at: string;
  kind: ActivityKind;
  source: string;
  subject: string | null;
  data: unknown;
}

/**
 * One page of the feed. `subject`: a handle matches its admin items (and those of its appeals), its status and identity
 * events, its appeals, its votes and the list versions that added, changed or removed it; an install id matches its admin
 * items, its standing events, its votes and its install item.
 */
export async function readActivity(q: Queryable, o: { kinds: readonly ActivityKind[]; subject: Subject | null; cursor: Cursor | null; limit: number }): Promise<{ items: Activity[]; next: string | null }> {
  const params: unknown[] = [];
  const bind = (v: unknown) => `$${params.push(v)}`;
  const limit = bind(o.limit + 1);
  const subject = o.subject ? `${bind(o.subject.value)}::text` : null;
  const h = o.subject?.kind === 'handle' ? subject : null;
  const i = o.subject?.kind === 'install' ? subject : null;
  const want = new Set(o.kinds);
  const events = EVENT_KINDS.filter((k) => want.has(k));
  const at = o.cursor ? `${bind(o.cursor.at)}::timestamptz` : null;
  const key = o.cursor ? `${bind(o.cursor.key)}::text` : null;

  const sources: string[] = [];
  if (want.has('admin')) {
    const where = h ? ` where l.target = ${h} or l.target in (select p.id::text from appeals p where p.handle = ${h})` : i ? ` where l.target = ${i}` : '';
    sources.push(`select 'a:' || ${pad('l.id')} as key, l.at as at, 'admin'::text as kind, 'admin'::text as source, l.target as subject,
      jsonb_build_object('action', l.action, 'session', l.session, 'before', l.before, 'after', l.after) as data from admin_log l${where}`);
  }
  if (events.length > 0) {
    sources.push(`select 'e:' || ${pad('e.id')} as key, e.at as at, e.kind as kind, e.source as source, e.subject as subject, e.data as data
      from events e where e.kind = any(${bind(events)}::text[])${subject ? ` and e.subject = ${subject}` : ''}`);
  }
  if (want.has('list') && !i) {
    const where = h ? ` where s.delta->'remove' @> jsonb_build_array(${h}) or s.delta->'add' @> jsonb_build_array(jsonb_build_array(${h}))` : '';
    sources.push(`select 'l:' || ${pad('s.version')} as key, s.generated_at as at, 'list'::text as kind, 'list'::text as source, s.version::text as subject,
      jsonb_build_object('version', s.version, 'count', s.count, 'delta', s.delta) as data from list_snapshots s${where}`);
  }
  if (want.has('appeal') && !i) {
    sources.push(`select 'p:' || p.id::text as key, p.created_at as at, 'appeal'::text as kind, 'public'::text as source, p.handle as subject,
      jsonb_build_object('appealId', p.id, 'status', p.status) as data from appeals p${h ? ` where p.handle = ${h}` : ''}`);
  }
  if (want.has('run') && !subject) {
    sources.push(`select 'r:' || ${pad('r.id')} as key, r.ended_at as at, 'run'::text as kind, r.job as source, null::text as subject,
      jsonb_build_object('job', r.job, 'ok', false, 'error', r.detail->>'error', 'ms', (extract(epoch from r.ended_at - r.started_at) * 1000)::bigint) as data
      from job_runs r where not r.ok`);
  }
  if (want.has('vote')) {
    const where = h ? ` where v.handle = ${h}` : i ? ` where v.install_id = ${i}::uuid` : '';
    // Never votes.text: a post text is not served (SPEC 14.1).
    sources.push(`select 'v:' || v.install_id::text || ':' || v.handle as key, v.updated_at as at, 'vote'::text as kind, 'public'::text as source, v.handle as subject,
      jsonb_build_object('install', v.install_id, 'network', ${networkOf('n.ip_hash')}, 'value', case when v.value = 1 then 'slop' else 'not_slop' end,
                         'first', v.created_at = v.updated_at) as data
      from votes v join installs n on n.id = v.install_id${where}`);
  }
  if (want.has('install') && !h) {
    sources.push(`select 'i:' || n.id::text as key, n.created_at as at, 'install'::text as kind, 'public'::text as source, n.id::text as subject,
      jsonb_build_object('network', ${networkOf('n.ip_hash')}, 'extVersion', n.ext_version) as data from installs n${i ? ` where n.id = ${i}::uuid` : ''}`);
  }
  if (sources.length === 0) return { items: [], next: null };

  // The predicates on `at` reach the index of each source; the key orders the rows of one time.
  const after = at ? ` where x.at <= ${at} and (x.at < ${at} or x.key collate "C" < ${key})` : '';
  const pages = sources.map((sql) => `(select * from (${sql}) x${after} order by x.at desc, x.key collate "C" desc limit ${limit})`);
  const { rows } = await q.query<Row>(
    `select key, at, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at, kind, source, subject, data
     from (${pages.join(' union all ')}) u order by at desc, key collate "C" desc limit ${limit}`,
    params,
  );
  const page = rows.slice(0, o.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const d = r.data as { version: number; count: number; delta: ListDelta | null };
      return { key: r.key, at: r.at.toISOString(), kind: r.kind, source: r.source, subject: r.subject, data: r.kind === 'list' ? listVersion(d.version, d.count, d.delta, LIST_ITEMS) : r.data };
    }),
    next: rows.length > o.limit && last ? `${last.cursor_at}${last.key}` : null,
  };
}
