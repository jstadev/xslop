import { request } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { adminConfig, ADMIN_PASSWORD, ADMIN_USER, fromIp, getChallenge, makeApp, newKeys, ORIGIN, register, signed, signHeaders, type Identity, type TestApp } from './helpers/app.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';

// Regression tests of the security round of 2026-11-10 (report ids S-n).

const POST_ID_EPOCH = 1288834974657;
/** The X post id of a post written one minute before this file started; `n` keeps the ids apart. */
const T0 = Date.now() - 60_000;
const postId = (n: number) => String((BigInt(T0 - POST_ID_EPOCH - (n >> 12)) << 22n) | BigInt(n & 4095));

describe.each(BACKENDS)('security round 2026-11-10 (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    tdb = await openTestDb(backend);
  });
  afterAll(async () => {
    await tdb.close();
  });
  beforeEach(async () => {
    await tdb.reset();
    t = await makeApp(tdb.db);
  });

  it('R3-2 refuses a replayed request in the last millisecond of its clock window', async () => {
    const id = await register(t);
    const headers = await signHeaders(id, 'GET', '/api/v1/me', '', t.clock.now() + 300_000);
    expect((await t.app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
    t.clock.advance(600_000);
    const replay = await t.app.inject({ url: '/api/v1/me', headers });
    expect([replay.statusCode, replay.json().error?.code]).toEqual([401, 'replay']);
  });

  describe('S-2 a number below the float4 range in an observation', () => {
    const item = (n: number, genericScore: number, overlapScore = 0.5) => ({
      handle: 'obs_one',
      tweetId: postId(n),
      parentTweetId: null,
      parentHandle: null,
      parentAt: null,
      replyAt: new Date().toISOString(),
      textLen: 12,
      simhash: '0123456789abcdef',
      genericScore,
      overlapScore,
      hasMedia: false,
      verified: false,
    });

    it('never fails the batch, and R13 stores no score at all', async () => {
      const id = await register(t);
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [item(101, 1e-50), item(102, 0.25, 1e-46), item(103, 5e-324, 1)] });
      expect([r.statusCode, r.json()]).toEqual([202, { accepted: 3 }]);
      const { rows } = await tdb.db.query<{ tweet_id: string; generic_score: number | null; overlap_score: number | null }>('select tweet_id, generic_score, overlap_score from sightings order by tweet_id');
      expect(rows).toEqual([101, 102, 103].map((n) => ({ tweet_id: postId(n), generic_score: null, overlap_score: null })));
    });

    it('still refuses a score outside 0..1', async () => {
      const id = await register(t);
      for (const bad of [-1e-50, 1.0000001, 2]) {
        const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [item(201, bad)] });
        expect([bad, r.statusCode, r.json().error.code]).toEqual([bad, 400, 'invalid_request']);
      }
      expect((await tdb.db.query('select 1 from sightings')).rowCount).toBe(0);
    });
  });

  describe('S-4 the 30-day install budget of a network', () => {
    /** Holds every budget count until `release` runs, so the parallel requests all read the same count. */
    function gated(db: Db): { db: Db; release: () => void; waiting: () => number } {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let waiting = 0;
      const hold = async (text: string) => {
        if (!text.includes('from installs where ip_hash')) return;
        waiting++;
        await gate;
      };
      const wrap =
        (q: Db['query']): Db['query'] =>
        async <R>(text: string, params?: readonly unknown[]) => {
          const r = await q<R>(text, params);
          await hold(text);
          return r;
        };
      return {
        db: { ...db, query: wrap(db.query), tx: (fn) => db.tx((q) => fn({ query: wrap(q.query) })) },
        release: () => open(),
        waiting: () => waiting,
      };
    }

    /** Registers one install from `ip`, then adds `more` installs of the same network by SQL. Returns the network. */
    async function fill(ip: string, more: number): Promise<string> {
      const first = await register(t, ip);
      const { rows } = await tdb.db.query<{ ip_hash: string; public_key: unknown }>('select ip_hash, public_key from installs where id = $1', [first.installId]);
      await tdb.db.query('insert into installs (id, public_key, ip_hash) select gen_random_uuid(), $1::jsonb, $2 from generate_series(1, $3::int)', [JSON.stringify(rows[0]!.public_key), rows[0]!.ip_hash, more]);
      return rows[0]!.ip_hash;
    }

    it('holds at 1000 when the last free place gets four requests at once', async () => {
      const ip = '203.0.113.50';
      const network = await fill(ip, 998);
      const g = gated(tdb.db);
      const slow = await makeApp(g.db);
      const pows = [];
      for (let i = 0; i < 4; i++) pows.push({ publicKey: (await newKeys()).publicKey, ...(await getChallenge(slow, 'install', ip)) });
      const sent = pows.map((payload) => slow.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: { ...payload, extVersion: '1.1.3' } }));
      // On the unfixed code all four counts ran before any insert. With the fix the lock lets one count run at a time.
      const deadline = Date.now() + 600;
      while (g.waiting() < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      g.release();
      const codes = (await Promise.all(sent)).map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 429, 429, 429]);
      const stored = await tdb.db.query<{ n: number }>('select count(*)::int as n from installs where ip_hash = $1', [network]);
      expect(stored.rows[0]!.n).toBe(1000);
    });

    it('still registers on another network and reports the wait on a full one', async () => {
      const ip = '203.0.113.51';
      await fill(ip, 999);
      const pow = await getChallenge(t, 'install', ip);
      const full = await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: { publicKey: (await newKeys()).publicKey, ...pow, extVersion: '1.1.3' } });
      expect([full.statusCode, full.json().error.code]).toEqual([429, 'rate_limited']);
      expect(full.headers['retry-after']).toBe('3600');
      // The refused request did not use its challenge: only the first registration did.
      expect((await tdb.db.query('select 1 from used_challenges')).rowCount).toBe(1);
      await expect(register(t, '203.0.114.51')).resolves.toMatchObject({ installId: expect.any(String) });
    });
  });
});

// The limit lives in memory and the insert is the one that S-2 runs on both databases, so PGlite is enough here.
describe('S-5 the sightings that all networks together store in an hour', () => {
  const CAP = 10_000;
  let serial = 0;
  let tdb: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    tdb = await openTestDb('pglite');
    t = await makeApp(tdb.db);
  });
  afterAll(async () => {
    await t.app.close();
    await tdb.close();
  });
  /** 100 sightings, each with its own handle and tweet id: the per-handle limit never applies. */
  const batch = () => ({
    items: Array.from({ length: 100 }, () => {
      const n = ++serial;
      return {
        handle: `u${n.toString(36)}`,
        tweetId: postId(n),
        parentTweetId: null,
        parentHandle: null,
        parentAt: null,
        replyAt: new Date().toISOString(),
        textLen: 20,
        simhash: '0123456789abcdef',
        genericScore: 0.5,
        overlapScore: 0.5,
        hasMedia: false,
        verified: false,
      };
    }),
  });
  const stored = async () => (await tdb.db.query<{ n: number }>('select count(*)::int as n from sightings')).rows[0]!.n;

  it('stops at 10,000 rows, drops the rest without an error, and stores again after the hour', { timeout: 120_000 }, async () => {
    // Four networks with two installs each may send 12,000 items in an hour (3,000 per network, 1,500 per install).
    const installs = [];
    for (let net = 0; net < 4; net++) for (let i = 0; i < 2; i++) installs.push({ id: await register(t, `203.0.${120 + net}.9`), ip: `203.0.${120 + net}.9` });
    const accepted: number[] = [];
    for (let round = 0; round < 15; round++) {
      for (const { id, ip } of installs) {
        const r = await signed(t, id, 'POST', '/api/v1/observations', batch(), { headers: fromIp(ip) });
        expect(r.statusCode).toBe(202);
        accepted.push((r.json() as { accepted: number }).accepted);
      }
    }
    expect(await stored()).toBe(CAP);
    expect(accepted.length).toBe(120);
    expect(accepted.slice(0, 100).every((n) => n === 100)).toBe(true);
    expect(accepted.slice(100).every((n) => n === 0)).toBe(true);

    // A dropped batch used none of the budget of its handles: the same sighting lands after the cap frees.
    const fresh = await register(t, '203.0.130.9');
    const again = batch();
    const dropped = await signed(t, fresh, 'POST', '/api/v1/observations', again, { headers: fromIp('203.0.130.9') });
    expect([dropped.statusCode, dropped.json()]).toEqual([202, { accepted: 0 }]);
    t.clock.advance(36 * 60_000);
    const later = await signed(t, fresh, 'POST', '/api/v1/observations', again, { headers: fromIp('203.0.130.9') });
    expect([later.statusCode, later.json()]).toEqual([202, { accepted: 100 }]);
    expect(await stored()).toBe(CAP + 100);
  });
});

// Round 2 (report id R2-1). The limit lives in memory, like S-5, so PGlite is enough here.
describe('R2-1 the sightings that one network of registration stores in a day', () => {
  const CAP = 10_000;
  let serial = 0;
  let tdb: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    tdb = await openTestDb('pglite');
    t = await makeApp(tdb.db);
  });
  afterAll(async () => {
    await t.app.close();
    await tdb.close();
  });
  /** 100 sightings, each with its own handle and tweet id: the per-handle limit never applies. */
  const batch = () => ({
    items: Array.from({ length: 100 }, () => {
      const n = ++serial;
      return {
        handle: `n${n.toString(36)}`,
        tweetId: postId(20_000 + n),
        parentTweetId: null,
        parentHandle: null,
        parentAt: null,
        replyAt: new Date().toISOString(),
        textLen: 20,
        simhash: '0123456789abcdef',
        genericScore: 0.5,
        overlapScore: 0.5,
        hasMedia: false,
        verified: false,
      };
    }),
  });
  const send = async (id: Identity, from: string) => {
    const r = await signed(t, id, 'POST', '/api/v1/observations', batch(), { headers: fromIp(from) });
    expect(r.statusCode).toBe(202);
    return (r.json() as { accepted: number }).accepted;
  };
  const stored = async () => (await tdb.db.query<{ n: number }>('select count(*)::int as n from sightings')).rows[0]!.n;

  it('stops one network at 10,000 rows, from whatever address its installs send, and a second network still stores', { timeout: 120_000 }, async () => {
    // Seven installs of one /24. The network may register 5 an hour, so the last two come 24 minutes later.
    const installs: Identity[] = [];
    for (let i = 0; i < 7; i++) {
      if (i === 5) t.clock.advance(24 * 60_000);
      installs.push(await register(t, `203.0.140.${10 + i}`));
    }
    // Each install sends from an address of its own, so the hourly limit per sending network (3,000) never applies.
    const accepted: number[] = [];
    for (let n = 0; n < 100; n++) {
      const k = Math.floor(n / 15);
      accepted.push(await send(installs[k]!, `198.18.${k}.1`));
    }
    expect(accepted.every((n) => n === 100)).toBe(true);
    expect(await stored()).toBe(CAP);

    // Six minutes later the hourly cap of all networks holds 1,000 again. The day cap of this network holds 41.
    t.clock.advance(6 * 60_000);
    expect(await send(installs[6]!, '198.18.6.1')).toBe(0);
    expect(await stored()).toBe(CAP);
    // The key is the network of registration: a second network stores, also from an address of the first one.
    const other = await register(t, '203.0.141.10');
    expect(await send(other, '203.0.140.200')).toBe(100);
    expect(await stored()).toBe(CAP + 100);
  });
});

// S-1 needs no second database. The other tests here are not findings: they keep the two rules that every
// other limit and the list itself stand on.
describe('headers, the client network and the admin guard', () => {
  let tdb: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    tdb = await openTestDb('pglite');
    t = await makeApp(tdb.db, { admin: await adminConfig() });
  });
  afterAll(async () => {
    await t.app.close();
    await tdb.close();
  });

  /** The challenge route allows 30 an hour per network, so the 31st request shows which network a request counted for. */
  const challenge = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => t.app.inject({ url: '/api/v1/challenge', headers, remoteAddress });
  const drain = async (headers: (i: number) => Record<string, string>, remoteAddress?: string): Promise<number> => {
    let ok = 0;
    for (let i = 0; i < 31; i++) if ((await challenge(headers(i), remoteAddress)).statusCode === 200) ok++;
    return ok;
  };

  it('has no column for an address, and only a vote and the copy of a vote that a clear keeps name an install', async () => {
    const { rows } = await tdb.db.query<{ t: string; c: string; type: string }>(
      'select table_name as t, column_name as c, data_type as type from information_schema.columns where table_schema = current_schema()',
    );
    expect(rows.length).toBeGreaterThan(60);
    expect(rows.filter((x) => x.type === 'inet' || x.type === 'cidr' || /(^|_)(ip|addr|address)$/.test(x.c))).toEqual([]);
    expect(rows.filter((x) => x.c.includes('install')).map((x) => `${x.t}.${x.c}`).sort()).toEqual(['cleared_votes.install_id', 'votes.install_id']);
  });

  it('R3-1 ends a request that is not complete after 30 seconds, so a body that never ends holds no connection', () => {
    expect([t.app.server.requestTimeout, t.app.server.headersTimeout]).toEqual([30_000, 30_000]);
  });

  describe('S-1 every answer without its own cache rule is no-store', () => {
    it('keeps no-store when the path reaches an API route through a percent-encoded prefix', async () => {
      const login = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN, ...fromIp('198.51.100.21') }, payload: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      for (const url of ['/api/admin/session', '/%61pi/admin/session', '/api/%61dmin/session', '/%61%70%69/admin/session']) {
        const r = await t.app.inject({ url, headers: { cookie, ...fromIp('198.51.100.21') } });
        expect([url, r.statusCode, typeof r.json().csrf, r.headers['cache-control']]).toEqual([url, 200, 'string', 'no-store']);
      }
      for (const url of ['/%61pi/v1/accounts/abc', '/%61pi/v1/challenge', '/%61pi/health', '/%61pi/admin/overview']) {
        expect([url, (await t.app.inject({ url, headers: fromIp('198.51.100.22') })).headers['cache-control']]).toEqual([url, 'no-store']);
      }
    });

    it('leaves the routes that state their own cache rule alone', async () => {
      const stats = await t.app.inject({ url: '/api/v1/stats', headers: fromIp('198.51.100.23') });
      expect([stats.statusCode, stats.headers['cache-control']]).toEqual([200, 'public, max-age=60']);
      const unknown = await t.app.inject({ method: 'POST', url: '/nope', headers: fromIp('198.51.100.23'), payload: {} });
      expect([unknown.statusCode, unknown.headers['cache-control']]).toEqual([404, 'no-store']);
    });
  });

  it('takes the last X-Forwarded-For value, the one that the proxy appended: a value that the client sent first changes nothing', async () => {
    expect(await drain((i) => ({ 'x-forwarded-for': `10.${i}.0.1, 203.0.113.7` }))).toBe(30);
    expect((await challenge({ 'x-forwarded-for': '198.18.0.1, 203.0.113.200' })).statusCode).toBe(429);
    expect((await challenge({ 'x-forwarded-for': '203.0.113.7, 198.18.0.1' })).statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For from a peer that is not the local proxy, so a direct client cannot name its network', async () => {
    expect(await drain((i) => ({ 'x-forwarded-for': `10.${i}.1.1` }), '192.0.2.44')).toBe(30);
    expect((await challenge({ 'x-forwarded-for': '10.99.1.1' }, '192.0.2.99')).statusCode).toBe(429);
    expect((await challenge({ 'x-forwarded-for': '192.0.2.44' }, '198.51.100.44')).statusCode).toBe(200);
  });

  it('counts an IPv4-mapped address with its IPv4 network, and every address it cannot read as one shared network', async () => {
    expect(await drain(() => ({ 'x-forwarded-for': '::ffff:203.0.115.9' }))).toBe(30);
    expect((await challenge({ 'x-forwarded-for': '203.0.115.200' })).statusCode).toBe(429);
    expect(await drain((i) => ({ 'x-forwarded-for': `not-an-address-${i}` }))).toBe(30);
    expect((await challenge({ 'x-forwarded-for': '1.2.3.4:5555' })).statusCode).toBe(429);
  });

  it('answers no admin route without a session, with or without the site Origin', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: [string, string][] = [
      ['GET', '/api/admin/session'], ['POST', '/api/admin/logout'], ['GET', '/api/admin/appeals'], ['POST', `/api/admin/appeals/${id}/decide`],
      ['GET', '/api/admin/accounts'], ['POST', '/api/admin/accounts/abc'], ['GET', '/api/admin/installs'], ['POST', `/api/admin/installs/${id}/ban`],
      ['POST', `/api/admin/installs/${id}/unban`], ['GET', '/api/admin/overview'], ['HEAD', '/api/admin/overview'],
      ['GET', '/api/admin/review'], ['GET', '/api/admin/log'], ['POST', '/api/admin/accounts/abc/ban-voters'],
      ['POST', `/api/admin/installs/${id}/trust`], ['POST', `/api/admin/installs/${id}/untrust`],
      ['GET', '/api/admin/activity'], ['GET', '/api/admin/accounts/abc'], ['GET', `/api/admin/installs/${id}`], ['GET', '/api/admin/lists'],
      ['GET', '/api/admin/jobs'], ['HEAD', '/api/admin/activity'],
    ];
    for (const [method, url] of routes) {
      const write = method === 'POST';
      const bare = await t.app.inject({ method: method as 'GET', url });
      expect([method, url, bare.statusCode]).toEqual([method, url, write ? 403 : 401]);
      const forged = await t.app.inject({
        method: method as 'GET',
        url,
        headers: { origin: ORIGIN, 'x-csrf': 'A'.repeat(43), cookie: `__Host-xs_admin=${'A'.repeat(43)}` },
        ...(write ? { payload: {} } : {}),
      });
      expect([method, url, forged.statusCode]).toEqual([method, url, 401]);
    }
    for (const [method, url] of [['GET', '/api/admin/nope'], ['DELETE', '/api/admin/session'], ['PUT', '/api/admin/accounts/abc'], ['GET', '/api/admin']] as const) {
      expect([method, url, (await t.app.inject({ method, url })).statusCode]).toEqual([method, url, 404]);
    }
    expect((await tdb.db.query('select 1 from accounts')).rowCount).toBe(0);
  });
});

describe('S-3 a URL that the router cannot decode', () => {
  const PORT = 14210;
  let tdb: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    tdb = await openTestDb('pglite');
    t = await makeApp(tdb.db);
    await t.app.listen({ host: '127.0.0.1', port: PORT });
  });
  afterAll(async () => {
    await t.app.close();
    await tdb.close();
  });

  const get = (path: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

  it('gets the error shape and the API headers, and the answer never repeats the path', async () => {
    for (const path of ['/%ZZ', '/api/v1/accounts/%E0%A4%A', '/api/v1/avatars/%ff"<script>alert(1)</script>', '/%c0%af']) {
      const r = await get(path);
      expect([path, r.status, JSON.parse(r.body)]).toEqual([path, 400, { error: { code: 'bad_request', message: 'The request is not valid.' } }]);
      expect(r.headers).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      expect(r.body).not.toContain('script');
    }
  });

  it('still serves a good URL on the same socket server', async () => {
    const r = await get('/api/v1/accounts/abc');
    expect([r.status, JSON.parse(r.body).status]).toEqual([200, 'none']);
  });
});
