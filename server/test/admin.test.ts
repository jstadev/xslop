import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, loggerOptions } from '../src/app.js';
import type { Db } from '../src/db.js';
import { runScoreJob } from '../src/jobs/score-job.js';
import { hotp } from '../src/lib/crypto.js';
import { computeScores } from '../src/scoring/index.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { ADMIN_PASSWORD, ADMIN_USER, adminConfig, fromIp, getChallenge, makeApp, NO_FILES, ORIGIN, register, signed, testConfig, type TestApp } from './helpers/app.js';

describe.each(BACKENDS)('admin API (%s)', (backend) => {
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

  const login = (username = ADMIN_USER, password = ADMIN_PASSWORD, headers: Record<string, string> = { origin: ORIGIN }) =>
    t.app.inject({ method: 'POST', url: '/api/admin/login', headers, payload: { username, password } });

  async function session(): Promise<{ cookie: string; csrf: string; token: string }> {
    const r = await login();
    expect(r.statusCode).toBe(200);
    const setCookie = r.headers['set-cookie'] as string;
    const token = /^__Host-xs_admin=([^;]+);/.exec(setCookie)![1]!;
    return { cookie: `__Host-xs_admin=${token}`, csrf: r.json().csrf, token };
  }
  const write = (s: { cookie: string; csrf: string }, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf': s.csrf, origin: ORIGIN, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

  describe('login', () => {
    it('sets a strict session cookie and stores only its hash', async () => {
      const r = await login();
      const setCookie = r.headers['set-cookie'] as string;
      expect(setCookie).toMatch(/^__Host-xs_admin=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/);
      expect(setCookie).not.toMatch(/Domain=/i);
      expect(r.json().csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const token = /^__Host-xs_admin=([^;]+);/.exec(setCookie)![1]!;
      const { rows } = await tdb.db.query<{ token_hash: string; expires_at: Date }>('select token_hash, expires_at from admin_sessions');
      expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]!.expires_at.getTime() - Date.now()).toBeGreaterThan(43_100_000);
      const s = await t.app.inject({ url: '/api/admin/session', headers: { cookie: `__Host-xs_admin=${token}` } });
      expect(s.json()).toEqual({ user: ADMIN_USER, csrf: r.json().csrf });
      // The old cookie name is not a session any more.
      expect((await t.app.inject({ url: '/api/admin/session', headers: { cookie: `xs_admin=${token}` } })).statusCode).toBe(401);
    });
    it('rejects a wrong password and a wrong user in about the same time', async () => {
      const time = async (user: string, pw: string, ip: string) => {
        const t0 = performance.now();
        const r = await login(user, pw, { origin: ORIGIN, ...fromIp(ip) });
        expect([r.statusCode, r.json().error.code]).toEqual([401, 'invalid_credentials']);
        expect(r.headers['set-cookie']).toBeUndefined();
        return performance.now() - t0;
      };
      const badPw: number[] = [];
      const badUser: number[] = [];
      for (let i = 0; i < 3; i++) {
        badPw.push(await time(ADMIN_USER, 'wrong password here', `203.0.${i}.1`));
        badUser.push(await time('intruder', ADMIN_PASSWORD, `203.1.${i}.1`));
      }
      // Both paths run the full scrypt: a bad user is not answered early.
      expect(Math.min(...badUser) / Math.min(...badPw)).toBeGreaterThan(0.5);
    });
    it('locks a network out after 5 failures in 15 minutes, even with the right password', async () => {
      for (let i = 0; i < 5; i++) expect((await login(ADMIN_USER, `wrong ${i}`)).statusCode).toBe(401);
      const locked = await login();
      expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'rate_limited']);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await login(ADMIN_USER, ADMIN_PASSWORD, { origin: ORIGIN, ...fromIp('198.51.100.5') })).statusCode).toBe(200);
      t.clock.advance(180_001);
      expect((await login()).statusCode).toBe(200);
    });
    it('does not count successful logins as failures', async () => {
      for (let i = 0; i < 6; i++) expect((await login()).statusCode).toBe(200);
    });
    it('R3-3 checks at most two passwords at a time, whatever the number of networks; a busy answer costs no attempt', async () => {
      const net = (i: number) => ({ origin: ORIGIN, ...fromIp(`203.0.${i}.1`) });
      const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => login(ADMIN_USER, 'a wrong password', net(i))));
      expect(burst.map((r) => r.statusCode).sort()).toEqual([401, 401, 429, 429, 429, 429]);
      const busy = burst.findIndex((r) => r.statusCode === 429);
      expect([burst[busy]!.json().error.code, burst[busy]!.headers['retry-after']]).toEqual(['rate_limited', '1']);
      for (let i = 0; i < 5; i++) expect((await login(ADMIN_USER, `wrong ${i}`, net(busy))).statusCode).toBe(401);
      expect((await login(ADMIN_USER, ADMIN_PASSWORD, net(busy))).statusCode).toBe(429);
    });
    it('rejects a missing or foreign Origin, bad bodies, and a disabled admin', async () => {
      expect((await login(ADMIN_USER, ADMIN_PASSWORD, {})).json().error.code).toBe('bad_origin');
      expect((await login(ADMIN_USER, ADMIN_PASSWORD, { origin: 'https://evil.test' })).statusCode).toBe(403);
      const r = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { username: ADMIN_USER, password: ADMIN_PASSWORD, role: 'root' } });
      expect(r.statusCode).toBe(400);
      const off = await makeApp(tdb.db);
      const d = await off.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { username: 'a', password: 'b' } });
      expect([d.statusCode, d.json().error.code]).toEqual([503, 'admin_disabled']);
    });
  });

  describe('session guard', () => {
    it('needs a valid session cookie on every route', async () => {
      for (const url of ['/api/admin/session', '/api/admin/overview', '/api/admin/appeals', '/api/admin/accounts', '/api/admin/installs']) {
        const r = await t.app.inject({ url });
        expect([r.statusCode, r.json().error.code]).toEqual([401, 'unauthorized']);
        expect((await t.app.inject({ url, headers: { cookie: `__Host-xs_admin=${'A'.repeat(43)}` } })).statusCode).toBe(401);
      }
    });
    it('needs x-csrf and the site Origin on every write', async () => {
      const s = await session();
      const url = '/api/admin/accounts/someone';
      const noCsrf = await t.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, origin: ORIGIN }, payload: { action: 'confirm' } });
      expect([noCsrf.statusCode, noCsrf.json().error.code]).toEqual([403, 'bad_csrf']);
      expect((await write(s, url, { action: 'confirm' }, { 'x-csrf': 'x'.repeat(43) })).json().error.code).toBe('bad_csrf');
      const wrongOrigin = await write(s, url, { action: 'confirm' }, { origin: 'https://evil.test' });
      expect([wrongOrigin.statusCode, wrongOrigin.json().error.code]).toEqual([403, 'bad_origin']);
      const noOrigin = await t.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf': s.csrf }, payload: { action: 'confirm' } });
      expect(noOrigin.json().error.code).toBe('bad_origin');
      expect((await tdb.db.query('select 1 from accounts')).rows.length).toBe(0);
      expect((await write(s, url, { action: 'confirm' })).statusCode).toBe(200);
    });
    it('A4 limits admin changes to 30 per minute, so a stolen session cannot rewrite the list in one burst', async () => {
      const s = await session();
      for (let i = 0; i < 30; i++) expect((await write(s, `/api/admin/accounts/slop_${i}`, { action: 'confirm' })).statusCode).toBe(200);
      const r = await write(s, '/api/admin/accounts/slop_30', { action: 'confirm' });
      expect([r.statusCode, r.json().error?.code, r.headers['retry-after']]).toEqual([429, 'rate_limited', '2']);
      expect((await tdb.db.query('select 1 from accounts')).rows.length).toBe(30);
      expect((await t.app.inject({ url: '/api/admin/overview', headers: { cookie: s.cookie } })).statusCode).toBe(200);
      t.clock.advance(2_000);
      expect((await write(s, '/api/admin/accounts/slop_30', { action: 'confirm' })).statusCode).toBe(200);
    });
    it('rejects an expired session and ends a session on logout', async () => {
      const s = await session();
      const out = await write(s, '/api/admin/logout');
      expect(out.statusCode).toBe(204);
      expect(out.headers['set-cookie']).toMatch(/^__Host-xs_admin=; .*Max-Age=0$/);
      expect((await t.app.inject({ url: '/api/admin/session', headers: { cookie: s.cookie } })).statusCode).toBe(401);
      const s2 = await session();
      await tdb.db.query("update admin_sessions set expires_at = now() - interval '1 second'");
      expect((await t.app.inject({ url: '/api/admin/session', headers: { cookie: s2.cookie } })).statusCode).toBe(401);
    });
  });

  describe('actions', () => {
    it('R3-4 writes one log line per admin change with the action and its target, and no secret', async () => {
      const lines: string[] = [];
      const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
      const app = await buildApp({ db: tdb.db, config: testConfig({ admin }), files: NO_FILES, logger: { ...loggerOptions, stream } });
      const install = '22222222-2222-4222-8222-222222222222';
      await tdb.db.query("insert into installs (id, public_key, ip_hash) values ($1, '{}', 'net')", [install]);
      const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
      const cookie = (r.headers['set-cookie'] as string).split(';')[0]!;
      const post = (url: string, payload?: object) =>
        app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf': r.json().csrf, origin: ORIGIN }, ...(payload ? { payload } : {}) });
      expect((await post('/api/admin/accounts/@SomeOne', { action: 'confirm' })).statusCode).toBe(200);
      expect((await post('/api/admin/accounts/nobody', { action: 'reset' })).statusCode).toBe(404);
      expect((await post(`/api/admin/installs/${install}/ban`)).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/admin/overview', headers: { cookie } })).statusCode).toBe(200);
      await app.close();
      const actions = lines.map((l) => JSON.parse(l) as Record<string, string>).filter((l) => l.msg === 'admin action');
      expect(actions.map((l) => [l.action, l.target])).toEqual([['login', expect.stringMatching(/^[0-9a-f]{16}$/)], ['confirm', 'someone'], ['ban', install]]);
      for (const secret of [cookie.split('=')[1]!, r.json().csrf, ADMIN_PASSWORD, '203.0.113']) expect(lines.join('')).not.toContain(secret);
    });
    // PGlite has one connection, so only Postgres can hold two transactions against each other.
    it.runIf(backend === 'postgres')('R3-5 an accept and a new appeal of the same network take their locks in one order: no deadlock, no 500', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier, score) values ('listed', 'confirmed', 2, 0.9)");
      const appeal = async (pow: { challenge: string; nonce: string }) =>
        t.app.inject({ method: 'POST', url: '/api/v1/appeals', headers: fromIp('203.0.113.9'), payload: { handle: 'listed', message: 'This account is run by a person, not a bot.', ...pow } });
      const first = await appeal(await getChallenge(t, 'appeal', '203.0.113.9'));
      const s = await session();
      // An open transaction holds the challenge of the second appeal, so that appeal stops between its two locks.
      const pow = await getChallenge(t, 'appeal', '203.0.113.9');
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect();
      await holder.query('begin');
      await holder.query("insert into used_challenges (challenge_hash, expires_at) values ($1, now() + interval '10 minutes')", [createHash('sha256').update(pow.challenge).digest('hex')]);
      const waiting = async (n: number) => {
        for (let i = 0; i < 250; i++) {
          // Not on `holder`: inside a transaction pg_stat_activity keeps its first answer.
          const { rows } = await tdb.db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event in ('transactionid', 'tuple')");
          if (rows[0]!.n >= n) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`${n} transactions should wait for a lock`);
      };
      const second = appeal(pow);
      let accept: Promise<Awaited<ReturnType<typeof write>>>;
      try {
        await waiting(1);
        // inject() sends nothing before then() is called.
        accept = write(s, `/api/admin/appeals/${first.json().appealId}/decide`, { decision: 'accept' }).then((r) => r);
        await waiting(2);
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
      expect([(await second).json().error?.code, (await accept).json().status]).toEqual(['appeal_open', 'accepted']);
    });
    it('lists and decides appeals; accept clears the account', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier, score) values ('listed', 'confirmed', 2, 0.9), ('other', 'flagged', 1, 0.5)");
      const open = async (handle: string, ip = `192.0.${handle.length}.1`) =>
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/appeals',
            headers: fromIp(ip),
            payload: { handle, email: null, message: 'I write my own replies, please check my profile.', ...(await getChallenge(t, 'appeal')) },
          })
        ).json().appealId as string;
      const a1 = await open('listed');
      const a2 = await open('other');
      const a3 = await open('listed', '198.51.100.40');
      const s = await session();
      const list = (await t.app.inject({ url: '/api/admin/appeals', headers: { cookie: s.cookie } })).json();
      expect(list.appeals.map((x: { appealId: string }) => x.appealId).sort()).toEqual([a1, a2, a3].sort());
      const codes = list.appeals.filter((x: { handle: string }) => x.handle === 'listed').map((x: { code: string }) => x.code);
      expect(codes).toHaveLength(2);
      expect(new Set(codes).size).toBe(2);
      expect(list.appeals.find((x: { appealId: string }) => x.appealId === a1)).toMatchObject({ handle: 'listed', status: 'open', code: expect.stringMatching(/^xslop-/), account: { status: 'confirmed', tier: 2, score: 90 } });

      const accept = await write(s, `/api/admin/appeals/${a1}/decide`, { decision: 'accept', note: 'bio code found' });
      expect(accept.json()).toMatchObject({ appealId: a1, status: 'accepted', decidedAt: expect.stringMatching(/Z$/) });
      const acct = (await tdb.db.query<{ status: string; tier: number; override: string; cleared_at: Date | null; listed_at: Date | null }>("select status, tier, override, cleared_at, listed_at from accounts where handle = 'listed'")).rows[0]!;
      expect([acct.status, acct.tier, acct.override, acct.cleared_at instanceof Date, acct.listed_at]).toEqual(['cleared', 0, 'clear', true, null]);
      expect((await write(s, `/api/admin/appeals/${a2}/decide`, { decision: 'reject', note: null })).json().status).toBe('rejected');
      expect((await tdb.db.query("select status from accounts where handle = 'other'")).rows[0]).toEqual({ status: 'flagged' });

      const again = await write(s, `/api/admin/appeals/${a1}/decide`, { decision: 'reject' });
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'appeal_closed']);
      expect((await write(s, '/api/admin/appeals/00000000-0000-4000-8000-000000000000/decide', { decision: 'reject' })).statusCode).toBe(404);
      expect((await write(s, `/api/admin/appeals/${a1}/decide`, { decision: 'maybe' })).statusCode).toBe(400);
      expect((await write(s, `/api/admin/appeals/${a3}/decide`, { decision: 'reject', note: 'null \u0000 byte' })).statusCode).toBe(400);
      const accepted = (await t.app.inject({ url: '/api/admin/appeals?status=accepted', headers: { cookie: s.cookie } })).json();
      expect(accepted.appeals.map((x: { appealId: string; note: string | null }) => [x.appealId, x.note]).sort()).toEqual([[a1, 'bio code found'], [a3, null]].sort());
      expect((await t.app.inject({ url: '/api/admin/appeals?status=all', headers: { cookie: s.cookie } })).statusCode).toBe(400);
    });

    it('R2-4 an accept closes every other open appeal of that account in the same decision; a reject closes only its own', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier, score) values ('listed', 'confirmed', 2, 0.9), ('other', 'flagged', 1, 0.5)");
      const open = async (handle: string, ip: string) =>
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/appeals',
            headers: fromIp(ip),
            payload: { handle, email: null, message: 'I write my own replies, please check my profile.', ...(await getChallenge(t, 'appeal', ip)) },
          })
        ).json().appealId as string;
      const strangers = [];
      for (let i = 0; i < 6; i++) strangers.push(await open('listed', `192.0.${50 + i}.1`));
      const owner = await open('listed', '198.51.100.40');
      const elsewhere = [await open('other', '192.0.50.1'), await open('other', '198.51.100.40')];
      const s = await session();
      const statuses = async (handle: string) =>
        (await tdb.db.query<{ id: string; status: string; note: string | null; decided: boolean }>('select id, status, note, decided_at is not null as decided from appeals where handle = $1', [handle])).rows;

      expect((await write(s, `/api/admin/appeals/${strangers[0]}/decide`, { decision: 'reject', note: 'no code in the bio' })).json().status).toBe('rejected');
      expect((await statuses('listed')).filter((r) => r.status === 'open')).toHaveLength(6);

      const accept = await write(s, `/api/admin/appeals/${owner}/decide`, { decision: 'accept', note: 'bio code found' });
      expect(accept.json()).toMatchObject({ appealId: owner, handle: 'listed', status: 'accepted' });
      const after = await statuses('listed');
      expect(after.filter((r) => r.status === 'open')).toEqual([]);
      expect(after.filter((r) => r.status === 'rejected').map((r) => r.id)).toEqual([strangers[0]]);
      expect(after.filter((r) => r.status === 'accepted').map((r) => [r.id, r.note, r.decided]).sort()).toEqual(
        [[owner, 'bio code found', true], ...strangers.slice(1).map((id) => [id, null, true])].sort(),
      );
      // The appeals of another account stay open, and the public status of a closed appeal says accepted.
      expect((await statuses('other')).map((r) => r.status)).toEqual(['open', 'open']);
      expect(elsewhere).toHaveLength(2);
      expect((await t.app.inject({ url: `/api/v1/appeals/${strangers[1]}` })).json()).toMatchObject({ status: 'accepted', decidedAt: expect.stringMatching(/Z$/) });
      expect((await t.app.inject({ url: '/api/admin/overview', headers: { cookie: s.cookie } })).json().appealsOpen).toBe(2);
      const again = await write(s, `/api/admin/appeals/${strangers[1]}/decide`, { decision: 'reject' });
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'appeal_closed']);
    });

    it('finds accounts and applies confirm, clear and reset overrides', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier, score) values ('slop_a', 'flagged', 1, 0.7), ('slop_b', 'none', 0, 0.1), ('zed', 'confirmed', 2, 0.95)");
      const s = await session();
      const get = async (q: string) => (await t.app.inject({ url: `/api/admin/accounts${q}`, headers: { cookie: s.cookie } })).json().accounts.map((a: { handle: string }) => a.handle);
      expect(await get('')).toEqual(['zed', 'slop_a', 'slop_b']);
      expect(await get('?handle=@SLOP_')).toEqual(['slop_a', 'slop_b']);
      expect(await get('?status=confirmed')).toEqual(['zed']);
      expect(await get('?limit=1')).toEqual(['zed']);
      for (const q of ['?limit=abc', '?status=gone', '?handle=a%20b', '?x=1']) expect((await t.app.inject({ url: `/api/admin/accounts${q}`, headers: { cookie: s.cookie } })).statusCode).toBe(400);

      expect((await write(s, '/api/admin/accounts/slop_b', { action: 'confirm' })).json().account).toMatchObject({ handle: 'slop_b', status: 'confirmed', tier: 2, override: 'confirm' });
      const cleared = (await write(s, '/api/admin/accounts/zed', { action: 'clear' })).json().account;
      expect(cleared).toMatchObject({ status: 'cleared', tier: 0, override: 'clear', clearedAt: expect.stringMatching(/Z$/) });
      expect((await write(s, '/api/admin/accounts/zed', { action: 'reset' })).json().account.override).toBeNull();
      expect((await write(s, '/api/admin/accounts/brandnew', { action: 'confirm' })).json().account.status).toBe('confirmed');
      const listedAt = async (h: string) => (await tdb.db.query<{ listed_at: Date | null }>('select listed_at from accounts where handle = $1', [h])).rows[0]!.listed_at;
      // Confirm and clear set listed_at at once, not at the next score run. A confirm keeps an earlier listing time.
      expect(await listedAt('brandnew')).toBeInstanceOf(Date);
      expect(await listedAt('slop_b')).toBeInstanceOf(Date);
      await tdb.db.query("update accounts set listed_at = '2026-01-01T00:00:00Z' where handle = 'slop_b'");
      await write(s, '/api/admin/accounts/slop_b', { action: 'confirm' });
      expect((await listedAt('slop_b'))!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      await write(s, '/api/admin/accounts/slop_b', { action: 'clear' });
      expect(await listedAt('slop_b')).toBeNull();
      expect(await listedAt('zed')).toBeNull();
      // A5: a confirm withdraws the clear, so a later reset does not bring the clear and its strikes back.
      expect((await write(s, '/api/admin/accounts/slop_b', { action: 'confirm' })).json().account).toMatchObject({ status: 'confirmed', clearedAt: null });
      expect((await write(s, '/api/admin/accounts/ghost', { action: 'reset' })).statusCode).toBe(404);
      expect((await write(s, '/api/admin/accounts/zed', { action: 'delete' })).statusCode).toBe(400);
    });

    it('lists installs and bans and unbans them, which blocks signed requests', async () => {
      const a = await register(t, '198.51.100.1');
      const b = await register(t, '198.51.100.2');
      await tdb.db.query('update installs set reputation = 0.1 where id = $1', [b.installId]);
      const s = await session();
      const list = (await t.app.inject({ url: '/api/admin/installs?sort=reputation&limit=10', headers: { cookie: s.cookie } })).json();
      expect(list.installs.map((i: { id: string }) => i.id)).toEqual([b.installId, a.installId]);
      expect(list.installs[0]).toMatchObject({ reputation: 0.1, bannedAt: null, extVersion: '1.0.0', votes: 0, sameNetwork: 2, trusted: false, standing: false, goodMarks: 0, slopVotes: 0, notSlopVotes: 0 });
      const ban = await write(s, `/api/admin/installs/${a.installId}/ban`);
      expect(ban.json()).toEqual({ id: a.installId, bannedAt: expect.stringMatching(/Z$/), trusted: false });
      expect((await signed(t, a, 'GET', '/api/v1/me')).statusCode).toBe(403);
      expect((await write(s, `/api/admin/installs/${a.installId}/unban`)).json().bannedAt).toBeNull();
      expect((await signed(t, a, 'GET', '/api/v1/me')).statusCode).toBe(200);
      expect((await write(s, '/api/admin/installs/00000000-0000-4000-8000-000000000000/ban')).statusCode).toBe(404);
      expect((await write(s, '/api/admin/installs/nope/ban')).statusCode).toBe(400);
    });

    it('reports an overview', async () => {
      await tdb.db.query("insert into accounts (handle, status, seed) values ('a', 'confirmed', true), ('b', 'flagged', false), ('c', 'cleared', true), ('d', 'pending', false), ('e', 'pending', false)");
      await tdb.db.query("insert into installs (id, public_key, ip_hash, standing, trusted, banned_at) values (gen_random_uuid(), '{}', 'n1', true, true, null), (gen_random_uuid(), '{}', 'n2', true, false, null), (gen_random_uuid(), '{}', 'n3', true, false, now())");
      await tdb.db.query("insert into jobs (name, last_run_at, last_ok_at, detail) values ('score', now(), now(), '{\"listed\": 2}'::jsonb), ('profiles', now(), null, '{\"checked\": 7}'::jsonb)");
      // Rows that became moved: one today, one 2 days ago.
      await tdb.db.query("insert into accounts (handle, identity, identity_at) values ('moved_today', 'moved', now() - interval '1 hour'), ('moved_before', 'moved', now() - interval '2 days')");
      const s = await session();
      const r = (await t.app.inject({ url: '/api/admin/overview', headers: { cookie: s.cookie } })).json();
      expect(r).toEqual({
        accounts: { confirmed: 1, flagged: 1, pending: 2, cleared: 1, seed: 2 },
        votes: 0,
        installs: 3,
        bannedInstalls: 1,
        standingInstalls: 2,
        trustedInstalls: 1,
        sightings: 0,
        appealsOpen: 0,
        listVersion: null,
        score: { lastRunAt: expect.stringMatching(/Z$/), lastOkAt: expect.stringMatching(/Z$/), detail: { listed: 2 } },
        facts: { lastRunAt: expect.stringMatching(/Z$/), lastOkAt: null, detail: { checked: 7 }, moved24h: 1 },
      });
    });
  });
  /** One install per network: `slop` networks say slop, then `notSlop` networks say not slop. Returns the install ids. */
  async function crowd(handle: string, slop: number, notSlop = 0, tweetId = '1850000000000000001'): Promise<string[]> {
    await tdb.db.query('insert into accounts (handle) values ($1) on conflict do nothing', [handle]);
    const { rows } = await tdb.db.query<{ id: string }>(
      `insert into installs (id, public_key, ip_hash) select gen_random_uuid(), '{}'::jsonb, $1 || '-' || i from generate_series(1, $2::int) i returning id`,
      [handle, slop + notSlop],
    );
    const ids = rows.map((r) => r.id);
    for (const [k, id] of ids.entries()) {
      await tdb.db.query('insert into votes (install_id, handle, value, tweet_id) values ($1, $2, $3, $4)', [id, handle, k < slop ? 1 : 0, tweetId]);
    }
    return ids;
  }
  const get = (s: { cookie: string }, url: string) => t.app.inject({ url, headers: { cookie: s.cookie } });
  const logRows = async () =>
    (await tdb.db.query<{ session: string; action: string; target: string; before: Record<string, unknown> | null }>('select session, action, target, before from admin_log order by id')).rows;
  const listBody = async () => {
    const { rows } = await tdb.db.query<{ version: number; body_gzip: Uint8Array }>('select version, body_gzip from list_snapshots order by version desc limit 1');
    const { gunzipSync } = await import('node:zlib');
    return rows[0] ? (JSON.parse(gunzipSync(Buffer.from(rows[0].body_gzip)).toString('utf8')) as { version: number; accounts: [string, number, number][]; ids: (string | null)[] }) : null;
  };

  describe('login with a second factor (XSLOP_ADMIN_TOTP)', () => {
    const key = Buffer.from('a twenty byte secret');
    let t2: TestApp;
    beforeEach(async () => {
      t2 = await makeApp(tdb.db, { admin: { ...admin!, totp: key } });
    });
    const step = () => Math.floor(t2.clock.now() / 30_000);
    const login2 = (code: string | undefined, password = ADMIN_PASSWORD, ip = '198.51.100.70') =>
      t2.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN, ...fromIp(ip) }, payload: { username: ADMIN_USER, password, ...(code === undefined ? {} : { code }) } });

    it('opens a session with the right code, once, and answers a wrong, used or missing code like a wrong password', async () => {
      const wrongPassword = await login2(hotp(key, step()), 'not the password');
      expect([wrongPassword.statusCode, wrongPassword.json()]).toEqual([401, { error: { code: 'invalid_credentials', message: 'The username, password or code is wrong.' } }]);
      const code = hotp(key, step());
      const ok = await login2(code);
      expect([ok.statusCode, typeof ok.json().csrf]).toEqual([200, 'string']);
      for (const bad of [code, hotp(key, step() + 9), undefined]) {
        const r = await login2(bad, ADMIN_PASSWORD, '198.51.100.71');
        expect([String(bad), r.statusCode, r.json(), r.headers['set-cookie']]).toEqual([String(bad), 401, wrongPassword.json(), undefined]);
      }
      expect((await login2('12345', ADMIN_PASSWORD, '198.51.100.72')).statusCode).toBe(400);
    });

    it('takes the code of the step before and of the step after, and refuses two steps away', async () => {
      expect((await login2(hotp(key, step() - 2))).statusCode).toBe(401);
      expect((await login2(hotp(key, step() + 2))).statusCode).toBe(401);
      expect((await login2(hotp(key, step() - 1))).statusCode).toBe(200);
      expect((await login2(hotp(key, step() + 1))).statusCode).toBe(200);
      // A code of a step at or before the newest used one never works again.
      expect((await login2(hotp(key, step()))).statusCode).toBe(401);
      t2.clock.advance(60_000);
      expect((await login2(hotp(key, step()))).statusCode).toBe(200);
    });

    it('lets one of two parallel logins with the same code through', async () => {
      const code = hotp(key, step());
      const both = await Promise.all([login2(code, ADMIN_PASSWORD, '198.51.100.73'), login2(code, ADMIN_PASSWORD, '198.51.100.74')]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      expect((await tdb.db.query('select 1 from admin_sessions')).rowCount).toBe(1);
    });

    it('stops every login after 10 wrong codes with the right password from any networks, and not after wrong passwords', async () => {
      for (let i = 0; i < 12; i++) expect((await login2(hotp(key, step() + 5), 'a wrong password', `203.0.${60 + i}.1`)).statusCode).toBe(401);
      for (let i = 0; i < 10; i++) expect((await login2(hotp(key, step() + 5), ADMIN_PASSWORD, `203.0.${80 + i}.1`)).statusCode).toBe(401);
      const locked = await login2(hotp(key, step()), ADMIN_PASSWORD, '203.0.99.1');
      expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'rate_limited']);
      t2.clock.advance(90_000);
      expect((await login2(hotp(key, step()), ADMIN_PASSWORD, '203.0.99.1')).statusCode).toBe(200);
    });

    it('needs no code when the secret is not set, and ignores one', async () => {
      expect((await login()).statusCode).toBe(200);
      const r = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { username: ADMIN_USER, password: ADMIN_PASSWORD, code: '000000' } });
      expect(r.statusCode).toBe(200);
    });
  });

  describe('session idle limit and admin log', () => {
    it('ends a session 30 minutes after its last request, and a request keeps it open', async () => {
      const s = await session();
      await tdb.db.query("update admin_sessions set seen_at = now() - interval '29 minutes'");
      expect((await get(s, '/api/admin/session')).statusCode).toBe(200);
      const { rows } = await tdb.db.query<{ fresh: boolean }>("select seen_at > now() - interval '1 minute' as fresh from admin_sessions");
      expect(rows[0]!.fresh).toBe(true);
      await tdb.db.query("update admin_sessions set seen_at = now() - interval '31 minutes'");
      expect((await get(s, '/api/admin/session')).statusCode).toBe(401);
      expect((await write(s, '/api/admin/accounts/idle_target', { action: 'confirm' })).statusCode).toBe(401);
      expect((await tdb.db.query('select 1 from accounts')).rowCount).toBe(0);
    });

    it('writes one admin_log row per change with the state before, and serves the log newest first', async () => {
      const s = await session();
      const sessionId = createHash('sha256').update(s.token).digest('hex').slice(0, 16);
      await tdb.db.query("insert into accounts (handle, status, tier, score, listed_at) values ('logged_one', 'flagged', 1, 0.55, '2026-11-01T00:00:00Z')");
      expect((await write(s, '/api/admin/accounts/logged_one', { action: 'protect' })).statusCode).toBe(200);
      expect((await write(s, '/api/admin/accounts/missing_one', { action: 'reset' })).statusCode).toBe(404);
      const rows = await logRows();
      expect(rows.map((r) => [r.session, r.action, r.target])).toEqual([
        [sessionId, 'login', sessionId],
        [sessionId, 'protect', 'logged_one'],
      ]);
      expect(rows[1]!.before).toMatchObject({ account: { status: 'flagged', tier: 1, protected: false, override: null, listed_at: '2026-11-01T00:00:00.000Z' } });
      const log = (await get(s, '/api/admin/log?limit=1')).json();
      expect(log).toEqual({ entries: [{ id: 2, at: expect.stringMatching(/Z$/), session: sessionId, action: 'protect', target: 'logged_one', before: rows[1]!.before }] });
      for (const q of ['?limit=abc', '?limit=1000', '?x=1']) expect((await get(s, `/api/admin/log${q}`)).statusCode).toBe(400);
    });

    it('rolls the change back when its admin_log row cannot be written', async () => {
      const s = await session();
      const failing: Db = {
        ...tdb.db,
        tx: (fn) => tdb.db.tx((q) => fn({ query: (text, params) => (text.startsWith('insert into admin_log') ? Promise.reject(new Error('log is down')) : q.query(text, params)) })),
      };
      const broken = await makeApp(failing, { admin });
      const r = await broken.app.inject({ method: 'POST', url: '/api/admin/accounts/rolled_back', headers: { cookie: s.cookie, 'x-csrf': s.csrf, origin: ORIGIN }, payload: { action: 'confirm' } });
      expect(r.statusCode).toBe(500);
      expect((await tdb.db.query('select 1 from accounts')).rowCount).toBe(0);
      expect(await listBody()).toBeNull();
    });
  });

  describe('decisions', () => {
    it('a clear with penalty keeps every vote in cleared_votes, a confirm removes them, and both publish the list at once (SPEC 13.9 item 10)', async () => {
      const ids = await crowd('ring_member_ok', 3, 1);
      await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.7, x_user_id = '4242', listed_at = now() where handle = 'ring_member_ok'");
      // SPEC 13.10 item 5: each row keeps the standing of its install at the clear (stored standing or trusted, not banned).
      await tdb.db.query('update installs set standing = true where id = $1', [ids[0]]);
      await tdb.db.query('update installs set trusted = true where id = $1', [ids[1]]);
      await tdb.db.query('update installs set standing = true, banned_at = now() where id = $1', [ids[2]]);
      const s = await session();
      const cleared = (await write(s, '/api/admin/accounts/ring_member_ok', { action: 'clear' })).json();
      expect(cleared.account).toMatchObject({ status: 'cleared', tier: 0, score: 0, override: 'clear', overrideAt: expect.stringMatching(/Z$/), clearPenalty: true });
      expect(cleared.list).toEqual({ version: 1, changed: true, listed: 0 });
      const kept = await tdb.db.query<{ install_id: string; value: number }>('select install_id, value from cleared_votes order by value desc, install_id');
      expect(kept.rows.map((r) => r.value)).toEqual([1, 1, 1, 0]);
      expect(kept.rows.map((r) => r.install_id).sort()).toEqual([...ids].sort());
      const standing = await tdb.db.query<{ install_id: string; standing: boolean }>('select install_id, standing from cleared_votes');
      expect(Object.fromEntries(standing.rows.map((r) => [r.install_id, r.standing]))).toEqual({ [ids[0]!]: true, [ids[1]!]: true, [ids[2]!]: false, [ids[3]!]: false });
      // The voters delete their votes: the rows of the clear stay.
      await tdb.db.query("delete from votes where handle = 'ring_member_ok'");
      expect((await tdb.db.query('select 1 from cleared_votes')).rowCount).toBe(4);

      const confirmed = (await write(s, '/api/admin/accounts/ring_member_ok', { action: 'confirm' })).json();
      expect(confirmed.account).toMatchObject({ status: 'confirmed', tier: 2, score: 100, override: 'confirm', clearedAt: null });
      expect(confirmed.list).toEqual({ version: 2, changed: true, listed: 1 });
      expect((await tdb.db.query('select 1 from cleared_votes')).rowCount).toBe(0);
      expect(await listBody()).toMatchObject({ version: 2, accounts: [['ring_member_ok', 100, 2]], ids: ['4242'] });
      expect((await logRows()).find((r) => r.action === 'confirm')!.before).toMatchObject({ account: { status: 'cleared', override: 'clear' }, clearedVotes: expect.arrayContaining([expect.objectContaining({ value: 1 })]) });
      // The public list serves the new version at its next check (15 s), with no score run.
      t.clock.advance(15_001);
      const list = await t.app.inject({ url: '/api/v1/list' });
      expect(list.json()).toMatchObject({ version: 2, accounts: [['ring_member_ok', 100, 2]], ids: ['4242'] });
    });

    it('clears a starter account and a clear asked without penalty with no rows; a confirm keeps a moved handle off the list and lists a gone one (SPEC 13.10 item 10)', async () => {
      await crowd('starter_acct_1', 2);
      await crowd('soft_clear_one', 2);
      await tdb.db.query("update accounts set seed = true, clear_penalty = false, status = 'confirmed', tier = 2 where handle = 'starter_acct_1'");
      const s = await session();
      expect((await write(s, '/api/admin/accounts/starter_acct_1', { action: 'clear', penalty: true })).json().account.clearPenalty).toBe(false);
      expect((await write(s, '/api/admin/accounts/soft_clear_one', { action: 'clear', penalty: false })).json().account.clearPenalty).toBe(false);
      expect((await tdb.db.query('select 1 from cleared_votes')).rowCount).toBe(0);
      await tdb.db.query("insert into accounts (handle, identity, status, seed) values ('gone_handle_1', 'gone', 'none', false), ('moved_starter', 'moved', 'confirmed', true)");
      // moved: the handle has another X id now, so the decision stays on the row and nobody is listed. gone: the source did
      // not find the handle, which proves nothing, so the admin's confirm lists it.
      for (const [handle, listed, status] of [['moved_starter', 0, 'none'], ['gone_handle_1', 1, 'confirmed']] as const) {
        const r = (await write(s, `/api/admin/accounts/${handle}`, { action: 'confirm' })).json();
        expect([handle, r.account]).toEqual([handle, expect.objectContaining({ status: 'confirmed', tier: 2, override: 'confirm', identity: handle === 'moved_starter' ? 'moved' : 'gone' })]);
        expect([handle, r.list.listed]).toEqual([handle, listed]);
        expect((await t.app.inject({ url: `/api/v1/accounts/${handle}` })).json().status).toBe(status);
      }
    });

    it('round 2 H1: a confirm stores the "not slop" votes set before it, so a vote deleted or flipped after the confirm keeps its penalty', async () => {
      const ids = await crowd('upheld_account', 2, 2);
      // ids[2] has stored standing: 30 days old, reputation 0.75. Its "not slop" vote is set before the confirm.
      await tdb.db.query("update installs set standing = true, reputation = 0.75, created_at = now() - interval '30 days' where id = $1", [ids[2]]);
      await tdb.db.query("update votes set updated_at = now() - interval '1 hour' where handle = 'upheld_account'");
      const s = await session();
      await write(s, '/api/admin/accounts/upheld_account', { action: 'clear' });
      expect((await tdb.db.query('select 1 from cleared_votes')).rowCount).toBe(4);
      await write(s, '/api/admin/accounts/upheld_account', { action: 'confirm' });
      const rows = async () =>
        (await tdb.db.query<{ install_id: string; value: number; standing: boolean; same: boolean }>(
          "select c.install_id, c.value, c.standing, c.cleared_at = a.override_at as same from cleared_votes c join accounts a on a.handle = c.handle order by c.install_id",
        )).rows;
      // The rows of the clear are gone; the two "not slop" votes are stored at the time of the confirm.
      const kept = await rows();
      expect(kept.map((r) => [r.install_id, r.value, r.standing, r.same])).toEqual([ids[2]!, ids[3]!].sort().map((id) => [id, 0, id === ids[2], true]));
      // The voters delete and flip their votes: the rows stay as the confirm stored them.
      await tdb.db.query('delete from votes where install_id = $1', [ids[2]]);
      await tdb.db.query("update votes set value = 1, updated_at = now() where install_id = $1", [ids[3]]);
      expect(await rows()).toEqual(kept);
      // Through the real job: the install with no vote left is loaded by its row and loses its standing. Without the row it
      // would not be loaded at all and would keep the stored standing.
      await runScoreJob(tdb.db, computeScores);
      expect((await tdb.db.query<{ standing: boolean }>('select standing from installs where id = $1', [ids[2]])).rows[0]).toEqual({ standing: false });
    });

    it('protects, unprotects and resets, and refuses an unknown action, a bad penalty and a handle with a NUL', async () => {
      await tdb.db.query("insert into accounts (handle, status, override, override_at) values ('big_account_1', 'confirmed', 'confirm', now())");
      const s = await session();
      expect((await write(s, '/api/admin/accounts/big_account_1', { action: 'protect' })).json().account.protected).toBe(true);
      expect((await write(s, '/api/admin/accounts/big_account_1', { action: 'unprotect' })).json().account.protected).toBe(false);
      expect((await write(s, '/api/admin/accounts/big_account_1', { action: 'reset' })).json().account).toMatchObject({ override: null, overrideAt: null });
      expect((await write(s, '/api/admin/accounts/nobody_here', { action: 'protect' })).statusCode).toBe(404);
      for (const [url, body] of [
        ['/api/admin/accounts/big_account_1', { action: 'ban' }],
        ['/api/admin/accounts/big_account_1', { action: 'clear', penalty: 'yes' }],
        ['/api/admin/accounts/big_account_1', { action: 'clear', extra: 1 }],
        ['/api/admin/accounts/big%00one', { action: 'clear' }],
        ['/api/admin/accounts/%00/ban-voters', undefined],
      ] as const) {
        expect([url, (await write(s, url, body)).statusCode]).toEqual([url, 400]);
      }
      expect((await tdb.db.query("select 1 from accounts where status = 'cleared'")).rowCount).toBe(0);
    });

    it('bans the installs that marked a small crowd, and refuses a crowd of 11 networks', async () => {
      const ring = await crowd('ring_target_01', 3, 2);
      const s = await session();
      // The account row carries the exact count that ban-voters bans, not parts.networks (round 2 finding).
      await tdb.db.query("update accounts set parts = '{\"networks\": 7}'::jsonb where handle = 'ring_target_01'");
      const banNetworks = async (handle: string) => (await get(s, `/api/admin/accounts?handle=${handle}`)).json().accounts[0].banNetworks;
      expect(await banNetworks('ring_target_01')).toBe(3);
      const r = await write(s, '/api/admin/accounts/ring_target_01/ban-voters');
      expect(r.json()).toEqual({ banned: 3 });
      const banned = await tdb.db.query<{ id: string }>('select id from installs where banned_at is not null order by id');
      expect(banned.rows.map((x) => x.id)).toEqual(ring.slice(0, 3).sort());
      expect((await logRows()).at(-1)).toMatchObject({ action: 'ban-voters', target: 'ring_target_01', before: { unbannedInstalls: ring.slice(0, 3).sort() } });

      expect(await banNetworks('ring_target_01')).toBe(0);
      await crowd('popular_target', 11);
      expect(await banNetworks('popular_target')).toBe(11);
      const big = await write(s, '/api/admin/accounts/popular_target/ban-voters');
      expect([big.statusCode, big.json().error.code]).toEqual([409, 'crowd_too_large']);
      expect((await tdb.db.query('select 1 from installs where banned_at is not null')).rowCount).toBe(3);
      expect((await logRows()).filter((x) => x.target === 'popular_target')).toEqual([]);
    });

    it('trusts and untrusts an install, which /me reports', async () => {
      const a = await register(t, '198.51.100.31');
      const s = await session();
      expect((await write(s, `/api/admin/installs/${a.installId}/trust`)).json()).toEqual({ id: a.installId, bannedAt: null, trusted: true });
      expect((await signed(t, a, 'GET', '/api/v1/me')).json()).toMatchObject({ trusted: true, standing: false, goodMarks: 0 });
      // SPEC 13.8: the installs view adds trusted, standing, goodMarks, slopVotes and notSlopVotes.
      await tdb.db.query("insert into accounts (handle) values ('trust_target_1'), ('trust_target_2') on conflict do nothing");
      await tdb.db.query("insert into votes (install_id, handle, value) values ($1, 'trust_target_1', 1), ($1, 'trust_target_2', 0)", [a.installId]);
      await tdb.db.query('update installs set good_marks = 2, standing = true where id = $1', [a.installId]);
      const list = (await get(s, '/api/admin/installs?sort=votes')).json();
      expect(list.installs[0]).toMatchObject({ id: a.installId, trusted: true, standing: true, goodMarks: 2, votes: 2, slopVotes: 1, notSlopVotes: 1 });
      expect((await write(s, `/api/admin/installs/${a.installId}/untrust`)).json().trusted).toBe(false);
      expect((await write(s, '/api/admin/installs/00000000-0000-4000-8000-000000000000/trust')).statusCode).toBe(404);
      expect((await logRows()).filter((r) => r.action === 'trust' || r.action === 'untrust').map((r) => r.before)).toEqual([{ install: { banned_at: null, trusted: false } }, { install: { banned_at: null, trusted: true } }]);
    });
  });

  describe('review queue and appeals with marks', () => {
    it('serves the pending, disputed and auto queues with the full review item', async () => {
      const parts = (p: Record<string, unknown>) => JSON.stringify({ reason: 'votes_pending', want: 'confirmed', gate: 'standing', networks: 5, anchors: 1, notSlop: 0, dissent: 0, trust: 1.4, behaviour: 0.3, sightings: 4, fastReplyShare: 0.5, ...p });
      await tdb.db.query(
        `insert into accounts (handle, status, score, seed, parts, confirmed_at, override, x_user_id, identity) values
           ('pending_low', 'pending', 0.61, false, $1::jsonb, null, null, null, 'unknown'),
           ('pending_top', 'pending', 0.66, false, $2::jsonb, null, null, '777', 'ok'),
           ('starter_dispute', 'confirmed', 0.8, true, $3::jsonb, null, null, null, 'ok'),
           ('listed_dissent', 'flagged', 0.5, false, $4::jsonb, null, null, null, 'ok'),
           ('auto_new', 'confirmed', 0.7, false, $5::jsonb, now() - interval '1 hour', null, null, 'ok'),
           ('auto_old', 'confirmed', 0.7, false, $5::jsonb, now() - interval '8 days', null, null, 'ok'),
           ('admin_said', 'confirmed', 1, false, $5::jsonb, now(), 'confirm', null, 'ok')`,
        [parts({ anchors: 0 }), parts({ anchors: 2, networks: 3 }), parts({ disputed: true, notSlop: 5 }), parts({ dissent: 3 }), parts({})],
      );
      await tdb.db.query("insert into profiles (handle, name, followers) values ('pending_top', 'Top Pending', 1234)");
      const voters = await crowd('pending_top', 2, 0, '1850000000000000011');
      await tdb.db.query("update votes set tweet_id = '1850000000000000012' where install_id = $1", [voters[1]]);
      await tdb.db.query("insert into evidence (tweet_id, handle, x_user_id, ok) values ('1850000000000000011', 'pending_top', '777', true), ('1850000000000000012', 'pending_top', '999', false)");
      const s = await session();
      const queue = async (name: string) => (await get(s, `/api/admin/review?queue=${name}`)).json().items as { handle: string }[];
      const pending = await queue('pending');
      expect(pending.map((i) => i.handle)).toEqual(['pending_top', 'pending_low']);
      expect(pending[0]).toEqual({
        handle: 'pending_top',
        name: 'Top Pending',
        followers: 1234,
        xUserId: '777',
        identity: 'ok',
        status: 'pending',
        want: 'confirmed',
        gate: 'standing',
        networks: 3,
        anchors: 2,
        notSlop: 0,
        dissent: 0,
        trust: 1.4,
        score: 66,
        seed: false,
        protected: false,
        behaviour: 0.3,
        sightings: 4,
        fastReplyShare: 0.5,
        evidence: [{ tweetId: '1850000000000000011', at: expect.stringMatching(/Z$/) }],
        banNetworks: 2,
        firstVoteAt: expect.stringMatching(/Z$/),
        lastVoteAt: expect.stringMatching(/Z$/),
      });
      expect((await queue('disputed')).map((i) => i.handle)).toEqual(['starter_dispute', 'listed_dissent']);
      expect((await queue('auto')).map((i) => i.handle)).toEqual(['auto_new']);
      for (const q of ['', '?queue=all', '?queue=pending&limit=x', '?queue=pending&x=1']) expect((await get(s, `/api/admin/review${q}`)).statusCode).toBe(400);
    });

    it('13.10 item 8: orders the pending queue by anchors, evidence, reply timing, trust and handle, and counts the whole queue', async () => {
      const parts = (p: Record<string, unknown>) => JSON.stringify({ reason: 'votes_pending', want: 'confirmed', gate: 'standing', networks: 9, anchors: 0, evidence: 0, behaviour: 0, trust: 1, ...p });
      // Each row wins over the next one by exactly one key, in the order of the SPEC; networks never decide.
      const rows: [string, Record<string, unknown>][] = [
        ['q_anchors', { anchors: 2, networks: 2 }],
        ['q_evidence', { anchors: 1, evidence: 2 }],
        ['q_timing', { anchors: 1, evidence: 1, behaviour: 0.9 }],
        ['q_trust', { anchors: 1, evidence: 1, behaviour: 0.2, trust: 3 }],
        ['q_handle_a', { anchors: 1, evidence: 1, behaviour: 0.2, trust: 2 }],
        ['q_handle_b', { anchors: 1, evidence: 1, behaviour: 0.2, trust: 2 }],
      ];
      for (const [handle, p] of [...rows].reverse()) await tdb.db.query("insert into accounts (handle, status, parts) values ($1, 'pending', $2::jsonb)", [handle, parts(p)]);
      const s = await session();
      const all = (await get(s, '/api/admin/review?queue=pending')).json();
      expect([all.total, all.items.map((i: { handle: string }) => i.handle)]).toEqual([6, rows.map(([h]) => h)]);
      const two = (await get(s, '/api/admin/review?queue=pending&limit=2')).json();
      expect([two.total, two.items.length]).toEqual([6, 2]);
      expect((await get(s, '/api/admin/review?queue=auto')).json()).toEqual({ total: 0, items: [] });
    });

    it('shows the marks that an accept with penalty strikes, and an accept without penalty keeps no rows', async () => {
      await crowd('appealed_one', 3, 1);
      await crowd('appealed_two', 2);
      await crowd('appealed_seed', 2);
      await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.8");
      await tdb.db.query("update accounts set seed = true, clear_penalty = false where handle = 'appealed_seed'");
      const open = async (handle: string) =>
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/appeals',
            headers: fromIp('192.0.2.77'),
            payload: { handle, email: null, message: 'I write my own replies, please check my profile.', ...(await getChallenge(t, 'appeal', '192.0.2.77')) },
          })
        ).json().appealId as string;
      const one = await open('appealed_one');
      const two = await open('appealed_two');
      await open('appealed_seed');
      const s = await session();
      const marks = (await get(s, '/api/admin/appeals')).json().appeals.map((a: { handle: string; marks: unknown }) => [a.handle, a.marks]);
      expect(marks.sort()).toEqual([
        ['appealed_one', { networks: 3, strikes: 3 }],
        ['appealed_seed', { networks: 2, strikes: 0 }],
        ['appealed_two', { networks: 2, strikes: 2 }],
      ]);
      expect((await write(s, `/api/admin/appeals/${one}/decide`, { decision: 'accept', penalty: false })).json().status).toBe('accepted');
      expect((await tdb.db.query('select 1 from cleared_votes')).rowCount).toBe(0);
      expect((await write(s, `/api/admin/appeals/${two}/decide`, { decision: 'accept' })).json().status).toBe('accepted');
      expect((await tdb.db.query("select 1 from cleared_votes where handle = 'appealed_two'")).rowCount).toBe(2);
      expect(await listBody()).toMatchObject({ accounts: [['appealed_seed', 80, 2]] });
      expect((await write(s, `/api/admin/appeals/${two}/decide`, { decision: 'accept', penalty: 1 })).statusCode).toBe(400);
    });

    it('13.12 marks.strikes: 12 slop networks without standing and 2 with standing give 14; 11 with standing give the count of those without', async () => {
      const mixed = await crowd('strike_mix_14', 14);
      const big = await crowd('strike_big_14', 14);
      await tdb.db.query('update installs set standing = true where id = any($1::uuid[])', [[...mixed.slice(0, 2), ...big.slice(0, 10)]]);
      // Trust counts as standing, like the rows of a clear.
      await tdb.db.query('update installs set trusted = true where id = $1', [big[10]]);
      await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.8");
      const appeal: Record<string, string> = {};
      for (const handle of ['strike_mix_14', 'strike_big_14']) {
        const pow = await getChallenge(t, 'appeal', '192.0.2.78');
        const r = await t.app.inject({ method: 'POST', url: '/api/v1/appeals', headers: fromIp('192.0.2.78'), payload: { handle, message: 'I write my own replies, please check my profile.', ...pow } });
        appeal[handle] = r.json().appealId;
      }
      const s = await session();
      const marks = async () => Object.fromEntries((await get(s, '/api/admin/appeals')).json().appeals.map((a: { handle: string; marks: unknown }) => [a.handle, a.marks]));
      expect(await marks()).toEqual({ strike_mix_14: { networks: 14, strikes: 14 }, strike_big_14: { networks: 14, strikes: 3 } });
      // A banned install has no standing in the rows, but its network keeps its slop row: 10 with standing are struck too.
      await tdb.db.query('update installs set banned_at = now() where id = $1', [big[0]]);
      expect((await marks()).strike_big_14).toEqual({ networks: 14, strikes: 14 });
      // The rows that the accept stores carry the same split.
      expect((await write(s, `/api/admin/appeals/${appeal.strike_big_14}/decide`, { decision: 'accept' })).json().status).toBe('accepted');
      const rows = await tdb.db.query<{ standing: boolean; n: number }>("select standing, count(*)::int as n from cleared_votes where handle = 'strike_big_14' and value = 1 group by standing order by standing");
      expect(rows.rows).toEqual([{ standing: false, n: 4 }, { standing: true, n: 10 }]);
    });

    it('an accept that races a new appeal of the same account leaves no open appeal on the cleared account', async () => {
      await crowd('raced_account', 2);
      await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.9");
      const first = await t.app.inject({
        method: 'POST',
        url: '/api/v1/appeals',
        headers: fromIp('192.0.2.88'),
        payload: { handle: 'raced_account', message: 'I write my own replies, please check my profile.', ...(await getChallenge(t, 'appeal', '192.0.2.88')) },
      });
      const s = await session();
      const pow = await getChallenge(t, 'appeal', '198.51.100.88');
      const [accept, second] = await Promise.all([
        write(s, `/api/admin/appeals/${first.json().appealId}/decide`, { decision: 'accept' }),
        t.app.inject({ method: 'POST', url: '/api/v1/appeals', headers: fromIp('198.51.100.88'), payload: { handle: 'raced_account', message: 'This is the owner of the account, writing by hand.', ...pow } }),
      ]);
      expect(accept.json().status).toBe('accepted');
      expect([201, 404]).toContain(second.statusCode);
      expect((await tdb.db.query("select 1 from appeals where status = 'open'")).rowCount).toBe(0);
    });
  });

  describe('guards of the new routes', () => {
    it('answers 401 without a session, 403 without x-csrf or with a foreign Origin, and 400 on bad input', async () => {
      const install = (await register(t, '198.51.100.41')).installId;
      await tdb.db.query("insert into accounts (handle) values ('guarded_one')");
      const s = await session();
      const reads = ['/api/admin/review?queue=pending', '/api/admin/log'];
      for (const url of reads) expect([url, (await t.app.inject({ url })).statusCode]).toEqual([url, 401]);
      const writes: [string, object | undefined][] = [
        ['/api/admin/accounts/guarded_one', { action: 'protect' }],
        ['/api/admin/accounts/guarded_one/ban-voters', undefined],
        [`/api/admin/installs/${install}/trust`, undefined],
        [`/api/admin/installs/${install}/untrust`, undefined],
      ];
      for (const [url, body] of writes) {
        const bare = await t.app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'x-csrf': s.csrf }, ...(body ? { payload: body } : {}) });
        expect([url, bare.statusCode]).toEqual([url, 401]);
        const noCsrf = await t.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, origin: ORIGIN }, ...(body ? { payload: body } : {}) });
        expect([url, noCsrf.statusCode, noCsrf.json().error.code]).toEqual([url, 403, 'bad_csrf']);
        expect([url, (await write(s, url, body, { origin: 'https://evil.test' })).statusCode]).toEqual([url, 403]);
      }
      expect((await write(s, '/api/admin/installs/not-a-uuid/trust')).statusCode).toBe(400);
      expect((await tdb.db.query('select 1 from installs where trusted')).rowCount).toBe(0);
      expect((await tdb.db.query('select 1 from accounts where protected')).rowCount).toBe(0);
      expect((await logRows()).map((r) => r.action)).toEqual(['login']);
    });
  });
});
