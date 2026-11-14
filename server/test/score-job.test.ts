import { randomUUID } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { RETENTION, runScoreJob, SCORE_LOCK, type ComputeScores } from '../src/jobs/score-job.js';
import { loadLatestEntries } from '../src/list.js';
import { computeScores, NETWORK_DAILY_VOTES, PROTECTED_MIN_FOLLOWERS } from '../src/scoring/index.js';
import { importSeed } from '../src/scripts/import-seed.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { makeApp } from './helpers/app.js';
import { fakeCompute } from './helpers/fake-scoring.js';

type Input = Parameters<ComputeScores>[0];
type Q = TestDb['db'];

interface InstallOpts { net?: string; days?: number; trusted?: boolean; standing?: boolean; reputation?: number; banned?: boolean; seenDays?: number }
/** An install row as the registration route writes it, with the v2 columns. */
async function install(q: Q, o: InstallOpts = {}): Promise<string> {
  const id = randomUUID();
  await q.query(
    `insert into installs (id, public_key, ip_hash, created_at, trusted, standing, reputation, banned_at, last_seen_at)
     values ($1, '{}', $2, now() - make_interval(days => $3::int), $4, $5, $6, case when $7::boolean then now() end,
             case when $8::int >= 0 then now() - make_interval(days => $8::int) end)`,
    [id, o.net ?? `net-${id}`, o.days ?? 30, o.trusted ?? false, o.standing ?? false, o.reputation ?? 0.5, o.banned ?? false, o.seenDays ?? -1],
  );
  return id;
}
/** A vote row as the vote route writes it (the account row first). */
async function castVote(q: Q, installId: string, handle: string, value: 0 | 1 = 1, o: { tweetId?: string; at?: Date } = {}): Promise<void> {
  await q.query('insert into accounts (handle) values ($1) on conflict do nothing', [handle]);
  await q.query(
    `insert into votes (install_id, handle, value, tweet_id, created_at, updated_at) values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), coalesce($5::timestamptz, now()))
     on conflict (install_id, handle) do update set value = excluded.value, tweet_id = excluded.tweet_id, updated_at = excluded.updated_at`,
    [installId, handle, value, o.tweetId ?? null, o.at ?? null],
  );
}
/** The admin decisions of SPEC 13.8, as the admin API writes them. */
async function adminConfirm(q: Q, h: string): Promise<void> {
  await q.query("update accounts set override = 'confirm', override_at = now(), status = 'confirmed', tier = 2, cleared_at = null, listed_at = coalesce(listed_at, now()), updated_at = now() where handle = $1", [h]);
  await q.query('delete from cleared_votes where handle = $1', [h]);
}
async function adminClear(q: Q, h: string, penalty = true): Promise<void> {
  if (penalty) {
    await q.query(
      `insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at)
       select v.handle, v.install_id, i.ip_hash, v.value, v.updated_at, now() from votes v join installs i on i.id = v.install_id where v.handle = $1
       on conflict (handle, install_id) do update set value = excluded.value, at = excluded.at, cleared_at = excluded.cleared_at`,
      [h],
    );
  }
  await q.query(
    "update accounts set override = 'clear', override_at = now(), clear_penalty = $2, status = 'cleared', tier = 0, cleared_at = now(), listed_at = null, updated_at = now() where handle = $1",
    [h, penalty],
  );
}
const ADMIN_CLEAR = (h: string) =>
  `update accounts set override = 'clear', override_at = now(), status = 'cleared', tier = 0, cleared_at = now(), listed_at = null, updated_at = now() where handle = '${h}'`;
const ADMIN_CONFIRM = (h: string) =>
  `update accounts set override = 'confirm', override_at = now(), status = 'confirmed', tier = 2, listed_at = coalesce(listed_at, now()), updated_at = now() where handle = '${h}'`;
// Runs `admin` after the job has loaded its input and before it writes.
const adminDuringRun = (db: Db, admin: string): Db => ({
  ...db,
  session: (fn) => db.session((s) => fn({ ...s, tx: async (write) => (await s.query(admin), s.tx(write)) })),
});
// Records the input and writes nothing.
const capture = (sink: (input: Input) => void): ComputeScores => (input) => {
  sink(input);
  return { accounts: [], installs: [], struckNetworks: 0, model: { epochs: 0 } };
};
// The real engine, with the input recorded.
const real = (sink: (input: Input) => void = () => undefined): ComputeScores => (input) => (sink(input), computeScores(input));

interface Row { status: string; tier: number; score: number; parts: Record<string, unknown>; listed_at: Date | null; confirmed_at: Date | null }
const account = async (q: Q, h: string): Promise<Row> =>
  (await q.query<Row>('select status, tier, score, parts, listed_at, confirmed_at from accounts where handle = $1', [h])).rows[0]!;
const detail = async (q: Q) => (await q.query<{ detail: Record<string, unknown> }>("select detail from jobs where name = 'score'")).rows[0]!.detail;
const listed = async (q: Q) => [...((await loadLatestEntries(q))?.entries.values() ?? [])];
const installRow = async (q: Q, id: string) =>
  (await q.query<{ reputation: number; standing: boolean; good_marks: number }>('select reputation, standing, good_marks from installs where id = $1', [id])).rows[0]!;
const ago = (ms: number) => new Date(Date.now() - ms);
const events = async (q: Q, kind: string) =>
  (await q.query<{ source: string; subject: string; data: Record<string, unknown> }>('select source, subject, data from events where kind = $1 order by id', [kind])).rows;
const runs = async (q: Q) => (await q.query<{ job: string; ok: boolean; detail: Record<string, unknown>; ordered: boolean }>('select job, ok, detail, started_at <= ended_at as ordered from job_runs order by id')).rows;
/** The fake engine with other parts for some handles. */
const withParts = (compute: ComputeScores, parts: Record<string, Record<string, unknown>>): ComputeScores => (input) => {
  const out = compute(input);
  for (const a of out.accounts) Object.assign(a.parts, parts[a.handle] ?? {});
  return out;
};
/** A session whose advisory lock is held by another run. */
const lockHeld = (db: Db): Db => ({
  ...db,
  session: (fn) => db.session((s) => fn({ ...s, query: (text, params) => (text.includes('pg_try_advisory_lock') ? Promise.resolve({ rows: [{ ok: false }], rowCount: 1 } as never) : s.query(text, params)) })),
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.each(BACKENDS)('score job (%s)', (backend) => {
  let tdb: TestDb;
  let q: Q;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
    q = tdb.db;
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => tdb.reset());

  it('loads the v2 input: standing, account state, verified sightings, cleared votes, protected and the brake count', async () => {
    const a = await install(q, { net: 'n1', trusted: true });
    const b = await install(q, { net: 'n2', standing: true, reputation: 0.75 });
    const c = await install(q, { net: 'n3' });
    await castVote(q, a, 'slopper');
    await castVote(q, b, 'slopper');
    await castVote(q, b, 'fine', 0);
    await castVote(q, a, 'famous');
    await q.query(
      `insert into accounts (handle, seed, override, override_at, cleared_at, clear_penalty, x_user_id, identity, protected)
       values ('seeded', true, 'clear', now(), now(), false, '42', 'ok', true)`,
    );
    await q.query("insert into profiles (handle, followers) values ('famous', $1), ('slopper', $2)", [PROTECTED_MIN_FOLLOWERS, PROTECTED_MIN_FOLLOWERS - 1]);
    // A row of an admin clear whose voter has no vote left: that install is loaded too.
    await q.query("insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at, standing) values ('seeded', $1, 'n3', 1, now() - interval '1 day', now(), true)", [c]);
    await q.query(
      `insert into sightings (tweet_id, handle, parent_tweet_id, reply_at, latency_sec, verified_at, simhash) values
         ('11', 'slopper', '10', now() - interval '2 hours', 4, now(), 'ffffffffffffffff'),
         ('12', 'slopper', null, now() - interval '1 hour', null, now(), null),
         ('13', 'slopper', '10', now() - interval '1 hour', 1, null, null),
         ('14', 'nobody', '10', now() - interval '1 hour', 1, now(), null)`,
    );
    // The brake counts only confirms by votes in the last 24 hours.
    await q.query(
      `insert into accounts (handle, confirmed_at, override, seed) values
         ('auto_today', now() - interval '1 hour', null, false), ('auto_older', now() - interval '25 hours', null, false),
         ('auto_override', now() - interval '1 hour', 'confirm', false), ('auto_seed', now() - interval '1 hour', null, true)`,
    );
    // The flag brake (SPEC 13.10 item 6) counts tier 1 rows listed in the last 24 hours, no override, not a starter.
    await q.query(
      `insert into accounts (handle, status, tier, listed_at, override, seed) values
         ('flag_today', 'flagged', 1, now() - interval '1 hour', null, false), ('flag_older', 'flagged', 1, now() - interval '25 hours', null, false),
         ('flag_override', 'flagged', 1, now() - interval '1 hour', 'confirm', false), ('flag_seed', 'flagged', 1, now() - interval '1 hour', null, true),
         ('flag_tier2', 'confirmed', 2, now() - interval '1 hour', null, false)`,
    );
    // A pending row whose votes are gone is still loaded, so the run can write it again.
    await q.query("insert into accounts (handle, status, score) values ('was_pending', 'pending', 0.7)");

    let seen: Input | null = null;
    await runScoreJob(q, capture((input) => (seen = input)));
    const input = seen!;
    const byId = Object.fromEntries(input.installs.map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual([a, b, c].sort());
    expect(byId[a]).toMatchObject({ ipHash: 'n1', banned: false, reputation: 0.5, trusted: true, standing: false });
    expect(byId[b]).toMatchObject({ trusted: false, standing: true, reputation: 0.75 });
    expect(byId[a]!.createdAt).toBeInstanceOf(Date);
    expect(input.votes.filter((v) => v.handle === 'slopper').map((v) => v.value)).toEqual([1, 1]);
    expect(input.votes.find((v) => v.handle === 'fine')?.value).toBe(0);

    const acc = Object.fromEntries(input.accounts.map((x) => [x.handle, x]));
    // A seed or an override is a state of its own; the other rows of the brake have none.
    expect(Object.keys(acc).sort()).toEqual([
      'auto_override', 'auto_seed', 'famous', 'fine', 'flag_older', 'flag_override', 'flag_seed', 'flag_tier2', 'flag_today', 'seeded', 'slopper', 'was_pending',
    ]);
    expect(acc.seeded).toMatchObject({ seed: true, override: 'clear', identity: 'ok', protected: true, status: 'none', evidence: 0, listedAt: null });
    // SPEC 13.11: the engine reads the penalty from the rows of cleared_votes; clearPenalty is no input.
    expect(acc.seeded).not.toHaveProperty('clearPenalty');
    expect(acc.seeded!.overrideAt).toBeInstanceOf(Date);
    expect(acc.seeded!.clearedAt).toBeInstanceOf(Date);
    expect([acc.famous!.protected, acc.slopper!.protected, acc.fine!.protected]).toEqual([true, false, false]);
    expect(acc.slopper).toMatchObject({ identity: 'unknown', override: null, overrideAt: null });

    // Verified sightings of scored accounts only, with the v2 fields and nothing else.
    expect(input.sightings.map((s) => s.tweetId).sort()).toEqual(['11', '12']);
    expect(Object.keys(input.sightings[0]!).sort()).toEqual(['handle', 'latencySec', 'parentTweetId', 'replyAt', 'tweetId']);
    expect(input.sightings.find((s) => s.tweetId === '11')).toMatchObject({ handle: 'slopper', parentTweetId: '10', latencySec: 4 });
    expect(input.clearedVotes).toEqual([{ handle: 'seeded', install: c, ipHash: 'n3', value: 1, at: expect.any(Date), clearedAt: expect.any(Date), standing: true }]);
    expect(input.autoConfirmsToday).toBe(1);
    expect(input.autoFlagsToday).toBe(1);
  });

  it('sets listed_at when an account is listed, keeps it while listed, clears it at tier 0, and passes it to the engine', async () => {
    await q.query("insert into accounts (handle, seed) values ('a', true), ('b', true)");
    const listedAts = async () => Object.fromEntries((await q.query<{ handle: string; listed_at: Date | null }>('select handle, listed_at from accounts order by handle')).rows.map((r) => [r.handle, r.listed_at?.toISOString() ?? null]));
    const [t1, t2, t3] = ['2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z', '2026-11-01T10:10:00.000Z'];
    await runScoreJob(q, fakeCompute({ a: [0.9, 2] }), () => new Date(t1));
    expect(await listedAts()).toEqual({ a: t1, b: null });
    await runScoreJob(q, fakeCompute({ a: [0.5, 1], b: [0.9, 2] }), () => new Date(t2));
    expect(await listedAts()).toEqual({ a: t1, b: t2 });
    let seen: Input | null = null;
    await runScoreJob(q, (input) => ((seen = input), fakeCompute({ b: [0.9, 2] })(input)), () => new Date(t3));
    expect(await listedAts()).toEqual({ a: null, b: t2 });
    expect(seen!.accounts.map((x) => [x.handle, x.listedAt?.toISOString() ?? null])).toEqual(expect.arrayContaining([['a', t1], ['b', t2]]));
  });

  it('keeps a pending account out of the list: 2 and 7 brand-new networks mark an account (SPEC 13.9 item 1)', async () => {
    await q.query("insert into accounts (handle, seed) values ('starter_account', true)");
    for (const [h, n] of [['two_networks', 2], ['seven_networks', 7]] as const) {
      await q.query("insert into accounts (handle, x_user_id, identity) values ($1, '9001', 'ok')", [h]);
      for (let i = 0; i < n; i++) await castVote(q, await install(q, { days: 0 }), h);
    }
    const r = await runScoreJob(q, real());
    expect(r).toMatchObject({ listed: 1, listChanged: true });
    for (const h of ['two_networks', 'seven_networks']) {
      const row = await account(q, h);
      expect([row.status, row.tier, row.parts.gate, row.listed_at]).toEqual(['pending', 0, 'standing', null]);
    }
    expect((await account(q, 'seven_networks')).parts.want).toBe('confirmed');
    expect((await listed(q)).map((e) => e[0])).toEqual(['starter_account']);
    expect(await detail(q)).toMatchObject({ pending: 2, standingInstalls: 0, listed: 1 });
    const t = await makeApp(q);
    expect((await t.app.inject({ url: '/api/v1/list' })).json().accounts).toEqual([['starter_account', expect.any(Number), 2]]);
  });

  it('confirms with standing, identity and evidence; confirmed_at is set, kept, and emptied; the list carries the X id (SPEC 13.9 item 2)', async () => {
    await q.query("insert into accounts (handle, x_user_id, identity) values ('target_account', '777001', 'ok')");
    const voters: string[] = [];
    for (let i = 0; i < 4; i++) {
      voters.push(await install(q, { net: `net${i}`, trusted: i < 2 }));
      await castVote(q, voters[i]!, 'target_account', 1, { tweetId: `185000000000000010${i}`, at: ago(HOUR) });
    }
    await q.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000100', 'target_account', '777001', true)");
    const [t1, t2, t3, t4] = [0, 1, 2, 3].map((i) => new Date(Date.now() + i * 60_000));

    // Evidence of one network: flagged, held below confirmed by the evidence gate.
    await runScoreJob(q, real(), () => t1!);
    expect(await account(q, 'target_account')).toMatchObject({ status: 'flagged', tier: 1, confirmed_at: null, parts: expect.objectContaining({ want: 'confirmed', gate: 'evidence', evidence: 1, anchors: 2 }) });

    await q.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000102', 'target_account', '777001', true)");
    await runScoreJob(q, real(), () => t2!);
    const confirmed = await account(q, 'target_account');
    expect([confirmed.status, confirmed.tier, confirmed.parts.reason, confirmed.parts.evidence]).toEqual(['confirmed', 2, 'votes_confirmed', 2]);
    expect(confirmed.confirmed_at?.toISOString()).toBe(t2!.toISOString());
    expect(await listed(q)).toEqual([['target_account', expect.any(Number), 2, '777001']]);

    // The next run keeps the time, also when a fifth network changes the row, and gives the engine this confirm for the brake.
    await castVote(q, await install(q, { net: 'net4' }), 'target_account', 1, { at: ago(HOUR) });
    let seen: Input | null = null;
    await runScoreJob(q, real((input) => (seen = input)), () => t3!);
    expect(await account(q, 'target_account')).toMatchObject({ status: 'confirmed', confirmed_at: t2, parts: expect.objectContaining({ networks: 5 }) });
    expect(seen!.autoConfirmsToday).toBe(1);

    // The X facts job does not find the account (gone): it keeps its state and its listing (SPEC 13.10 item 10).
    await q.query("update accounts set identity = 'gone' where handle = 'target_account'");
    await runScoreJob(q, real(), () => t4!);
    expect(await account(q, 'target_account')).toMatchObject({ status: 'confirmed', tier: 2, confirmed_at: t2 });
    expect((await listed(q)).map((e) => e[0])).toEqual(['target_account']);
    // The handle has another X id now (moved): it leaves the list and loses confirmed_at.
    await q.query("update accounts set identity = 'moved' where handle = 'target_account'");
    await runScoreJob(q, real(), () => new Date(t4!.getTime() + 60_000));
    expect(await account(q, 'target_account')).toMatchObject({ status: 'none', tier: 0, confirmed_at: null, listed_at: null });
    expect(await listed(q)).toEqual([]);
  });

  it('counts evidence from loaded slop votes on ok posts of the account X id only', async () => {
    await q.query("insert into accounts (handle, x_user_id) values ('ev_account', '500')");
    const cases: [net: string, value: 0 | 1, tweet: string, author: string | null, ok: boolean, banned?: boolean][] = [
      ['e1', 1, '201', '500', true],
      ['e1', 1, '202', '500', true], // a second install of the same network
      ['e2', 1, '203', '500', true],
      ['e3', 1, '204', '999', false], // a post of another author
      ['e4', 1, '205', '501', true], // a row checked against an old X id
      ['e5', 0, '206', '500', true], // a "not slop" vote
      ['e6', 1, '207', '500', true, true], // a banned voter
      ['e7', 1, '208', null, false], // a post that does not exist
    ];
    for (const [net, value, tweet, author, ok, banned] of cases) {
      await castVote(q, await install(q, { net, banned: banned ?? false }), 'ev_account', value, { tweetId: tweet });
      await q.query('insert into evidence (tweet_id, handle, x_user_id, ok) values ($1, $2, $3, $4)', [tweet, 'ev_account', author, ok]);
    }
    let seen: Input | null = null;
    await runScoreJob(q, capture((input) => (seen = input)));
    expect(seen!.accounts.find((a) => a.handle === 'ev_account')!.evidence).toBe(2);
  });

  it('stores reputation, good marks and standing, and the next run reads them (SPEC 13.9 item 11)', async () => {
    const voter = await install(q, { net: 'v1', days: 8 });
    const dissenter = await install(q, { net: 'v2', days: 8 });
    const marked = ['marked_one', 'marked_two', 'marked_three'];
    for (const h of marked) await castVote(q, voter, h, 1, { at: ago(HOUR) });
    await castVote(q, dissenter, 'marked_one', 0, { at: ago(HOUR) });
    await runScoreJob(q, real());
    expect(await installRow(q, voter)).toEqual({ reputation: 0.5, standing: false, good_marks: 0 });

    for (const h of marked) await adminConfirm(q, h);
    await runScoreJob(q, real());
    expect(await installRow(q, voter)).toEqual({ reputation: expect.closeTo(0.8, 6), standing: true, good_marks: 3 });
    expect(await installRow(q, dissenter)).toEqual({ reputation: expect.closeTo(1 / 3, 6), standing: false, good_marks: 0 });
    expect(await detail(q)).toMatchObject({ standingInstalls: 1 });

    let seen: Input | null = null;
    await runScoreJob(q, real((input) => (seen = input)));
    expect(seen!.installs.find((i) => i.id === voter)).toMatchObject({ standing: true, trusted: false, reputation: expect.closeTo(0.8, 6) });

    // A ban ends standing at once, although the banned install is no longer loaded.
    await q.query('update installs set banned_at = now() where id = $1', [voter]);
    await runScoreJob(q, real());
    expect((await installRow(q, voter)).standing).toBe(false);
  });

  it('strikes hold after the voters delete their votes, through cleared_votes; an admin confirm removes them (SPEC 13.9 item 10)', async () => {
    const ring: string[] = [];
    for (let i = 0; i < 5; i++) ring.push(await install(q, { net: `ring${i}` }));
    for (const id of ring) for (const h of ['victim_zero', 'victim_one']) await castVote(q, id, h, 1, { at: ago(HOUR) });
    await adminClear(q, 'victim_zero');
    await adminClear(q, 'victim_one');
    await q.query('delete from votes');
    // One ring member votes again: it is loaded, and its network counts for nothing.
    await castVote(q, ring[0]!, 'fresh_target');
    let seen: Input | null = null;
    await runScoreJob(q, real((input) => (seen = input)), () => new Date(Date.now() + 1000));
    expect(seen!.clearedVotes).toHaveLength(10);
    expect(new Set(seen!.installs.map((i) => i.id))).toEqual(new Set(ring));
    expect((await detail(q)).struckNetworks).toBe(5);

    await adminConfirm(q, 'victim_one');
    await runScoreJob(q, real(), () => new Date(Date.now() + 1000));
    expect((await q.query('select 1 from cleared_votes')).rows).toHaveLength(5);
    expect((await detail(q)).struckNetworks).toBe(0);
  });

  it('leaves the votes past the budget of a network in the table, but never the votes of an install with standing (SPEC 13.9 item 9)', async () => {
    const flood = await install(q, { net: 'shared' });
    const standing = await install(q, { net: 'shared', trusted: true });
    const handles = Array.from({ length: NETWORK_DAILY_VOTES + 30 }, (_, i) => `junk${i}`);
    for (const [i, h] of handles.entries()) await castVote(q, flood, h, 1, { at: ago(HOUR - i * 1000) });
    // More votes than the bound of one day: an install with standing is never cut by the loader.
    const kept = Array.from({ length: NETWORK_DAILY_VOTES + 10 }, (_, i) => `kept${i}`);
    for (const h of kept) await castVote(q, standing, h);
    // A flood of "not slop" votes uses no budget: it does not push the slop vote of its network out.
    const dissent = await install(q, { net: 'quiet' });
    const neighbour = await install(q, { net: 'quiet' });
    for (const h of handles) await castVote(q, dissent, h, 0, { at: ago(2 * HOUR) });
    await castVote(q, neighbour, 'kept_three');

    let seen: Input | null = null;
    await runScoreJob(q, real((input) => (seen = input)));
    const loaded = (id: string) => seen!.votes.filter((v) => v.install === id).map((v) => v.handle);
    expect(new Set(loaded(flood))).toEqual(new Set(handles.slice(0, NETWORK_DAILY_VOTES)));
    expect(new Set(loaded(standing))).toEqual(new Set(kept));
    expect(loaded(neighbour)).toEqual(['kept_three']);
    expect(loaded(dissent)).toHaveLength(NETWORK_DAILY_VOTES);
    expect((await detail(q)).votesHeld).toBe(60);
  });

  it('gives the engine only installs with a loaded vote or a cleared vote: idle, held and banned installs change nothing', async () => {
    const a = await install(q, { net: 'na' });
    const b = await install(q, { net: 'nb' });
    await castVote(q, a, 'slopper');
    await castVote(q, b, 'slopper');
    const slopper = async () => (await q.query("select status, score, tier, parts from accounts where handle = 'slopper'")).rows[0];
    await runScoreJob(q, real());
    const before = { slopper: await slopper(), reputations: [await installRow(q, a), await installRow(q, b)] };
    expect(before.slopper).toMatchObject({ status: 'pending', tier: 0 });

    await q.query(
      `insert into installs (id, public_key, ip_hash, reputation)
       select gen_random_uuid(), '{}'::jsonb, case when i % 2 = 0 then 'na' else 'idle' || i end, 0.875 from generate_series(1, 600) i`,
    );
    const heavy = await install(q, { net: 'nh' });
    const late = await install(q, { net: 'nh', reputation: 0.75 });
    for (let i = 0; i < NETWORK_DAILY_VOTES; i++) await castVote(q, heavy, `h${i}`, 1, { at: ago(HOUR) });
    await castVote(q, late, 'late');
    const banned = await install(q, { net: 'nx', banned: true, reputation: 0.25 });
    await castVote(q, banned, 'slopper');

    let seen: Input | null = null;
    await runScoreJob(q, real((input) => (seen = input)));
    expect(new Set(seen!.installs.map((i) => i.id))).toEqual(new Set([a, b, heavy]));
    expect({ slopper: await slopper(), reputations: [await installRow(q, a), await installRow(q, b)] }).toEqual(before);
    expect([(await installRow(q, late)).reputation, (await installRow(q, banned)).reputation]).toEqual([0.75, 0.25]);
    expect((await q.query<{ n: number }>('select count(*)::int as n from installs where reputation = 0.875::real')).rows[0]!.n).toBe(600);
    expect(await detail(q)).toMatchObject({ installs: 3, votesHeld: 2 });
  });

  it('keeps an admin clear that lands during a run, in the row and in the list', async () => {
    await q.query("insert into accounts (handle, seed) values ('a', true), ('b', true)");
    const r = await runScoreJob(adminDuringRun(q, ADMIN_CLEAR('a')), fakeCompute({ a: [0.9, 2], b: [0.8, 2] }));
    expect(r.listed).toBe(1);
    const row = (await q.query<{ status: string; tier: number; override: string; listed_at: Date | null }>("select status, tier, override, listed_at from accounts where handle = 'a'")).rows[0]!;
    expect(row).toEqual({ status: 'cleared', tier: 0, override: 'clear', listed_at: null });
    expect((await listed(q)).map((e) => e[0])).toEqual(['b']);
  });

  it('keeps a second admin decision with the same override that lands during a run', async () => {
    await q.query("insert into accounts (handle, override, override_at, status, cleared_at) values ('a', 'clear', now() - interval '1 day', 'cleared', now() - interval '1 day')");
    await runScoreJob(adminDuringRun(q, ADMIN_CLEAR('a')), fakeCompute({ a: [0.4, 0, 'cleared'] }));
    expect((await q.query<{ score: number }>("select score from accounts where handle = 'a'")).rows[0]!.score).toBe(0);
  });

  it('keeps an admin confirm that lands during a run, in the row and in the list', async () => {
    await q.query("insert into accounts (handle, seed) values ('a', true)");
    await runScoreJob(adminDuringRun(q, ADMIN_CONFIRM('a')), fakeCompute({}));
    expect((await q.query("select status, tier from accounts where handle = 'a'")).rows[0]).toEqual({ status: 'confirmed', tier: 2 });
    expect((await listed(q)).map((e) => e[0])).toEqual(['a']);
  });

  it('still updates a row that already had an admin answer when the run started, also when override_at has microseconds', async () => {
    // Postgres stores microseconds and a JavaScript date holds milliseconds: the writer compares at milliseconds, or a row
    // with an admin decision is never written again. Row b has microseconds on every backend (PGlite's now() may not).
    await q.query(
      `insert into accounts (handle, override, override_at, cleared_at, status) values
         ('a', 'clear', now(), now(), 'cleared'), ('b', 'confirm', '2026-11-12 10:00:00.123456+00', null, 'none')`,
    );
    await runScoreJob(q, fakeCompute({ a: [0.25, 0, 'cleared'], b: [1, 2, 'confirmed'] }));
    const rows = (await q.query<{ handle: string; score: number; status: string; parts: { reason: string } }>('select handle, score, status, parts from accounts order by handle')).rows;
    expect(rows.map((r) => [r.handle, r.score, r.status, r.parts.reason])).toEqual([['a', 0.25, 'cleared', 'test'], ['b', 1, 'confirmed', 'test']]);
  });

  it('votes do not remove a starter account: "not slop" with standing marks it as disputed, without standing it is dissent', async () => {
    await q.query("insert into accounts (handle, seed, seed_source, status, tier, score, listed_at) values ('seedy', true, 'x_list:1', 'confirmed', 2, 0.8, now() - interval '3 days')");
    const crowd: string[] = [];
    for (let i = 0; i < 7; i++) crowd.push(await install(q, { net: `c${i}` }));
    for (const id of crowd) await castVote(q, id, 'seedy', 0);
    await runScoreJob(q, real());
    expect(await account(q, 'seedy')).toMatchObject({ status: 'confirmed', tier: 2, parts: expect.objectContaining({ reason: 'seed', disputed: false, dissent: 7, notSlop: 0 }) });

    await q.query('update installs set trusted = true');
    await runScoreJob(q, real());
    expect(await account(q, 'seedy')).toMatchObject({ status: 'confirmed', tier: 2, parts: expect.objectContaining({ reason: 'seed', disputed: true, notSlop: 7 }) });
    expect((await listed(q)).map((e) => e[0])).toEqual(['seedy']);

    await adminClear(q, 'seedy', false);
    await runScoreJob(q, real());
    expect(await account(q, 'seedy')).toMatchObject({ status: 'cleared', tier: 0 });
    expect(await listed(q)).toEqual([]);
  });

  it('fails cleanly past its time budget and writes nothing', async () => {
    await q.query("insert into accounts (handle, seed) values ('a', true)");
    await expect(runScoreJob(q, fakeCompute({ a: [0.9, 2] }), () => new Date(), -1)).rejects.toThrow(/budget/);
    expect((await q.query<{ tier: number }>("select tier from accounts where handle = 'a'")).rows[0]!.tier).toBe(0);
    expect((await q.query('select 1 from list_snapshots')).rows).toHaveLength(0);
    expect((await detail(q)).error).toMatch(/budget/);
    expect((await runScoreJob(q, fakeCompute({ a: [0.9, 2] }))).skipped).toBe(false);
  });

  it('records a failure, keeps last_ok_at, and writes nothing from invalid output: a pending account with a tier never reaches the list', async () => {
    await q.query("insert into accounts (handle, seed) values ('a', true)");
    await runScoreJob(q, fakeCompute({ a: [0.9, 2] }));
    const before = (await q.query<{ last_ok_at: Date }>("select last_ok_at from jobs where name = 'score'")).rows[0]!.last_ok_at;

    await expect(runScoreJob(q, () => { throw new Error('model exploded'); })).rejects.toThrow('model exploded');
    const failed = (await q.query<{ last_ok_at: Date; detail: { error: string } }>("select last_ok_at, detail from jobs where name = 'score'")).rows[0]!;
    expect(failed.detail.error).toBe('model exploded');
    expect(failed.last_ok_at.getTime()).toBe(before.getTime());
    // SPEC 14.1: the ok run and the failed run each wrote one job_runs row.
    expect((await runs(q)).map((r) => [r.job, r.ok, r.ok ? r.detail.listed : r.detail, r.ordered])).toEqual([['score', true, 1, true], ['score', false, { error: 'model exploded' }, true]]);

    const bad: [string, ComputeScores][] = [
      ['NaN score', (input) => { const out = fakeCompute({ a: [0.1, 0] })(input); out.accounts[0]!.score = Number.NaN; return out; }],
      ['pending with tier 1', fakeCompute({ a: [0.9, 1, 'pending'] })],
      ['flagged with tier 2', fakeCompute({ a: [0.9, 2, 'flagged'] })],
      ['unknown status', fakeCompute({ a: [0.9, 2, 'listed' as 'confirmed'] })],
      ['negative good marks', (input) => { const out = fakeCompute({ a: [0.9, 2] })(input); out.installs.push({ id: 'x', reputation: 0.5, goodMarks: -1, standing: false }); return out; }],
    ];
    for (const [why, compute] of bad) await expect(runScoreJob(q, compute), why).rejects.toThrow(/invalid/);
    const acct = (await q.query<{ score: number; tier: number; status: string }>("select score, tier, status from accounts where handle = 'a'")).rows[0]!;
    expect([Math.round(acct.score * 100), acct.tier, acct.status]).toEqual([90, 2, 'confirmed']);
    expect((await q.query('select 1 from list_snapshots')).rows).toHaveLength(1);
    expect((await runScoreJob(q, fakeCompute({ a: [0.9, 2] }))).skipped).toBe(false);
  });

  it.skipIf(backend !== 'postgres')('round 2 R14: the writer locks account rows in handle order, like the X facts commit, so the two never deadlock', async () => {
    // The table order puts dl_zulu before dl_alpha, so a writer that locks in table order takes dl_zulu first.
    await q.query("insert into accounts (handle, seed) values ('dl_zulu', true)");
    await q.query("insert into accounts (handle, seed) values ('dl_alpha', true)");
    const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await other.connect();
    try {
      // The X facts commit locks its rows in handle order: it holds dl_alpha and goes on to dl_zulu.
      await other.query('begin');
      await other.query("select 1 from accounts where handle = 'dl_alpha' for update");
      const job = runScoreJob(q, fakeCompute({ dl_alpha: [0.9, 2], dl_zulu: [0.9, 2] }));
      await new Promise((r) => setTimeout(r, 500));
      const next = await other.query("select 1 from accounts where handle = 'dl_zulu' for update").then(() => 'ok', (e: Error) => e.message);
      await other.query(next === 'ok' ? 'commit' : 'rollback');
      const run = await job.then(() => 'ok', (e: Error) => e.message);
      expect([next, run]).toEqual(['ok', 'ok']);
    } finally {
      await other.end();
    }
  });

  it.skipIf(backend !== 'postgres')('skips when another run holds the lock', async () => {
    const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await other.connect();
    try {
      // Another channel on the same database (another schema) holds its own lock: this run goes on.
      await other.query("select pg_advisory_lock($1::int, hashtext('xslop_other_channel'))", [SCORE_LOCK]);
      expect((await runScoreJob(q, fakeCompute({}))).skipped).toBe(false);
      await q.query('delete from jobs');
      await q.query('delete from job_runs');
      await other.query('select pg_advisory_lock($1::int, hashtext(current_schema()))', [SCORE_LOCK]);
      expect((await runScoreJob(q, fakeCompute({}))).skipped).toBe(true);
      expect((await q.query('select 1 from jobs')).rows).toHaveLength(0);
      expect(await runs(q)).toEqual([]);
      await other.query('select pg_advisory_unlock($1::int, hashtext(current_schema()))', [SCORE_LOCK]);
      expect((await runScoreJob(q, fakeCompute({}))).skipped).toBe(false);
    } finally {
      await other.end();
    }
  });

  describe('retention (SPEC 4 and 13.7)', () => {
    const days = (n: number) => `now() - interval '${n} days'`;
    const count = async (sql: string) => (await q.query<{ n: number }>(`select count(*)::int as n from ${sql}`)).rows[0]!.n;

    it('removes old sightings, used challenges, expired sessions and snapshots beyond 60', async () => {
      await q.query(`insert into sightings (tweet_id, handle, reply_at) values ('1', 'old', ${days(RETENTION.sightings + 1)}), ('2', 'new', ${days(1)})`);
      await q.query("insert into used_challenges values ('a', now() - interval '1 minute'), ('b', now() + interval '5 minutes')");
      await q.query("insert into admin_sessions (token_hash, csrf, expires_at, ip_hash) values ('x', 'c', now() - interval '1 second', 'h'), ('y', 'c', now() + interval '1 hour', 'h')");
      const empty = Buffer.from('{"v":1,"accounts":[]}');
      for (let i = 0; i < 70; i++) await q.query("insert into list_snapshots (count, body_gzip, body_br, etag) values (0, $1, $2, 'e')", [gzipSync(empty), brotliCompressSync(empty)]);
      await runScoreJob(q, fakeCompute({}));
      expect((await q.query('select tweet_id from sightings')).rows).toEqual([{ tweet_id: '2' }]);
      expect((await q.query('select challenge_hash from used_challenges')).rows).toEqual([{ challenge_hash: 'b' }]);
      expect((await q.query('select token_hash from admin_sessions')).rows).toEqual([{ token_hash: 'y' }]);
      expect((await q.query('select count(*)::int as n, min(version)::int as lo, max(version)::int as hi from list_snapshots')).rows[0]).toEqual({ n: 60, lo: 11, hi: 70 });
    });

    it(`removes votes older than ${RETENTION.votes} days only on accounts with status none and no state`, async () => {
      const voter = await install(q);
      await q.query(`insert into accounts (handle, seed, override, cleared_at, status) values
        ('plain', false, null, null, 'none'), ('seeded', true, null, null, 'none'), ('decided', false, 'confirm', null, 'confirmed'),
        ('reset', false, null, ${days(10)}, 'none'), ('waiting', false, null, null, 'pending'), ('recent', false, null, null, 'none')`);
      for (const h of ['plain', 'seeded', 'decided', 'reset', 'waiting']) await castVote(q, voter, h, 1, { at: ago((RETENTION.votes + 1) * DAY) });
      await castVote(q, voter, 'recent', 1, { at: ago((RETENTION.votes - 1) * DAY) });
      // The run keeps every status as it is; only retention changes the rows.
      await runScoreJob(q, capture(() => undefined));
      expect((await q.query<{ handle: string }>('select handle from votes order by handle')).rows.map((r) => r.handle)).toEqual(['decided', 'recent', 'reset', 'seeded', 'waiting']);
    });

    it(`removes evidence older than ${RETENTION.evidence} days of accounts that are not pending or listed`, async () => {
      await q.query("insert into accounts (handle, status) values ('gone_by', 'none'), ('waiting', 'pending'), ('listed', 'flagged')");
      await q.query(`insert into evidence (tweet_id, handle, ok, checked_at) values
        ('1', 'gone_by', true, ${days(RETENTION.evidence + 1)}), ('2', 'gone_by', true, ${days(1)}),
        ('3', 'waiting', true, ${days(RETENTION.evidence + 1)}), ('4', 'listed', true, ${days(RETENTION.evidence + 1)})`);
      await runScoreJob(q, capture(() => undefined));
      expect((await q.query<{ tweet_id: string }>('select tweet_id from evidence order by tweet_id')).rows.map((r) => r.tweet_id)).toEqual(['2', '3', '4']);
    });

    it(`removes cleared votes and admin log rows older than ${RETENTION.clearedVotes} and ${RETENTION.adminLog} days`, async () => {
      await q.query("insert into accounts (handle, override, cleared_at, status) values ('cleared_one', 'clear', now(), 'cleared')");
      await q.query(`insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at) values
        ('cleared_one', $1, 'n1', 1, ${days(RETENTION.clearedVotes + 2)}, ${days(RETENTION.clearedVotes + 1)}),
        ('cleared_one', $2, 'n2', 1, ${days(RETENTION.clearedVotes)}, ${days(RETENTION.clearedVotes - 1)})`, [randomUUID(), randomUUID()]);
      await q.query(`insert into admin_log (at, session, action, target) values (${days(RETENTION.adminLog + 1)}, 's', 'clear', 'a'), (${days(1)}, 's', 'confirm', 'b')`);
      await runScoreJob(q, capture(() => undefined));
      expect((await q.query<{ ip_hash: string }>('select ip_hash from cleared_votes')).rows).toEqual([{ ip_hash: 'n2' }]);
      expect((await q.query<{ target: string }>('select target from admin_log')).rows).toEqual([{ target: 'b' }]);
    });

    it(`removes events older than ${RETENTION.events} days and job runs older than ${RETENTION.jobRuns} days (SPEC 14.1)`, async () => {
      await q.query(`insert into events (at, source, kind, subject, data) values
        (${days(RETENTION.events + 1)}, 'score', 'status', 'old_one', '{}'), (${days(RETENTION.events - 1)}, 'facts', 'identity', 'kept_one', '{}')`);
      await q.query(`insert into job_runs (job, started_at, ended_at, ok, detail) values
        ('score', ${days(RETENTION.jobRuns + 1)}, ${days(RETENTION.jobRuns + 1)}, true, '{}'), ('profiles', ${days(RETENTION.jobRuns - 1)}, ${days(RETENTION.jobRuns - 1)}, false, '{}')`);
      await runScoreJob(q, capture(() => undefined));
      expect((await q.query<{ subject: string }>('select subject from events')).rows).toEqual([{ subject: 'kept_one' }]);
      // The old run is gone; the run of 29 days ago and the run that did the retention stay.
      expect((await q.query<{ job: string }>('select job from job_runs order by id')).rows).toEqual([{ job: 'profiles' }, { job: 'score' }]);
    });

    it(`removes installs with no vote and no activity for ${RETENTION.installs} days`, async () => {
      const idle = await install(q, { days: RETENTION.installs + 5, seenDays: RETENTION.installs + 1 });
      const neverSeen = await install(q, { days: RETENTION.installs + 1 });
      const voted = await install(q, { days: RETENTION.installs + 5, seenDays: RETENTION.installs + 1 });
      const active = await install(q, { days: RETENTION.installs + 5, seenDays: 1 });
      const young = await install(q, { days: 1 });
      await castVote(q, voted, 'kept_account', 1, { at: ago(10 * DAY) });
      await runScoreJob(q, capture(() => undefined));
      const left = new Set((await q.query<{ id: string }>('select id from installs')).rows.map((r) => r.id));
      expect([idle, neverSeen, voted, active, young].map((id) => left.has(id))).toEqual([false, false, true, true, true]);
    });

    it(`removes account rows with nothing on them, unchanged for ${RETENTION.accounts} days, with their profile`, async () => {
      const old = days(RETENTION.accounts + 1);
      await q.query(`insert into accounts (handle, status, seed, override, cleared_at, protected, updated_at) values
        ('empty_old', 'none', false, null, null, false, ${old}), ('empty_new', 'none', false, null, null, false, ${days(1)}),
        ('seeded', 'none', true, null, null, false, ${old}), ('decided', 'cleared', false, 'clear', now(), false, ${old}),
        ('guarded', 'none', false, null, null, true, ${old}), ('appealed', 'none', false, null, null, false, ${old}),
        ('voted', 'none', false, null, null, false, ${old}), ('checked', 'none', false, null, null, false, ${old})`);
      await q.query("insert into profiles (handle, name) values ('empty_old', 'Gone Soon')");
      await q.query("insert into appeals (id, handle, message, code, ip_hash) values ($1, 'appealed', 'This account is a real person.', 'xslop-AAAAAA', 'n1')", [randomUUID()]);
      await q.query("insert into votes (install_id, handle, value, updated_at) values ($1, 'voted', 0, now() - interval '1 day')", [await install(q)]);
      await q.query("insert into evidence (tweet_id, handle, ok, checked_at) values ('1', 'checked', true, now() - interval '1 day')");
      await runScoreJob(q, capture(() => undefined));
      expect((await q.query<{ handle: string }>('select handle from accounts order by handle')).rows.map((r) => r.handle)).toEqual(['appealed', 'checked', 'decided', 'empty_new', 'guarded', 'seeded', 'voted']);
      expect(await count('profiles')).toBe(0);
    });

    it('keeps the list and the heartbeat of a run when retention fails', async () => {
      await q.query("insert into accounts (handle, seed) values ('a', true)");
      const broken: Db = { ...q, session: (fn) => q.session((s) => {
        let call = 0;
        return fn({ ...s, tx: (write) => (++call === 2 ? Promise.reject(new Error('retention failed')) : s.tx(write)) });
      }) };
      await expect(runScoreJob(broken, fakeCompute({ a: [0.9, 2] }))).rejects.toThrow('retention failed');
      expect((await listed(q)).map((e) => e[0])).toEqual(['a']);
      expect((await q.query<{ ok: boolean }>("select last_ok_at is not null as ok from jobs where name = 'score'")).rows[0]!.ok).toBe(true);
      // One run, one job_runs row: it failed in its retention.
      expect((await runs(q)).map((r) => [r.ok, r.detail])).toEqual([[false, { error: 'retention failed' }]]);
      // Its events stay with the list: they were written in the transaction of the change.
      expect((await events(q, 'status')).map((e) => e.subject)).toEqual(['a']);
    });
  });

  describe('history (SPEC 14.1)', () => {
    it('writes a status event when status, tier, gate or want change, and none when only the score changes', async () => {
      await q.query("insert into accounts (handle, seed) values ('moving_one', true), ('steady_one', true)");
      await runScoreJob(q, fakeCompute({ moving_one: [0.5, 1], steady_one: [0, 0] }));
      expect(await events(q, 'status')).toEqual([{
        source: 'score',
        subject: 'moving_one',
        data: {
          from: { status: 'none', tier: 0, gate: null, want: null },
          to: { status: 'flagged', tier: 1, gate: null, want: null, reason: 'test', score: 50, networks: 0, anchors: 0, notSlop: 0, dissent: 0, evidence: 0 },
        },
      }]);
      // The score alone: the row is written, no event.
      await runScoreJob(q, fakeCompute({ moving_one: [0.75, 1] }));
      expect((await account(q, 'moving_one')).score).toBe(0.75);
      expect(await events(q, 'status')).toHaveLength(1);
      // want alone, then gate alone, then status and tier.
      await runScoreJob(q, withParts(fakeCompute({ moving_one: [0.75, 1] }), { moving_one: { want: 'confirmed' } }));
      await runScoreJob(q, withParts(fakeCompute({ moving_one: [0.75, 1] }), { moving_one: { want: 'confirmed', gate: 'evidence', anchors: 2, networks: 4 } }));
      await runScoreJob(q, withParts(fakeCompute({ moving_one: [0.5, 0, 'pending'] }), { moving_one: { want: 'confirmed', gate: 'evidence', anchors: 2, networks: 4 } }));
      const all = await events(q, 'status');
      expect(all.map((e) => [e.data.from, e.data.to])).toEqual([
        [{ status: 'none', tier: 0, gate: null, want: null }, expect.objectContaining({ status: 'flagged', tier: 1 })],
        [{ status: 'flagged', tier: 1, gate: null, want: null }, expect.objectContaining({ status: 'flagged', tier: 1, gate: null, want: 'confirmed', score: 75 })],
        [{ status: 'flagged', tier: 1, gate: null, want: 'confirmed' }, expect.objectContaining({ gate: 'evidence', want: 'confirmed', anchors: 2, networks: 4 })],
        [{ status: 'flagged', tier: 1, gate: 'evidence', want: 'confirmed' }, expect.objectContaining({ status: 'pending', tier: 0, gate: 'evidence', score: 50 })],
      ]);
    });

    it('writes the status events of a real engine run: brand-new networks make an account pending with gate standing', async () => {
      await q.query("insert into accounts (handle, x_user_id, identity) values ('crowd_target', '9001', 'ok')");
      for (let i = 0; i < 2; i++) await castVote(q, await install(q, { days: 0 }), 'crowd_target');
      await runScoreJob(q, real());
      expect(await events(q, 'status')).toEqual([{
        source: 'score',
        subject: 'crowd_target',
        data: {
          from: { status: 'none', tier: 0, gate: null, want: null },
          to: { status: 'pending', tier: 0, gate: 'standing', want: 'flagged', reason: expect.any(String), score: expect.any(Number), networks: 2, anchors: 0, notSlop: 0, dissent: 0, evidence: 0 },
        },
      }]);
      await runScoreJob(q, real());
      expect(await events(q, 'status')).toHaveLength(1);
    });

    it('writes a standing event when the stored standing flips, also through the ban rule, and none for a reputation change alone', async () => {
      const voter = await install(q, { net: 'v1', days: 8 });
      const dissenter = await install(q, { net: 'v2', days: 8 });
      const marked = ['marked_one', 'marked_two', 'marked_three'];
      for (const h of marked) await castVote(q, voter, h, 1, { at: ago(HOUR) });
      await castVote(q, dissenter, 'marked_one', 0, { at: ago(HOUR) });
      await runScoreJob(q, real());
      expect(await events(q, 'standing')).toEqual([]);

      for (const h of marked) await adminConfirm(q, h);
      await runScoreJob(q, real());
      // The voter gains standing; the dissenter loses reputation and keeps no standing: one event.
      expect(await installRow(q, dissenter)).toMatchObject({ standing: false, reputation: expect.closeTo(1 / 3, 6) });
      expect(await events(q, 'standing')).toEqual([{ source: 'score', subject: voter, data: { standing: true, reputation: expect.closeTo(0.8, 6), goodMarks: 3, banned: false } }]);
      await runScoreJob(q, real());
      expect(await events(q, 'standing')).toHaveLength(1);

      // A ban ends the standing through the ban rule of writeInstalls: the banned install is not loaded.
      await q.query('update installs set banned_at = now() where id = $1', [voter]);
      await runScoreJob(q, real());
      expect((await events(q, 'standing')).slice(1)).toEqual([{ source: 'score', subject: voter, data: { standing: false, reputation: expect.closeTo(0.8, 6), goodMarks: 3, banned: true } }]);
    });

    it('writes its events in the transaction of the change: a run that fails at its heartbeat leaves no event and no change', async () => {
      await q.query("insert into accounts (handle, seed) values ('a', true)");
      const trusted = await install(q, { trusted: true });
      await castVote(q, trusted, 'a');
      const failing: Db = {
        ...q,
        session: (fn) => q.session((s) => fn({ ...s, tx: (write) => s.tx((t) => write({ query: (text, params) => (text.startsWith('insert into jobs') ? Promise.reject(new Error('heartbeat failed')) : t.query(text, params)) })) })),
      };
      await expect(runScoreJob(failing, fakeCompute({ a: [0.9, 2] }))).rejects.toThrow('heartbeat failed');
      expect([(await account(q, 'a')).tier, (await installRow(q, trusted)).standing]).toEqual([0, false]);
      expect((await q.query('select 1 from events')).rows).toEqual([]);
      expect((await runs(q)).map((r) => [r.ok, r.detail])).toEqual([[false, { error: 'heartbeat failed' }]]);
      // The same run without the fault writes both events.
      await runScoreJob(q, fakeCompute({ a: [0.9, 2] }));
      expect([(await events(q, 'status')).length, (await events(q, 'standing')).length]).toEqual([1, 1]);
    });

    it('writes one job_runs row for a run with the heartbeat detail, and none for a skipped run', async () => {
      await q.query("insert into accounts (handle, seed) values ('a', true)");
      expect((await runScoreJob(lockHeld(q), fakeCompute({}))).skipped).toBe(true);
      expect(await runs(q)).toEqual([]);
      await runScoreJob(q, fakeCompute({ a: [0.9, 2] }));
      const [run] = await runs(q);
      expect(run).toMatchObject({ job: 'score', ok: true, ordered: true });
      expect(run!.detail).toEqual(await detail(q));
    });
  });

  it('keeps the first public time across a clear and a later confirm', async () => {
    const early = await install(q, { net: 'early', days: 30 });
    const during = await install(q, { net: 'during', days: 30 });
    const first = ago(8 * DAY);
    await q.query(
      `insert into accounts (handle, x_user_id, identity, listed_at, status, tier) values ('came_back', '77', 'ok', $1, 'flagged', 1)`,
      [first],
    );
    await runScoreJob(q, real());
    const stamped = (await q.query<{ t: Date; listed: Date | null }>('select first_public_at as t, listed_at as listed from accounts where handle = $1', ['came_back'])).rows[0]!;
    expect(stamped.t.getTime()).toBe(first.getTime());

    await adminClear(q, 'came_back', false);
    await runScoreJob(q, real());
    const kept = (await q.query<{ t: Date; listed: Date | null }>('select first_public_at as t, listed_at as listed from accounts where handle = $1', ['came_back'])).rows[0]!;
    expect(kept.listed).toBeNull();
    expect(kept.t.getTime()).toBe(first.getTime());

    await castVote(q, early, 'came_back', 1, { at: ago(10 * DAY) });
    await castVote(q, during, 'came_back', 1, { at: ago(5 * DAY) });
    await adminConfirm(q, 'came_back');
    await runScoreJob(q, real());
    expect(await installRow(q, early)).toMatchObject({ good_marks: 1 });
    expect(await installRow(q, during)).toMatchObject({ good_marks: 0, reputation: 0.5 });
    expect((await q.query<{ t: Date }>('select first_public_at as t from accounts where handle = $1', ['came_back'])).rows[0]!.t.getTime()).toBe(first.getTime());
  });

  it('keeps an earlier confirm when the current listing is later', async () => {
    const first = ago(8 * DAY);
    await q.query(
      `insert into accounts (handle, listed_at, status, tier) values ('again', now(), 'confirmed', 2)`,
    );
    await q.query(`insert into admin_log (at, session, action, target) values ($1, 's', 'confirm', 'again')`, [first]);
    await runScoreJob(q, real());
    expect((await q.query<{ t: Date }>('select first_public_at as t from accounts where handle = $1', ['again'])).rows[0]!.t.getTime()).toBe(first.getTime());
  });

  it('copies the earlier first public time when a listed handle moves', async () => {
    const early = ago(8 * DAY);
    const late = ago(DAY);
    await q.query(`insert into accounts (handle, first_public_at) values ('old_name', $1), ('new_name', $2)`, [early, late]);
    await q.query(`update accounts set identity = 'moved', moved_to = 'new_name' where handle = 'old_name'`);
    const dest = (await q.query<{ t: Date }>('select first_public_at as t from accounts where handle = $1', ['new_name'])).rows[0]!.t;
    expect(dest.getTime()).toBe(early.getTime());
    await q.query(`insert into accounts (handle, first_public_at) values ('from_name', $1), ('to_name', null)`, [early]);
    await q.query(`update accounts set identity = 'moved', moved_to = 'to_name' where handle = 'from_name'`);
    expect((await q.query<{ t: Date }>('select first_public_at as t from accounts where handle = $1', ['to_name'])).rows[0]!.t.getTime()).toBe(early.getTime());
  });

  it('a deleted standing vote still fills the 24 hour budget', async () => {
    const ring = await install(q, { net: 'budget-ring', trusted: true });
    const spentAt = ago(2 * HOUR);
    for (let i = 0; i < 5; i++) await castVote(q, ring, `oldb${i}`, 1, { at: spentAt });
    await runScoreJob(q, real());
    expect(await account(q, 'oldb0')).toMatchObject({ parts: { anchors: 1 } });
    expect((await q.query<{ n: number }>('select count(*)::int as n from votes where install_id = $1 and standing_at is not null', [ring])).rows[0]!.n).toBe(5);

    await q.query('delete from votes where install_id = $1', [ring]);
    expect((await q.query<{ n: number }>('select count(*)::int as n from votes where install_id = $1', [ring])).rows[0]!.n).toBe(0);
    const kept = (await q.query<{ n: number; at: Date }>('select count(*)::int as n, min(at) as at from standing_spent where ip_hash = $1', ['budget-ring'])).rows[0]!;
    expect(kept.n).toBe(5);
    expect(kept.at.getTime()).toBe(spentAt.getTime());

    for (let i = 0; i < 5; i++) await castVote(q, ring, `newb${i}`, 1, { at: ago(HOUR) });
    await runScoreJob(q, real());
    expect(await account(q, 'newb0')).toMatchObject({ parts: { anchors: 0 } });
    expect(await account(q, 'newb4')).toMatchObject({ parts: { anchors: 0 } });
  });

  it('a value change keeps the standing budget time', async () => {
    const ring = await install(q, { net: 'budget-flip', trusted: true });
    const spentAt = ago(3 * HOUR);
    for (let i = 0; i < 5; i++) await castVote(q, ring, `flip${i}`, 1, { at: spentAt });
    await runScoreJob(q, real());
    await q.query('update votes set value = 0, updated_at = now() where install_id = $1', [ring]);
    for (let i = 0; i < 5; i++) await castVote(q, ring, `after${i}`, 1, { at: ago(HOUR) });
    await runScoreJob(q, real());
    const row = (await q.query<{ standing_at: Date; updated_at: Date }>('select standing_at, updated_at from votes where install_id = $1 and handle = $2', [ring, 'flip0'])).rows[0]!;
    expect(row.standing_at.getTime()).toBe(spentAt.getTime());
    expect(row.updated_at.getTime()).toBeGreaterThan(row.standing_at.getTime() + HOUR);
    expect(await account(q, 'after0')).toMatchObject({ parts: { anchors: 0 } });
    expect(await account(q, 'after4')).toMatchObject({ parts: { anchors: 0 } });
  });

  it('a loaded slop vote past the budget gives no evidence', async () => {
    const flood = await install(q, { net: 'flood', trusted: true });
    const second = await install(q, { net: 'second', trusted: true });
    const plain = await install(q, { net: 'plain', days: 0 });
    await q.query(`insert into accounts (handle, x_user_id, identity) values ('ev_target', '4242', 'ok')`);
    for (let i = 0; i < NETWORK_DAILY_VOTES; i++) await castVote(q, flood, `junk${i}`, 1, { at: ago(2 * HOUR) });
    await castVote(q, flood, 'ev_target', 1, { tweetId: '3001', at: ago(HOUR) });
    await castVote(q, second, 'ev_target', 1, { at: ago(HOUR) });
    await castVote(q, plain, 'ev_target', 1, { at: ago(HOUR) });
    await q.query(`insert into evidence (tweet_id, handle, x_user_id, ok) values ('3001', 'ev_target', '4242', true)`);
    await runScoreJob(q, real());
    expect(await account(q, 'ev_target')).toMatchObject({ status: 'pending', tier: 0, parts: { gate: 'evidence', evidence: 0, anchors: 1 } });
  });

  it('an admin clear during the run takes the standing away before the write', async () => {
    const voter = await install(q, { net: 'pen', days: 30, standing: true, reputation: 0.8 });
    const plain = await install(q, { net: 'plain2', days: 0 });
    await q.query(`insert into accounts (handle, x_user_id, identity) values ('bait', '1', 'ok'), ('live_target', '2', 'ok')`);
    await castVote(q, voter, 'bait', 1, { at: ago(3 * HOUR) });
    await castVote(q, voter, 'live_target', 1, { tweetId: '901', at: ago(HOUR) });
    await castVote(q, plain, 'live_target', 1, { at: ago(HOUR) });
    await q.query(`insert into evidence (tweet_id, handle, x_user_id, ok) values ('901', 'live_target', '2', true)`);
    const clear = `with kept as (
      insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at, standing)
      select v.handle, v.install_id, i.ip_hash, v.value, v.updated_at, now(), true
      from votes v join installs i on i.id = v.install_id where v.handle = 'bait'
      on conflict (handle, install_id) do nothing returning 1)
      update accounts set override = 'clear', override_at = now(), status = 'cleared', tier = 0, score = 0,
        cleared_at = now(), listed_at = null, clear_penalty = true, updated_at = now() where handle = 'bait'`;
    await runScoreJob(adminDuringRun(q, clear), real());
    expect(await account(q, 'live_target')).toMatchObject({ status: 'pending', tier: 0, parts: { anchors: 0, gate: 'standing' } });
    expect((await installRow(q, voter)).standing).toBe(false);
    expect((await q.query<{ status: string; override: string; listed_at: Date | null }>(`select status, override, listed_at from accounts where handle = 'bait'`)).rows[0]).toEqual({
      status: 'cleared', override: 'clear', listed_at: null,
    });
  });

  it('runs end to end with the real scoring engine on the seed list', async () => {
    const { total } = await importSeed(q);
    const starter = (await q.query<{ handle: string }>('select handle from accounts order by handle limit 1')).rows[0]!.handle;
    const voter = await install(q);
    await castVote(q, voter, starter, 0);
    await castVote(q, voter, 'brand_new_one');

    const r = await runScoreJob(q, computeScores);
    expect(r).toMatchObject({ skipped: false, accounts: total + 1, listChanged: true, version: 1, listed: total });
    const counts = await q.query<{ status: string; tier: number; n: number }>('select status, tier, count(*)::int as n from accounts group by status, tier order by status');
    // Starter accounts are confirmed from day one; one vote alone moves nothing.
    expect(counts.rows).toEqual([
      { status: 'confirmed', tier: 2, n: total },
      { status: 'none', tier: 0, n: 1 },
    ]);
    const t = await makeApp(q);
    const list = (await t.app.inject({ url: '/api/v1/list' })).json() as { accounts: [string, number, number][]; ids: string[] };
    expect(list.accounts).toHaveLength(total);
    expect(list.accounts.every(([h, s, tier]) => /^[a-z0-9_]{1,15}$/.test(h) && s >= 0 && s <= 100 && tier === 2)).toBe(true);
    // Every starter account carries the X id of its seed file.
    expect(list.ids).toHaveLength(total);
    expect(list.ids.every((id) => /^[0-9]{1,20}$/.test(id))).toBe(true);
    expect((await account(q, 'brand_new_one')).parts).toMatchObject({ networks: 1, reason: 'none', want: null, gate: null });
    // Unchanged input: no new snapshot.
    expect((await runScoreJob(q, computeScores)).listChanged).toBe(false);
  }, 120_000);

  // SPEC 13.9 item 15, the job part: load and write times of a whole run with the real engine.
  it.skipIf(backend !== 'pglite')('runs a whole job with 50,000 votes, 20,000 accounts and 500,000 sightings', async () => {
    await q.query(`insert into installs (id, public_key, ip_hash, created_at, reputation)
      select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, '{}', 'net' || (i % 1500), now() - interval '30 days', 0.5 from generate_series(1, 5000) i`);
    await q.query(`insert into accounts (handle, x_user_id, identity) select 'acct' || i, (100000 + i)::text, 'ok' from generate_series(1, 20000) i`);
    await q.query(`insert into votes (install_id, handle, value, updated_at)
      select ('00000000-0000-4000-8000-' || lpad((1 + (i % 5000))::text, 12, '0'))::uuid, 'acct' || (1 + (i * 7919 + (i / 5000) * 2003) % 20000), (i % 9 <> 0)::int,
             now() - make_interval(hours => 1 + i % 700)
      from generate_series(1, 50000) i on conflict do nothing`);
    await q.query(`insert into sightings (tweet_id, handle, parent_tweet_id, reply_at, latency_sec, verified_at)
      select (1900000000000000000 + i)::text, 'acct' || (1 + i % 20000), (1800000000000000000 + i)::text, now() - make_interval(mins => i % 40000), i % 600, now()
      from generate_series(1, 500000) i`);
    const votes = (await q.query<{ n: number }>('select count(*)::int as n from votes')).rows[0]!.n;
    const cpu = process.cpuUsage();
    const r = await runScoreJob(q, computeScores);
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({ votes, accounts: r.accounts, loadMs: r.loadMs, computeMs: r.computeMs, writeMs: r.writeMs, totalMs: r.ms, cpuMs: Math.round((used.user + used.system) / 1000) }));
    expect(votes).toBeGreaterThan(49_000);
    expect(r).toMatchObject({ skipped: false, accounts: 20_000 });
  }, 600_000);
});
