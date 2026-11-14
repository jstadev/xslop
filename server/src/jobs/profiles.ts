import { createPgDb, type Db, type Queryable } from '../db.js';
import { requireDatabaseUrl } from '../env.js';
import { errorText, recordRun, writeEvents, type HistoryEvent } from '../history.js';
import { postTime } from '../lib/http.js';
import { isMain } from '../lib/main.js';
import { createXSource, type Avatar, type Miss, type XPost, type XProfile, type XSourceDeps } from '../lib/xsource.js';

// The X facts job (SPEC 13.6), run by the xslop-profiles timer every 2 minutes: the identity of accounts, evidence
// posts, reply timing of sightings, renames, and the public profile (name, followers, avatar) of each account it checks.

/** pg_advisory_lock key of this job. The second key is the schema, so the channels that share one database do not block each other. */
export const PROFILES_LOCK = 0x7a510003;
/** Accounts per run. At most this many avatars of 256 KiB wait in memory for the one commit. */
export const MAX_PER_RUN = 120;
/** Work order (3): pending accounts per run. */
export const PENDING_PER_RUN = 20;
export const EVIDENCE_PER_ACCOUNT = 3;
export const SIGHTINGS_PER_ACCOUNT = 15;
/** Runs in a row without the account before it is gone. A run counts a miss at most once a day. */
export const MISSES_FOR_GONE = 5;
/** Accounts that one sponsor network gets checked in one run (SPEC 13.10 item 7). */
export const PER_SPONSOR = 3;
/** Requests of a run that the work classes (1) to (3) may use, so the weekly check of listed accounts (4) always runs. */
export const FIRST_CLASSES_REQUESTS = 160;
/** Accounts of a run that only class (4) can take, so it also keeps its place in the work list. */
export const FOURTH_CLASS_SLOTS = 40;
/** Candidates that one class reads before the fair order picks from them. */
const CANDIDATES = MAX_PER_RUN * 4;
/** Proven posts that one rename search reads. */
const RENAME_POSTS = 2;
// No request starts after 8 minutes. One call adds at most 48 s (3 profile tries and an avatar, each 10 s plus the pace),
// so a run ends within the 9 minutes of SPEC 13.6 and before the unit's TimeoutStartSec of 600 s.
const MAX_RUN_MS = 8 * 60_000;

// A check that found the account holds for 7 days. Any attempt holds the next one back for a day, so the 5 misses of
// `gone` take 5 days and an account that the source cannot read costs one request a day. A gone account keeps its state
// and is checked each day (SPEC 13.10 item 10).
const DUE = `(a.identity = 'gone' or a.identity_at is null or a.identity_at < now() - interval '7 days')
  and not exists (select 1 from profiles p where p.handle = a.handle and p.fetched_at > now() - interval '1 day')`;

// A pending account with a request left: its identity check is due, or a post of EVIDENCE_POSTS or a sighting of UNVERIFIED
// waits for X. A checked account leaves class (3), so 20 checked accounts cannot hold its places for the rest of the queue.
const WORK_LEFT = `(${DUE} or (a.identity = 'ok' and (
    exists (select 1 from votes v join installs i on i.id = v.install_id
            where v.handle = a.handle and v.value = 1 and v.tweet_id is not null and i.banned_at is null
              and not exists (select 1 from evidence e where e.tweet_id = v.tweet_id)
              and not exists (select 1 from votes y join installs j on j.id = y.install_id join evidence e on e.tweet_id = y.tweet_id
                              where y.handle = a.handle and y.value = 1 and j.banned_at is null and j.ip_hash = i.ip_hash and e.handle = a.handle and e.ok))
    or exists (select 1 from sightings s where s.handle = a.handle and s.verified_at is null))))`;

// The sponsor of an account: the network of its earliest slop vote of an install that is not banned (SPEC 13.10 item 7).
const SPONSOR = `(select i.ip_hash from votes v join installs i on i.id = v.install_id
  where v.handle = a.handle and v.value = 1 and i.banned_at is null order by v.updated_at, v.install_id limit 1) as sponsor`;

/** The work order of a run, in priority. Votes of installs without standing alone start no request, except through (3). */
const WORK: { sql: string; evidence: boolean; max: number }[] = [
  // (1) a gate that only these facts open, anchors first. The engine names the identity gate before the standing gate, so
  // a crowd of installs without standing reaches it too: only an account with an anchor is worked here (SPEC 13.6).
  {
    sql: `select a.handle, ${SPONSOR} from accounts a
          where a.parts->>'gate' in ('identity', 'evidence') and coalesce((a.parts->>'anchors')::numeric, 0) >= 1
          order by a.parts->'anchors' desc nulls last, a.handle limit $1`,
    evidence: true,
    max: MAX_PER_RUN,
  },
  // (2) never checked, with a slop vote of an install with standing
  {
    sql: `select a.handle, ${SPONSOR} from accounts a where a.identity = 'unknown' and ${DUE}
            and exists (select 1 from votes v join installs i on i.id = v.install_id
                        where v.handle = a.handle and v.value = 1 and i.standing and i.banned_at is null)
          order by a.handle limit $1`,
    evidence: false,
    max: MAX_PER_RUN,
  },
  // (3) every pending account, so the review queue shows checked facts (SPEC 13.12): the ones that the crowd would confirm
  // first, then most networks. Five first-day installs carry too little trust for a confirm, and their account waits here too.
  {
    sql: `select a.handle, ${SPONSOR} from accounts a where a.status = 'pending' and ${WORK_LEFT}
          order by a.parts->>'want' = 'confirmed' desc nulls last, a.parts->'networks' desc nulls last, a.handle limit $1`,
    evidence: true,
    max: PENDING_PER_RUN,
  },
  // (4) listed and starter accounts, rows with an admin decision, and gone or moved rows that get votes, each 7 days. A
  // decision on a row with no X id binds the X id at the next run, while the account that the admin judged still holds the
  // handle, and later checks let the decision follow that account's renames (round 2 R13).
  {
    sql: `select a.handle, ${SPONSOR} from accounts a
          where (a.tier >= 1 or a.seed or a.override is not null or (a.identity in ('gone', 'moved') and exists (select 1 from votes v where v.handle = a.handle)))
            and ${DUE}
          order by a.identity_at nulls first, a.handle limit $1`,
    evidence: false,
    max: MAX_PER_RUN,
  },
];

/**
 * The fair order inside one class (SPEC 13.10 item 7): round robin by sponsor network, at most PER_SPONSOR accounts of
 * one sponsor. Round r holds the r-th account of each sponsor, in the order of the class. An account with no sponsor
 * (no slop vote, a starter account) is a round of its own.
 */
export function fairOrder<T extends { sponsor: string | null }>(rows: readonly T[], max: number): T[] {
  const seen = new Map<string, number>();
  const ranked = rows.flatMap((r, i) => {
    const round = r.sponsor === null ? 0 : (seen.get(r.sponsor) ?? 0);
    if (r.sponsor !== null) seen.set(r.sponsor, round + 1);
    return round < PER_SPONSOR ? [{ r, round, i }] : [];
  });
  return ranked.sort((a, b) => a.round - b.round || a.i - b.i).slice(0, max).map((x) => x.r);
}

const DETAIL = `
  select a.handle, a.x_user_id as "xUserId", a.identity, a.status = 'pending' or a.tier >= 1 as timing, ${DUE} as due
  from accounts a where a.handle = any($1::text[])`;

// Up to 3 posts that the slop votes of the account name and that have no evidence row: one per network, installs with
// standing first, newest first. A network that already has an ok post here needs no second one. A post that several networks
// name is one post: its one row is the evidence of each of them (the score job counts the networks).
const EVIDENCE_POSTS = `
  with voted as (
    select v.tweet_id, i.ip_hash, i.standing, v.updated_at
    from votes v join installs i on i.id = v.install_id
    where v.handle = $1 and v.value = 1 and v.tweet_id is not null and i.banned_at is null)
  select tweet_id from (
    select distinct on (x.ip_hash) x.tweet_id, x.standing, x.updated_at from voted x
    where not exists (select 1 from evidence e where e.tweet_id = x.tweet_id)
      and not exists (select 1 from voted y join evidence e on e.tweet_id = y.tweet_id where y.ip_hash = x.ip_hash and e.handle = $1 and e.ok)
    order by x.ip_hash, x.standing desc, x.updated_at desc) t
  group by tweet_id
  order by bool_or(standing) desc, max(updated_at) desc limit ${EVIDENCE_PER_ACCOUNT}`;

const UNVERIFIED = `
  select tweet_id, parent_tweet_id from sightings where handle = $1 and verified_at is null
  order by reply_at desc limit ${SIGHTINGS_PER_ACCOUNT}`;

// Posts that are proven to be by an X id: its evidence rows, and the verified sightings of the rows. A voter or a
// sighting names any post it likes, so an unproven post could only waste the requests of a rename search.
const PROVEN_POSTS = `
  select tweet_id from (
    select tweet_id, checked_at as t from evidence where x_user_id = $1
    union all select tweet_id, verified_at from sightings where handle = any($2::text[]) and verified_at is not null) c
  order by t desc limit ${RENAME_POSTS}`;

// A failed avatar keeps the previous one, so a passing error does not blank a stored picture.
const STORE_PROFILE = `
  insert into profiles (handle, x_id, name, followers, avatar, avatar_type, gone, fetched_at)
  values ($1, $2, $3, $4, $5, $6, false, now())
  on conflict (handle) do update set x_id = excluded.x_id, name = excluded.name, followers = excluded.followers,
    avatar = coalesce(excluded.avatar, profiles.avatar),
    avatar_type = case when excluded.avatar is null then profiles.avatar_type else excluded.avatar_type end,
    gone = false, misses = 0, fetched_at = excluded.fetched_at`;

const STORE_MISSING = `
  insert into profiles (handle, misses) values ($1, 1)
  on conflict (handle) do update set misses = profiles.misses + 1, fetched_at = now()
  returning misses`;

// A gone account loses nothing: it keeps its state, its profile and its avatar (SPEC 13.10 item 10).
const STORE_GONE = `update profiles set gone = true where handle = $1`;

// The handle shows another X id than the stored one. The profile keeps the name, followers and avatar of the stored id (the new
// owner's face never shows on a listed row); x_id remembers the id that this check saw, for the check of the next day.
const STORE_SEEN = `
  insert into profiles (handle, x_id, fetched_at) values ($1, $2, now())
  on conflict (handle) do update set x_id = excluded.x_id, fetched_at = excluded.fetched_at
  returning (select x_id from profiles where handle = $1) as seen_before`;

// A failed attempt keeps the data and only stamps the attempt, so the next one waits a day.
const STORE_FAILED = `insert into profiles (handle) values ($1) on conflict (handle) do update set fetched_at = now()`;

/** Another row that holds an X id, a row with identity ok first. */
const CLAIMED_BY = `select handle, identity from accounts where x_user_id = $1 and handle <> $2 order by identity = 'ok' desc, handle limit 1`;

const SET_OK = `update accounts set x_user_id = $2, identity = 'ok', identity_at = now(), moved_to = null where handle = $1`;
// The row keeps its X id and its state until the row of its new handle claims them.
const SET_LOST = `update accounts set identity = $2, identity_at = now() where handle = $1`;

/** The rename move of SPEC 13.6, from $1 to $2. Both rows are locked. */
const MOVE = [
  // B takes the starter state, the admin decision (as one group, only when A has one) and the protection of A. It keeps
  // the earliest listing time, so votes cast while A was public earn no good mark on B.
  `update accounts b set seed = b.seed or a.seed, seed_source = case when a.seed then a.seed_source else b.seed_source end,
     protected = b.protected or a.protected, listed_at = least(b.listed_at, a.listed_at), confirmed_at = least(b.confirmed_at, a.confirmed_at),
     updated_at = now()
   from accounts a where a.handle = $1 and b.handle = $2`,
  `update accounts b set override = a.override, override_at = a.override_at, clear_penalty = a.clear_penalty, cleared_at = a.cleared_at
   from accounts a where a.handle = $1 and b.handle = $2 and (a.override is not null or a.cleared_at is not null)`,
  // A vote of an install that already voted on B stays with B.
  `delete from votes a using votes b where a.handle = $1 and b.handle = $2 and a.install_id = b.install_id`,
  `update votes set handle = $2 where handle = $1`,
  `delete from cleared_votes a using cleared_votes b where a.handle = $1 and b.handle = $2 and a.install_id = b.install_id`,
  `update cleared_votes set handle = $2 where handle = $1`,
  `update evidence set handle = $2 where handle = $1`,
  `update sightings set handle = $2 where handle = $1`,
  `update appeals set handle = $2 where handle = $1 and status = 'open'
     and ip_hash not in (select ip_hash from appeals where handle = $2 and status = 'open')`,
  `update accounts set seed = false, seed_source = null, override = null, override_at = null, clear_penalty = true, cleared_at = null,
     protected = false, x_user_id = null, identity = 'moved', identity_at = now(), moved_to = $2, updated_at = now()
   where handle = $1`,
];

export type ProfileJobDeps = XSourceDeps;

interface ProfileJobResult {
  skipped: boolean;
  picked: number;
  requests: number;
  ok: number;
  avatars: number;
  missing: number;
  failed: number;
  evidence: number;
  verified: number;
  deleted: number;
  renamed: number;
  stopped: 'rate_limited' | 'deadline' | null;
  ms: number;
}

interface Work {
  handle: string;
  xUserId: string | null;
  identity: 'unknown' | 'ok' | 'gone' | 'moved';
  timing: boolean;
  due: boolean;
  evidence: boolean;
  first: boolean; // work classes (1) to (3)
}

type ProfileOutcome = XProfile | 'missing' | 'failed';
interface Timing {
  replyAt: Date;
  parentAt: Date | null;
  latencySec: number | null;
}

/** The times in the two post ids; null when the reply would come before its parent. */
function timingOf(tweetId: string, parentId: string | null): Timing | null {
  const replyAt = postTime(tweetId);
  const parentAt = parentId === null ? null : postTime(parentId);
  const latencySec = parentAt === null ? null : Math.round((replyAt.getTime() - parentAt.getTime()) / 1000);
  return latencySec !== null && latencySec < 0 ? null : { replyAt, parentAt, latencySec };
}

/**
 * `claimed`: another row with identity ok holds the id, and no confirmed rename moves it here. `elsewhere`: X's embed answer
 * of a proven post of the stored id names another handle in this run.
 */
async function storeProfile(q: Queryable, handle: string, outcome: ProfileOutcome, avatar: Avatar | null, stored: string | null, claimed: boolean, elsewhere: boolean): Promise<void> {
  if (typeof outcome === 'object') {
    if (stored !== null && stored !== outcome.xId) {
      // The handle has another X id than the stored one: its owner left it (`moved`), and the new owner gets nothing of the
      // row. One profile answer is not proof: `moved` needs X's embed answer, or the same other id at the check of an earlier
      // day (attempts are a day apart).
      const { rows } = await q.query<{ seen_before: string | null }>(STORE_SEEN, [handle, outcome.xId]);
      if (elsewhere || rows[0]?.seen_before === outcome.xId) await q.query(SET_LOST, [handle, 'moved']);
      return;
    }
    await q.query(STORE_PROFILE, [handle, outcome.xId, outcome.name, outcome.followers, avatar?.bytes ?? null, avatar?.type ?? null]);
    // A new row takes no id that a live row holds on the word of one source: it stays as it is until a rename is confirmed.
    if (stored === outcome.xId || (stored === null && !claimed)) await q.query(SET_OK, [handle, outcome.xId]);
  } else if (outcome === 'missing') {
    const { rows } = await q.query<{ misses: number }>(STORE_MISSING, [handle]);
    if (rows[0]!.misses >= MISSES_FOR_GONE) {
      await q.query(STORE_GONE, [handle]);
      await q.query(SET_LOST, [handle, 'gone']);
    }
  } else {
    await q.query(STORE_FAILED, [handle]);
  }
}

interface IdentityRow {
  handle: string;
  identity: string;
  x_user_id: string | null;
  moved_to?: string | null;
}

/**
 * The identity events of a commit (SPEC 14.1): one for each row whose identity changed, and one on the new handle of each
 * rename, with the row that it took the state from. A row that a rename emptied keeps its old X id in the event.
 */
async function identityEvents(q: Queryable, before: readonly IdentityRow[], renames: readonly { from: string; to: string }[]): Promise<HistoryEvent[]> {
  const was = new Map(before.map((r) => [r.handle, r]));
  const { rows } = await q.query<IdentityRow>('select handle, identity, x_user_id, moved_to from accounts where handle = any($1::text[]) order by handle collate "C"', [[...was.keys()]]);
  return rows.flatMap((r): HistoryEvent[] => {
    const b = was.get(r.handle)!;
    const tookFrom = renames.find((m) => m.to === r.handle)?.from;
    if (tookFrom !== undefined) return [{ subject: r.handle, data: { from: b.identity, to: r.identity, xUserId: r.x_user_id, tookFrom } }];
    if (b.identity === r.identity) return [];
    return [{ subject: r.handle, data: { from: b.identity, to: r.identity, xUserId: r.x_user_id ?? b.x_user_id, movedTo: r.moved_to ?? null } }];
  });
}

const defaults: ProfileJobDeps = {
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/**
 * One run: lock, read the work order, ask the sources at the pace limit, then write everything in one commit with its identity
 * events. A run that did work or failed writes one job_runs row. A second concurrent run skips and writes nothing.
 */
export async function runProfilesJob(db: Db, overrides: Partial<ProfileJobDeps> = {}): Promise<ProfileJobResult> {
  const deps = { ...defaults, ...overrides };
  const started = deps.now();
  // Wall time for job_runs: deps.now is the clock of the pace and the deadline.
  const startedAt = new Date();
  const result: ProfileJobResult = { skipped: false, picked: 0, requests: 0, ok: 0, avatars: 0, missing: 0, failed: 0, evidence: 0, verified: 0, deleted: 0, renamed: 0, stopped: null, ms: 0 };
  return db.session(async (s) => {
    const lock = await s.query<{ ok: boolean }>('select pg_try_advisory_lock($1::int, hashtext(current_schema())) as ok', [PROFILES_LOCK]);
    if (!lock.rows[0]?.ok) return { ...result, skipped: true };
    try {
      const src = createXSource(deps);
      const profiles = new Map<string, { outcome: ProfileOutcome; avatar: Avatar | null }>();
      const evidence: { tweetId: string; handle: string; xUserId: string | null; ok: boolean }[] = [];
      const evidenceOf: { handle: string; xId: string }[] = [];
      const sightings: { tweetId: string; handle: string; timing: Timing | null }[] = [];
      const moves: { from: string; to: string; xId: string }[] = [];
      // Handles whose stored X id X's embed answer showed at another handle in this run.
      const elsewhere = new Set<string>();
      let postsFound = 0;

      const halt = (): boolean => {
        if (!result.stopped && deps.now() - started > MAX_RUN_MS) result.stopped = 'deadline';
        return result.stopped !== null;
      };
      const checkProfile = async (handle: string): Promise<ProfileOutcome | null> => {
        if (halt()) return null;
        const r = await src.profile(handle);
        if (r === 'rate_limited') {
          result.stopped = r;
          return null;
        }
        const avatar = typeof r === 'object' && r.avatarUrl && !halt() ? await src.avatar(r.avatarUrl) : null;
        profiles.set(handle, { outcome: r, avatar });
        if (avatar) result.avatars++;
        return r;
      };
      // Each post id is asked once in a run (SPEC 13.12): the evidence, the reply timing and the rename searches of several
      // accounts can name the same post.
      const posts = new Map<string, XPost | Exclude<Miss, 'rate_limited'>>();
      const readPost = async (tweetId: string): Promise<XPost | Exclude<Miss, 'rate_limited'> | null> => {
        const known = posts.get(tweetId);
        if (known !== undefined) return known;
        if (halt()) return null;
        const r = await src.post(tweetId);
        if (r === 'rate_limited') {
          result.stopped = r;
          return null;
        }
        posts.set(tweetId, r);
        if (typeof r === 'object') postsFound++;
        return r;
      };
      /** A rename needs two sources: X's embed answer said that `xId` is at `to` now, and fxtwitter says that `to` has `xId`. */
      const confirmRename = async (from: string, xId: string, to: string): Promise<void> => {
        if (to === from || moves.some((m) => m.from === from || m.to === to)) return;
        const at = profiles.get(to)?.outcome ?? (await checkProfile(to));
        if (at !== null && typeof at === 'object' && at.xId === xId) moves.push({ from, to, xId });
      };
      /** Where X id `xId` of row `from` is now, read from a proven post of it: the handle that X names, or null. */
      const findRename = async (from: string, xId: string, handles: string[]): Promise<string | null> => {
        if (moves.some((m) => m.from === from)) return null;
        const { rows } = await s.query<{ tweet_id: string }>(PROVEN_POSTS, [xId, handles]);
        for (const { tweet_id } of rows) {
          const p = await readPost(tweet_id);
          if (p === null) return null;
          if (typeof p !== 'object' || p.via !== 'embed' || p.authorId !== xId) continue;
          await confirmRename(from, xId, p.authorHandle);
          return p.authorHandle;
        }
        return null;
      };

      const picked: { handle: string; evidence: boolean; first: boolean }[] = [];
      for (const [cls, { sql, evidence: ev, max }] of WORK.entries()) {
        const first = cls < WORK.length - 1;
        const room = MAX_PER_RUN - (first ? FOURTH_CLASS_SLOTS : 0) - picked.length;
        if (room <= 0) continue;
        const { rows } = await s.query<{ handle: string; sponsor: string | null }>(sql, [CANDIDATES]);
        const fresh = rows.filter((r) => !picked.some((p) => p.handle === r.handle));
        for (const { handle } of fairOrder(fresh, Math.min(max, room))) picked.push({ handle, evidence: ev, first });
      }
      const top = picked;
      const details = new Map((await s.query<Omit<Work, 'evidence' | 'first'>>(DETAIL, [top.map((p) => p.handle)])).rows.map((r) => [r.handle, r]));
      const work: Work[] = top.flatMap((p) => {
        const d = details.get(p.handle);
        return d ? [{ ...d, evidence: p.evidence, first: p.first }] : [];
      });
      result.picked = work.length;

      for (const w of work) {
        if (halt()) break;
        // Classes (1) to (3) never take the whole run: the weekly check of listed and starter accounts keeps its share.
        if (w.first && src.requests >= FIRST_CLASSES_REQUESTS) continue;
        let xId = w.xUserId;
        let mine = w.identity === 'ok';
        if (w.due) {
          // A rename search of an earlier account may have read this handle already.
          const r = profiles.get(w.handle)?.outcome ?? (await checkProfile(w.handle));
          if (r === null) break;
          if (typeof r === 'object') {
            mine = xId === null || xId === r.xId;
            if (mine) {
              xId = r.xId;
              // Another row holds this id: its owner may have renamed to this handle. Until X confirms it, a new row gets no work.
              const other = (await s.query<{ handle: string; identity: string }>(CLAIMED_BY, [xId, w.handle])).rows[0];
              if (other) {
                await findRename(other.handle, xId, [other.handle, w.handle]);
                if (w.xUserId === null && other.identity === 'ok' && !moves.some((m) => m.to === w.handle)) mine = false;
              }
            } else {
              const at = await findRename(w.handle, xId!, [w.handle]);
              if (at !== null && at !== w.handle) elsewhere.add(w.handle);
            }
          } else if (r === 'missing' && xId && (await findRename(w.handle, xId, [w.handle])) === w.handle) {
            // X itself shows the account at its handle, so the 404 of fxtwitter was false: no miss.
            profiles.set(w.handle, { outcome: 'failed', avatar: null });
          }
        }
        // Evidence and timing compare post authors with the X id of the account.
        if (!mine || !xId) continue;
        const owner = xId;
        // X's embed answer of a post by the account names its handle now: another handle means a rename.
        const renamed = { to: null as string | null };
        const read = async (tweetId: string): Promise<XPost | 'missing' | 'failed' | null> => {
          const p = await readPost(tweetId);
          if (typeof p === 'object' && p?.via === 'embed' && p.authorId === owner && p.authorHandle !== w.handle) renamed.to = p.authorHandle;
          return p;
        };
        if (w.evidence) {
          evidenceOf.push({ handle: w.handle, xId: owner });
          for (const { tweet_id } of (await s.query<{ tweet_id: string }>(EVIDENCE_POSTS, [w.handle])).rows) {
            const p = await read(tweet_id);
            if (p === null) break;
            if (p !== 'failed') evidence.push({ tweetId: tweet_id, handle: w.handle, xUserId: typeof p === 'object' ? p.authorId : null, ok: typeof p === 'object' && p.authorId === owner });
          }
        }
        if (w.timing) {
          for (const row of (await s.query<{ tweet_id: string; parent_tweet_id: string | null }>(UNVERIFIED, [w.handle])).rows) {
            const p = await read(row.tweet_id);
            if (p === null) break;
            if (p === 'failed') continue;
            const verified = typeof p === 'object' && p.authorId === owner && p.inReplyTo === row.parent_tweet_id;
            sightings.push({ tweetId: row.tweet_id, handle: w.handle, timing: verified ? timingOf(row.tweet_id, row.parent_tweet_id) : null });
          }
        }
        if (renamed.to) await confirmRename(w.handle, owner, renamed.to);
      }
      result.requests = src.requests;
      result.ms = deps.now() - started;
      for (const { outcome } of profiles.values()) result[typeof outcome === 'object' ? 'ok' : outcome]++;

      // A run in which no account (or no post) answered says nothing about a miss: an outage of a source answers 404 too.
      const stored = [...profiles].filter(([handle, { outcome }]) => (details.has(handle) || moves.some((m) => m.to === handle)) && (outcome !== 'missing' || result.ok > 0));
      const keptEvidence = evidence.filter((e) => e.xUserId !== null || postsFound > 0);
      const keptSightings = sightings.filter((x) => x.timing !== null || postsFound > 0);
      // One commit per run moves max(fetched_at) once. Row-by-row commits would make the web process rebuild its
      // view every 15 s for the whole run and expire every walking cursor. At most 120 avatars of 256 KiB wait here.
      await s.tx(async (q) => {
        await q.query('insert into accounts (handle) select unnest($1::text[]) on conflict (handle) do nothing', [moves.map((m) => m.to)]);
        // Row locks in one fixed order (handle order), taken before any write, so two writers cannot deadlock.
        const touched = [...new Set([...stored.map(([h]) => h), ...moves.flatMap((m) => [m.from, m.to])])];
        const before = await q.query<IdentityRow>(
          'select handle, identity, x_user_id from accounts where handle = any($1::text[]) order by handle collate "C" for update',
          [touched],
        );
        const ids = new Map(before.rows.map((r) => [r.handle, r.x_user_id]));
        for (const [handle, { outcome, avatar }] of stored) {
          const other = typeof outcome === 'object' && !moves.some((m) => m.to === handle) ? (await q.query<{ identity: string }>(CLAIMED_BY, [outcome.xId, handle])).rows[0] : undefined;
          await storeProfile(q, handle, outcome, avatar, ids.get(handle) ?? null, other?.identity === 'ok', elsewhere.has(handle));
        }

        await q.query(
          'insert into evidence (tweet_id, handle, x_user_id, ok) select * from unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) on conflict (tweet_id) do nothing',
          [keptEvidence.map((e) => e.tweetId), keptEvidence.map((e) => e.handle), keptEvidence.map((e) => e.xUserId), keptEvidence.map((e) => e.ok)],
        );
        result.evidence = keptEvidence.length;
        // A post that a voter named on another handle first was checked there. Its author is this account: it is evidence here.
        for (const { handle, xId } of evidenceOf) {
          await q.query(
            `update evidence set handle = $1, ok = true, checked_at = now()
             where handle <> $1 and x_user_id = $2 and tweet_id in (select tweet_id from votes where handle = $1 and value = 1)`,
            [handle, xId],
          );
        }

        const ok = keptSightings.filter((x) => x.timing !== null);
        const bad = keptSightings.filter((x) => x.timing === null);
        await q.query(
          `update sightings s set verified_at = now(), reply_at = u.r, parent_at = u.p, latency_sec = u.l
           from unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::int[]) as u(t, h, r, p, l)
           where s.tweet_id = u.t and s.handle = u.h`,
          [ok.map((x) => x.tweetId), ok.map((x) => x.handle), ok.map((x) => x.timing!.replyAt), ok.map((x) => x.timing!.parentAt), ok.map((x) => x.timing!.latencySec)],
        );
        await q.query('delete from sightings where (tweet_id, handle) in (select * from unnest($1::text[], $2::text[]))', [bad.map((x) => x.tweetId), bad.map((x) => x.handle)]);
        result.verified = ok.length;
        result.deleted = bad.length;

        // A move runs only while A still holds the id and B has it now (B is new, or its check just found it).
        const after = new Map((await q.query<{ handle: string; x_user_id: string | null }>('select handle, x_user_id from accounts where handle = any($1::text[])', [touched])).rows.map((r) => [r.handle, r.x_user_id]));
        const renamed = moves.filter((m) => after.get(m.from) === m.xId && after.get(m.to) === m.xId);
        for (const m of renamed) for (const sql of MOVE) await q.query(sql, [m.from, m.to]);
        result.renamed = renamed.length;
        await writeEvents(q, 'facts', 'identity', await identityEvents(q, before.rows, renamed));
        await q.query(
          `insert into jobs (name, last_run_at, last_ok_at, detail) values ('profiles', now(), now(), $1::jsonb)
           on conflict (name) do update set last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, detail = excluded.detail`,
          [JSON.stringify(result)],
        );
        if (result.picked > 0) await recordRun(q, 'profiles', startedAt, true, result);
      });
      return result;
    } catch (err) {
      await recordRun(s, 'profiles', startedAt, false, { error: errorText(err) }).catch(() => undefined);
      throw err;
    } finally {
      await s.query('select pg_advisory_unlock($1::int, hashtext(current_schema()))', [PROFILES_LOCK]).catch(() => undefined);
    }
  });
}

if (isMain(import.meta.url)) {
  const db = createPgDb(requireDatabaseUrl(), 2);
  try {
    console.log(JSON.stringify({ job: 'profiles', ...(await runProfilesJob(db)) }));
  } catch (err) {
    console.error(JSON.stringify({ job: 'profiles', error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
