import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadStatic } from '../src/http/static.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { fromIp, getChallenge, makeApp, makeStaticRoot, register, signed, vote, type TestApp } from './helpers/app.js';

const message = 'This is my own account. I write every reply myself and I never use a bot.';

describe.each(BACKENDS)('public routes (%s)', (backend) => {
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

  describe('GET /api/v1/accounts/:handle', () => {
    it('answers status none for an unknown handle', async () => {
      const r = await t.app.inject({ url: '/api/v1/accounts/@Nobody_Here' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        handle: 'nobody_here',
        status: 'none',
        tier: 0,
        score: 0,
        seed: false,
        votes: { slop: 0, notSlop: 0 },
        sightings: 0,
        signals: null,
        evidence: [],
        appealOpen: false,
      });
      expect(r.headers['access-control-allow-origin']).toBe('*');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    });
    it('reports votes, verified sightings, signals and evidence of a listed account, without banned installs', async () => {
      const a = await register(t, '198.51.100.1');
      const b = await register(t, '192.0.2.2');
      const c = await register(t, '203.0.113.3');
      await signed(t, a, 'POST', '/api/v1/votes', vote('listed', 'slop', { text: 'Great point! Totally agree 🚀' }));
      await signed(t, b, 'POST', '/api/v1/votes', vote('listed', 'not_slop'));
      await signed(t, c, 'POST', '/api/v1/votes', vote('listed', 'slop', { text: 'banned rater text', tweetId: '1850000000000000002' }));
      await tdb.db.query('update installs set banned_at = now() where id = $1', [c.installId]);
      await tdb.db.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000001', 'listed', '42', true), ('1850000000000000002', 'listed', '42', true)");
      // Only a sighting that the X facts job verified counts.
      await tdb.db.query("insert into sightings (tweet_id, handle, reply_at, verified_at) values ('77', 'listed', now(), now()), ('78', 'listed', now(), null)");
      await tdb.db.query(
        `update accounts set status = 'confirmed', tier = 2, score = 0.874, seed = true,
         parts = '{"sightings": 12, "fastReplyShare": 0.5}'::jsonb where handle = 'listed'`,
      );
      const r = (await t.app.inject({ url: '/api/v1/accounts/LISTED' })).json();
      expect(r).toEqual({
        handle: 'listed',
        status: 'confirmed',
        tier: 2,
        score: 87,
        seed: true,
        votes: { slop: 1, notSlop: 1 },
        sightings: 1,
        signals: { fastReplyShare: 0.5, replies: 12 },
        evidence: [{ tweetId: '1850000000000000001', at: expect.stringMatching(/Z$/) }],
        appealOpen: false,
      });
    });
    it('R13 gives a pending account and every account that is not listed nothing but zeros, in each field (SPEC 13.9 item 1)', async () => {
      const voters = [await register(t, '198.51.100.1'), await register(t, '192.0.2.1'), await register(t, '203.0.113.1')];
      const states: [string, string, number, number][] = [
        ['waiting_crowd', 'pending', 0, 0.71],
        ['cleared_one', 'cleared', 0, 0.9],
        ['plain_none', 'none', 0, 0.3],
        // A moved account keeps its state on the row, and a status needs its tier: none of these is listed.
        ['moved_away', 'confirmed', 2, 0.5],
        ['tier_zero_one', 'confirmed', 0, 0.75],
      ];
      for (const [handle, status, tier, score] of states) {
        for (const [k, id] of voters.entries()) await signed(t, id, 'POST', '/api/v1/votes', vote(handle, k === 2 ? 'not_slop' : 'slop'));
        await tdb.db.query(
          `update accounts set status = $2, tier = $3, score = $4, seed = $5,
             parts = '{"sightings": 30, "fastReplyShare": 0.9, "networks": 2, "want": "confirmed", "gate": "standing"}'::jsonb where handle = $1`,
          [handle, status, tier, score, handle === 'cleared_one'],
        );
        await tdb.db.query("insert into sightings (tweet_id, handle, reply_at, verified_at) values ($1, $2, now(), now())", [String(9000 + score * 100 + tier + handle.length), handle]);
        await tdb.db.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ($1, $2, '1', true) on conflict do nothing", [`1850000000000000001`, handle]);
      }
      await tdb.db.query("update accounts set identity = 'moved', moved_to = 'plain_none' where handle = 'moved_away'");
      await tdb.db.query("insert into appeals (id, handle, message, code, ip_hash) values (gen_random_uuid(), 'waiting_crowd', 'An appeal that is still open here.', 'xslop-AAAAAA', 'net')");
      for (const [handle] of states) {
        const r = await t.app.inject({ url: `/api/v1/accounts/${handle}` });
        expect([handle, r.statusCode, r.json()]).toEqual([
          handle,
          200,
          { handle, status: 'none', tier: 0, score: 0, seed: false, votes: { slop: 0, notSlop: 0 }, sightings: 0, signals: null, evidence: [], appealOpen: false },
        ]);
        expect(r.body).not.toContain('pending');
      }
      // An appeal needs a listed account: a moved one is not.
      const pow = await getChallenge(t, 'appeal', '203.0.113.9');
      const ap = await t.app.inject({ method: 'POST', url: '/api/v1/appeals', headers: fromIp('203.0.113.9'), payload: { handle: 'moved_away', message, ...pow } });
      expect([ap.statusCode, ap.json().error.code]).toEqual([404, 'not_listed']);
    });
    it('13.10 item 10: a listed account that the source did not find (gone) stays listed and answers its state', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier, score, identity) values ('gone_owner', 'flagged', 1, 0.25, 'gone')");
      expect((await t.app.inject({ url: '/api/v1/accounts/gone_owner' })).json()).toMatchObject({ handle: 'gone_owner', status: 'flagged', tier: 1, score: 25 });
    });
    it('A2 serves no behaviour shares for an account that is not listed, whatever its sightings say', async () => {
      await tdb.db.query(`insert into accounts (handle, parts) values ('person', '{"sightings": 12, "fastReplyShare": 1, "duplicateShare": 1, "genericShare": 1}'::jsonb)`);
      expect((await t.app.inject({ url: '/api/v1/accounts/person' })).json()).toMatchObject({ status: 'none', signals: null });
    });
    it('R2-5 serves the post id and the time of a vote as evidence, never the text that the voter sent', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier) values ('victim', 'confirmed', 2)");
      const claim = 'Any text that the attacker wants on this page.';
      const a = await register(t, '198.51.100.1');
      const b = await register(t, '192.0.2.1');
      await signed(t, a, 'POST', '/api/v1/votes', vote('victim', 'slop', { text: claim, tweetId: '1850000000000000007' }));
      // A post without text (a picture) is evidence too: the page links to the post.
      await signed(t, b, 'POST', '/api/v1/votes', vote('victim', 'slop', { text: null, tweetId: '1850000000000000008' }));
      await tdb.db.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000007', 'victim', '5', true), ('1850000000000000008', 'victim', '5', true)");
      await tdb.db.query("update votes set created_at = created_at - interval '1 hour' where install_id = $1", [a.installId]);
      const r = await t.app.inject({ url: '/api/v1/accounts/victim' });
      expect(r.body).not.toContain(claim);
      expect(r.body).not.toContain('"text"');
      expect(r.json().evidence).toEqual([
        { tweetId: '1850000000000000008', at: expect.stringMatching(/Z$/) },
        { tweetId: '1850000000000000007', at: expect.stringMatching(/Z$/) },
      ]);
      // The text never reaches the table.
      expect((await tdb.db.query<{ text: string | null }>('select text from votes where install_id = $1', [a.installId])).rows[0]!.text).toBeNull();
    });
    it('R2-3 counts each network once in the public vote numbers, however many installs it has', async () => {
      const crowd = [await register(t, '198.51.100.1'), await register(t, '198.51.100.2'), await register(t, '198.51.100.3'), await register(t, '192.0.2.1')];
      for (const id of crowd) await signed(t, id, 'POST', '/api/v1/votes', vote('counted'));
      await signed(t, await register(t, '192.0.2.2'), 'POST', '/api/v1/votes', vote('counted', 'not_slop'));
      await signed(t, await register(t, '203.0.113.1'), 'POST', '/api/v1/votes', vote('counted', 'not_slop'));
      await tdb.db.query("update accounts set status = 'flagged', tier = 1 where handle = 'counted'");
      expect((await t.app.inject({ url: '/api/v1/accounts/counted' })).json().votes).toEqual({ slop: 2, notSlop: 2 });
    });
    it('R13 takes evidence only from posts that the server verified as written by the account, one per network, by first vote time', async () => {
      await tdb.db.query("insert into accounts (handle, seed, status, tier) values ('seeded', true, 'confirmed', 2), ('other_account', false, 'none', 0)");
      const say = async (ip: string, tweetId: string) => {
        const id = await register(t, ip);
        await signed(t, id, 'POST', '/api/v1/votes', vote('seeded', 'slop', { tweetId }));
        return id;
      };
      const first = await say('198.51.100.20', '101');
      await say('192.0.2.20', '102');
      const sameNetwork = await say('192.0.2.21', '103');
      await say('203.0.113.20', '104');
      await say('203.0.114.20', '105');
      await say('203.0.115.20', '107');
      // 104: written by someone else. 105: not checked yet. 107: checked for another account.
      await tdb.db.query(
        `insert into evidence (tweet_id, handle, x_user_id, ok) values ('101', 'seeded', '9', true), ('102', 'seeded', '9', true),
           ('103', 'seeded', '9', true), ('104', 'seeded', '10', false), ('106', 'seeded', '9', true), ('107', 'other_account', '9', true)`,
      );
      await tdb.db.query("update votes set created_at = created_at - interval '2 hours' where install_id = $1", [first.installId]);
      await tdb.db.query("update votes set created_at = created_at - interval '1 hour' where install_id = $1", [sameNetwork.installId]);
      // A re-vote changes the post but does not move the vote to the front.
      await signed(t, first, 'POST', '/api/v1/votes', vote('seeded', 'slop', { tweetId: '106' }));
      const ev = (await t.app.inject({ url: '/api/v1/accounts/seeded' })).json().evidence as { tweetId: string }[];
      expect(ev.map((e) => e.tweetId)).toEqual(['102', '106']);
    });
    it('shows no evidence for an account that is not listed', async () => {
      const a = await register(t);
      await signed(t, a, 'POST', '/api/v1/votes', vote('victim', 'slop', { text: 'invented claim about a real person' }));
      expect((await t.app.inject({ url: '/api/v1/accounts/victim' })).json().evidence).toEqual([]);
    });
    it('rejects bad handles and limits each network to 60 per minute', async () => {
      for (const h of ['a.b', 'x'.repeat(16), '%20']) expect((await t.app.inject({ url: `/api/v1/accounts/${h}` })).statusCode).toBe(400);
      expect((await t.app.inject({ url: '/api/v1/accounts/ok?q=1' })).statusCode).toBe(400);
      for (let i = 0; i < 60; i++) await t.app.inject({ url: '/api/v1/accounts/ok', headers: fromIp('203.0.113.4') });
      expect((await t.app.inject({ url: '/api/v1/accounts/ok', headers: fromIp('203.0.113.4') })).statusCode).toBe(429);
      t.clock.advance(1000);
      expect((await t.app.inject({ url: '/api/v1/accounts/ok', headers: fromIp('203.0.113.4') })).statusCode).toBe(200);
    });
  });

  describe('appeals', () => {
    beforeEach(async () => {
      await tdb.db.query("insert into accounts (handle, status, tier) values ('listed', 'confirmed', 2), ('free', 'none', 0)");
    });
    const appeal = async (over: Record<string, unknown> = {}, ip = '192.0.2.10') =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/appeals',
        headers: fromIp(ip),
        payload: { handle: '@Listed', email: 'me@example.org', message, ...(await getChallenge(t, 'appeal', ip)), ...over },
      });

    it('opens an appeal with a bio code, one open appeal per handle and network, and reports its status', async () => {
      const r = await appeal();
      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body.code).toMatch(/^xslop-[A-HJ-NP-Z2-9]{6}$/);
      expect(body.status).toBe('open');
      const s = await t.app.inject({ url: `/api/v1/appeals/${body.appealId}` });
      expect(s.json()).toEqual({ appealId: body.appealId, handle: 'listed', status: 'open', createdAt: expect.stringMatching(/Z$/), decidedAt: null });
      const sameNetwork = await appeal({}, '192.0.2.11');
      expect([sameNetwork.statusCode, sameNetwork.json().error.code]).toEqual([409, 'appeal_open']);
      // An appeal from another network is not blocked by the first one.
      const owner = await appeal({}, '192.0.3.10');
      expect(owner.statusCode).toBe(201);
      expect(owner.json().code).not.toBe(body.code);
      expect((await t.app.inject({ url: '/api/v1/accounts/listed' })).json().appealOpen).toBe(true);
      const row = await tdb.db.query<{ ip_hash: string; email: string }>('select ip_hash, email from appeals');
      expect(row.rows).toHaveLength(2);
      expect(row.rows[0]!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    });
    it('R2-4 six networks with open appeals do not lock the owner out; one network still holds one place per handle', async () => {
      for (let i = 0; i < 6; i++) expect((await appeal({}, `192.0.${30 + i}.1`)).statusCode).toBe(201);
      const owner = await appeal({}, '192.0.40.1');
      expect(owner.statusCode).toBe(201);
      expect((await tdb.db.query("select 1 from appeals where status = 'open'")).rows).toHaveLength(7);
      const second = await appeal({}, '192.0.40.2');
      expect([second.statusCode, second.json().error.code]).toEqual([409, 'appeal_open']);
      // A refused appeal does not use its challenge, and a decision frees the place of that network.
      expect((await tdb.db.query('select 1 from used_challenges')).rows).toHaveLength(7);
      await tdb.db.query("update appeals set status = 'rejected', decided_at = now() where id = $1", [owner.json().appealId]);
      expect((await appeal({}, '192.0.40.2')).statusCode).toBe(201);
    });
    it('opens no appeal for an account that left the list', async () => {
      await tdb.db.query("update accounts set status = 'cleared', tier = 0 where handle = 'listed'");
      const r = await appeal();
      expect([r.statusCode, r.json().error.code]).toEqual([404, 'not_listed']);
      expect((await tdb.db.query('select 1 from appeals')).rows).toHaveLength(0);
      expect((await tdb.db.query('select 1 from used_challenges')).rows).toHaveLength(0);
    });
    it('rejects unlisted accounts, bad proofs, wrong purposes and bad fields', async () => {
      let n = 20;
      const ip = () => `192.0.${n++}.1`;
      const notListed = await appeal({ handle: 'free' }, ip());
      expect([notListed.statusCode, notListed.json().error.code]).toEqual([404, 'not_listed']);
      const installPow = await getChallenge(t, 'install');
      const wrongPurpose = await appeal(installPow, ip());
      expect([wrongPurpose.statusCode, wrongPurpose.json().error.code]).toEqual([400, 'invalid_challenge']);
      for (const over of [{ message: 'too short' }, { message: ' '.repeat(30) }, { message: `${message}\u0000` }, { email: 'not-an-email' }, { email: 'me\u0000@example.org' }, { handle: 'bad handle' }, { extra: 1 }]) {
        expect((await appeal(over, ip())).statusCode).toBe(400);
      }
      expect((await appeal({ email: null }, ip())).statusCode).toBe(201);
    });
    it('limits each network to 3 appeals per hour', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier) values ('l2', 'flagged', 1), ('l3', 'flagged', 1), ('l4', 'flagged', 1)");
      for (const h of ['listed', 'l2', 'l3']) expect((await appeal({ handle: h }, '192.0.2.10')).statusCode).toBe(201);
      expect((await appeal({ handle: 'l4' }, '192.0.2.11')).statusCode).toBe(429);
    });
    it('answers 404 for an unknown appeal and 400 for a bad id', async () => {
      expect((await t.app.inject({ url: '/api/v1/appeals/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
      expect((await t.app.inject({ url: '/api/v1/appeals/123' })).statusCode).toBe(400);
    });
  });

  it('serves stats, cached for 60 seconds', async () => {
    // Only listed accounts count: a status with its tier, never a moved row (round 2: the stats counted rows that the list leaves out).
    await tdb.db.query(
      `insert into accounts (handle, status, tier, identity) values ('a', 'confirmed', 2, 'ok'), ('b', 'flagged', 1, 'gone'), ('c', 'none', 0, 'ok'),
         ('moved_row', 'confirmed', 2, 'moved'), ('tierless', 'confirmed', 0, 'ok'), ('pend', 'pending', 0, 'ok')`,
    );
    const r = await t.app.inject({ url: '/api/v1/stats' });
    expect(r.json()).toEqual({ confirmed: 1, flagged: 1, votes: 0, installs: 0, sightings: 0, generatedAt: expect.stringMatching(/Z$/) });
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    await tdb.db.query("insert into accounts (handle, status, tier) values ('d', 'confirmed', 2)");
    expect((await t.app.inject({ url: '/api/v1/stats' })).json().confirmed).toBe(1);
    t.clock.advance(60_001);
    expect((await t.app.inject({ url: '/api/v1/stats' })).json().confirmed).toBe(2);
  });

  it('never lets a shared cache store a failed stats request', async () => {
    const broken = await makeApp({ ...tdb.db, query: () => Promise.reject(new Error('database is down')) });
    const r = await broken.app.inject({ url: '/api/v1/stats' });
    expect([r.statusCode, r.headers['cache-control']]).toEqual([500, 'no-store']);
  });

  it('never answers a malformed URL with a server error', async () => {
    for (const url of ['/%ZZ', '/api/v1/accounts/%ZZ', '/api/v1/avatars/%E0%A4%A', '/api/v1/list?x=%ZZ', '/api/v1/sloppers?q=%ff']) {
      expect((await t.app.inject({ url })).statusCode, url).toBeLessThan(500);
    }
  });

  it('serves the extension config as is, or 503 when the file is missing', async () => {
    const missing = await t.app.inject({ url: '/api/v1/config' });
    expect([missing.statusCode, missing.json().error.code]).toEqual([503, 'config_unavailable']);
    const { root, configFile } = await makeStaticRoot();
    const t2 = await makeApp(tdb.db, {}, await loadStatic(root, configFile));
    const r = await t2.app.inject({ url: '/api/v1/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ v: 1, minVersion: '1.0.0' });
    expect(r.headers).toMatchObject({ 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' });
    expect((await t2.app.inject({ url: '/api/v1/config', headers: { 'if-none-match': r.headers.etag as string } })).statusCode).toBe(304);
  });

  it('reports health from the database and the last score run', async () => {
    const before = await t.app.inject({ url: '/api/health' });
    expect([before.statusCode, before.json()]).toEqual([503, { ok: false, db: true, scoredAt: null }]);
    await tdb.db.query("insert into jobs (name, last_ok_at) values ('score', now() - interval '19 minutes')");
    expect((await t.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await tdb.db.query("update jobs set last_ok_at = now() - interval '21 minutes'");
    expect((await t.app.inject({ url: '/api/health' })).statusCode).toBe(503);
  });
});
