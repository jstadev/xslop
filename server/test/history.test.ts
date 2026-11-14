import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runScoreJob } from '../src/jobs/score-job.js';
import {
  ANCHORS_CONFIRM, ANCHORS_FLAG, CLEARED_RETURN_MIN_NETWORKS, CONFIRM_MIN_NETWORKS, CONFIRM_MIN_TRUST, CONFIRM_SHARE_BOUND, computeScores, EVIDENCE_CONFIRM,
  EVIDENCE_FLAG, FLAG_MIN_NETWORKS, FLAG_SHARE_BOUND, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, NETWORK_DAILY_VOTES, PROTECTED_MIN_FOLLOWERS,
  SEED_DISPUTE_MIN_NETWORKS, STANDING_MIN_AGE_DAYS, STANDING_MIN_GOOD_MARKS, STANDING_MIN_REPUTATION, STRIKE_MAX_CROWD,
} from '../src/scoring/index.js';
import { ADMIN_PASSWORD, ADMIN_USER, adminConfig, fromIp, getChallenge, makeApp, ORIGIN, type TestApp } from './helpers/app.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { fakeCompute } from './helpers/fake-scoring.js';

/** A network hash as the server stores it (32 hex characters), and its label in the console (SPEC 14.1). */
const ipHashOf = (net: string) => createHash('sha256').update(`network ${net}`).digest('hex').slice(0, 32);
const label = (ipHash: string) => createHash('sha256').update(ipHash).digest('hex').slice(0, 8);
/** Old vote rows can hold a post text (SPEC 4). No admin answer may serve it. */
const POST_TEXT = 'An old stored post text that the console never shows';
const DEFAULT_KINDS = ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run'];

interface Item {
  key: string;
  at: string;
  kind: string;
  source: string;
  subject: string | null;
  data: Record<string, unknown>;
}

describe.each(BACKENDS)('admin console history routes (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;
  let admin: Awaited<ReturnType<typeof adminConfig>>;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
    admin = await adminConfig();
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => {
    await tdb.reset();
    t = await makeApp(tdb.db, { admin });
  });

  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => tdb.db.query<R>(sql, params);
  async function session(): Promise<{ cookie: string; csrf: string }> {
    const r = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
    expect(r.statusCode).toBe(200);
    return { cookie: (r.headers['set-cookie'] as string).split(';')[0]!, csrf: r.json().csrf };
  }
  // Every answer of a new route is kept, so the privacy test reads them all.
  const bodies: string[] = [];
  const get = async (s: { cookie: string }, url: string) => {
    const r = await t.app.inject({ url, headers: { cookie: s.cookie } });
    bodies.push(r.body);
    return r;
  };
  const write = (s: { cookie: string; csrf: string }, url: string, payload?: object) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf': s.csrf, origin: ORIGIN }, ...(payload ? { payload } : {}) });
  const activity = async (s: { cookie: string }, query = '') => (await get(s, `/api/admin/activity${query}`)).json() as { items: Item[]; next: string | null };

  async function install(net: string, o: { trusted?: boolean; days?: number } = {}): Promise<string> {
    const id = randomUUID();
    await q("insert into installs (id, public_key, ip_hash, created_at, trusted, ext_version) values ($1, '{}', $2, now() - make_interval(days => $3::int), $4, '1.2.0')", [
      id,
      ipHashOf(net),
      o.days ?? 30,
      o.trusted ?? false,
    ]);
    return id;
  }
  async function castVote(installId: string, handle: string, value: 0 | 1 = 1, tweetId: string | null = null): Promise<void> {
    await q('insert into accounts (handle) values ($1) on conflict do nothing', [handle]);
    await q("insert into votes (install_id, handle, value, tweet_id, text, created_at, updated_at) values ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - interval '1 hour')", [
      installId,
      handle,
      value,
      tweetId,
      POST_TEXT,
    ]);
  }
  async function appeal(handle: string, ip: string): Promise<string> {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/appeals',
      headers: fromIp(ip),
      payload: { handle, email: null, message: 'I write my own replies, please check my profile.', ...(await getChallenge(t, 'appeal', ip)) },
    });
    expect(r.statusCode).toBe(201);
    return r.json().appealId;
  }

  /**
   * The flow of SPEC 13.9 item 2 through the real engine: 4 networks, 2 of them trusted, evidence of one network (flagged, gate
   * evidence), then of two (confirmed). Then a public appeal, an admin accept with penalty and an admin confirm.
   */
  async function listedFlow(s: { cookie: string; csrf: string }) {
    await q("insert into accounts (handle, x_user_id, identity) values ('target_acct', '777001', 'ok')");
    const voters: string[] = [];
    for (let i = 0; i < 4; i++) {
      voters.push(await install(`net${i}`, { trusted: i < 2 }));
      await castVote(voters[i]!, 'target_acct', 1, `185000000000000010${i}`);
    }
    await q("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000100', 'target_acct', '777001', true)");
    await runScoreJob(tdb.db, computeScores);
    await q("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000102', 'target_acct', '777001', true)");
    await runScoreJob(tdb.db, computeScores);
    // The test clock of the app stays at its start; the admin changes come after the runs.
    t.clock.t = Date.now();
    const appealId = await appeal('target_acct', '192.0.2.70');
    const accept = await write(s, `/api/admin/appeals/${appealId}/decide`, { decision: 'accept', note: 'bio code found' });
    expect(accept.json().status).toBe('accepted');
    const cleared = await get(s, '/api/admin/accounts/target_acct');
    const confirm = await write(s, '/api/admin/accounts/target_acct', { action: 'confirm' });
    expect(confirm.statusCode).toBe(200);
    return { voters, appealId, cleared: cleared.json(), confirm: confirm.json() };
  }

  it('answers 401 without a session on every new route', async () => {
    const id = randomUUID();
    for (const url of ['/api/admin/activity', '/api/admin/accounts/someone', `/api/admin/installs/${id}`, '/api/admin/lists', '/api/admin/jobs', '/api/admin/jobs?job=score']) {
      const r = await t.app.inject({ url });
      expect([url, r.statusCode, r.json().error.code]).toEqual([url, 401, 'unauthorized']);
      expect((await t.app.inject({ url, headers: { cookie: `__Host-xs_admin=${'A'.repeat(43)}` } })).statusCode).toBe(401);
    }
  });

  it('answers 400 on bad input and 404 for an account or install without a row', async () => {
    const s = await session();
    const cursor = `2026-11-13T10:00:00.123456Ze:${'1'.padStart(19, '0')}`;
    expect((await get(s, `/api/admin/activity?cursor=${cursor}`)).statusCode).toBe(200);
    const bad = [
      '/api/admin/activity?kinds=bogus',
      '/api/admin/activity?kinds=',
      '/api/admin/activity?kinds=admin,,status',
      '/api/admin/activity?kinds=admin,vote,',
      '/api/admin/activity?subject=Bad-Handle',
      '/api/admin/activity?subject=@someone',
      '/api/admin/activity?subject=sixteen_chars_xx',
      `/api/admin/activity?subject=${randomUUID().toUpperCase()}`,
      '/api/admin/activity?limit=0',
      '/api/admin/activity?limit=201',
      '/api/admin/activity?limit=abc',
      '/api/admin/activity?x=1',
      '/api/admin/accounts/a.b',
      `/api/admin/accounts/${'x'.repeat(33)}`,
      '/api/admin/accounts/someone?x=1',
      '/api/admin/installs/not-a-uuid',
      `/api/admin/installs/${randomUUID().toUpperCase()}`,
      `/api/admin/installs/${randomUUID()}?x=1`,
      '/api/admin/lists?limit=0',
      '/api/admin/lists?limit=61',
      '/api/admin/lists?x=1',
      '/api/admin/jobs?job=web',
      '/api/admin/jobs?limit=0',
      '/api/admin/jobs?limit=501',
      '/api/admin/jobs?job=score&x=1',
    ];
    for (const url of bad) expect([url, (await get(s, url)).statusCode]).toEqual([url, 400]);
    // Every bad cursor answers bad_request (SPEC 14.2): another charset, too long, an unknown key, a date that does not exist.
    for (const c of ['bad', 'a!b', `${cursor}${'0'.repeat(100)}`, `2026-11-13T10:00:00.123456Zx:${'1'.padStart(19, '0')}`, `2026-02-30T10:00:00.123456Ze:${'1'.padStart(19, '0')}`, '2026-11-13T10:00:00.123Ze:1']) {
      const r = await get(s, `/api/admin/activity?cursor=${encodeURIComponent(c)}`);
      expect([c, r.statusCode, r.json().error.code]).toEqual([c, 400, 'bad_request']);
    }
    for (const url of ['/api/admin/accounts/nobody_here', `/api/admin/installs/${randomUUID()}`]) {
      const r = await get(s, url);
      expect([url, r.statusCode, r.json().error.code]).toEqual([url, 404, 'not_found']);
    }
    // The limits that the SPEC allows.
    for (const url of ['/api/admin/activity?limit=1', '/api/admin/activity?limit=200', '/api/admin/lists?limit=60', '/api/admin/jobs?limit=500']) expect([url, (await get(s, url)).statusCode]).toEqual([url, 200]);
  });

  it('serves the account page, the install page, lists, jobs, overview and activity from a real run and real admin actions, and no ip_hash or post text', async () => {
    bodies.length = 0;
    const s = await session();
    const { voters, appealId, cleared, confirm } = await listedFlow(s);
    // A plain network gets a strike: its vote on an account that the admin clears with the penalty.
    await castVote(voters[2]!, 'struck_acct', 1);
    expect((await write(s, '/api/admin/accounts/struck_acct', { action: 'clear' })).statusCode).toBe(200);

    // admin_log.after holds the answer of the change; /log serves it.
    const logged = (await q<{ action: string; after: unknown }>("select action, after from admin_log where target = 'target_acct'")).rows;
    expect(logged).toEqual([{ action: 'confirm', after: confirm }]);
    expect(confirm.list).toEqual({ version: 4, changed: true, listed: 1 });
    const log = (await get(s, '/api/admin/log')).json();
    expect(log.entries.find((e: { action: string }) => e.action === 'confirm').after).toEqual(confirm);
    expect(log.entries.find((e: { action: string }) => e.action === 'login').after).toBeNull();

    // The account page while the account was cleared: the stored clear rows.
    expect(cleared.account).toMatchObject({ status: 'cleared', override: 'clear' });
    expect(cleared.clearedVotes).toEqual({ rows: 4, networks: 4, slopNetworks: 4, clearedAt: expect.stringMatching(/Z$/) });
    expect(cleared.list).toEqual({ version: 3, inList: false, score: null, tier: null });

    const page = (await get(s, '/api/admin/accounts/target_acct')).json();
    expect(page.account).toMatchObject({
      handle: 'target_acct',
      status: 'confirmed',
      tier: 2,
      override: 'confirm',
      xUserId: '777001',
      identity: 'ok',
      banNetworks: 4,
      name: null,
      followers: null,
      listedAt: expect.stringMatching(/Z$/),
      firstSeenAt: expect.stringMatching(/Z$/),
      confirmedAt: expect.stringMatching(/Z$/),
      identityAt: null,
      movedTo: null,
      seedSource: null,
      parts: expect.objectContaining({ reason: 'votes_confirmed', anchors: 2, evidence: 2 }),
    });
    expect(page.profile).toBeNull();
    expect(page.list).toEqual({ version: 4, inList: true, score: 100, tier: 2 });
    expect(page.votes).toMatchObject({ slop: 4, notSlop: 0, truncated: false });
    expect(page.votes.networks.map((n: { network: string; voice: string; standing: boolean }) => [n.network, n.voice, n.standing])).toEqual([
      ...[label(ipHashOf('net0')), label(ipHashOf('net1'))].sort().map((n) => [n, 'slop', true]),
      ...[label(ipHashOf('net2')), label(ipHashOf('net3'))].sort().map((n) => [n, 'slop', false]),
    ]);
    const first = page.votes.networks.find((n: { network: string }) => n.network === label(ipHashOf('net0')));
    expect(first.installs).toEqual([
      { id: voters[0], value: 'slop', standing: true, trusted: true, banned: false, reputation: expect.any(Number), votedAt: expect.stringMatching(/Z$/), changedAt: expect.stringMatching(/Z$/), tweetId: '1850000000000000100' },
    ]);
    expect(page.evidence.map((e: { tweetId: string; ok: boolean; matchesId: boolean }) => [e.tweetId, e.ok, e.matchesId]).sort()).toEqual([
      ['1850000000000000100', true, true],
      ['1850000000000000102', true, true],
    ]);
    expect(page.sightings).toEqual({ stored: 0, verified: 0, recent: [] });
    expect(page.clearedVotes).toEqual({ rows: 0, networks: 0, slopNetworks: 0, clearedAt: null });
    expect(page.appeals).toEqual([
      { appealId, status: 'accepted', createdAt: expect.stringMatching(/Z$/), decidedAt: expect.stringMatching(/Z$/), note: 'bio code found', message: expect.any(String), email: null, code: expect.stringMatching(/^xslop-/) },
    ]);
    // The timeline: the two status changes of the runs, the appeal, its accept (an admin item on the appeal id), the confirm and
    // the four list versions that touched the handle. No login, no standing event of an install.
    const timeline = page.timeline as Item[];
    expect(timeline.filter((i) => i.kind === 'status').map((i) => [i.data.from, (i.data.to as { status: string }).status])).toEqual([
      [{ status: 'flagged', tier: 1, gate: 'evidence', want: 'confirmed' }, 'confirmed'],
      [{ status: 'none', tier: 0, gate: null, want: null }, 'flagged'],
    ]);
    expect(timeline.filter((i) => i.kind === 'admin').map((i) => [i.subject, i.data.action])).toEqual([['target_acct', 'confirm'], [appealId, 'accept']]);
    expect(timeline.filter((i) => i.kind === 'list').map((i) => i.subject)).toEqual(['4', '3', '2', '1']);
    expect(timeline.find((i) => i.subject === '3')!.data).toEqual({ version: 3, count: 0, from: 2, added: [], addedCount: 0, removed: ['target_acct'], removedCount: 1 });
    expect(timeline.filter((i) => i.kind === 'appeal')).toEqual([{ key: `p:${appealId}`, at: expect.any(String), kind: 'appeal', source: 'public', subject: 'target_acct', data: { appealId, status: 'accepted' } }]);
    expect(new Set(timeline.map((i) => i.kind))).toEqual(new Set(['status', 'admin', 'list', 'appeal']));

    // The install page of a trusted voter and of the voter that got a strike.
    const trusted = (await get(s, `/api/admin/installs/${voters[0]}`)).json();
    expect(trusted.install).toMatchObject({ id: voters[0], trusted: true, standing: true, votes: 1, slopVotes: 1, network: label(ipHashOf('net0')), sameNetwork: 1 });
    expect(trusted.standing).toEqual({
      has: true,
      trusted: true,
      banned: false,
      ageDays: 30,
      goodMarks: 0,
      reputation: expect.any(Number),
      needs: { ageDays: STANDING_MIN_AGE_DAYS, goodMarks: STANDING_MIN_GOOD_MARKS, reputation: STANDING_MIN_REPUTATION },
    });
    expect(trusted.votes).toEqual({ total: 1, items: [{ handle: 'target_acct', value: 'slop', votedAt: expect.any(String), changedAt: expect.any(String), tweetId: '1850000000000000100', accountStatus: 'confirmed' }] });
    expect(trusted.network).toEqual({ network: label(ipHashOf('net0')), installs: 1, banned: 0, strikes: [] });
    expect((trusted.timeline as Item[]).map((i) => [i.kind, i.source, i.subject, i.data])).toEqual([['standing', 'score', voters[0], { standing: true, reputation: expect.any(Number), goodMarks: 0, banned: false }]]);
    const plain = (await get(s, `/api/admin/installs/${voters[2]}`)).json();
    expect(plain.standing).toMatchObject({ has: false, trusted: false });
    expect(plain.network.strikes).toEqual([{ handle: 'struck_acct', clearedAt: expect.stringMatching(/Z$/), standing: false }]);
    expect(plain.votes.items.map((v: { handle: string; accountStatus: string }) => [v.handle, v.accountStatus]).sort()).toEqual([['struck_acct', 'cleared'], ['target_acct', 'confirmed']]);

    // The list versions, newest first.
    const lists = (await get(s, '/api/admin/lists')).json();
    expect(lists.versions.map((v: { version: number; from: number | null; addedCount: number; removed: string[] }) => [v.version, v.from, v.addedCount, v.removed])).toEqual([
      [4, 3, 1, []],
      [3, 2, 0, ['target_acct']],
      [2, 1, 1, []],
      [1, null, 1, []],
    ]);
    expect(lists.versions[0]).toEqual({ version: 4, generatedAt: expect.stringMatching(/Z$/), count: 1, from: 3, added: [['target_acct', 100, 2]], addedCount: 1, removed: [], removedCount: 0 });
    expect((await get(s, '/api/admin/lists?limit=1')).json().versions).toHaveLength(1);

    // The job runs.
    const jobs = (await get(s, '/api/admin/jobs?job=score')).json();
    expect(jobs.runs.map((r: { job: string; ok: boolean }) => [r.job, r.ok])).toEqual([['score', true], ['score', true]]);
    expect(jobs.runs[0]).toEqual({ id: 2, job: 'score', startedAt: expect.stringMatching(/Z$/), endedAt: expect.stringMatching(/Z$/), ms: expect.any(Number), ok: true, detail: expect.objectContaining({ version: 2, listed: 1 }) });
    expect(jobs.runs[0].ms).toBeGreaterThanOrEqual(0);
    expect(jobs.last).toEqual({ lastRunAt: expect.stringMatching(/Z$/), lastOkAt: expect.stringMatching(/Z$/), detail: jobs.runs[0].detail });
    expect((await get(s, '/api/admin/jobs?job=profiles')).json()).toEqual({ runs: [], last: { lastRunAt: null, lastOkAt: null, detail: null } });
    expect((await get(s, '/api/admin/jobs')).json()).toMatchObject({ runs: [{ id: 2 }, { id: 1 }], last: null });

    // The overview additions.
    const overview = (await get(s, '/api/admin/overview')).json();
    expect(overview.queues).toEqual({ pending: 0, disputed: 0, auto: 0 });
    expect(overview.list).toEqual({ version: 4, count: 1, generatedAt: expect.stringMatching(/Z$/) });
    expect(overview.last24h).toEqual({
      votes: 5,
      slopVotes: 5,
      notSlopVotes: 0,
      newInstalls: 0,
      statusChanges: 2,
      identityChanges: 0,
      standingChanges: 2,
      listVersions: 4,
      appeals: 1,
      adminActions: 3,
    });
    expect(overview.score).toMatchObject({ runs24h: 2, failed24h: 0 });
    expect(overview.facts).toMatchObject({ runs24h: 0, failed24h: 0 });
    expect(overview.rules).toEqual({
      standingMinAgeDays: STANDING_MIN_AGE_DAYS,
      standingMinGoodMarks: STANDING_MIN_GOOD_MARKS,
      standingMinReputation: STANDING_MIN_REPUTATION,
      anchorsFlag: ANCHORS_FLAG,
      anchorsConfirm: ANCHORS_CONFIRM,
      evidenceFlag: EVIDENCE_FLAG,
      evidenceConfirm: EVIDENCE_CONFIRM,
      flagMinNetworks: FLAG_MIN_NETWORKS,
      confirmMinNetworks: CONFIRM_MIN_NETWORKS,
      confirmMinTrust: CONFIRM_MIN_TRUST,
      flagShareBound: FLAG_SHARE_BOUND,
      confirmShareBound: CONFIRM_SHARE_BOUND,
      protectedMinFollowers: PROTECTED_MIN_FOLLOWERS,
      maxAutoConfirmsPerDay: MAX_AUTO_CONFIRMS_PER_DAY,
      maxAutoFlagsPerDay: MAX_AUTO_FLAGS_PER_DAY,
      strikeMaxCrowd: STRIKE_MAX_CROWD,
      clearedReturnMinNetworks: CLEARED_RETURN_MIN_NETWORKS,
      seedDisputeMinNetworks: SEED_DISPUTE_MIN_NETWORKS,
      networkDailyVotes: NETWORK_DAILY_VOTES,
    });

    // The feed: by default no vote and no install item.
    const feed = await activity(s);
    expect(new Set(feed.items.map((i) => i.kind))).toEqual(new Set(['admin', 'status', 'standing', 'list', 'appeal']));
    expect(feed.next).toBeNull();
    expect(feed.items.filter((i) => i.kind === 'admin').map((i) => i.data.action)).toEqual(['clear', 'confirm', 'accept', 'login']);
    expect(feed.items.find((i) => i.kind === 'admin' && i.data.action === 'confirm')!.data).toEqual({ action: 'confirm', session: expect.stringMatching(/^[0-9a-f]{16}$/), before: expect.any(Object), after: confirm });
    // The account and install rows of the list views carry the new fields.
    const row = (await get(s, '/api/admin/accounts?handle=target_acct')).json().accounts[0];
    expect(row).toMatchObject({ handle: 'target_acct', name: null, followers: null, listedAt: expect.stringMatching(/Z$/) });
    const installs = (await get(s, '/api/admin/installs?sort=created')).json().installs as { id: string; network: string }[];
    expect(installs.find((i) => i.id === voters[3])!.network).toBe(label(ipHashOf('net3')));
    await activity(s, '?kinds=vote,install');
    await activity(s, `?subject=${voters[2]}&kinds=${DEFAULT_KINDS.join(',')},vote,install`);

    // Privacy (SPEC 14.1): no answer holds an ip_hash or a post text, although the tables hold both.
    const hashes = (await q<{ h: string }>('select ip_hash as h from installs union select ip_hash from cleared_votes union select ip_hash from appeals union select ip_hash from admin_sessions')).rows.map((r) => r.h);
    expect(hashes.length).toBeGreaterThanOrEqual(5);
    expect((await q('select 1 from votes where text = $1', [POST_TEXT])).rows.length).toBe(5);
    expect(bodies.length).toBeGreaterThan(15);
    for (const body of bodies) {
      for (const h of hashes) expect(body.includes(h), h).toBe(false);
      expect(body.includes(POST_TEXT)).toBe(false);
    }
    // No stored row keeps one either: the confirm logged the rows of the clear by network label.
    const stored = JSON.stringify((await q('select before, after from admin_log')).rows) + JSON.stringify((await q('select data from events')).rows);
    for (const h of hashes) expect(stored.includes(h), h).toBe(false);
    expect((await q<{ before: { clearedVotes: { network: string }[] } }>("select before from admin_log where action = 'confirm'")).rows[0]!.before.clearedVotes.map((r) => r.network).sort()).toEqual(
      ['net0', 'net1', 'net2', 'net3'].map((n) => label(ipHashOf(n))).sort(),
    );
  });

  it('activity: default kinds, the kinds filter, and the subject filter by handle and by install id', async () => {
    const one = await install('a1');
    const two = await install('a2');
    await castVote(one, 'subj_one', 1);
    await castVote(one, 'subj_two', 0);
    await castVote(two, 'subj_one', 1);
    await runScoreJob(tdb.db, fakeCompute({ subj_one: [0.5, 1] }));
    const s = await session();
    expect((await write(s, '/api/admin/accounts/subj_two', { action: 'protect' })).statusCode).toBe(200);
    const appealId = await appeal('subj_one', '192.0.2.71');
    // A changed vote is not `first` any more.
    await q("update votes set value = 0, updated_at = now() where install_id = $1 and handle = 'subj_one'", [two]);

    const all = await activity(s);
    expect(all.items.map((i) => [i.kind, i.subject])).toEqual(
      expect.arrayContaining([['status', 'subj_one'], ['list', '1'], ['admin', 'subj_two'], ['appeal', 'subj_one']]),
    );
    expect(all.items.some((i) => i.kind === 'vote' || i.kind === 'install')).toBe(false);

    const votes = await activity(s, '?kinds=vote');
    expect(votes.items.map((i) => [i.key, i.subject, i.data]).sort()).toEqual(
      [
        [`v:${one}:subj_one`, 'subj_one', { install: one, network: label(ipHashOf('a1')), value: 'slop', first: true }],
        [`v:${one}:subj_two`, 'subj_two', { install: one, network: label(ipHashOf('a1')), value: 'not_slop', first: true }],
        [`v:${two}:subj_one`, 'subj_one', { install: two, network: label(ipHashOf('a2')), value: 'not_slop', first: false }],
      ].sort(),
    );
    expect(votes.items[0]!.key).toBe(`v:${two}:subj_one`);
    const installs = await activity(s, '?kinds=install');
    expect(installs.items.map((i) => [i.kind, i.source, i.subject, i.data]).sort()).toEqual(
      [[ 'install', 'public', one, { network: label(ipHashOf('a1')), extVersion: '1.2.0' }], ['install', 'public', two, { network: label(ipHashOf('a2')), extVersion: '1.2.0' }]].sort(),
    );
    expect((await activity(s, '?kinds=vote,install,vote')).items).toHaveLength(5);
    expect((await activity(s, '?kinds=appeal')).items.map((i) => i.data)).toEqual([{ appealId, status: 'open' }]);

    // By handle: its status event, the list version that added it, its appeal; never the change of another account or a login.
    const byHandle = await activity(s, '?subject=subj_one');
    expect(byHandle.items.map((i) => [i.kind, i.subject])).toEqual([['appeal', 'subj_one'], expect.anything(), expect.anything()]);
    expect(byHandle.items.map((i) => i.kind).sort()).toEqual(['appeal', 'list', 'status']);
    expect((await activity(s, '?subject=subj_one&kinds=vote')).items.map((i) => i.key).sort()).toEqual([`v:${one}:subj_one`, `v:${two}:subj_one`].sort());
    expect((await activity(s, '?subject=subj_two')).items.map((i) => [i.kind, i.data.action])).toEqual([['admin', 'protect']]);
    // By install id: its votes match, and its install item.
    const byInstall = await activity(s, `?subject=${one}&kinds=${[...DEFAULT_KINDS, 'vote', 'install'].join(',')}`);
    expect(byInstall.items.map((i) => i.key).sort()).toEqual([`i:${one}`, `v:${one}:subj_one`, `v:${one}:subj_two`].sort());
    // A subject with no row matches nothing; a run has no subject.
    expect((await activity(s, '?subject=nobody_here&kinds=run,list,admin')).items).toEqual([]);
  });

  it('activity: the cursor pages over every item exactly once, in order, also through items that share one time', async () => {
    // One score run writes 30 status events in one transaction: they share one time. The votes and installs of one statement too.
    await q("insert into accounts (handle, seed) select 'pager_' || lpad(g::text, 2, '0'), true from generate_series(1, 30) g");
    await q("insert into installs (id, public_key, ip_hash, ext_version) select gen_random_uuid(), '{}', 'pager-net-' || g, '1.2.0' from generate_series(1, 9) g");
    await q("insert into votes (install_id, handle, value) select i.id, 'pager_01', 1 from installs i");
    await runScoreJob(tdb.db, fakeCompute(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pager_${String(i + 1).padStart(2, '0')}`, [0.9, 2]]))));
    await runScoreJob(tdb.db, fakeCompute({ pager_03: [0.5, 1], pager_04: [0.5, 1], pager_05: [0.4, 0, 'pending'] }));
    const s = await session();
    const kinds = `?kinds=${[...DEFAULT_KINDS, 'vote', 'install'].join(',')}`;
    const whole = await activity(s, `${kinds}&limit=200`);
    expect(whole.next).toBeNull();
    // 30 status events in each run, 2 list versions, 9 installs, 9 votes and the login.
    expect(whole.items.length).toBe(30 + 30 + 2 + 9 + 9 + 1);
    // Many items share one time, so pages of 7 cut through ties.
    const times = new Map<string, number>();
    for (const i of whole.items) times.set(i.at, (times.get(i.at) ?? 0) + 1);
    expect(Math.max(...times.values())).toBeGreaterThan(7);
    for (let k = 1; k < whole.items.length; k++) expect(whole.items[k - 1]!.at >= whole.items[k]!.at).toBe(true);

    const paged: Item[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const r = await activity(s, `${kinds}&limit=7${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      expect(r.items.length).toBeLessThanOrEqual(7);
      if (r.next) expect(r.next).toMatch(/^[A-Za-z0-9_.:-]{1,120}$/);
      paged.push(...r.items);
      next = r.next;
      pages++;
    } while (next && pages < 50);
    expect(pages).toBe(Math.ceil(whole.items.length / 7));
    expect(paged.map((i) => i.key)).toEqual(whole.items.map((i) => i.key));
    expect(new Set(paged.map((i) => i.key)).size).toBe(paged.length);
    // A filter keeps the paging exact: only status events, 3 at a time.
    const status: string[] = [];
    next = null;
    do {
      const r = await activity(s, `?kinds=status&limit=3${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      status.push(...r.items.map((i) => i.key));
      next = r.next;
    } while (next);
    expect(status).toEqual(whole.items.filter((i) => i.kind === 'status').map((i) => i.key));
  });

  it('account page: the voice of each network follows standing, a tie is split, the votes stop at 500, and the list flag follows the newest snapshot', async () => {
    const s = await session();
    expect((await get(s, '/api/admin/accounts/voice_acct')).statusCode).toBe(404);
    // Network vA: one trusted slop voter outvotes two plain "not slop" voters. vB: one each, split. vC: no standing, 2 to 1 not slop.
    const anchor = await install('vA', { trusted: true });
    await castVote(anchor, 'voice_acct', 1);
    for (let i = 0; i < 2; i++) await castVote(await install('vA'), 'voice_acct', 0);
    await castVote(await install('vB'), 'voice_acct', 1);
    await castVote(await install('vB'), 'voice_acct', 0);
    await castVote(await install('vC'), 'voice_acct', 1);
    for (let i = 0; i < 2; i++) await castVote(await install('vC'), 'voice_acct', 0);
    // A banned install has no standing: its network vD votes by all its votes.
    const banned = await install('vD', { trusted: true });
    await q('update installs set banned_at = now() where id = $1', [banned]);
    await castVote(banned, 'voice_acct', 1);
    await castVote(await install('vD'), 'voice_acct', 0);

    let page = (await get(s, '/api/admin/accounts/voice_acct')).json();
    expect(page.list).toBeNull();
    expect(page.votes).toMatchObject({ slop: 4, notSlop: 6, truncated: false });
    const voices = Object.fromEntries(page.votes.networks.map((n: { network: string; voice: string; standing: boolean; installs: unknown[] }) => [n.network, [n.voice, n.standing, n.installs.length]]));
    expect(voices).toEqual({
      [label(ipHashOf('vA'))]: ['slop', true, 3],
      [label(ipHashOf('vB'))]: ['split', false, 2],
      [label(ipHashOf('vC'))]: ['not_slop', false, 3],
      [label(ipHashOf('vD'))]: ['split', false, 2],
    });
    expect(page.votes.networks[0].network).toBe(label(ipHashOf('vA')));

    // The list flag: in the list with its score and tier, then out of it.
    await q("insert into accounts (handle, seed) values ('listed_acct', true)");
    await runScoreJob(tdb.db, fakeCompute({ listed_acct: [0.8, 2] }));
    expect((await get(s, '/api/admin/accounts/listed_acct')).json().list).toEqual({ version: 1, inList: true, score: 80, tier: 2 });
    page = (await get(s, '/api/admin/accounts/voice_acct')).json();
    expect(page.list).toEqual({ version: 1, inList: false, score: null, tier: null });

    // 500 votes are read whole; the 501st sets truncated, and the counts hold every vote.
    await q("insert into accounts (handle) values ('big_acct')");
    await q("insert into installs (id, public_key, ip_hash) select gen_random_uuid(), '{}', 'big-net-' || (g % 40) from generate_series(1, 501) g");
    await q("insert into votes (install_id, handle, value) select id, 'big_acct', 1 from installs where ip_hash like 'big-net-%' order by id limit 500");
    page = (await get(s, '/api/admin/accounts/big_acct')).json();
    expect([page.votes.truncated, page.votes.slop, page.votes.networks.reduce((n: number, x: { installs: unknown[] }) => n + x.installs.length, 0)]).toEqual([false, 500, 500]);
    await q("insert into votes (install_id, handle, value) select id, 'big_acct', 0 from installs where ip_hash like 'big-net-%' and id not in (select install_id from votes) limit 1");
    page = (await get(s, '/api/admin/accounts/big_acct')).json();
    expect([page.votes.truncated, page.votes.slop, page.votes.notSlop, page.votes.networks.reduce((n: number, x: { installs: unknown[] }) => n + x.installs.length, 0)]).toEqual([true, 500, 1, 500]);
    // The handle is normalized like the other routes.
    expect((await get(s, '/api/admin/accounts/@BIG_acct')).json().account.handle).toBe('big_acct');
  });

  it('account page: the profile and the checked facts', async () => {
    await q("insert into accounts (handle, x_user_id, identity, identity_at, seed, seed_source) values ('facts_acct', '42', 'ok', now(), true, 'x_list:7')");
    await q("insert into profiles (handle, x_id, name, followers, avatar, avatar_type, misses) values ('facts_acct', '42', 'Facts Account', 1234, $1, 'image/jpeg', 1)", [Buffer.from([1, 2, 3])]);
    await q("insert into evidence (tweet_id, handle, x_user_id, ok) values ('11', 'facts_acct', '42', true), ('12', 'facts_acct', '99', false)");
    await q(`insert into sightings (tweet_id, handle, parent_tweet_id, reply_at, latency_sec, verified_at) values
      ('21', 'facts_acct', '20', now() - interval '1 hour', 30, now()), ('22', 'facts_acct', '20', now() - interval '2 hours', null, null)`);
    const s = await session();
    const page = (await get(s, '/api/admin/accounts/facts_acct')).json();
    expect(page.account).toMatchObject({ name: 'Facts Account', followers: 1234, seed: true, seedSource: 'x_list:7', identityAt: expect.stringMatching(/Z$/) });
    expect(page.profile).toEqual({ xId: '42', name: 'Facts Account', followers: 1234, gone: false, misses: 1, fetchedAt: expect.stringMatching(/Z$/), avatar: true });
    expect(page.evidence.map((e: { tweetId: string; ok: boolean; matchesId: boolean }) => [e.tweetId, e.ok, e.matchesId]).sort()).toEqual([['11', true, true], ['12', false, false]]);
    expect(page.sightings).toEqual({
      stored: 2,
      verified: 1,
      recent: [
        { tweetId: '21', parentTweetId: '20', replyAt: expect.stringMatching(/Z$/), latencySec: 30, verified: true },
        { tweetId: '22', parentTweetId: '20', replyAt: expect.stringMatching(/Z$/), latencySec: null, verified: false },
      ],
    });
  });
});
