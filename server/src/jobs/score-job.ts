/** The scoring run: loads the input, calls the engine, writes accounts, installs, the list snapshot and retention. */
import type { Db, Queryable } from '../db.js';
import type { AccountScore, ScoringInput, ScoringOutput } from '../scoring/index.js';
import { NETWORK_DAILY_VOTES, PROTECTED_MIN_FOLLOWERS } from '../scoring/index.js';
import { errorText, recordRun, writeEvents, type HistoryEvent } from '../history.js';
import { HANDLE_RE } from '../lib/http.js';
import { publishList } from '../list.js';

export type ComputeScores = (input: ScoringInput) => ScoringOutput;

/** pg_advisory_lock key of this job. The second key is the schema, so the channels that share one database do not block each other. */
export const SCORE_LOCK = 0x7a510001;

const DAY_MS = 86_400_000;
/** SPEC 4, 13.7 and 14.1: age in days past which a row can go. */
export const RETENTION = { sightings: 30, votes: 180, accounts: 30, installs: 90, evidence: 30, clearedVotes: 400, adminLog: 400, events: 400, jobRuns: 30 } as const;
const SNAPSHOTS_KEPT = 60;
const CHUNK = 1000;
/** The tier of each status. A row that breaks it fails the run before anything is written, so a pending account never reaches the list. */
const TIER_OF: Readonly<Record<string, number>> = { none: 0, pending: 0, cleared: 0, flagged: 1, confirmed: 2 };

// A row needs one of these to have anything to score: a state of its own, or a loaded vote (`voted` is the parameter with their handles).
// A pending row has a state, so it is written again when its votes go.
const scored = (voted: string): string =>
  `a.seed or a.status <> 'none' or a.override is not null or a.cleared_at is not null or a.handle = any(${voted}::text[])`;

/** systemd stops the job at 240 s (TimeoutStartSec). Past this point the writes might not finish, so the run fails cleanly instead. */
const TIME_BUDGET_MS = 200_000;

interface ScoreJobResult {
  skipped: boolean;
  accounts: number;
  listed: number;
  version: number | null;
  listChanged: boolean;
  ms: number;
  loadMs: number;
  computeMs: number;
  writeMs: number;
}

type LoadedAccount = ScoringInput['accounts'][number];

/**
 * Loads the scoring input. The SQL names the output columns after the engine's fields, so the driver's
 * rows are the input: one object per row, never a second mapped copy of each table (the unit has 1 GB).
 */
async function loadInput(q: Queryable, now: Date): Promise<{ input: ScoringInput; votesHeld: number }> {
  // The engine counts NETWORK_DAILY_VOTES votes of a network per day, and the votes of installs with standing take their places
  // first. So in time order, slop vote number i of the other installs of a network cannot count before the first vote of the
  // network plus floor(i / budget) days, whatever the votes with standing do. Their "not slop" votes use no budget and only give
  // `dissent`; the same bound on them keeps a flood of them out of memory and never moves a slop vote. The votes past the bound
  // stay in the table: a flood of votes that count nowhere must not fill the memory of the job. The votes of installs that can
  // have standing (trusted, or stored standing) are all loaded: they have their own stored-vote limit. A banned install counts
  // for nothing and uses no budget, so its votes stay in the table.
  const votes = await q.query<ScoringInput['votes'][number]>(
    `select install, handle, value, at from (
       select v.install_id as install, v.handle, v.value, v.updated_at as at, i.trusted or i.standing as standing,
              row_number() over (partition by i.ip_hash, i.trusted or i.standing, v.value
                                 order by date_trunc('milliseconds', v.updated_at), v.handle collate "C", v.install_id) as place,
              min(v.updated_at) over (partition by i.ip_hash) as first_at
       from votes v join installs i on i.id = v.install_id
       where i.banned_at is null) t
     where standing or place <= $2::int * (floor(extract(epoch from $1::timestamptz - first_at) / 86400) + 1)`,
    [now, NETWORK_DAILY_VOTES],
  );
  const stored = await q.query<{ n: number }>('select count(*)::int as n from votes');
  const clearedVotes = await q.query<ScoringInput['clearedVotes'][number]>(
    'select handle, install_id as install, ip_hash as "ipHash", value, at, cleared_at as "clearedAt", standing from cleared_votes',
  );
  // The installs of those votes, and the installs whose votes an admin clear stored: a voter that deletes its votes after a
  // clear still loses its reputation and its standing. No other install can change, so the table stays out of memory. An
  // install that is not loaded keeps its stored values.
  const installs = await q.query<ScoringInput['installs'][number]>(
    `select id, created_at as "createdAt", ip_hash as "ipHash", banned_at is not null as banned, reputation, trusted, standing from installs
     where id = any($1::uuid[]) or (banned_at is null and id in (select install_id from cleared_votes))`,
    [[...new Set(votes.rows.map((v) => v.install))]],
  );
  const voted = [...new Set(votes.rows.map((v) => v.handle))];
  const accounts = await q.query<LoadedAccount>(
    `select a.handle, a.seed, a.cleared_at as "clearedAt", a.override, a.override_at as "overrideAt",
            a.listed_at as "listedAt", a.status, a.identity, 0 as evidence, a.protected or coalesce(p.followers >= $2, false) as protected
     from accounts a left join profiles p on p.handle = a.handle where ${scored('$1')}`,
    [voted, PROTECTED_MIN_FOLLOWERS],
  );
  await countEvidence(q, votes.rows, accounts.rows);
  // Verified sightings only (the X facts job checked the post, its author and its parent), newest 50 per account, read in the
  // order of sightings_verified_idx.
  const sightings = await q.query<ScoringInput['sightings'][number]>(
    `select a.handle, s.tweet_id as "tweetId", s.parent_tweet_id as "parentTweetId", s.reply_at as "replyAt", s.latency_sec as "latencySec"
     from accounts a cross join lateral (
       select s.tweet_id, s.parent_tweet_id, s.reply_at, s.latency_sec from sightings s
       where s.handle = a.handle and s.verified_at is not null and s.reply_at > $1::timestamptz - interval '${RETENTION.sightings} days'
       order by s.reply_at desc, s.tweet_id desc limit 50) s
     where ${scored('$2')}`,
    [now, voted],
  );
  // The brakes (SPEC 13.3 and 13.10 item 6): accounts that votes confirmed, and accounts that votes flagged, in the last 24 hours.
  const brake = await q.query<{ confirms: number; flags: number }>(
    `select count(*) filter (where confirmed_at > $1::timestamptz - interval '24 hours')::int as confirms,
            count(*) filter (where tier = 1 and listed_at > $1::timestamptz - interval '24 hours')::int as flags
     from accounts where override is null and not seed`,
    [now],
  );
  return {
    input: {
      now,
      installs: installs.rows,
      votes: votes.rows,
      accounts: accounts.rows,
      sightings: sightings.rows,
      clearedVotes: clearedVotes.rows,
      autoConfirmsToday: brake.rows[0]!.confirms,
      autoFlagsToday: brake.rows[0]!.flags,
    },
    votesHeld: stored.rows[0]!.n - votes.rows.length,
  };
}

/**
 * evidence (SPEC 13.6) = networks with a loaded slop vote that names a post which the X facts job found written by the account:
 * an `ok` row for that handle whose author id is still the account's X id. A held or banned vote gives no evidence.
 */
async function countEvidence(q: Queryable, votes: readonly ScoringInput['votes'][number][], accounts: LoadedAccount[]): Promise<void> {
  const { rows } = await q.query<{ handle: string; install: string; network: string }>(
    `select v.handle, v.install_id as install, i.ip_hash as network
     from evidence e
     join accounts a on a.handle = e.handle and a.x_user_id = e.x_user_id
     join votes v on v.handle = e.handle and v.tweet_id = e.tweet_id and v.value = 1
     join installs i on i.id = v.install_id and i.banned_at is null
     where e.ok`,
  );
  if (rows.length === 0) return;
  const named = new Map<string, Map<string, string>>();
  for (const r of rows) {
    let m = named.get(r.handle);
    if (!m) named.set(r.handle, (m = new Map()));
    m.set(r.install, r.network);
  }
  const networks = new Map<string, Set<string>>();
  for (const v of votes) {
    const network = named.get(v.handle)?.get(v.install);
    if (network === undefined) continue;
    let s = networks.get(v.handle);
    if (!s) networks.set(v.handle, (s = new Set()));
    s.add(network);
  }
  for (const a of accounts) a.evidence = networks.get(a.handle)?.size ?? 0;
}

/** Rejects output that would write garbage (NaN scores, unknown statuses, a tier that does not match its status) before anything is written. */
function checkOutput(out: ScoringOutput): void {
  for (const a of out.accounts) {
    if (
      !HANDLE_RE.test(a.handle) ||
      TIER_OF[a.status] !== a.tier ||
      !Number.isFinite(a.score) ||
      a.score < 0 ||
      a.score > 1 ||
      typeof a.parts?.reason !== 'string'
    ) {
      throw new Error(`scoring returned an invalid account row for ${JSON.stringify(a.handle)}`);
    }
  }
  for (const i of out.installs) {
    if (!Number.isFinite(i.reputation) || i.reputation < 0 || i.reputation > 1 || typeof i.standing !== 'boolean' || !Number.isSafeInteger(i.goodMarks) || i.goodMarks < 0) {
      throw new Error(`scoring returned an invalid install row for ${i.id}`);
    }
  }
}

const votesConfirmed = (a: AccountScore): boolean => a.status === 'confirmed' && a.parts.reason === 'votes_confirmed';

// The rows of one chunk that the run changes: the admin decision is the one that the run loaded, and a value differs.
const RESULTS = 'unnest($1::text[], $2::text[], $3::real[], $4::smallint[], $5::jsonb[], $6::text[], $7::timestamptz[], $8::boolean[]) as u(h, s, sc, t, p, o, oa, c)';
const CHANGED = `a.handle = u.h
    and (a.override, date_trunc('milliseconds', a.override_at)) is not distinct from (u.o, u.oa)
    and (a.status, a.score, a.tier, a.parts, a.listed_at is null, a.confirmed_at is null)
      is distinct from (u.s, u.sc, u.t, u.p, u.t = 0, not u.c)`;

interface StoredState {
  handle: string;
  status: string;
  tier: number;
  gate: string | null;
  want: string | null;
}

/** A status event (SPEC 14.1) when status, tier, gate or want differ from the stored row. A change of the score alone writes none. */
function statusEvent(o: StoredState, a: AccountScore): HistoryEvent[] {
  const p = a.parts;
  if (o.status === a.status && o.tier === a.tier && o.gate === p.gate && o.want === p.want) return [];
  return [{
    subject: a.handle,
    data: {
      from: { status: o.status, tier: o.tier, gate: o.gate, want: o.want },
      to: { status: a.status, tier: a.tier, gate: p.gate, want: p.want, reason: p.reason, score: Math.round(a.score * 100), networks: p.networks, anchors: p.anchors, notSlop: p.notSlop, dissent: p.dissent, evidence: p.evidence },
    },
  }];
}

/**
 * listed_at: set to `now` when an account reaches tier 1 or 2 without one, cleared at tier 0. confirmed_at: set to `now` when
 * votes confirm an account, kept while they do, null otherwise. `override` and `override_at` are the values that the run loaded.
 * A row where they moved since then has an admin answer newer than this result: it stays as it is until the next run.
 * The rows are locked in handle order before the update, the order of the X facts commit, so the two cannot deadlock.
 * The lock reads the stored state of each row that changes, for its status event.
 */
async function writeAccounts(q: Queryable, accounts: AccountScore[], loaded: ReadonlyMap<string, LoadedAccount>, now: Date): Promise<number> {
  let changed = 0;
  const events: HistoryEvent[] = [];
  const sorted = [...accounts].sort((x, y) => (x.handle < y.handle ? -1 : x.handle > y.handle ? 1 : 0));
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const part = sorted.slice(i, i + CHUNK);
    const params = [
      part.map((a) => a.handle),
      part.map((a) => a.status),
      part.map((a) => a.score),
      part.map((a) => a.tier),
      part.map((a) => JSON.stringify(a.parts)),
      part.map((a) => loaded.get(a.handle)!.override),
      part.map((a) => loaded.get(a.handle)!.overrideAt),
      part.map(votesConfirmed),
    ];
    const { rows: stored } = await q.query<StoredState>(
      `select a.handle, a.status, a.tier, a.parts->>'gate' as gate, a.parts->>'want' as want
       from accounts a, ${RESULTS} where ${CHANGED} order by a.handle collate "C" for update of a`,
      params,
    );
    const r = await q.query(
      `update accounts a set status = u.s, score = u.sc, tier = u.t, parts = u.p,
         listed_at = case when u.t >= 1 then coalesce(a.listed_at, $9::timestamptz) end,
         confirmed_at = case when u.c then coalesce(a.confirmed_at, $9::timestamptz) end,
         updated_at = now()
       from ${RESULTS} where ${CHANGED}`,
      [...params, now],
    );
    changed += r.rowCount;
    const byHandle = new Map(part.map((a) => [a.handle, a]));
    for (const o of stored) events.push(...statusEvent(o, byHandle.get(o.handle)!));
  }
  await writeEvents(q, 'score', 'status', events);
  return changed;
}

/** The data of a standing event (SPEC 14.1), from the row aliased `c` with the columns that the writers return. */
const STANDING_DATA = "jsonb_build_object('standing', c.standing, 'reputation', c.reputation, 'goodMarks', c.good_marks, 'banned', c.banned)";

/**
 * Stores reputation, standing and good marks of each loaded install. A ban ends standing at once, also for an install that is
 * not loaded. Each flip of the stored standing writes a standing event in the same statement (every part of a statement reads
 * the rows as they were before it).
 */
async function writeInstalls(q: Queryable, installs: ScoringOutput['installs']): Promise<void> {
  for (let i = 0; i < installs.length; i += CHUNK) {
    const part = installs.slice(i, i + CHUNK);
    await q.query(
      `with u as (select * from unnest($1::uuid[], $2::real[], $3::boolean[], $4::int[]) as u(id, r, s, g)),
       flipped as (select i.id from installs i join u on u.id = i.id where i.standing <> u.s),
       c as (update installs i set reputation = u.r, standing = u.s, good_marks = u.g from u
             where i.id = u.id and (i.reputation, i.standing, i.good_marks) is distinct from (u.r, u.s, u.g)
             returning i.id, i.standing, i.reputation, i.good_marks, i.banned_at is not null as banned)
       insert into events (source, kind, subject, data)
       select 'score', 'standing', c.id::text, ${STANDING_DATA} from c join flipped f on f.id = c.id`,
      [part.map((x) => x.id), part.map((x) => x.reputation), part.map((x) => x.standing), part.map((x) => x.goodMarks)],
    );
  }
  await q.query(
    `with c as (update installs set standing = false where standing and banned_at is not null returning id, standing, reputation, good_marks, true as banned)
     insert into events (source, kind, subject, data) select 'score', 'standing', c.id::text, ${STANDING_DATA} from c`,
  );
}

/** SPEC 4 and 13.7. Each rule keeps what a later run, an admin or an appeal can still use. */
async function retention(q: Queryable, now: Date): Promise<void> {
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY_MS);
  await q.query('delete from sightings where reply_at < $1', [ago(RETENTION.sightings)]);
  await q.query('delete from used_challenges where expires_at < $1', [now]);
  await q.query('delete from admin_sessions where expires_at < $1', [now]);
  await q.query(`delete from list_snapshots where version < (select min(version) from (select version from list_snapshots order by version desc limit ${SNAPSHOTS_KEPT}) k)`);
  await q.query(
    `delete from votes v using accounts a where a.handle = v.handle and v.updated_at < $1
       and a.status = 'none' and not a.seed and a.override is null and a.cleared_at is null`,
    [ago(RETENTION.votes)],
  );
  await q.query(
    "delete from evidence e using accounts a where a.handle = e.handle and a.status not in ('pending', 'flagged', 'confirmed') and e.checked_at < $1",
    [ago(RETENTION.evidence)],
  );
  await q.query('delete from cleared_votes where cleared_at < $1', [ago(RETENTION.clearedVotes)]);
  await q.query('delete from admin_log where at < $1', [ago(RETENTION.adminLog)]);
  await q.query('delete from events where at < $1', [ago(RETENTION.events)]);
  await q.query('delete from job_runs where started_at < $1', [ago(RETENTION.jobRuns)]);
  // A signed request moves last_seen_at, so an install that comes back during this statement is not deleted.
  await q.query('delete from installs i where coalesce(i.last_seen_at, i.created_at) < $1 and not exists (select 1 from votes v where v.install_id = i.id)', [ago(RETENTION.installs)]);
  // An account row with nothing on it: no state, no vote, no appeal, no evidence, unchanged for 30 days. Its profile goes with it.
  await q.query(
    `with gone as (
       select a.handle from accounts a
       where a.status = 'none' and not a.seed and a.override is null and a.cleared_at is null and not a.protected and a.updated_at < $1
         and not exists (select 1 from votes v where v.handle = a.handle)
         and not exists (select 1 from appeals p where p.handle = a.handle)
         and not exists (select 1 from evidence e where e.handle = a.handle)
         and not exists (select 1 from cleared_votes c where c.handle = a.handle)),
     profile as (delete from profiles where handle in (select handle from gone))
     delete from accounts where handle in (select handle from gone)`,
    [ago(RETENTION.accounts)],
  );
}

/**
 * One scoring run (SPEC 6, 13 and 14.1): lock, load, computeScores, write accounts, installs, their events, snapshot and
 * delta, heartbeat; then retention in its own transaction, then one job_runs row (also for a failed run). A second
 * concurrent run skips and writes nothing.
 */
export async function runScoreJob(db: Db, compute: ComputeScores, clock: () => Date = () => new Date(), budgetMs = TIME_BUDGET_MS): Promise<ScoreJobResult> {
  const started = Date.now();
  return db.session(async (s) => {
    const lock = await s.query<{ ok: boolean }>('select pg_try_advisory_lock($1::int, hashtext(current_schema())) as ok', [SCORE_LOCK]);
    if (!lock.rows[0]?.ok) return { skipped: true, accounts: 0, listed: 0, version: null, listChanged: false, ms: Date.now() - started, loadMs: 0, computeMs: 0, writeMs: 0 };
    try {
      const now = clock();
      const { input, votesHeld } = await loadInput(s, now);
      const loadMs = Date.now() - started;
      const out = compute(input);
      checkOutput(out);
      const computeMs = Date.now() - started - loadMs;
      if (loadMs + computeMs > budgetMs) throw new Error(`scoring took ${loadMs + computeMs} ms, past its ${budgetMs} ms budget; nothing was written`);
      const loaded = new Map(input.accounts.map((a) => [a.handle, a]));
      // Only loaded rows are written: the engine never creates an account row.
      const accounts = out.accounts.filter((a) => loaded.has(a.handle));
      const { result, detail } = await s.tx(async (q) => {
        const accountsChanged = await writeAccounts(q, accounts, loaded, now);
        await writeInstalls(q, out.installs);
        const snap = await publishList(q, now);
        const counts = await q.query<{ pending: number; standing: number }>(
          "select (select count(*) from accounts where status = 'pending')::int as pending, (select count(*) from installs where standing)::int as standing",
        );
        const ms = Date.now() - started;
        const r: ScoreJobResult = { skipped: false, accounts: accounts.length, listed: snap.listed, version: snap.version, listChanged: snap.changed, ms, loadMs, computeMs, writeMs: ms - loadMs - computeMs };
        const detail = {
          ...r,
          accountsChanged,
          installs: out.installs.length,
          votesHeld,
          struckNetworks: out.struckNetworks,
          pending: counts.rows[0]!.pending,
          standingInstalls: counts.rows[0]!.standing,
          model: out.model,
        };
        await q.query(
          `insert into jobs (name, last_run_at, last_ok_at, detail) values ('score', $1, $1, $2::jsonb)
           on conflict (name) do update set last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, detail = excluded.detail`,
          [now, JSON.stringify(detail)],
        );
        return { result: r, detail };
      });
      await s.tx((q) => retention(q, now));
      await recordRun(s, 'score', new Date(started), true, detail);
      return result;
    } catch (err) {
      const failure = { error: errorText(err) };
      await s
        .query(
          `insert into jobs (name, last_run_at, detail) values ('score', now(), $1::jsonb)
           on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail`,
          [JSON.stringify(failure)],
        )
        .catch(() => undefined);
      await recordRun(s, 'score', new Date(started), false, failure).catch(() => undefined);
      throw err;
    } finally {
      await s.query('select pg_advisory_unlock($1::int, hashtext(current_schema()))', [SCORE_LOCK]).catch(() => undefined);
    }
  });
}
