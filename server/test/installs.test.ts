import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import {
  fromIp,
  getChallenge,
  makeApp,
  meetsBits,
  newKeys,
  NO_FILES,
  randomNonce,
  register,
  signed,
  signHeaders,
  solvePow,
  testConfig,
  vote,
  type TestApp,
} from './helpers/app.js';

describe.each(BACKENDS)('installs and signatures (%s)', (backend) => {
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

  describe('challenge', () => {
    it('issues a token with the configured difficulty', async () => {
      const r = await t.app.inject({ url: '/api/v1/challenge' });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.difficulty).toBe(8);
      const payload = JSON.parse(Buffer.from(body.challenge.split('.')[0], 'base64url').toString());
      expect(payload.p).toBe('install');
      expect(payload.n).toMatch(/^[0-9a-f]{32}$/);
      expect(payload.exp - Math.floor(t.clock.now() / 1000)).toBe(600);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });
    it('rejects a bad purpose and unknown query fields', async () => {
      for (const url of ['/api/v1/challenge?purpose=admin', '/api/v1/challenge?x=1']) {
        const r = await t.app.inject({ url });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.code).toBe('invalid_request');
      }
    });
    it('limits each network to 30 per hour', async () => {
      for (let i = 0; i < 30; i++) expect((await t.app.inject({ url: '/api/v1/challenge', headers: fromIp('203.0.113.9') })).statusCode).toBe(200);
      const r = await t.app.inject({ url: '/api/v1/challenge', headers: fromIp('203.0.113.200') });
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe('rate_limited');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect((await t.app.inject({ url: '/api/v1/challenge', headers: fromIp('203.0.114.9') })).statusCode).toBe(200);
    });
    it('counts 6to4, mapped, Teredo and NAT64 forms of one IPv4 as one network', async () => {
      for (let i = 0; i < 30; i++) expect((await t.app.inject({ url: '/api/v1/challenge', headers: fromIp('203.0.113.9') })).statusCode).toBe(200);
      for (const ip of ['2002:cb00:71c8::1', '::ffff:cb00:7109', '64:ff9b::203.0.113.50', '2001:0:1111:2222:8000:63bf:34ff:8ef6']) {
        const r = await t.app.inject({ url: '/api/v1/challenge', headers: fromIp(ip) });
        expect(r.statusCode, ip).toBe(429);
      }
      expect((await t.app.inject({ url: '/api/v1/challenge', headers: fromIp('2002:cb00:7209::1') })).statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/installs', () => {
    it('registers a key and stores only the IP hash', async () => {
      const id = await register(t, '192.0.2.44');
      expect(id.installId).toMatch(/^[0-9a-f-]{36}$/);
      const { rows } = await tdb.db.query<{ public_key: unknown; ip_hash: string; ext_version: string; reputation: number }>(
        'select public_key, ip_hash, ext_version, reputation from installs where id = $1',
        [id.installId],
      );
      expect(rows[0]!.public_key).toEqual(id.publicKey);
      expect(rows[0]!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(rows[0])).not.toContain('192.0.2');
      expect(rows[0]!.ext_version).toBe('1.0.0');
      expect(rows[0]!.reputation).toBe(0.5);
    });
    it('accepts a challenge once only', async () => {
      const { publicKey } = await newKeys();
      const pow = await getChallenge(t);
      const body = { publicKey, ...pow, extVersion: '1.0.0' };
      expect((await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: body })).statusCode).toBe(201);
      const again = await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: body });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('challenge_used');
    });
    it('rejects a wrong proof, a wrong purpose, a forged token and an expired one', async () => {
      const { publicKey } = await newKeys();
      const pow = await getChallenge(t);
      let wrong = 'w';
      for (let i = 0; meetsBits(pow.challenge, wrong, 8); i++) wrong = `w${i}`;
      const cases: [Record<string, string>, string][] = [
        [{ challenge: pow.challenge, nonce: wrong }, 'bad_proof'],
        [await getChallenge(t, 'appeal'), 'invalid_challenge'],
        [{ challenge: pow.challenge.replace(/.(?=.{5}$)/, (c) => (c === 'A' ? 'B' : 'A')), nonce: pow.nonce }, 'invalid_challenge'],
        [{ challenge: pow.challenge.replace(/.$/, (c) => String.fromCharCode(c.charCodeAt(0) ^ 1)), nonce: pow.nonce }, 'invalid_challenge'],
      ];
      for (const [p, code] of cases) {
        const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: { publicKey, ...p, extVersion: '1.0.0' } });
        expect([r.statusCode, r.json().error.code]).toEqual([400, code]);
      }
      t.clock.advance(601_000);
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: { publicKey, ...pow, extVersion: '1.0.0' } });
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'challenge_expired']);
    });
    it('accepts only kty, crv, x and y in the JWK', async () => {
      const { publicKey } = await newKeys();
      const cases = [
        { ...publicKey, d: publicKey.x },
        { ...publicKey, ext: true },
        { ...publicKey, crv: 'P-384' },
        { kty: 'EC', crv: 'P-256', x: publicKey.x },
      ];
      for (const key of cases) {
        const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: { publicKey: key, ...(await getChallenge(t)), extVersion: '1.0.0' } });
        expect([r.statusCode, r.json().error.code]).toEqual([400, 'invalid_request']);
      }
      // Valid base64url coordinates that are not a point on P-256.
      const offCurve = { ...publicKey, y: publicKey.x };
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: { publicKey: offCurve, ...(await getChallenge(t)), extVersion: '1.0.0' } });
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'invalid_key']);
    });
    it('rejects unknown fields, bad versions, non-JSON and oversize bodies', async () => {
      const { publicKey } = await newKeys();
      const pow = await getChallenge(t);
      let n = 0;
      const send = (payload: unknown, headers: Record<string, string> = {}) =>
        t.app.inject({ method: 'POST', url: '/api/v1/installs', payload: payload as string, headers: { ...headers, ...fromIp(`10.0.${n++}.1`) } });
      expect((await send({ publicKey, ...pow, extVersion: '1.0.0', admin: true })).statusCode).toBe(400);
      expect((await send({ publicKey, ...pow, extVersion: 'v1' })).statusCode).toBe(400);
      const bad = await send('{"publicKey":', { 'content-type': 'application/json' });
      expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'invalid_json']);
      const text = await send('hello', { 'content-type': 'text/plain' });
      expect([text.statusCode, text.json().error.code]).toEqual([415, 'unsupported_media_type']);
      const big = await send(JSON.stringify({ pad: 'x'.repeat(70_000) }), { 'content-type': 'application/json' });
      expect([big.statusCode, big.json().error.code]).toEqual([413, 'body_too_large']);
      const proto = await send('{"__proto__":{"x":1}}', { 'content-type': 'application/json' });
      expect(proto.statusCode).toBe(400);
    });
    it('R13 counts only registrations that succeeded: empty and invalid requests do not close registration for a network', async () => {
      const ip = '198.51.100.60';
      const send = async (payload: unknown) => (await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: payload as object })).statusCode;
      const { publicKey } = await newKeys();
      for (let i = 0; i < 5; i++) expect(await send({})).toBe(400);
      for (let i = 0; i < 5; i++) expect(await send({ publicKey, challenge: 'x'.repeat(40), nonce: 'n', extVersion: '1.0.0' })).toBe(400);
      const pow = await getChallenge(t, 'install', ip);
      expect(await send({ publicKey, ...pow, extVersion: '1.0.0' })).toBe(201);
      // A replayed challenge is refused and costs nothing either.
      for (let i = 0; i < 5; i++) expect(await send({ publicKey, ...pow, extVersion: '1.0.0' })).toBe(409);
      for (let i = 0; i < 4; i++) await register(t, ip);
      const sixth = await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: { publicKey, ...(await getChallenge(t, 'install', ip)), extVersion: '1.0.0' } });
      expect([sixth.statusCode, sixth.json().error.code, sixth.headers['retry-after']]).toEqual([429, 'rate_limited', '720']);
      // The refused request did not use its challenge.
      expect((await tdb.db.query('select 1 from used_challenges')).rowCount).toBe(5);
    });
    it('bounds the requests of a network at 120 a minute before any database work', async () => {
      let queries = 0;
      const counted: Db = { ...tdb.db, query: (text, params) => (queries++, tdb.db.query(text, params)), tx: (fn) => (queries++, tdb.db.tx(fn)) };
      const t2 = await makeApp(counted);
      const junk = () => t2.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp('203.0.113.66'), payload: {} });
      for (let i = 0; i < 120; i++) expect((await junk()).statusCode).toBe(400);
      expect([(await junk()).statusCode, queries]).toEqual([429, 0]);
    });
    it('limits each network to 5 installs per hour', async () => {
      for (let i = 0; i < 5; i++) await register(t, '198.51.100.1');
      const { publicKey } = await newKeys();
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp('198.51.100.2'), payload: { publicKey, ...(await getChallenge(t)), extVersion: '1.0.0' } });
      expect(r.statusCode).toBe(429);
      t.clock.advance(12 * 60_000);
      await register(t, '198.51.100.3');
    });
    it('R2-3 lets install 26 of a shared network register, and stops the network at 1000 installs in 30 days', async () => {
      for (let h = 0; h < 5; h++) {
        for (let i = 0; i < 5; i++) await register(t, `203.0.113.${10 + i}`);
        t.clock.advance(3_600_000);
      }
      // Person 26 of an office, a campus or a phone carrier that shares this /24.
      const person = await register(t, '203.0.113.99');
      const { rows } = await tdb.db.query<{ ip_hash: string; public_key: unknown }>('select ip_hash, public_key from installs where id = $1', [person.installId]);
      expect((await tdb.db.query<{ n: number }>('select count(*) as n from installs where ip_hash = $1', [rows[0]!.ip_hash])).rows[0]!.n).toBe(26);

      await tdb.db.query('insert into installs (id, public_key, ip_hash) select gen_random_uuid(), $1::jsonb, $2 from generate_series(1, 974)', [JSON.stringify(rows[0]!.public_key), rows[0]!.ip_hash]);
      const { publicKey } = await newKeys();
      const ip = '203.0.113.98';
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/installs', headers: fromIp(ip), payload: { publicKey, ...(await getChallenge(t, 'install', ip)), extVersion: '1.0.0' } });
      expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
      expect(r.headers['retry-after']).toBe('3600');
      expect((await tdb.db.query<{ n: number }>('select count(*) as n from installs')).rows[0]!.n).toBe(1000);
      await register(t, '203.0.114.10');
      await tdb.db.query("update installs set created_at = created_at - interval '31 days'");
      await register(t, ip);
    }, 60_000);
  });

  describe('signed requests', () => {
    it('accepts a request signed like the extension signs it', async () => {
      const id = await register(t);
      const r = await signed(t, id, 'GET', '/api/v1/me');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ installId: id.installId, createdAt: expect.stringMatching(/Z$/), reputation: 0.5, standing: false, goodMarks: 0, trusted: false, votes: [] });
      await tdb.db.query('update installs set standing = true, good_marks = 4, trusted = true where id = $1', [id.installId]);
      expect((await signed(t, id, 'GET', '/api/v1/me')).json()).toMatchObject({ standing: true, goodMarks: 4, trusted: true });
      const seen = await tdb.db.query<{ last_seen_at: Date | null }>('select last_seen_at from installs where id = $1', [id.installId]);
      expect(seen.rows[0]!.last_seen_at).toBeInstanceOf(Date);
    });
    it('rejects a tampered body, path, method or signature', async () => {
      const id = await register(t);
      const body = JSON.stringify(vote('someone'));
      const ts = t.clock.now();
      const h = await signHeaders(id, 'POST', '/api/v1/votes', body, ts);
      const tamperedBody = body.replace('someone', 'someone2');
      const cases = [
        { method: 'POST' as const, url: '/api/v1/votes', payload: tamperedBody, headers: h },
        { method: 'POST' as const, url: '/api/v1/votes?x=1', payload: body, headers: h },
        { method: 'POST' as const, url: '/api/v1/votes', payload: body, headers: { ...h, 'x-xslop-ts': String(ts + 1) } },
        { method: 'POST' as const, url: '/api/v1/votes', payload: body, headers: { ...h, 'x-xslop-sig': `${h['x-xslop-sig']!.slice(0, 10)}${h['x-xslop-sig']![10] === 'A' ? 'B' : 'A'}${h['x-xslop-sig']!.slice(11)}` } },
      ];
      for (const c of cases) {
        const r = await t.app.inject({ ...c, headers: { ...c.headers, 'content-type': 'application/json' } });
        expect([r.statusCode, r.json().error.code]).toEqual([401, 'bad_signature']);
      }
      const other = await register(t);
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/votes', payload: body, headers: { ...h, 'x-xslop-install': other.installId, 'content-type': 'application/json' } });
      expect(r.json().error.code).toBe('bad_signature');
      const { rows } = await tdb.db.query('select 1 from votes');
      expect(rows.length).toBe(0);
    });
    it('rejects clock skew over 300 seconds', async () => {
      const id = await register(t);
      for (const skew of [-301_000, 301_000]) {
        const h = await signHeaders(id, 'GET', '/api/v1/me', '', t.clock.now() + skew);
        const r = await t.app.inject({ url: '/api/v1/me', headers: h });
        expect([r.statusCode, r.json().error.code]).toEqual([401, 'clock_skew']);
      }
      const h = await signHeaders(id, 'GET', '/api/v1/me', '', t.clock.now() - 299_000);
      expect((await t.app.inject({ url: '/api/v1/me', headers: h })).statusCode).toBe(200);
    });
    it('rejects a replayed nonce', async () => {
      const id = await register(t);
      const nonce = randomNonce();
      const h = await signHeaders(id, 'GET', '/api/v1/me', '', t.clock.now(), nonce);
      expect((await t.app.inject({ url: '/api/v1/me', headers: h })).statusCode).toBe(200);
      const again = await t.app.inject({ url: '/api/v1/me', headers: h });
      expect([again.statusCode, again.json().error.code]).toEqual([401, 'replay']);
    });
    it('limits each network to 600 signed requests per minute before any database work', async () => {
      let queries = 0;
      const counted: Db = { ...tdb.db, query: (text, params) => (queries++, tdb.db.query(text, params)) };
      const t2 = await makeApp(counted);
      const forged = (ip: string, method: 'GET' | 'POST' | 'DELETE' = 'POST', url = '/api/v1/votes') =>
        t2.app.inject({
          method,
          url,
          headers: {
            ...fromIp(ip),
            'x-xslop-install': randomUUID(),
            'x-xslop-ts': String(t2.clock.now()),
            'x-xslop-nonce': randomNonce(),
            'x-xslop-sig': 'A'.repeat(86),
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { payload: '{}' } : {}),
        });
      for (let i = 0; i < 600; i++) expect((await forged('203.0.113.77')).statusCode).toBe(401);
      expect(queries).toBe(600);
      for (const [method, url] of [['POST', '/api/v1/votes'], ['DELETE', '/api/v1/votes/someone'], ['GET', '/api/v1/me'], ['POST', '/api/v1/observations']] as const) {
        const r = await forged('203.0.113.78', method, url);
        expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
      }
      expect(queries).toBe(600);
      expect((await forged('203.0.114.77')).statusCode).toBe(401);
      t2.clock.advance(60_000);
      expect((await forged('203.0.113.77')).statusCode).toBe(401);
    }, 60_000);
    it('rejects missing headers, unknown installs and banned installs', async () => {
      const none = await t.app.inject({ url: '/api/v1/me' });
      expect([none.statusCode, none.json().error.code]).toEqual([401, 'missing_signature']);
      const id = await register(t);
      const ghost = { ...id, installId: '00000000-0000-4000-8000-000000000000' };
      const u = await t.app.inject({ url: '/api/v1/me', headers: await signHeaders(ghost, 'GET', '/api/v1/me', '', t.clock.now()) });
      expect([u.statusCode, u.json().error.code]).toEqual([401, 'unknown_install']);
      const malformed = await t.app.inject({ url: '/api/v1/me', headers: { ...(await signHeaders(id, 'GET', '/api/v1/me', '', t.clock.now())), 'x-xslop-nonce': 'short' } });
      expect(malformed.json().error.code).toBe('bad_signature');
      await tdb.db.query('update installs set banned_at = now() where id = $1', [id.installId]);
      const b = await signed(t, id, 'GET', '/api/v1/me');
      expect([b.statusCode, b.json().error.code]).toEqual([403, 'banned']);
    });
  });

  it('round trip over a real socket: challenge, proof, install, signed vote, me', async () => {
    const app = await buildApp({ db: tdb.db, config: testConfig(), logger: false, files: NO_FILES });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const addr = app.server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;
      const ch = (await (await fetch(`${base}/api/v1/challenge?purpose=install`)).json()) as { challenge: string; difficulty: number };
      const { keys, publicKey } = await newKeys();
      const reg = await fetch(`${base}/api/v1/installs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey, challenge: ch.challenge, nonce: solvePow(ch.challenge, ch.difficulty), extVersion: '1.0.0' }),
      });
      expect(reg.status).toBe(201);
      const { installId } = (await reg.json()) as { installId: string };
      const body = JSON.stringify(vote('@RoundTrip_1'));
      const res = await fetch(`${base}/api/v1/votes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await signHeaders({ keys, installId }, 'POST', '/api/v1/votes', body, Date.now())) },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ handle: 'roundtrip_1', value: 'slop', account: { status: 'none', tier: 0 } });
      const me = await fetch(`${base}/api/v1/me`, { headers: await signHeaders({ keys, installId }, 'GET', '/api/v1/me', '', Date.now()) });
      expect(((await me.json()) as { votes: { handle: string }[] }).votes.map((v) => v.handle)).toEqual(['roundtrip_1']);
    } finally {
      await app.close();
    }
  });
});

describe('signature encoding', () => {
  it('accepts only the canonical base64url spelling of a 64-byte signature', async () => {
    const { SIG_CANONICAL_PROBE } = { SIG_CANONICAL_PROBE: /^[A-Za-z0-9_-]{85}[AQgw]$/ };
    const sig = Buffer.alloc(64, 7).toString('base64url');
    expect(SIG_CANONICAL_PROBE.test(sig)).toBe(true);
    const alt = sig.slice(0, 85) + String.fromCharCode(sig.charCodeAt(85) + 1);
    expect(Buffer.from(alt, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect(SIG_CANONICAL_PROBE.test(alt)).toBe(false);
  });
});
