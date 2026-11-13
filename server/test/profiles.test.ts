import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { EVIDENCE_PER_ACCOUNT, FIRST_CLASSES_REQUESTS, FOURTH_CLASS_SLOTS, MAX_PER_RUN, MISSES_FOR_GONE, PENDING_PER_RUN, PER_SPONSOR, PROFILES_LOCK, runProfilesJob, type ProfileJobDeps } from '../src/jobs/profiles.js';
import { runScoreJob } from '../src/jobs/score-job.js';
import { postTime } from '../src/lib/http.js';
import { MAX_AVATAR_BYTES, PACE_MS, TRIES_PER_PROFILE } from '../src/lib/xsource.js';
import { loadLatestEntries } from '../src/list.js';
import { computeScores } from '../src/scoring/index.js';
import { fromIp, makeApp, type TestApp } from './helpers/app.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0xff, 0x01, 0x80, 0x00]);
const FX = 'https://api.fxtwitter.com/';
const EMBED = 'https://cdn.syndication.twimg.com/tweet-result?id=';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('{"code":404,"message":"User not found"}', { status: 404 });

/** A post id that holds the time `ms` (SPEC 13.6: the time is in the id). */
let seq = 0n;
const postId = (ms: number) => String((BigInt(ms - 1288834974657) << 22n) + (seq++ % 4096n));
const HOUR = 3_600_000;

interface Post {
  author: string;
  handle: string;
  reply?: string | null;
}

/** A fake X: handles with their ids, posts with their authors, sources that can be down. Every request is recorded. */
class World {
  users = new Map<string, string>();
  posts = new Map<string, Post>();
  down = new Set<'embed' | 'fx'>();
  override: ((url: string) => Response | undefined) | null = null;
  calls: { url: string; init: RequestInit }[] = [];
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    this.calls.push({ url, init: init ?? {} });
    return this.override?.(url) ?? this.answer(url);
  }) as typeof globalThis.fetch;

  private answer(url: string): Response {
    if (url.startsWith('https://pbs.twimg.com/')) return new Response(new Uint8Array(JPEG), { status: 200 });
    if (url.startsWith(EMBED)) {
      if (this.down.has('embed')) return new Response('down', { status: 503 });
      const id = new URL(url).searchParams.get('id')!;
      const p = this.posts.get(id);
      return p ? json({ __typename: 'Tweet', id_str: id, in_reply_to_status_id_str: p.reply ?? null, user: { id_str: p.author, screen_name: p.handle } }) : new Response('<html>', { status: 404 });
    }
    if (url.startsWith(`${FX}status/`)) {
      if (this.down.has('fx')) return new Response('down', { status: 503 });
      const id = url.slice(`${FX}status/`.length);
      const p = this.posts.get(id);
      return p ? json({ code: 200, tweet: { id, replying_to_status: p.reply ?? null, author: { id: p.author, screen_name: p.handle } } }) : notFound();
    }
    if (url.startsWith(FX)) {
      if (this.down.has('fx')) return new Response('down', { status: 503 });
      const handle = url.slice(FX.length);
      const id = this.users.get(handle);
      return id
        ? json({ code: 200, message: 'OK', user: { id, screen_name: handle.toUpperCase(), name: `Name of ${handle}`, followers: 4242, avatar_url: `https://pbs.twimg.com/profile_images/1234/${handle}_normal.jpg` } })
        : notFound();
    }
    throw new Error(`unexpected fetch of ${url}`);
  }

  urls(prefix = ''): string[] {
    return this.calls.map((c) => c.url).filter((u) => u.startsWith(prefix));
  }
}

function fakeTime(): Pick<ProfileJobDeps, 'sleep' | 'now'> & { sleeps: number[] } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

interface AccountRow {
  handle: string;
  x_user_id: string | null;
  identity: string;
  identity_at: Date | null;
  moved_to: string | null;
  seed: boolean;
  seed_source: string | null;
  override: string | null;
  cleared_at: Date | null;
  protected: boolean;
  listed_at: Date | null;
}

describe.each(BACKENDS)('X facts job (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => {
    await tdb.reset();
    t = await makeApp(tdb.db);
  });

  const q = (sql: string, params: unknown[] = []) => tdb.db.query(sql, params);
  type Acct = { status?: string; tier?: number; score?: number; seed?: boolean; xId?: string | null; identity?: string; parts?: object | null; override?: string | null };
  const account = (handle: string, a: Acct = {}) =>
    q(
      `insert into accounts (handle, status, tier, score, seed, seed_source, x_user_id, identity, parts, override, override_at, listed_at)
       values ($1, $2, $3::smallint, $4, $5::boolean, case when $5::boolean then 'x_list:1' end, $6, $7, $8::jsonb, $9::text, case when $9::text is not null then now() end,
               case when $3::smallint >= 1 then now() - interval '3 days' end)`,
      [handle, a.status ?? (a.tier === 2 ? 'confirmed' : a.tier === 1 ? 'flagged' : 'none'), a.tier ?? 0, a.score ?? 0.5, a.seed ?? false, a.xId ?? null, a.identity ?? 'unknown', a.parts ? JSON.stringify(a.parts) : null, a.override ?? null],
    );
  const install = async (network: string, standing = false, age = '30 days') => {
    const id = randomUUID();
    await q(`insert into installs (id, public_key, ip_hash, standing, created_at) values ($1, '{}', $2, $3, now() - $4::interval)`, [id, network, standing, age]);
    return id;
  };
  const parts = async (handle: string) =>
    (await q(`select status, parts->>'want' as want, parts->>'gate' as gate, (parts->>'anchors')::int as anchors, (parts->>'evidence')::int as evidence
              from accounts where handle = $1`, [handle])).rows[0];
  const vote = (installId: string, handle: string, tweetId: string, value = 1, agoMin = 60) =>
    q(`insert into votes (install_id, handle, value, tweet_id, created_at, updated_at) values ($1, $2, $3, $4, now() - $5 * interval '1 minute', now() - $5 * interval '1 minute')`, [installId, handle, value, tweetId, agoMin]);
  const sighting = (tweetId: string, handle: string, parent: string | null, verified = false) =>
    q(`insert into sightings (tweet_id, handle, parent_tweet_id, reply_at, verified_at) values ($1, $2, $3, $4, case when $5 then now() end)`, [tweetId, handle, parent, postTime(tweetId), verified]);
  const row = async (handle: string) => (await tdb.db.query<AccountRow>('select * from accounts where handle = $1', [handle])).rows[0];
  const profile = async (handle: string) => (await tdb.db.query<{ x_id: string | null; gone: boolean; misses: number; avatar: Uint8Array | null; fetched_at: Date }>('select * from profiles where handle = $1', [handle])).rows[0];
  const run = (w: World, time = fakeTime()) => runProfilesJob(tdb.db, { fetch: w.fetch, sleep: time.sleep, now: time.now });
  const age = (sql: string) => q(sql);
  const listed = async () => {
    await runScoreJob(tdb.db, computeScores);
    return (await loadLatestEntries(tdb.db))?.entries ?? new Map();
  };

  it('checks listed and starter accounts only, stores the identity and the profile, and serves the avatar', async () => {
    await account('listed_slop', { tier: 2 });
    await account('starter_slop', { seed: true, xId: '777', tier: 2 });
    await account('not_listed', { tier: 0 });
    const w = new World();
    w.users.set('listed_slop', '111').set('starter_slop', '777');
    expect(await run(w)).toMatchObject({ skipped: false, picked: 2, ok: 2, avatars: 2, missing: 0, failed: 0, stopped: null, requests: 4 });
    expect(w.urls(FX).sort()).toEqual([`${FX}listed_slop`, `${FX}starter_slop`]);
    for (const c of w.calls) {
      expect(c.init.redirect).toBe('error');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(await row('listed_slop')).toMatchObject({ x_user_id: '111', identity: 'ok', moved_to: null });
    expect((await row('listed_slop'))!.identity_at).toBeInstanceOf(Date);
    expect(await row('starter_slop')).toMatchObject({ x_user_id: '777', identity: 'ok' });
    expect(await row('not_listed')).toMatchObject({ identity: 'unknown', identity_at: null });
    expect(await profile('not_listed')).toBeUndefined();
    expect((await tdb.db.query<{ detail: { ok: number } }>("select detail from jobs where name = 'profiles'")).rows[0]!.detail.ok).toBe(2);

    const r = await t.app.inject({ url: '/api/v1/avatars/listed_slop' });
    expect([r.statusCode, r.headers['content-type']]).toEqual([200, 'image/jpeg']);
    expect(r.rawPayload.equals(JPEG)).toBe(true);
    // Checked within 7 days: nothing is due.
    expect((await run(w)).picked).toBe(0);
  });

  it('marks an account gone only after 5 runs in a row a day apart, and keeps its data until then', async () => {
    await account('vanished', { tier: 2 });
    await account('neighbour', { tier: 2 });
    const w = new World();
    w.users.set('vanished', '501').set('neighbour', '502');
    await run(w);
    w.users.delete('vanished');
    for (let misses = 1; misses <= MISSES_FOR_GONE; misses++) {
      await age("update accounts set identity_at = identity_at - interval '8 days'");
      await age("update profiles set fetched_at = fetched_at - interval '25 hours'");
      expect(await run(w)).toMatchObject({ picked: 2, ok: 1, missing: 1 });
      expect(await profile('vanished')).toMatchObject({ misses, gone: misses === MISSES_FOR_GONE });
      expect((await row('vanished'))!.identity).toBe(misses === MISSES_FOR_GONE ? 'gone' : 'ok');
      // A second run on the same day asks nothing.
      expect((await run(w)).requests).toBe(0);
    }
    expect(w.urls(`${FX}vanished`)).toHaveLength(1 + MISSES_FOR_GONE * TRIES_PER_PROFILE);
    // The id stays, so the row of a new handle of the account can still claim the state.
    expect((await row('vanished'))!.x_user_id).toBe('501');
  });

  it('records no miss when fxtwitter answers 404 but X shows the account at its handle in a proven post', async () => {
    const S = '5101';
    await account('false_404', { tier: 2, seed: true, xId: S, identity: 'ok' });
    await account('neighbour', { tier: 2 });
    const proven = postId(Date.now() - HOUR);
    await sighting(proven, 'false_404', null, true);
    const w = new World();
    w.users.set('neighbour', '5102');
    w.posts.set(proven, { author: S, handle: 'False_404' });
    for (let i = 0; i < MISSES_FOR_GONE + 1; i++) {
      await age("update accounts set identity_at = null");
      await age("update profiles set fetched_at = fetched_at - interval '25 hours'");
      expect(await run(w)).toMatchObject({ ok: 1, missing: 0, failed: 1, renamed: 0 });
    }
    expect(await row('false_404')).toMatchObject({ identity: 'ok', seed: true });
    expect((await profile('false_404'))!.misses).toBe(0);
  });

  it('records no miss when nobody answered in the run, because an outage also answers 404', async () => {
    await account('outage_a', { tier: 2 });
    await account('outage_b', { tier: 2 });
    const w = new World();
    expect(await run(w)).toMatchObject({ picked: 2, ok: 0, missing: 2 });
    expect(await profile('outage_a')).toBeUndefined();
    expect(await row('outage_a')).toMatchObject({ identity: 'unknown', identity_at: null });
  });

  it('13.9 #13 and 13.10 item 10: moved is never listed, also for a starter account and an admin confirm; gone stays listed; the state stays on the row', async () => {
    await account('starter_moved', { seed: true, xId: '601', tier: 2, status: 'confirmed' });
    await account('admin_moved', { xId: '602', tier: 2, status: 'confirmed', override: 'confirm' });
    await account('starter_gone', { seed: true, xId: '603', tier: 2, status: 'confirmed' });
    await account('steady_one', { seed: true, xId: '604', tier: 2, status: 'confirmed' });
    expect([...(await listed()).keys()].sort()).toEqual(['admin_moved', 'starter_gone', 'starter_moved', 'steady_one']);

    const w = new World();
    // The two handles have new owners; no row holds their ids, so nothing moves to them. One answer is no proof yet.
    w.users.set('starter_moved', '9601').set('admin_moved', '9602').set('steady_one', '604');
    await run(w);
    expect((await row('starter_moved'))!.identity).toBe('unknown');
    // The check of the next day names the same other ids: moved. The fifth miss of starter_gone, in a run in which another
    // account answers (a run where nobody answers records no miss).
    await q("update profiles set misses = $1 - 1 where handle = 'starter_gone'", [MISSES_FOR_GONE]);
    await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
    await q("update accounts set identity_at = null");
    await run(w);
    expect(await row('starter_moved')).toMatchObject({ identity: 'moved', x_user_id: '601', seed: true, moved_to: null });
    expect(await row('admin_moved')).toMatchObject({ identity: 'moved', x_user_id: '602', override: 'confirm' });
    expect(await row('starter_gone')).toMatchObject({ identity: 'gone', seed: true });
    expect((await q("select count(*)::int as n from accounts where x_user_id in ('9601', '9602')")).rows[0]).toEqual({ n: 0 });

    const after = await listed();
    expect([...after.keys()]).toEqual(['starter_gone', 'steady_one']);
    expect(after.get('steady_one')![3]).toBe('604');
  });

  it('13.9 #13: a starter account that renames leaves the list at the next score run, and the new handle is listed with its state', async () => {
    const S = '7001';
    await account('old_starter', { seed: true, xId: S, tier: 2, status: 'confirmed' });
    const proven = postId(Date.now() - 2 * HOUR);
    await sighting(proven, 'old_starter', null, true);
    const both = await install('net_both');
    const once = await install('net_once');
    await vote(both, 'old_starter', postId(Date.now() - 3 * HOUR));
    await vote(once, 'old_starter', postId(Date.now() - 3 * HOUR));
    await account('new_starter');
    await vote(both, 'new_starter', postId(Date.now() - HOUR), 0);
    await q("insert into appeals (id, handle, message, code, ip_hash) values ($1, 'old_starter', 'not me', 'c0de', 'net_appeal')", [randomUUID()]);
    expect([...(await listed()).keys()]).toEqual(['old_starter']);

    // The handle is free now (404). X's own embed answer of a proven post names the new handle, and fxtwitter agrees.
    const w = new World();
    w.posts.set(proven, { author: S, handle: 'New_Starter' });
    w.users.set('new_starter', S);
    expect(await run(w)).toMatchObject({ renamed: 1 });
    expect(await row('new_starter')).toMatchObject({ seed: true, seed_source: 'x_list:1', x_user_id: S, identity: 'ok' });
    expect(await row('old_starter')).toMatchObject({ seed: false, seed_source: null, x_user_id: null, identity: 'moved', moved_to: 'new_starter' });
    // The vote of an install that voted on both handles stays as it was on the new handle.
    const votes = (await q('select install_id, handle, value from votes order by handle, value')).rows;
    expect(votes).toEqual(expect.arrayContaining([{ install_id: both, handle: 'new_starter', value: 0 }, { install_id: once, handle: 'new_starter', value: 1 }]));
    expect(votes).toHaveLength(2);
    expect((await q('select handle from sightings')).rows).toEqual([{ handle: 'new_starter' }]);
    expect((await q('select handle from appeals')).rows).toEqual([{ handle: 'new_starter' }]);

    const after = await listed();
    expect([...after.keys()]).toEqual(['new_starter']);
    expect(after.get('new_starter')![3]).toBe(S);
  });

  it('carries an admin decision with a rename, and B keeps its own decision when A has none', async () => {
    const w = new World();
    for (const [from, to, id, override] of [['cleared_from', 'cleared_to', '7101', 'clear'], ['plain_from', 'plain_to', '7102', null]] as const) {
      await account(from, { xId: id, tier: 2, override, seed: override === null });
      const p = postId(Date.now() - HOUR);
      await sighting(p, from, null, true);
      w.posts.set(p, { author: id, handle: to });
      w.users.set(to, id);
    }
    await account('plain_to', { override: 'clear' });
    await run(w);
    expect(await row('cleared_to')).toMatchObject({ override: 'clear', x_user_id: '7101' });
    expect(await row('plain_to')).toMatchObject({ override: 'clear', seed: true });
    expect(await row('cleared_from')).toMatchObject({ override: null, identity: 'moved' });
  });

  it('checks evidence posts: up to 3, one per network, standing first; ok for the author, not ok for another', async () => {
    const S = '8001';
    await account('evid_acct', { status: 'pending', xId: S, identity: 'ok', parts: { gate: 'evidence', want: 'confirmed', anchors: 2, networks: 4 } });
    await q("update accounts set identity_at = now() where handle = 'evid_acct'");
    const w = new World();
    const ids = Array.from({ length: 5 }, (_, i) => postId(Date.now() - (i + 1) * HOUR));
    const voters = [await install('net_1'), await install('net_2', true), await install('net_3'), await install('net_3'), await install('net_4')];
    for (const [i, v] of voters.entries()) await vote(v, 'evid_acct', ids[i]!, 1, 10 + i);
    w.posts.set(ids[0]!, { author: S, handle: 'evid_acct' });
    w.posts.set(ids[1]!, { author: '8999', handle: 'someone_else' });
    w.posts.set(ids[2]!, { author: S, handle: 'evid_acct' });
    w.posts.set(ids[3]!, { author: S, handle: 'evid_acct' });
    expect(await run(w)).toMatchObject({ picked: 1, evidence: 3, requests: 3 });
    // The standing install first, then the newest vote of each other network (net_3 once).
    expect(w.urls(EMBED).map((u) => new URL(u).searchParams.get('id'))).toEqual([ids[1], ids[0], ids[2]]);
    const rows = (await q('select tweet_id, handle, x_user_id, ok from evidence order by tweet_id')).rows;
    expect(rows).toEqual(
      expect.arrayContaining([
        { tweet_id: ids[0], handle: 'evid_acct', x_user_id: S, ok: true },
        { tweet_id: ids[1], handle: 'evid_acct', x_user_id: '8999', ok: false },
        { tweet_id: ids[2], handle: 'evid_acct', x_user_id: S, ok: true },
      ]),
    );
    // The next run reads only the post that has no row yet.
    w.calls = [];
    await run(w);
    expect(w.urls(EMBED).map((u) => new URL(u).searchParams.get('id'))).toEqual([ids[4]]);
  });

  it('one post, one request: 3 networks name one post, also a sighting of the account; X gets 1 request for it, and the score run counts evidence 3', async () => {
    const S = '8601';
    const parent = postId(Date.now() - 2 * HOUR);
    const shared = postId(Date.now() - HOUR);
    const w = new World();
    w.users.set('one_post_acct', S);
    await account('one_post_acct');
    w.posts.set(shared, { author: S, handle: 'one_post_acct', reply: parent });
    for (const n of ['net_same_1', 'net_same_2', 'net_same_3']) await vote(await install(n, false, '2 hours'), 'one_post_acct', shared, 1, 10);
    await sighting(shared, 'one_post_acct', parent);
    await runScoreJob(tdb.db, computeScores);
    expect(await parts('one_post_acct')).toMatchObject({ status: 'pending', gate: 'identity', evidence: 0 });

    // The profile, its avatar and the post: the evidence of three networks and the reply timing share one request.
    expect(await run(w)).toMatchObject({ picked: 1, requests: 3, evidence: 1, verified: 1 });
    expect(w.urls().filter((u) => u.includes(shared))).toHaveLength(1);
    expect((await q('select tweet_id, handle, x_user_id, ok from evidence')).rows).toEqual([{ tweet_id: shared, handle: 'one_post_acct', x_user_id: S, ok: true }]);
    await runScoreJob(tdb.db, computeScores);
    expect(await parts('one_post_acct')).toMatchObject({ status: 'pending', gate: 'standing', evidence: 3 });
  });

  it('verifies reply timing from the post ids, and deletes a sighting of another author, another parent or no post', async () => {
    const S = '9001';
    await account('timed_acct', { tier: 1, xId: S, identity: 'ok' });
    const now = Date.now();
    const parent = postId(now - 10 * 60_000);
    const good = postId(now - 9 * 60_000);
    const fallback = postId(now - 8 * 60_000);
    const noParent = postId(now - 7 * 60_000);
    const otherAuthor = postId(now - 6 * 60_000);
    const otherParent = postId(now - 5 * 60_000);
    const noPost = postId(now - 4 * 60_000);
    for (const [id, p] of [[good, parent], [fallback, parent], [noParent, null], [otherAuthor, parent], [otherParent, parent], [noPost, parent]] as const) await sighting(id, 'timed_acct', p);
    const w = new World();
    w.users.set('timed_acct', S);
    w.posts.set(good, { author: S, handle: 'timed_acct', reply: parent });
    w.posts.set(noParent, { author: S, handle: 'timed_acct', reply: null });
    w.posts.set(otherAuthor, { author: '9002', handle: 'another_acct', reply: parent });
    w.posts.set(otherParent, { author: S, handle: 'timed_acct', reply: postId(now - 30 * 60_000) });
    // Source one fails for this post and source two answers.
    w.posts.set(fallback, { author: S, handle: 'timed_acct', reply: parent });
    w.override = (url) => (url.startsWith(EMBED) && url.includes(`id=${fallback}&`) ? new Response('down', { status: 502 }) : undefined);

    expect(await run(w)).toMatchObject({ verified: 3, deleted: 3 });
    const rows = (await tdb.db.query<{ tweet_id: string; reply_at: Date; parent_at: Date | null; latency_sec: number | null; verified_at: Date | null }>('select tweet_id, reply_at, parent_at, latency_sec, verified_at from sightings order by tweet_id')).rows;
    expect(rows.map((r) => r.tweet_id).sort()).toEqual([good, fallback, noParent].sort());
    const byId = new Map(rows.map((r) => [r.tweet_id, r]));
    expect(byId.get(good)).toMatchObject({ reply_at: postTime(good), parent_at: postTime(parent), latency_sec: 60 });
    expect(byId.get(fallback)!.latency_sec).toBe(120);
    expect(byId.get(noParent)).toMatchObject({ parent_at: null, latency_sec: null });
    for (const r of rows) expect(r.verified_at).toBeInstanceOf(Date);
  });

  it('stops at a rate limit and stores what it found before it', async () => {
    await account('first_ok', { tier: 2 });
    await account('then_limit', { tier: 2 });
    const w = new World();
    w.users.set('first_ok', '1').set('then_limit', '2');
    w.override = (url) => (url === `${FX}then_limit` ? new Response('{}', { status: 429 }) : undefined);
    expect(await run(w)).toMatchObject({ stopped: 'rate_limited', ok: 1 });
    expect(await row('first_ok')).toMatchObject({ identity: 'ok', x_user_id: '1' });
    expect(await row('then_limit')).toMatchObject({ identity: 'unknown' });
    expect(await profile('then_limit')).toBeUndefined();
  });

  it('works in order: gates first by anchors, standing votes start a check, plain votes do not, at most 20 pending', async () => {
    await account('gate_low', { status: 'pending', parts: { gate: 'identity', anchors: 1 } });
    await account('gate_high', { status: 'pending', parts: { gate: 'identity', anchors: 3 } });
    await account('standing_vote');
    await account('plain_votes');
    const standing = await install('net_s', true);
    await vote(standing, 'standing_vote', postId(Date.now() - HOUR));
    // A voter without standing names 1,000 posts on 1,000 accounts: no request for any of them.
    const plain = await install('net_p');
    await q(`insert into accounts (handle) select 'flood_' || g from generate_series(1, 1000) g`);
    await q(`insert into votes (install_id, handle, value, tweet_id) select $1, 'flood_' || g, 1, $2 from generate_series(1, 1000) g`, [plain, postId(Date.now() - HOUR)]);
    await vote(plain, 'plain_votes', postId(Date.now() - HOUR));
    for (let i = 0; i < PENDING_PER_RUN + 5; i++) await account(`pend_${String(i).padStart(2, '0')}`, { status: 'pending', parts: { want: 'confirmed', gate: 'standing', networks: 100 - i } });
    await account('listed_late', { tier: 1 });

    const w = new World();
    const r = await run(w);
    const order = [...new Set(w.urls(FX).map((u) => u.slice(FX.length)))];
    expect(order.slice(0, 3)).toEqual(['gate_high', 'gate_low', 'standing_vote']);
    expect(order.filter((h) => h.startsWith('pend_'))).toHaveLength(PENDING_PER_RUN);
    expect(order.at(-1)).toBe('listed_late');
    expect(order.some((h) => h.startsWith('flood_') || h === 'plain_votes')).toBe(false);
    expect(r.picked).toBe(3 + PENDING_PER_RUN + 1);
  });

  it('five first-day installs: the account gets its identity check and its evidence posts in the next run', async () => {
    // Five networks of 15% trust each: below the trust floor of a confirm, so the engine wants a flag, and work order (3)
    // takes every pending account (SPEC 13.12). Before, only `want = confirmed` was taken and the admin reviewed unchecked facts.
    const S = '8501';
    const w = new World();
    w.users.set('first_day_mark', S);
    await account('first_day_mark');
    const posts = Array.from({ length: 5 }, (_, i) => postId(Date.now() - (i + 1) * HOUR));
    for (const [i, p] of posts.entries()) {
      await vote(await install(`net_day_${i}`, false, '2 hours'), 'first_day_mark', p, 1, 10 + i);
      w.posts.set(p, { author: S, handle: 'first_day_mark' });
    }
    await runScoreJob(tdb.db, computeScores);
    expect(await parts('first_day_mark')).toEqual({ status: 'pending', want: 'flagged', gate: 'identity', anchors: 0, evidence: 0 });

    expect(await run(w)).toMatchObject({ picked: 1, ok: 1, evidence: EVIDENCE_PER_ACCOUNT, requests: 2 + EVIDENCE_PER_ACCOUNT });
    expect(await row('first_day_mark')).toMatchObject({ identity: 'ok', x_user_id: S });
    expect(w.urls(EMBED).map((u) => new URL(u).searchParams.get('id'))).toEqual(posts.slice(0, EVIDENCE_PER_ACCOUNT));
    // The run after it reads the other posts; the identity check waits for its day.
    w.calls = [];
    expect(await run(w)).toMatchObject({ picked: 1, evidence: 2, requests: 2 });
    expect(w.urls(EMBED).map((u) => new URL(u).searchParams.get('id'))).toEqual(posts.slice(EVIDENCE_PER_ACCOUNT));
    expect((await listed()).has('first_day_mark')).toBe(false);
    expect(await parts('first_day_mark')).toEqual({ status: 'pending', want: 'flagged', gate: 'standing', anchors: 0, evidence: 5 });
  });

  describe('attacks', () => {
    it('13.10 item 7: one sponsor network gets at most 3 accounts of a class in a run, and the first account of each sponsor goes first', async () => {
      const ring = await install('net_ring');
      for (let i = 0; i < 6; i++) {
        await account(`ring_pend_${i}`, { status: 'pending', parts: { want: 'confirmed', gate: 'standing', networks: 100 - i } });
        await vote(ring, `ring_pend_${i}`, postId(Date.now() - HOUR));
      }
      for (const [i, h] of ['honest_pend_a', 'honest_pend_b'].entries()) {
        await account(h, { status: 'pending', parts: { want: 'confirmed', gate: 'standing', networks: 50 - i } });
        await vote(await install(`net_honest_${i}`), h, postId(Date.now() - HOUR));
      }
      // A later vote of another network does not make it the sponsor: the earliest slop vote does.
      await vote(await install('net_late'), 'ring_pend_5', postId(Date.now() - HOUR), 1, 1);
      const w = new World();
      const r = await run(w);
      const order = [...new Set(w.urls(FX).map((u) => u.slice(FX.length)))];
      expect(order).toEqual(['ring_pend_0', 'honest_pend_a', 'honest_pend_b', 'ring_pend_1', 'ring_pend_2']);
      expect(order.filter((h) => h.startsWith('ring_'))).toHaveLength(PER_SPONSOR);
      expect(r.picked).toBe(5);
    });

    it('a flood of pending work cannot starve the weekly check of listed accounts: classes (1) to (3) use at most 160 requests of a run', async () => {
      const w = new World();
      for (let i = 0; i < PENDING_PER_RUN; i++) {
        const h = `flood_pend_${String(i).padStart(2, '0')}`;
        const id = String(6000 + i);
        await account(h, { status: 'pending', xId: id, identity: 'ok', parts: { want: 'confirmed', gate: 'standing', networks: 90 } });
        // 15 sightings each, real posts of the account: 300 reads, more than one run can make.
        for (let k = 0; k < 15; k++) {
          const p = postId(Date.now() - (k + 1) * 60_000);
          await sighting(p, h, null);
          w.posts.set(p, { author: id, handle: h });
        }
      }
      await q("update accounts set identity_at = now()");
      await account('listed_weekly', { tier: 2 });
      w.users.set('listed_weekly', '6999');
      const r = await run(w);
      expect(await row('listed_weekly')).toMatchObject({ identity: 'ok', x_user_id: '6999' });
      expect(r.requests).toBeLessThanOrEqual(FIRST_CLASSES_REQUESTS + 15 + 2);
      expect(r.stopped).toBeNull();
    });

    it('20 checked pending accounts with more networks do not hold class (3): a new pending account is checked in the next run', async () => {
      for (let i = 0; i < PENDING_PER_RUN; i++) {
        const h = `checked_pend_${String(i).padStart(2, '0')}`;
        await account(h, { status: 'pending', xId: String(6100 + i), identity: 'ok', parts: { want: 'confirmed', gate: 'standing', networks: 90 } });
        // Its network has an ok post here, so the second post of that network asks nothing (EVIDENCE_POSTS).
        const [checked, extra] = [postId(Date.now() - 2 * HOUR), postId(Date.now() - HOUR)];
        await vote(await install(`net_checked_${i}`), h, checked);
        await vote(await install(`net_checked_${i}`), h, extra);
        await q('insert into evidence (tweet_id, handle, x_user_id, ok) values ($1, $2, $3, true)', [checked, h, String(6100 + i)]);
      }
      await q('update accounts set identity_at = now()');
      await account('new_pend', { status: 'pending', parts: { want: 'flagged', gate: 'identity', networks: 2 } });
      const w = new World();
      w.users.set('new_pend', '6199');
      expect(await run(w)).toMatchObject({ picked: 1, requests: 2 });
      expect(await row('new_pend')).toMatchObject({ identity: 'ok', x_user_id: '6199' });
    });

    it('a flood of class (2) accounts cannot take every account of a run: class (4) keeps 40 of the 120', async () => {
      // 130 never checked accounts, each with a slop vote of an install with standing on its own network (so the sponsor rule
      // does not stop them).
      await q(`insert into installs (id, public_key, ip_hash, standing, created_at)
               select gen_random_uuid(), '{}', 'net_c2_' || g, true, now() - interval '30 days' from generate_series(1, 130) g`);
      await q(`insert into accounts (handle) select 'class2_' || g from generate_series(1, 130) g`);
      await q(`insert into votes (install_id, handle, value, tweet_id) select i.id, 'class2_' || substr(i.ip_hash, 8), 1, $1 from installs i where i.ip_hash like 'net_c2_%'`, [postId(Date.now() - HOUR)]);
      await account('listed_slot', { tier: 2 });
      const w = new World();
      w.users.set('listed_slot', '6998');
      const r = await run(w);
      expect(await row('listed_slot')).toMatchObject({ identity: 'ok', x_user_id: '6998' });
      expect(r.picked).toBe(MAX_PER_RUN - FOURTH_CLASS_SLOTS + 1);
    });

    it('moved needs proof: one profile answer delists nothing, two answers a day apart with another id do, so does X at once', async () => {
      await account('liar_target', { seed: true, xId: '5501', tier: 2, identity: 'ok' });
      await account('proved_moved', { seed: true, xId: '5502', tier: 2, identity: 'ok' });
      const proven = postId(Date.now() - HOUR);
      await sighting(proven, 'proved_moved', null, true);
      const w = new World();
      // fxtwitter names other ids for both handles. X's embed answer shows the id of proved_moved at another handle.
      w.users.set('liar_target', '9501').set('proved_moved', '9502');
      w.posts.set(proven, { author: '5502', handle: 'its_new_handle' });
      await run(w);
      expect((await row('liar_target'))!.identity).toBe('ok');
      expect((await row('proved_moved'))!.identity).toBe('moved');
      expect([...(await listed()).keys()]).toEqual(['liar_target']);
      // The profile shown for the listed row stays the one of its own id, never the face of the other account.
      expect(await profile('liar_target')).toMatchObject({ x_id: '9501' });
      // A lying source that names a different id the next day proves nothing either.
      w.users.set('liar_target', '9601');
      await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
      await q('update accounts set identity_at = null');
      await run(w);
      expect((await row('liar_target'))!.identity).toBe('ok');
      // The same other id on two days: moved.
      await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
      await q('update accounts set identity_at = null');
      await run(w);
      expect((await row('liar_target'))!.identity).toBe('moved');
    });

    it('13.10 item 10: a gone account keeps its state, its profile and its avatar, stays listed and is checked each day', async () => {
      await account('lost_404_slop', { seed: true, xId: '5701', tier: 2, status: 'confirmed', identity: 'ok' });
      await account('neighbour', { tier: 2 });
      const w = new World();
      w.users.set('lost_404_slop', '5701').set('neighbour', '5702');
      await run(w);
      w.users.delete('lost_404_slop');
      for (let i = 0; i < MISSES_FOR_GONE; i++) {
        await q("update accounts set identity_at = identity_at - interval '8 days'");
        await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
        await run(w);
      }
      expect(await row('lost_404_slop')).toMatchObject({ identity: 'gone', seed: true, x_user_id: '5701' });
      const p = await profile('lost_404_slop');
      expect(p).toMatchObject({ gone: true, x_id: '5701' });
      expect(p!.avatar).not.toBeNull();
      expect([...(await listed()).keys()]).toContain('lost_404_slop');
      // Checked the next day, although its identity_at is new: it comes back whole.
      w.users.set('lost_404_slop', '5701');
      await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
      w.calls = [];
      await run(w);
      expect(w.urls(`${FX}lost_404_slop`)).toHaveLength(1);
      expect(await row('lost_404_slop')).toMatchObject({ identity: 'ok', seed: true });
      expect(await profile('lost_404_slop')).toMatchObject({ gone: false, misses: 0 });
    });

    it('free votes start no request through the gates: an account with gate identity and no anchor waits for class (3), after classes (1) and (2) (SPEC 13.12)', async () => {
      // Two networks without standing pass the crowd flag test; the engine then names gate identity (it comes before standing).
      await account('free_crowd_gate', { status: 'pending', parts: { want: 'flagged', gate: 'identity', anchors: 0, networks: 2 } });
      await account('anchored_gate', { status: 'pending', parts: { want: 'flagged', gate: 'identity', anchors: 1, networks: 2 } });
      for (const n of ['net_free_1', 'net_free_2']) await vote(await install(n), 'free_crowd_gate', postId(Date.now() - HOUR));
      await account('standing_voted');
      await vote(await install('net_standing', true), 'standing_voted', postId(Date.now() - HOUR));
      const w = new World();
      const r = await run(w);
      expect([...new Set(w.urls(FX))]).toEqual([`${FX}anchored_gate`, `${FX}standing_voted`, `${FX}free_crowd_gate`]);
      expect(r.picked).toBe(3);
    });

    it('round 2 R13: a row with an admin clear and no X id is checked at the next run, so the clear binds the account that the admin judged', async () => {
      // No vote: before the repair only a slop vote of an install with standing put such a row into the work order.
      await account('cleared_no_xid', { override: 'clear' });
      const w = new World();
      w.users.set('cleared_no_xid', '8101');
      await run(w);
      expect(await row('cleared_no_xid')).toMatchObject({ identity: 'ok', x_user_id: '8101', override: 'clear' });
    });

    it('a voter names a post of another author: no evidence there, and the author gets it without a request', async () => {
      const W = '4001';
      await account('victim_acct', { status: 'pending', xId: '4002', identity: 'ok', parts: { gate: 'evidence', anchors: 2 } });
      await account('author_acct', { status: 'pending', xId: W, identity: 'ok', parts: { gate: 'evidence', anchors: 2 } });
      await q("update accounts set identity_at = now()");
      const post = postId(Date.now() - HOUR);
      const w = new World();
      w.posts.set(post, { author: W, handle: 'author_acct' });
      await vote(await install('net_attacker'), 'victim_acct', post);
      await run(w);
      expect((await q('select handle, x_user_id, ok from evidence')).rows).toEqual([{ handle: 'victim_acct', x_user_id: W, ok: false }]);

      await vote(await install('net_honest'), 'author_acct', post);
      w.calls = [];
      await run(w);
      expect(w.calls).toHaveLength(0);
      expect((await q('select handle, x_user_id, ok from evidence')).rows).toEqual([{ handle: 'author_acct', x_user_id: W, ok: true }]);
    });

    it('a handle that changes owner between two requests moves nothing to the new owner', async () => {
      const S = '3001';
      await account('owned_twice', { seed: true, xId: S, tier: 2, identity: 'ok' });
      const proven = postId(Date.now() - HOUR);
      await sighting(proven, 'owned_twice', null, true);
      const w = new World();
      // X says the account is at the new handle now, but that handle already belongs to someone else when it is read.
      w.posts.set(proven, { author: S, handle: 'next_owner' });
      w.users.set('next_owner', '3999');
      expect(await run(w)).toMatchObject({ renamed: 0 });
      expect(await row('owned_twice')).toMatchObject({ seed: true, x_user_id: S, identity: 'ok' });
      expect(await row('next_owner')).toBeUndefined();
    });

    it('one lying source moves no state: fxtwitter alone cannot rename, the embed answer of X must agree', async () => {
      const S = '2001';
      await account('real_slop', { seed: true, xId: S, tier: 2, identity: 'ok' });
      await q("update accounts set identity_at = now() where handle = 'real_slop'");
      const proven = postId(Date.now() - HOUR);
      await sighting(proven, 'real_slop', null, true);
      // fxtwitter says that an innocent account has the id of the starter account; X's answer says the id is still at its handle.
      await account('innocent_acct', { tier: 0 });
      await vote(await install('net_standing', true), 'innocent_acct', postId(Date.now() - HOUR));
      const w = new World();
      w.users.set('innocent_acct', S);
      w.posts.set(proven, { author: S, handle: 'real_slop' });
      expect(await run(w)).toMatchObject({ renamed: 0 });
      expect(await row('innocent_acct')).toMatchObject({ seed: false });
      expect(await row('real_slop')).toMatchObject({ seed: true, x_user_id: S });
      // X's answer fails and fxtwitter also says that the post of the starter account is by the innocent handle: still no move.
      w.down.add('embed');
      w.posts.set(proven, { author: S, handle: 'innocent_acct' });
      await q("update accounts set identity_at = null where handle = 'innocent_acct'");
      await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
      expect(await run(w)).toMatchObject({ renamed: 0 });
      expect(w.urls(`${FX}status/`).length).toBeGreaterThan(0);
      expect(await row('innocent_acct')).toMatchObject({ seed: false });
      // With no proven post there is nothing to ask X: still no move.
      await q('delete from sightings');
      await q("update accounts set identity_at = null where handle = 'innocent_acct'");
      await q("update profiles set fetched_at = fetched_at - interval '25 hours'");
      expect(await run(w)).toMatchObject({ renamed: 0 });
      expect(await row('innocent_acct')).toMatchObject({ seed: false });
    });
  });

  it('paces requests at one per 2 s and checks at most 120 accounts per run; stops at its deadline', async () => {
    await q(`insert into accounts (handle, status, tier, score) select 'pace_' || g, 'confirmed', 2, 0.5 from generate_series(1, 125) g`);
    const w = new World();
    w.override = (url) => (url.startsWith(FX) ? json({ user: { id: '5', screen_name: url.slice(FX.length), avatar_url: null } }) : undefined);
    const time = fakeTime();
    const r = await run(w, time);
    expect(r).toMatchObject({ picked: MAX_PER_RUN, ok: MAX_PER_RUN, requests: MAX_PER_RUN });
    expect(time.sleeps).toEqual(Array(MAX_PER_RUN - 1).fill(PACE_MS));

    await q("update accounts set identity_at = null, x_user_id = null");
    await q("update profiles set fetched_at = fetched_at - interval '2 days'");
    const slow = fakeTime();
    const stopped = await runProfilesJob(tdb.db, {
      fetch: w.fetch,
      now: slow.now,
      sleep: async (ms) => {
        await slow.sleep(ms);
        await slow.sleep(5 * 60_000);
      },
    });
    expect(stopped.stopped).toBe('deadline');
    expect(stopped.ok).toBeLessThan(5);
  });

  it('commits a run at once, so the web view rebuilds once per run and not once per account', async () => {
    for (const h of ['one_a', 'one_b', 'one_c']) await account(h, { tier: 2 });
    const w = new World();
    for (const h of ['one_a', 'one_b', 'one_c']) w.users.set(h, '42');
    await run(w);
    expect((await tdb.db.query<{ rows: number; times: number }>('select count(*)::int as rows, count(distinct fetched_at)::int as times from profiles')).rows[0]).toEqual({ rows: 3, times: 1 });
  });

  it('keeps the stored avatar when a later one fails, and never fetches an avatar of another host', async () => {
    await account('stable_one', { tier: 2 });
    await account('evil_avatar', { tier: 2 });
    const w = new World();
    w.users.set('stable_one', '61').set('evil_avatar', '62');
    w.override = (url) => (url === `${FX}evil_avatar` ? json({ user: { id: '62', screen_name: 'evil_avatar', avatar_url: 'https://evil.test/profile_images/1/a_normal.jpg' } }) : undefined);
    await run(w);
    expect(w.calls.every((c) => !c.url.includes('evil.test'))).toBe(true);
    expect((await profile('evil_avatar'))!.avatar).toBeNull();
    await age("update accounts set identity_at = identity_at - interval '8 days'");
    await age("update profiles set fetched_at = fetched_at - interval '2 days'");
    w.override = (url) => (url.startsWith('https://pbs.twimg.com/') ? new Response(new Uint8Array(MAX_AVATAR_BYTES + 1)) : undefined);
    await run(w);
    expect(Buffer.from((await profile('stable_one'))!.avatar!).equals(JPEG)).toBe(true);
  });

  it.skipIf(backend !== 'postgres')('skips when another run holds the lock', async () => {
    const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! });
    await other.connect();
    try {
      // Another channel on the same database (another schema) holds its own lock: this run goes on.
      await other.query("select pg_advisory_lock($1::int, hashtext('xslop_other_channel'))", [PROFILES_LOCK]);
      expect((await run(new World())).skipped).toBe(false);
      await other.query('select pg_advisory_lock($1::int, hashtext(current_schema()))', [PROFILES_LOCK]);
      expect((await run(new World())).skipped).toBe(true);
      await other.query('select pg_advisory_unlock($1::int, hashtext(current_schema()))', [PROFILES_LOCK]);
      expect((await run(new World())).skipped).toBe(false);
    } finally {
      await other.end();
    }
  });

  describe('GET /api/v1/avatars/:handle', () => {
    const setup = async () => {
      await account('has_pic', { tier: 2 });
      await account('no_pic', { tier: 2 });
      await account('cleared_x', { tier: 0 });
      const w = new World();
      w.users.set('has_pic', '71').set('no_pic', '72');
      w.override = (url) => (url === `${FX}no_pic` ? json({ user: { id: '72', screen_name: 'no_pic', avatar_url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' } }) : undefined);
      await run(w);
    };

    it('answers 404 for an unknown handle, an account with no avatar and an unlisted account', async () => {
      await setup();
      await q("insert into profiles (handle, avatar, avatar_type) values ('cleared_x', $1, 'image/jpeg')", [JPEG]);
      for (const handle of ['nobody_here', 'no_pic', 'cleared_x']) {
        const r = await t.app.inject({ url: `/api/v1/avatars/${handle}` });
        expect([r.statusCode, r.json().error.code], handle).toEqual([404, 'not_found']);
      }
      expect((await t.app.inject({ url: '/api/v1/avatars/has_pic' })).statusCode).toBe(200);
    });

    it('serves repeat requests from memory, normalizes the handle and rejects bad input', async () => {
      await setup();
      let queries = 0;
      const counted: Db = {
        ...tdb.db,
        query: (text, params) => {
          queries++;
          return tdb.db.query(text, params);
        },
      };
      const t2 = await makeApp(counted);
      expect((await t2.app.inject({ url: '/api/v1/avatars/@HAS_pic' })).statusCode).toBe(200);
      const after = queries;
      for (let i = 0; i < 4; i++) expect((await t2.app.inject({ url: '/api/v1/avatars/has_pic' })).rawPayload.equals(JPEG)).toBe(true);
      expect(queries).toBe(after);
      for (const bad of ['/api/v1/avatars/a.b', `/api/v1/avatars/${'x'.repeat(33)}`, '/api/v1/avatars/has_pic?x=1']) {
        expect((await t.app.inject({ url: bad })).statusCode, bad).toBe(400);
      }
    });

    it('limits each network', async () => {
      await setup();
      const ip = fromIp('203.0.113.62');
      for (let i = 0; i < 1200; i++) expect((await t.app.inject({ url: '/api/v1/avatars/has_pic', headers: ip })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/api/v1/avatars/has_pic', headers: ip })).statusCode).toBe(429);
    }, 120_000);
  });
});

describe('X facts deployment', () => {
  it('holds an advisory lock key that no other file of the server uses', async () => {
    // A transaction lock on the key of this job waits for a whole run (up to 9 minutes).
    const root = new URL('../src/', import.meta.url);
    const files = new Map<string, Set<string>>();
    for (const f of await readdir(root, { recursive: true })) {
      if (!f.endsWith('.ts')) continue;
      for (const m of (await readFile(new URL(f, root), 'utf8')).matchAll(/\b0x7a51[0-9a-f]*\b/gi)) {
        const key = m[0].toLowerCase();
        files.set(key, (files.get(key) ?? new Set()).add(f));
      }
    }
    expect(files.get(`0x${PROFILES_LOCK.toString(16)}`)).toEqual(new Set(['jobs/profiles.ts']));
    expect([...files].filter(([, f]) => f.size > 1).map(([key, f]) => `${key}: ${[...f].join(', ')}`)).toEqual([]);
  });

  it('runs on its own timer every 2 minutes, outside the release path, in the sandbox', async () => {
    const root = new URL('../../deploy/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('project.json', root), 'utf8'));
    expect(manifest.runtime.timers).toContain('xslop-profiles');
    expect(manifest.release.migrate).not.toContain('profiles');
    const service = await readFile(new URL('units/xslop-profiles.service', root), 'utf8');
    expect(service).toContain('server/dist/jobs/profiles.js');
    for (const line of ['User={{USER}}', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'Type=oneshot', 'TimeoutStartSec=600', 'SystemCallFilter=~@privileged @resources', 'InaccessiblePaths=/etc/{{KEY}}', 'TasksMax=64']) {
      expect(service).toContain(line);
    }
    expect(service.split('\n').filter((l) => l === '{{ENV}}')).toHaveLength(1);
    const timer = await readFile(new URL('units/xslop-profiles.timer', root), 'utf8');
    expect(timer).toContain('Unit={{UNIT}}.service');
    expect(timer).toMatch(/^OnUnitActiveSec=2min$/m);
  });
});
