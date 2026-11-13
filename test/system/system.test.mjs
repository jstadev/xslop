// End to end: the judging flow of SPEC 13 on the built release. The real server, score job and X facts job, the
// manifest's migrate command, Postgres 15, the built extensions and the built site and admin console in Chromium.
// README.md explains what is real, what is a stand-in, and what this run cannot prove.

import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { appendFile, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { chromium } from '../../extension/node_modules/@playwright/test/index.mjs';
import {
  Bot, NetworkProxy, OLD_VOTE_TEXT, Postgres, ROOT, Server, buildRelease, freePort, hashPassword, hex, leadingZeroBits, pg, readJson, run, serverEnv,
  totpCode, totpSecret, until,
} from './harness.mjs';
import { CT0, Extension, XWorld, barOf, barText, buttonOf, cutOffInternet, toastOf, tweetOf } from './x-fixture.mjs';

/** The production default of XSLOP_POW_BITS, so every proof is as hard as a real one. */
const POW_BITS = 18;
/** Handles of the story. The server takes 1 to 15 characters, so these cannot follow the 16-character rule of the docs. */
const H = {
  first: 'sys_first_acct',
  renamed: 'sys_first_new',
  second: 'sys_second_ok',
  third: 'sys_third_ok',
  auto: 'sys_auto_conf',
  flag: 'sys_flag_only',
  crowd: 'sys_crowd_new',
  strike: 'sys_strike_two',
  other: 'sys_other_one',
  replay: 'sys_replay_me',
};
const MINUTE_MS = 60_000;

const work = join('/tmp/xslop-r-system', `run-${process.pid}`);
const release = join(work, 'release');
const salt = hex(32);
const adminUser = `ops_${hex(4)}`;
const adminPassword = hex(18);
const adminTotp = totpSecret();
const world = new XWorld();

let postgres;
let server;
let databaseUrl;
let env;
let pool;
let monitor;
let site;
let browser;
let bootOutput;
let serverPort;
let facts;
let admin;
let adminCode;
const adminErrors = [];
const networks = new Map();
/** The five users of step 2, on networks 1 to 5, and the sixth user on network 6. */
const users = [];
let sixth;
let seedIds;
/** Values that a later step reads. */
const seen = {};
const pauses = [];

const prefixOf = (n) => (n === 5 ? '2001:db8:5::/48' : `100.64.${n}.0/24`);
async function network(n, host = 10) {
  const key = `${n}.${host}`;
  if (!networks.has(key)) networks.set(key, await NetworkProxy.start(serverPort, n === 5 ? `2001:db8:5::${host}` : `100.64.${n}.${host}`));
  return networks.get(key);
}

const networkHash = (prefix) => createHmac('sha256', Buffer.from(salt, 'hex')).update(prefix).digest('hex').slice(0, 32);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const account = (handle) =>
  one('select status, tier, score, parts, listed_at, override, identity, x_user_id, moved_to, cleared_at, clear_penalty from accounts where handle = $1', [handle]);
const installIds = (list) => list.map((u) => u.installId);

async function api(path, init) {
  const res = await fetch(`${monitor.origin}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const score = async () => {
  const out = JSON.parse((await run(process.execPath, ['server/dist/jobs/score.js'], { cwd: release, env })).trim().split('\n').at(-1));
  assert.equal(out.skipped, false);
  return out;
};
const scoreDetail = async () => (await one("select detail from jobs where name = 'score'")).detail;

/** One run of the X facts job from the build. Its fetch goes to the stand-in over real HTTP; its pause is recorded, not waited. */
async function factsRun() {
  const r = await facts.runProfilesJob(facts.db, { fetch: world.fetch, sleep: async (ms) => void pauses.push(ms) });
  assert.deepEqual([r.skipped, r.stopped], [false, null]);
  return r;
}

/** Runs the X facts job, as its timer does every 2 minutes, until a run writes no new evidence row. */
async function factsUntilQuiet() {
  const runs = [];
  for (let i = 0; i < 6; i++) {
    const r = await factsRun();
    runs.push(r.evidence);
    if (r.evidence === 0) return runs;
  }
  return assert.fail(`the X facts job still writes evidence after 6 runs: ${runs.join(', ')}`);
}

/** The server re-checks the newest snapshot every 15 s. */
const listAt = (version) =>
  until(async () => {
    const { json } = await api('/api/v1/list');
    return json.version === version ? json : null;
  }, `the list route serves version ${version}`, 40_000, 500);

const rowOf = (list, handle) => {
  const i = list.accounts.findIndex((r) => r[0] === handle);
  return i < 0 ? null : { row: list.accounts[i], id: list.ids[i] };
};

const NOT_LISTED = (handle) => ({ handle, status: 'none', tier: 0, score: 0, seed: false, votes: { slop: 0, notSlop: 0 }, sightings: 0, signals: null, evidence: [], appealOpen: false });

/** No public answer shows the account: list and delta of `version`, lookup, sloppers search, avatar. */
async function assertNotPublic(handle, version) {
  assert.equal(rowOf(await listAt(version), handle), null, `${handle} is not in the list`);
  assert.equal((await api(`/api/v1/list/delta?since=${version}`)).status, 304, 'no delta since the last version');
  assert.deepEqual((await api(`/api/v1/accounts/${handle}`)).json, NOT_LISTED(handle), `the lookup of ${handle}`);
  const { json } = await api(`/api/v1/sloppers?q=${handle}`);
  assert.deepEqual(json.items.map((i) => i.handle).filter((h) => h === handle), [], `/sloppers shows no ${handle}`);
  assert.equal((await api(`/api/v1/avatars/${handle}`)).status, 404, `no avatar of ${handle}`);
}

const newSitePage = async (errors) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await cutOffInternet(ctx);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
};

async function launchUser(n) {
  const user = await Extension.launch(release, await network(n), work, world);
  user.installId = (await until(() => user.stored('identity'), `the extension on network ${n} has an identity`, 120_000)).installId;
  return user;
}

/** One click on the reply of `handle`: the post collapses and X gets the mute before X answers; then the signed vote is stored. */
async function mark(user, handle, postId, full = false) {
  const page = await user.openReply(handle, postId);
  await buttonOf(page, postId).waitFor();
  const letXAnswer = user.holdX();
  await buttonOf(page, postId).click();
  await tweetOf(page, postId).waitFor({ state: 'hidden', timeout: 5_000 });
  assert.match(await barText(page, postId), new RegExp(`Hidden reply from @${handle}`));
  await until(() => user.creates(`screen_name=${handle}`).length === 1, `the mute of ${handle} reaches X`);
  letXAnswer();
  if (full) {
    const bearer = (await readJson(join(release, 'server/config/extension-config.json'))).mute.webBearer;
    const [create] = user.creates(`screen_name=${handle}`);
    assert.deepEqual(
      [create.method, create.url, create.headers.authorization, create.headers['x-csrf-token'], create.headers['x-twitter-auth-type'], create.headers['content-type']],
      ['POST', 'https://x.com/i/api/1.1/mutes/users/create.json', `Bearer ${bearer}`, CT0, 'OAuth2Session', 'application/x-www-form-urlencoded'],
    );
    await until(async () => (await toastOf(page).innerText()).includes(`Muted @${handle}`), `the toast names ${handle}`);
  }
  const vote = await until(() => one('select value, tweet_id, parent_tweet_id from votes where install_id = $1 and handle = $2', [user.installId, handle]), `the vote of ${handle}`);
  assert.deepEqual(vote, { value: 1, tweet_id: postId, parent_tweet_id: '100' });
  await page.close();
}

/** Each user marks the account on a post of its own; `authors[i]` wrote the post of user i (default: the account). */
async function crowdMarks(group, handle, authors = []) {
  const posts = group.map((_, i) => world.post(world.idOf(authors[i] ?? handle)));
  for (const [i, user] of group.entries()) await mark(user, handle, posts[i]);
  return posts;
}

/** A decision in the console: the first click arms the button, the second sends it. */
async function decide(row, label, armed, said) {
  await row.getByRole('button', { name: label, exact: true }).click();
  await row.getByRole('button', { name: armed, exact: true }).click();
  await until(async () => (await admin.locator('#status').innerText()).includes(said), `the console says: ${said}`, 15_000);
}

/** The row of an account in the Pending queue of the console, after a reload of the queue. */
async function pendingRow(handle) {
  await admin.locator('body').press('2');
  await admin.locator('body').press('r');
  const row = admin.locator('#review-table tbody tr', { hasText: `@${handle}` });
  await row.waitFor({ timeout: 15_000 });
  return row;
}

describe('xslop system: judging v2', { timeout: 40 * MINUTE_MS }, () => {
  before(async () => {
    await mkdir(work, { recursive: true });
    await buildRelease(release);
    postgres = await Postgres.start();
    databaseUrl = await postgres.createDatabase('xslop_system');
    serverPort = await freePort();
    monitor = await NetworkProxy.start(serverPort, '100.64.250.10');
    site = await NetworkProxy.start(serverPort, '100.64.251.10');
    env = serverEnv({
      release, databaseUrl, port: serverPort, siteOrigin: site.origin, powBits: POW_BITS, adminUser, adminHash: await hashPassword(release, adminPassword), adminTotp, salt, secret: hex(32),
    });
    const manifest = await readJson(join(ROOT, 'deploy/project.json'));
    bootOutput = await run('sh', ['-c', manifest.release.migrate], { cwd: release, env });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    server = await Server.start(release, env, monitor.origin);
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    // Every seed file in name order, as the import reads them: the first file that names a handle or an X id gives the account.
    seedIds = new Map();
    const takenIds = new Set();
    for (const file of (await readdir(join(ROOT, 'seed'))).filter((f) => f.endsWith('.json')).sort()) {
      for (const a of (await readJson(join(ROOT, 'seed', file))).accounts) {
        const handle = a.handle.toLowerCase();
        if (seedIds.has(handle) || takenIds.has(a.id)) continue;
        seedIds.set(handle, a.id);
        takenIds.add(a.id);
      }
    }
    for (const [handle, id] of seedIds) world.ids.set(handle, id);
    world.avatars.add(H.first);
    await world.listen();
    const { runProfilesJob } = await import(pathToFileURL(join(release, 'server/dist/jobs/profiles.js')));
    const { createPgDb } = await import(pathToFileURL(join(release, 'server/dist/db.js')));
    facts = { runProfilesJob, db: createPgDb(databaseUrl, 2) };
  });

  after(async () => {
    for (const ext of [...users, sixth]) await ext?.close().catch(() => undefined);
    await admin?.context().close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await facts?.db.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    for (const proxy of [...networks.values(), monitor, site]) await proxy?.close().catch(() => undefined);
    await world.close().catch(() => undefined);
    await postgres?.stop();
    await rm(work, { recursive: true, force: true });
  });

  it('step 1 (13.7, 13.8 list ids, 13.11 seed import): migrations 001 to 005, the seed import and the first score run publish the starter accounts with their X ids', async () => {
    assert.match(bootOutput, /applied: 001_init\.sql, 002_hardening\.sql, 003_profiles\.sql, 004_judging_v2\.sql, 005_x_user_id_index\.sql/);
    const seeded = Number(/seed accounts: (\d+)/.exec(bootOutput)[1]);
    assert.equal(seeded, seedIds.size);
    const db = await one("select count(*)::int as n, count(*) filter (where status = 'confirmed' and tier = 2 and identity = 'unknown')::int as confirmed from accounts where seed");
    assert.deepEqual(db, { n: seeded, confirmed: seeded });
    const health = await api('/api/health');
    assert.deepEqual([health.status, health.json.ok], [200, true]);
    const list = await api('/api/v1/list');
    assert.equal(list.json.v, 1);
    assert.equal(list.headers.get('etag'), `"${list.json.version}"`);
    assert.equal(list.json.accounts.length, seeded);
    assert.equal(list.json.ids.length, seeded);
    const wrong = list.json.accounts.filter((r, i) => list.json.ids[i] !== seedIds.get(r[0]) || r[2] !== 2);
    assert.deepEqual(wrong, [], 'every starter row carries its own X id');
    seen.version = list.json.version;
    seen.stats = (await api('/api/v1/stats')).json;
    assert.deepEqual([seen.stats.confirmed, seen.stats.flagged], [seeded, 0]);
    assert.equal((await scoreDetail()).pending, 0);
  });

  it('step 2 (13.1, 13.3 rule 5, 13.8): five new users on five networks mark one account; each hides and mutes it at once; it waits as pending with gate identity and no public answer shows it', async () => {
    users.push(...(await Promise.all([1, 2, 3, 4, 5].map(launchUser))));
    for (const [i, user] of users.entries()) assert.equal((await one('select ip_hash from installs where id = $1', [user.installId])).ip_hash, networkHash(prefixOf(i + 1)));
    const [first] = users;
    const row = await one('select * from installs where id = $1', [first.installId]);
    assert.deepEqual(Object.keys(row.public_key).sort(), ['crv', 'kty', 'x', 'y']);
    const post = first.proxy.log.find((e) => e.url === '/api/v1/installs');
    assert.equal(post.status, 201);
    const { challenge, nonce, extVersion } = JSON.parse(post.body);
    assert.equal(row.ext_version, extVersion);
    assert.ok(leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= POW_BITS, 'the stored install solved a real proof');
    const again = await fetch(`${(await network(91)).origin}/api/v1/installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: post.body });
    assert.deepEqual([again.status, (await again.json()).error.code], [409, 'challenge_used']);

    seen.postsFirst = users.map(() => world.post(world.idOf(H.first)));
    for (const [i, user] of users.entries()) await mark(user, H.first, seen.postsFirst[i], i === 0);
    const sent = JSON.parse(first.proxy.log.findLast((e) => e.method === 'POST' && e.url === '/api/v1/votes').body);
    assert.deepEqual(Object.keys(sent).sort(), ['context', 'handle', 'parentTweetId', 'postedAt', 'tweetId', 'value'], 'the built extension sends no post text');
    const stored = await one('select count(*)::int as votes, count(distinct i.ip_hash)::int as networks from votes v join installs i on i.id = v.install_id where v.handle = $1', [H.first]);
    assert.deepEqual(stored, { votes: 5, networks: 5 });

    // 13.3: "A pending account has tier 0, is not in the list, is not on /sloppers, and every public answer shows it as none with score 0."
    // Rule 5 checks the gates in the order protected, identity, standing: the handle is not checked yet, so the gate is identity.
    const job = await score();
    assert.deepEqual([job.listChanged, job.version], [false, seen.version]);
    const a = await account(H.first);
    assert.deepEqual([a.status, a.tier, a.listed_at, a.parts.want, a.parts.gate, a.parts.networks, a.parts.anchors], ['pending', 0, null, 'flagged', 'identity', 5, 0]);
    await assertNotPublic(H.first, seen.version);
    const { last_ok_at: scoredAt } = await one("select last_ok_at from jobs where name = 'score'");
    const stats = await until(async () => {
      const { json } = await api('/api/v1/stats');
      return new Date(json.generatedAt) >= scoredAt ? json : null;
    }, 'the stats of a time after the score run (the route keeps them 60 s)', 70_000, 1_000);
    assert.deepEqual([stats.confirmed, stats.flagged], [seen.stats.confirmed, seen.stats.flagged], 'the stats count no pending account');

    sixth = await launchUser(6);
    await until(async () => (await sixth.stored('list'))?.version === seen.version, 'the sixth user stores the current list', 60_000);
    const page = await sixth.openReply(H.first, seen.postsFirst[0]);
    await buttonOf(page, seen.postsFirst[0]).waitFor();
    assert.equal(await tweetOf(page, seen.postsFirst[0]).isVisible(), true, 'the sixth user sees the post');
    assert.equal(await barOf(page, seen.postsFirst[0]).count(), 0);
    seen.sixthTab = page;
  });

  it('step 3 (13.6 identity and evidence, 13.7 publishList, 13.8 admin): the X facts job checks the account, the admin confirms it in the console with TOTP, and the list has it in the same minute', async () => {
    // A day passes (moved in SQL): the first-day weight of the five installs ends, the crowd test of a confirm passes, and
    // work order (3) of the X facts job takes the account.
    await pool.query("update installs set created_at = created_at - interval '25 hours' where id = any($1::uuid[])", [installIds(users)]);
    await score();
    let a = await account(H.first);
    assert.deepEqual([a.status, a.parts.want, a.parts.gate, a.identity], ['pending', 'confirmed', 'identity', 'unknown']);
    assert.deepEqual(await factsUntilQuiet(), [3, 2, 0]);
    const idFirst = world.idOf(H.first);
    a = await account(H.first);
    assert.deepEqual([a.identity, a.x_user_id], ['ok', idFirst]);
    const { rows: evidence } = await pool.query('select tweet_id, x_user_id, ok from evidence where handle = $1 order by tweet_id', [H.first]);
    assert.deepEqual(evidence, [...seen.postsFirst].sort().map((t) => ({ tweet_id: t, x_user_id: idFirst, ok: true })));
    assert.deepEqual([...new Set(world.requests.map((r) => r.host))].sort(), ['api.fxtwitter.com', 'cdn.syndication.twimg.com', 'pbs.twimg.com']);
    assert.ok(pauses.length > 0 && pauses.every((ms) => ms > 0 && ms <= 2_000), 'one request per 2 seconds at most');
    await score();
    a = await account(H.first);
    assert.deepEqual([a.status, a.parts.want, a.parts.gate, a.parts.anchors, a.parts.evidence], ['pending', 'confirmed', 'standing', 0, 5]);
    await assertNotPublic(H.first, seen.version);

    // 13.8: a wrong code answers like a wrong password.
    const login = (code) => fetch(`${site.origin}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site.origin }, body: JSON.stringify({ username: adminUser, password: adminPassword, code }) });
    const step = Math.floor(Date.now() / 30_000);
    const wrong = String((Number(totpCode(adminTotp, step)) + 1) % 1_000_000).padStart(6, '0');
    const refused = await login(wrong);
    assert.deepEqual([refused.status, (await refused.json()).error.code], [401, 'invalid_credentials']);

    admin = await newSitePage(adminErrors);
    await admin.goto(`${site.origin}/admin`);
    await admin.fill('#login-user', adminUser);
    await admin.fill('#login-pass', adminPassword);
    adminCode = totpCode(adminTotp, Math.floor(Date.now() / 30_000));
    await admin.fill('#login-code', adminCode);
    await admin.click('#login-submit');
    await admin.locator('#app-view').waitFor({ state: 'visible', timeout: 15_000 });
    const reused = await login(adminCode);
    assert.deepEqual([reused.status, (await reused.json()).error.code], [401, 'invalid_credentials'], 'one code works once');

    const row = await pendingRow(H.first);
    const cells = await row.locator('td').allInnerTexts();
    assert.equal(cells[3], 'Confirm');
    assert.equal(cells[4], 'Too few voters with standing.');
    assert.deepEqual([cells[5], cells[6]], ['5', '0']);
    const links = await row.locator('a[aria-label^="Checked post"]').evaluateAll((as) => as.map((x) => x.getAttribute('href')));
    assert.equal(links.length, 3);
    for (const href of links) assert.ok(seen.postsFirst.some((t) => href === `https://x.com/i/status/${t}`), `${href} is a checked post of the account`);
    await decide(row, 'Confirm', 'Yes, confirm', `@${H.first} is confirmed.`);
    const confirmedAt = Date.now();

    a = await account(H.first);
    assert.deepEqual([a.status, a.tier, a.score, a.override], ['confirmed', 2, 1, 'confirm']);
    const log = await one('select session, action, target, before from admin_log where action = $1 and target = $2', ['confirm', H.first]);
    assert.equal(log.before.account.status, 'pending');
    assert.match(log.session, /^[0-9a-f]{16}$/);
    // 13.7: "Every admin confirm and clear publishes the list in its own transaction." No score run happens here.
    const list = await until(async () => {
      const { json } = await api('/api/v1/list');
      return rowOf(json, H.first) ? json : null;
    }, 'the list answer has the confirmed account', MINUTE_MS, 500);
    assert.ok(Date.now() - confirmedAt < MINUTE_MS, 'in the same minute');
    assert.deepEqual(rowOf(list, H.first), { row: [H.first, 100, 2], id: idFirst });
    const delta = await api(`/api/v1/list/delta?since=${seen.version}`);
    assert.deepEqual([delta.json.add, delta.json.addIds, delta.json.remove], [[[H.first, 100, 2]], [idFirst], []]);
    seen.version = list.version;
    const lookup = (await api(`/api/v1/accounts/${H.first}`)).json;
    assert.deepEqual([lookup.status, lookup.tier, lookup.score, lookup.votes], ['confirmed', 2, 100, { slop: 5, notSlop: 0 }]);
    assert.equal(lookup.evidence.length, 3);
    await until(async () => (await fetch(`${monitor.origin}/api/v1/avatars/${H.first}`)).status === 200, 'the avatar of the listed account serves', 40_000, 1_000);

    // The sixth user's open tab hides the account after the real list sync.
    await sixth.fireListAlarm();
    await until(async () => (await sixth.stored('list')).version === seen.version, 'the sixth user applies the delta');
    await tweetOf(seen.sixthTab, seen.postsFirst[0]).waitFor({ state: 'hidden', timeout: 10_000 });
    assert.match(await barText(seen.sixthTab, seen.postsFirst[0]), /Hidden by xslop \(score 100\)/);

    await admin.locator('body').press('6');
    const entry = admin.locator('#log-table tbody tr', { hasText: H.first });
    await entry.waitFor({ timeout: 15_000 });
    assert.deepEqual((await entry.locator('td').allInnerTexts()).slice(1, 4), [log.session, 'confirm', H.first]);

    // 13.6, 13.8: mute sync mutes a list account by its X id.
    await sixth.muteSharedList();
    const create = await until(() => sixth.calls.find((c) => c.op === 'create'), 'the first paced mute reaches X', 30_000);
    assert.equal(create.body, `user_id=${idFirst}`);
    await until(async () => (await sixth.stored('mute')).muted.some(([h, r]) => h === H.first && r.id === idFirst), 'the mute record holds the X id');
  });

  it('step 4 (13.2 standing and good marks, 13.3 rules 4 and 5, 13.6 evidence): admin approvals give standing; four installs with standing confirm an account with two checked posts, and one checked post only flags', async () => {
    await crowdMarks(users, H.second);
    await crowdMarks(users, H.third);
    await score();
    for (const handle of [H.second, H.third]) {
      const a = await account(handle);
      assert.deepEqual([a.status, a.parts.anchors], ['pending', 0], handle);
      await decide(await pendingRow(handle), 'Confirm', 'Yes, confirm', `@${handle} is confirmed.`);
    }
    // A week passes (moved in SQL). The score job gives the good marks of the three admin confirms.
    await pool.query("update installs set created_at = created_at - interval '8 days' where id = any($1::uuid[])", [installIds(users)]);
    await score();
    const { rows } = await pool.query('select standing, good_marks, reputation from installs where id = any($1::uuid[])', [installIds(users)]);
    assert.deepEqual(rows, users.map(() => ({ standing: true, good_marks: 3, reputation: 0.8 })));

    seen.postsAuto = await crowdMarks(users.slice(0, 4), H.auto, [H.auto, H.auto, H.other, H.other]);
    seen.postsFlag = await crowdMarks(users.slice(0, 4), H.flag, [H.flag, H.other, H.other, H.other]);
    await score();
    for (const handle of [H.auto, H.flag]) {
      const a = await account(handle);
      assert.deepEqual([a.status, a.parts.want, a.parts.gate, a.parts.anchors, a.parts.networks], ['pending', 'confirmed', 'identity', 4, 4], handle);
    }
    await factsUntilQuiet();
    const oks = async (handle) => (await pool.query('select tweet_id from evidence where handle = $1 and ok order by tweet_id', [handle])).rows.map((r) => r.tweet_id);
    assert.deepEqual(await oks(H.auto), seen.postsAuto.slice(0, 2).sort());
    assert.deepEqual(await oks(H.flag), seen.postsFlag.slice(0, 1));
    const job = await score();
    const auto = await account(H.auto);
    assert.deepEqual([auto.status, auto.tier, auto.override, auto.parts.reason, auto.parts.anchors, auto.parts.evidence, auto.parts.gate], ['confirmed', 2, null, 'votes_confirmed', 4, 2, null]);
    const flag = await account(H.flag);
    assert.deepEqual([flag.status, flag.tier, flag.parts.reason, flag.parts.want, flag.parts.gate, flag.parts.evidence], ['flagged', 1, 'votes_flagged', 'confirmed', 'evidence', 1]);
    const list = await listAt(job.version);
    assert.deepEqual(rowOf(list, H.auto), { row: [H.auto, Math.round(auto.score * 100), 2], id: world.idOf(H.auto) });
    assert.deepEqual(rowOf(list, H.flag), { row: [H.flag, Math.round(flag.score * 100), 1], id: world.idOf(H.flag) });
    seen.version = job.version;
  });

  it('step 5 (13.1, 13.2 voice and budget, 13.8 limits): attacks through the signed protocol change nothing public', async () => {
    // 30 new installs on 30 networks mark one account.
    const bots = [];
    for (let n = 100; n < 130; n++) {
      const bot = new Bot(await network(n));
      assert.equal(await bot.install(), 201);
      bots.push(bot);
    }
    for (const bot of bots) assert.equal((await bot.vote(H.crowd, 'slop', world.post(world.idOf(H.crowd)))).status, 200);
    let job = await score();
    assert.equal(job.listChanged, false);
    const crowd = await account(H.crowd);
    assert.deepEqual([crowd.status, crowd.parts.want, crowd.parts.gate, crowd.parts.networks, crowd.parts.anchors], ['pending', 'confirmed', 'identity', 30, 0]);
    await assertNotPublic(H.crowd, seen.version);

    // The same 30 installs say "not slop" on a starter account.
    const starter = [...seedIds.keys()].sort()[0];
    const before = await account(starter);
    for (const bot of bots) assert.equal((await bot.vote(starter, 'not_slop', world.post(world.idOf(starter)))).status, 200);
    job = await score();
    assert.equal(job.listChanged, false);
    const after = await account(starter);
    assert.deepEqual([after.status, after.tier, after.score, after.parts.reason, after.parts.notSlop, after.parts.dissent, after.parts.disputed], ['confirmed', 2, before.score, 'seed', 0, 30, false]);

    // Two installs without standing on the address of user 1 vote against the voice of user 1.
    for (let k = 0; k < 2; k++) {
      const bot = new Bot(await network(1, 77 + k));
      assert.equal(await bot.install(), 201);
      assert.equal((await one('select ip_hash from installs where id = $1', [bot.id])).ip_hash, networkHash(prefixOf(1)));
      assert.equal((await bot.vote(H.flag, 'not_slop', seen.postsFlag[0])).status, 200);
    }
    job = await score();
    assert.equal(job.listChanged, false);
    const flag = await account(H.flag);
    assert.deepEqual([flag.status, flag.parts.networks, flag.parts.anchors, flag.parts.notSlop, flag.parts.dissent], ['flagged', 4, 4, 0, 0], 'the voice of user 1 stands');

    // One network sends 60 votes in a day: 50 count. Its sixth install in an hour is refused.
    const flood = await network(60);
    const floodBots = [];
    for (let k = 0; k < 5; k++) {
      const bot = new Bot(flood);
      assert.equal(await bot.install(), 201);
      floodBots.push(bot);
    }
    assert.equal(await new Bot(flood).install(), 429, 'the sixth install of a network in an hour is refused');
    const handles = Array.from({ length: 60 }, (_, i) => `sys_bud_${String(i).padStart(2, '0')}`);
    for (const [i, handle] of handles.entries()) assert.equal((await floodBots[i % 5].vote(handle, 'slop', world.post(world.idOf(handle)))).status, 200);
    const held = (await scoreDetail()).votesHeld;
    job = await score();
    assert.equal(job.listChanged, false);
    assert.equal((await scoreDetail()).votesHeld - held, 10);
    const counted = await one("select count(*) filter (where (parts->>'networks')::int = 1)::int as counted, count(*) filter (where parts is null)::int as waiting from accounts where handle like 'sys\\_bud\\_%'");
    assert.deepEqual(counted, { counted: 50, waiting: 10 });
  });

  it('13.6 and 13.12 work order: votes of installs without standing alone start no request, except through (3), which checks every pending account', async () => {
    // One first-day install: no crowd test passes, the account is not pending, and no class of the work order takes it.
    const lone = 'sys_one_new';
    const lonePost = world.post(world.idOf(lone));
    const loner = new Bot(await network(142));
    assert.equal(await loner.install(), 201);
    assert.equal((await loner.vote(lone, 'slop', lonePost)).status, 200);
    // Two first-day installs on two networks: pending, so work order (3) checks the handle and the posts in the next run.
    const handle = 'sys_two_new';
    const posts = [];
    for (const n of [140, 141]) {
      const bot = new Bot(await network(n));
      assert.equal(await bot.install(), 201);
      posts.push(world.post(world.idOf(handle)));
      assert.equal((await bot.vote(handle, 'slop', posts.at(-1))).status, 200);
    }
    await score();
    assert.equal((await account(lone)).status, 'none');
    let a = await account(handle);
    assert.deepEqual([a.status, a.parts.want, a.parts.gate, a.parts.anchors], ['pending', 'flagged', 'identity', 0]);
    const start = world.requests.length;
    await factsRun();
    const asked = world.requests.slice(start).filter((r) => r.path.includes(lone) || r.path.includes(lonePost));
    assert.deepEqual(asked, [], 'requests of the X facts job about an account that one first-day install marked');
    a = await account(handle);
    assert.deepEqual([a.identity, a.x_user_id], ['ok', world.idOf(handle)]);
    const { rows } = await pool.query('select tweet_id from evidence where handle = $1 and ok order by tweet_id', [handle]);
    assert.deepEqual(rows.map((r) => r.tweet_id), [...posts].sort());
    await score();
    a = await account(handle);
    assert.deepEqual([a.status, a.parts.gate, a.parts.evidence], ['pending', 'standing', 2]);
  });

  it('step 6 (13.6 renames, 13.8 list ids, 13.11 extension 1.2.0): a listed account renames; the state follows its X id to the new handle and mute sync keeps the mute by id', async () => {
    const idFirst = world.idOf(H.first);
    // X now answers: the old handle belongs to a new account, and the X id of the listed account has the new handle.
    world.ids.set(H.first, String(world.nextId++));
    world.ids.set(H.renamed, idFirst);
    // Seven days pass for the check of the account (moved in SQL).
    await pool.query("update accounts set identity_at = now() - interval '8 days' where handle = $1", [H.first]);
    await pool.query("update profiles set fetched_at = now() - interval '2 days' where handle = $1", [H.first]);
    // The timer runs the job every 2 minutes; a run takes the listed accounts that were never checked first.
    let runs = 0;
    for (let r = { renamed: 0 }; r.renamed === 0 && runs < 10; runs++) r = await factsRun();
    assert.ok(runs < 10, 'a run of the X facts job finds the rename');
    const old = await account(H.first);
    assert.deepEqual([old.identity, old.moved_to, old.x_user_id, old.override], ['moved', H.renamed, null, null]);
    const moved = await account(H.renamed);
    assert.deepEqual([moved.identity, moved.x_user_id, moved.override], ['ok', idFirst, 'confirm']);
    const votes = await one('select count(*) filter (where handle = $1)::int as old, count(*) filter (where handle = $2)::int as new from votes', [H.first, H.renamed]);
    assert.deepEqual(votes, { old: 0, new: 5 });

    const from = seen.version;
    const job = await score();
    assert.equal(job.listChanged, true);
    const list = await listAt(job.version);
    assert.equal(rowOf(list, H.first), null, 'the old handle leaves the list');
    assert.deepEqual(rowOf(list, H.renamed), { row: [H.renamed, 100, 2], id: idFirst });
    const delta = (await api(`/api/v1/list/delta?since=${from}`)).json;
    assert.deepEqual([delta.remove, delta.add, delta.addIds], [[H.first], [[H.renamed, 100, 2]], [idFirst]]);
    assert.deepEqual((await api(`/api/v1/accounts/${H.first}`)).json, NOT_LISTED(H.first), 'the next owner of the handle is not shown');
    seen.version = job.version;

    await sixth.fireListAlarm();
    await until(async () => (await sixth.stored('list')).version === seen.version, 'the sixth user applies the rename');
    await until(async () => {
      const { muted } = await sixth.stored('mute');
      return muted.some(([h, m]) => h === H.renamed && m.id === idFirst) && !muted.some(([h]) => h === H.first);
    }, 'the mute record moves to the new handle');
    assert.deepEqual(sixth.calls.filter((c) => c.op === 'destroy' && c.body === `user_id=${idFirst}`), [], 'no unmute');
    assert.deepEqual([sixth.creates(`user_id=${idFirst}`).length, sixth.creates(`screen_name=${H.renamed}`).length], [1, 0], 'no second mute of the same X id');
  });

  it('step 7 (13.5 strikes, 13.7, 13.8 appeals, 13.10 item 3): an appeal from /check with proof of work, an accept with penalty in the console, then strikes and a silence', async () => {
    const errors = [];
    const page = await newSitePage(errors);
    await page.goto(`${site.origin}/sloppers?q=${H.auto}`);
    const entry = page.locator(`#sl-list li[data-handle="${H.auto}"]`);
    await entry.locator('button.sl-show').click({ timeout: 40_000 });
    const link = entry.locator('a.sl-card-appeal');
    await link.waitFor({ timeout: 10_000 });
    await link.click();
    await page.waitForURL(`**/check?appeal=${H.auto}`);
    await page.locator('#appeal-form').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#appeal-message', 'This is my account and a person writes these replies by hand.');
    await page.fill('#appeal-email', 'owner@example.com');
    await page.click('#appeal-submit');
    const code = await page.locator('#appeal-done .appeal-code').innerText({ timeout: 90_000 });
    assert.match(code, /^xslop-[A-Z2-9]{6}$/);
    const appeal = await one("select id, status, email, ip_hash from appeals where handle = $1 and status = 'open'", [H.auto]);
    assert.deepEqual([appeal.email, appeal.ip_hash], ['owner@example.com', networkHash('100.64.251.0/24')]);
    assert.deepEqual(errors, []);
    await page.context().close();

    await admin.locator('body').press('3');
    await admin.locator('body').press('r');
    const row = admin.locator('#appeals-table tbody tr', { hasText: H.auto });
    await row.waitFor({ timeout: 15_000 });
    const text = await row.innerText();
    assert.match(text, new RegExp(code));
    assert.match(text, /4 networks marked it\. An accept with penalty strikes 4\./);
    await decide(row, 'Accept with penalty', 'Yes, accept with penalty', `Appeal for @${H.auto} accepted with a penalty. The account is cleared.`);
    const clearedAt = Date.now();
    const list = await until(async () => {
      const { json } = await api('/api/v1/list');
      return json.version > seen.version && !rowOf(json, H.auto) ? json : null;
    }, 'the list answer drops the account', MINUTE_MS, 500);
    assert.ok(Date.now() - clearedAt < MINUTE_MS, 'in the same minute');
    seen.version = list.version;
    const cleared = await account(H.auto);
    assert.deepEqual([cleared.status, cleared.tier, cleared.override, cleared.clear_penalty, cleared.listed_at], ['cleared', 0, 'clear', true, null]);
    const { rows: kept } = await pool.query('select install_id, ip_hash, value, standing from cleared_votes where handle = $1 order by ip_hash', [H.auto]);
    const voters = users.slice(0, 4);
    assert.deepEqual(kept, voters.map((u, i) => ({ install_id: u.installId, ip_hash: networkHash(prefixOf(i + 1)), value: 1, standing: true })).sort((x, y) => (x.ip_hash < y.ip_hash ? -1 : 1)));

    const [session] = (await admin.context().cookies()).filter((c) => c.name === '__Host-xs_admin');
    assert.deepEqual([session.httpOnly, session.secure, session.sameSite, session.path], [true, true, 'Strict', '/']);
    const cookie = `__Host-xs_admin=${session.value}`;
    const write = (extra) => fetch(`${site.origin}/api/admin/accounts/${H.auto}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site.origin, cookie, ...extra }, body: JSON.stringify({ action: 'confirm' }) });
    assert.equal((await write({})).status, 403, 'a write without x-csrf is refused');
    assert.equal((await write({ 'x-csrf': 'wrong', origin: 'https://evil.example' })).status, 403, 'a foreign origin is refused');
    assert.equal((await fetch(`${monitor.origin}/api/admin/review?queue=pending`)).status, 401, 'no session, no data');

    // A wrong vote with standing takes the standing away (13.10 item 3). Stored standing is read by the next run.
    await score();
    await score();
    const { rows: after } = await pool.query('select standing, reputation from installs where id = any($1::uuid[]) order by id', [installIds(voters)]);
    assert.deepEqual(after, voters.map(() => ({ standing: false, reputation: 0.6666667 })));
    assert.equal((await scoreDetail()).struckNetworks, 0, 'one strike silences nobody');
    const flag = await account(H.flag);
    assert.deepEqual([flag.status, flag.parts.gate, flag.parts.networks, flag.parts.anchors], ['pending', 'standing', 4, 0], 'the flag waits for a person');

    // A second clear with penalty of an account that the same networks marked silences them (13.5).
    await crowdMarks(voters, H.strike);
    await score();
    const strike = await account(H.strike);
    assert.deepEqual([strike.status, strike.parts.gate, strike.parts.networks], ['pending', 'identity', 4]);
    await decide(await pendingRow(H.strike), 'Clear with penalty', 'Yes, clear with penalty', `@${H.strike} is cleared with a penalty for its slop voters.`);
    await score();
    assert.equal((await scoreDetail()).struckNetworks, 4);
    const silenced = await account(H.flag);
    assert.deepEqual([silenced.status, silenced.tier, silenced.parts.networks], ['none', 0, 0], 'the votes of the struck networks count for nothing');
    assert.deepEqual(adminErrors, []);
  });

  it('step 8 (12.12, 13.2 criteria): the public pages render from the build with the real content security policy and no console error; /rules shows the criteria of the server', async () => {
    const { json: criteria } = await api('/api/v1/criteria');
    const texts = [...criteria.tiers.flatMap((t) => [t.summary, ...t.rules]), ...criteria.weights, ...criteria.protections, criteria.appeal];
    const longest = texts.reduce((a, b) => (b.length > a.length ? b : a));
    // /rules is last: its check of the server criteria must not hide the result of the other pages.
    for (const path of ['/', '/sloppers', '/check', '/how-it-works', '/rules']) {
      const errors = [];
      const page = await newSitePage(errors);
      const res = await page.goto(`${site.origin}${path}`);
      assert.equal(res.status(), 200, path);
      assert.match(res.headers()['content-security-policy'], /default-src 'self'/, path);
      if (path === '/rules') {
        const body = page.locator('#criteria-body');
        const shown = await until(async () => {
          const text = (await body.innerText()).replace(/\s+/g, ' ');
          return text.includes(criteria.appeal.replace(/\s+/g, ' ')) ? text : null;
        }, `the criteria of the server render in /rules (longest sentence: ${longest.length} characters, "${longest.slice(0, 60)}...")`, 20_000).catch(async (err) => assert.fail(`${err.message}; the page shows: ${(await body.innerText()).slice(0, 300)}`));
        assert.deepEqual(texts.filter((t) => !shown.includes(t.replace(/\s+/g, ' '))), [], 'every sentence of the server criteria');
      }
      if (path === '/sloppers') {
        await page.fill('#sl-q', H.renamed);
        await page.locator(`#sl-list li[data-handle="${H.renamed}"]`).waitFor({ timeout: 40_000 });
      }
      await page.waitForLoadState('networkidle');
      assert.deepEqual(errors, [], path);
      await page.context().close();
    }
  });

  it('refuses replayed, tampered, unknown and malformed requests from the real signature path', async () => {
    const [first] = users;
    await mark(first, H.replay, world.post(world.idOf(H.replay)));
    const original = first.proxy.log.findLast((e) => e.url === '/api/v1/votes' && e.status === 200);
    const { host: _host, connection: _connection, 'content-length': _length, ...headers } = original.headers;
    const otherNetwork = await network(91);
    const send = (changes = {}, body = original.body) => fetch(`${otherNetwork.origin}/api/v1/votes`, { method: 'POST', headers: { ...headers, ...changes }, body });
    const codeOf = async (res) => [res.status, (await res.json()).error.code];
    assert.deepEqual(await codeOf(await send()), [401, 'replay']);
    const sig = headers['x-xslop-sig'];
    const middle = Math.floor(sig.length / 2);
    const tampered = `${sig.slice(0, middle)}${sig[middle] === 'A' ? 'B' : 'A'}${sig.slice(middle + 1)}`;
    assert.deepEqual(await codeOf(await send({ 'x-xslop-sig': tampered, 'x-xslop-nonce': 'AAAAAAAAAAAAAAAAAAAAAA' })), [401, 'bad_signature']);
    assert.deepEqual(await codeOf(await send({ 'x-xslop-install': randomUUID() })), [401, 'unknown_install']);
    assert.deepEqual(await codeOf(await send({ 'x-xslop-nonce': 'BBBBBBBBBBBBBBBBBBBBBB' }, `${original.body}`.replace(H.replay, 'other_handle'))), [401, 'bad_signature']);
    const bot = new Bot(await network(90));
    assert.equal(await bot.install(), 201);
    assert.equal((await bot.vote('BAD HANDLE!', 'slop', '1')).status, 400);
    assert.equal((await bot.vote('fine_handle', 'maybe', '1')).status, 400);
    assert.equal((await bot.vote('fine_handle', 'slop', 'not-a-number')).status, 400);
    assert.equal((await fetch(`${bot.proxy.origin}/api/v1/votes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });

  it('the release zips are served with their real hashes', async () => {
    const { json: latest } = await api('/downloads/latest.json');
    const zip = await fetch(`${monitor.origin}${latest.chrome.url}`);
    assert.equal(zip.status, 200);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), latest.chrome.sha256);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  });

  it('a v1.0.1 database upgrades with nothing lost, and the current server and job run on it', async () => {
    const url = await postgres.createDatabase('xslop_upgrade', { schema: false });
    await postgres.restore('xslop_upgrade', join(import.meta.dirname, 'fixtures/v1.0.1/database.sql.gz'));
    const upgrade = new pg.Pool({ connectionString: url, max: 2 });
    const port = await freePort();
    const upgradeEnv = { ...env, DATABASE_URL: url, PORT: String(port) };
    const script = (file) => run(process.execPath, [file], { cwd: release, env: upgradeEnv });
    const first = async (sql, params) => (await upgrade.query(sql, params)).rows[0];
    const proxy = await NetworkProxy.start(port, '100.64.252.10');
    let web;
    try {
      // The dump is static. Moving its clock to today keeps it inside the 30-day retention on every future run.
      const { rows: timeColumns } = await upgrade.query("select table_name, column_name from information_schema.columns where table_schema = 'xslop' and data_type = 'timestamp with time zone'");
      const { shift } = await first('select now() - max(generated_at) as shift from list_snapshots');
      for (const { table_name: table, column_name: column } of timeColumns) await upgrade.query(`update ${table} set ${column} = ${column} + $1::interval`, [shift]);

      const { rows: columns } = await upgrade.query("select table_name as t, column_name as c from information_schema.columns where table_schema = 'xslop' order by table_name, ordinal_position");
      const tables = Map.groupBy(columns, (r) => r.t);
      const skip = { accounts: ['status', 'score', 'tier', 'parts', 'listed_at', 'updated_at'], installs: ['reputation'] };
      const stableColumns = (table) => tables.get(table).map((r) => r.c).filter((c) => !skip[table]?.includes(c));
      // The seed import of this build writes a profile without the bio, so the bio is no part of what must stay.
      const fingerprint = async (table, where = 'true') => {
        const list = stableColumns(table).map((c) => (table === 'accounts' && c === 'profile' ? `"profile" - 'description' as "profile"` : `"${c}"`)).join(', ');
        return first(`select count(*)::int as rows, md5(coalesce(string_agg(r::text, E'\\n' order by r::text), '')) as sum from (select ${list} from ${table} where ${where}) r`);
      };
      const everyTable = [...tables.keys()];
      assert.deepEqual(everyTable, ['accounts', 'admin_sessions', 'appeals', 'installs', 'jobs', 'list_snapshots', 'schema_migrations', 'sightings', 'used_challenges', 'votes']);
      const baseline = Object.fromEntries(await Promise.all(everyTable.map(async (table) => [table, await fingerprint(table)])));
      assert.deepEqual((await upgrade.query('select name from schema_migrations order by name')).rows.map((r) => r.name), ['001_init.sql', '002_hardening.sql']);
      for (const table of ['accounts', 'installs', 'votes', 'sightings', 'appeals', 'admin_sessions', 'used_challenges', 'list_snapshots', 'jobs']) assert.ok(baseline[table].rows > 0, `the fixture holds ${table}`);
      const old = await first('select version::int as version, count, body_gzip, body_br from list_snapshots order by version desc limit 1');
      const statusOf = async (handle) => (await first('select status from accounts where handle = $1', [handle])).status;
      assert.deepEqual([await statusOf('old_cleared'), await statusOf('old_confirmed')], ['cleared', 'confirmed']);

      assert.match(await script('server/dist/scripts/migrate.js'), /applied: 003_profiles\.sql, 004_judging_v2\.sql, 005_x_user_id_index\.sql/);
      for (const table of everyTable.filter((t) => t !== 'schema_migrations')) assert.deepEqual(await fingerprint(table), baseline[table], `the migration leaves ${table} alone`);
      assert.deepEqual((await upgrade.query('select name from schema_migrations order by name')).rows.map((r) => r.name), ['001_init.sql', '002_hardening.sql', '003_profiles.sql', '004_judging_v2.sql', '005_x_user_id_index.sql']);
      assert.equal((await first('select count(*)::int as n from profiles')).n, 0);
      assert.match(await script('server/dist/scripts/migrate.js'), /schema is up to date/, 'a second run changes nothing');

      const edited = join(work, 'edited-migrations');
      await cp(join(release, 'server/migrations'), edited, { recursive: true });
      await appendFile(join(edited, '001_init.sql'), '-- edited after it was applied\n');
      const { migrate } = await import(pathToFileURL(join(release, 'server/dist/scripts/migrate.js')));
      const { createPgDb } = await import(pathToFileURL(join(release, 'server/dist/db.js')));
      const db = createPgDb(url, 1);
      await assert.rejects(migrate(db, edited), /migration 001_init\.sql changed after it was applied/);
      await db.close();

      web = await Server.start(release, upgradeEnv, proxy.origin);
      const get = async (path) => {
        const res = await fetch(`${proxy.origin}${path}`);
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null };
      };
      assert.equal((await get('/api/health')).json.ok, true);
      const { json: served } = await get('/api/v1/list');
      assert.deepEqual(served, JSON.parse(gunzipSync(old.body_gzip).toString()), 'the v1.0.1 snapshot still serves');
      assert.deepEqual(served, JSON.parse(brotliDecompressSync(old.body_br).toString()));
      assert.equal(served.accounts.length, old.count);

      const seedOutput = await script('server/dist/scripts/import-seed.js');
      const seedCount = Number(/seed accounts: (\d+)/.exec(seedOutput)[1]);
      const job = JSON.parse((await script('server/dist/jobs/score.js')).trim().split('\n').at(-1));
      assert.equal(job.skipped, false);

      for (const table of ['votes', 'sightings', 'appeals', 'admin_sessions', 'used_challenges', 'installs']) assert.deepEqual(await fingerprint(table), baseline[table], `the upgrade and the job keep ${table}`);
      // A seed list of kind site is new in this build: its rows are added, and every row of v1.0.1 stays as it was.
      const fromSites = "coalesce(seed_source, '') like 'site:%'";
      assert.deepEqual(await fingerprint('accounts', `not (${fromSites})`), baseline.accounts, 'the upgrade and the job keep accounts');
      assert.equal((await first(`select count(*)::int as n from accounts where ${fromSites}`)).n, (await first('select count(*)::int as n from accounts')).n - baseline.accounts.rows, 'only site seed rows are new');
      assert.deepEqual(await fingerprint('list_snapshots', `version <= ${old.version}`), baseline.list_snapshots, 'old snapshots stay');
      assert.equal((await first("select count(*)::int as n from accounts where profile ? 'description'")).n, 0, 'the seed import of this build removes the stored bios');
      assert.equal(await statusOf('old_cleared'), 'cleared');
      assert.equal((await first("select count(*)::int as n from appeals where status = 'open' and handle = 'old_confirmed'")).n, 1);
      assert.equal((await first('select count(*)::int as n from installs where banned_at is not null')).n, 1);
      assert.equal((await first('select count(*)::int as n from accounts where seed and tier = 2')).n, seedCount, 'every seed account stays confirmed');

      const { rows: statuses } = await upgrade.query("select handle, tier from accounts where handle ~ '^old_' order by handle");
      const newest = await until(async () => {
        const answer = await get('/api/v1/list');
        return answer.json.version === job.version ? answer.json : null;
      }, `the upgraded server serves version ${job.version}`, 40_000, 1_000);
      const listed = new Set(newest.accounts.map((r) => r[0]));
      for (const { handle, tier } of statuses) assert.equal(listed.has(handle), tier >= 1, `${handle} tier ${tier} and the list agree`);
      assert.ok(job.version > old.version, 'the rules of this release change the list of this fixture');
      // 13.11: a chain that holds a stored delta without addIds (written before 004) answers 410, so the extension fetches the
      // full list once. From the newest v1.0.1 version the one delta of this release gives every row and its X id.
      const { rows: kept } = await upgrade.query('select version::int as version, body_gzip from list_snapshots where version < $1 order by version', [job.version]);
      assert.equal(kept.length, old.version);
      for (const { version, body_gzip: body } of kept) {
        const delta = await get(`/api/v1/list/delta?since=${version}`);
        if (version < old.version) {
          assert.deepEqual([delta.status, delta.json?.error?.code], [410, 'delta_gone'], `delta from version ${version}`);
          continue;
        }
        assert.deepEqual([delta.status, delta.json.from, delta.json.version], [200, version, job.version]);
        const rows = new Map(JSON.parse(gunzipSync(body).toString()).accounts.map((r) => [r[0], r]));
        for (const handle of delta.json.remove) rows.delete(handle);
        for (const row of delta.json.add) rows.set(row[0], row);
        assert.deepEqual([...rows.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), newest.accounts, `the list rebuilt from version ${version}`);
        const ids = new Map(delta.json.add.map((r, i) => [r[0], delta.json.addIds[i]]));
        assert.deepEqual(newest.accounts.map((r) => ids.get(r[0]) ?? null), newest.ids, 'the delta carries the X id of every changed row');
      }
      assert.equal((await get(`/api/v1/list/delta?since=${job.version}`)).status, 304);
      const { json: sloppers } = await get('/api/v1/sloppers?limit=1');
      assert.equal(sloppers.total, newest.accounts.length);
      assert.equal((await get('/api/health')).json.ok, true);
    } finally {
      await web?.stop();
      await proxy.close();
      await upgrade.end();
    }
  });

  it('every request of the real extensions got a success answer', () => {
    const extensionNetworks = [1, 2, 3, 4, 5, 6].map((n) => networks.get(`${n}.10`));
    const failures = extensionNetworks.flatMap((proxy) => proxy.log.filter((e) => e.status === 0 || e.status >= 400)).map((e) => `${e.method} ${e.url}: ${e.status}`);
    assert.deepEqual(failures, []);
    assert.ok(extensionNetworks.every((proxy) => proxy.log.some((e) => e.url === '/api/v1/installs' && e.status === 201)));
  });

  it('the server log holds no vote text, no client address, no secret, and one line per admin change', async () => {
    assert.ok(server.log.length > 0, 'the server wrote a log');
    assert.deepEqual(server.log.split('\n').filter((line) => /"level":(50|60)/.test(line)), [], 'the whole scenario logs no server error');
    assert.equal(server.log.includes(OLD_VOTE_TEXT), false, 'vote text');
    assert.equal(server.log.includes('This is my account'), false, 'appeal text');
    assert.equal(server.log.includes('owner@example.com'), false, 'appeal email');
    assert.equal(/100\.64\.\d+\.\d+|2001:db8:5/.test(server.log), false, 'client address');
    for (const secret of [adminPassword, salt, adminTotp, adminCode]) assert.equal(server.log.includes(secret), false, 'no secret');
    const actions = server.log.split('\n').filter((line) => line.includes('"admin action"')).map((line) => JSON.parse(line)).map((l) => `${l.action} ${l.target}`);
    const rows = (await pool.query('select action, target from admin_log order by id')).rows.map((r) => `${r.action} ${r.target}`);
    assert.deepEqual(actions, rows, 'one log line per admin_log row');
  });
});
