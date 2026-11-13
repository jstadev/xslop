import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runScoreJob } from '../src/jobs/score-job.js';
import { loadLatestEntries, publishList } from '../src/list.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { makeApp, type TestApp } from './helpers/app.js';
import { fakeCompute } from './helpers/fake-scoring.js';

const seedAccounts = (db: TestDb['db'], handles: string[]) =>
  db.query('insert into accounts (handle, seed) select unnest($1::text[]), true on conflict do nothing', [handles]);

describe.each(BACKENDS)('global list, snapshots and deltas (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => {
    await tdb.reset();
    t = await makeApp(tdb.db);
    await seedAccounts(tdb.db, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ url, headers });
  /** Runs the job and moves the clock past the 15 s cache check. */
  const score = async (table: Parameters<typeof fakeCompute>[0]) => {
    const r = await runScoreJob(tdb.db, fakeCompute(table));
    t.clock.advance(15_001);
    return r;
  };

  it('answers 503 until the first snapshot exists', async () => {
    const r = await get('/api/v1/list');
    expect([r.statusCode, r.json().error.code]).toEqual([503, 'list_unavailable']);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('serves the newest snapshot sorted by handle with ETag, 304, CORS and every encoding', async () => {
    const job = await score({ charlie: [0.913, 2], alpha: [0.874, 2], bravo: [0.55, 1], delta: [0.2, 0] });
    expect(job).toMatchObject({ skipped: false, listChanged: true, version: 1, listed: 3 });
    const want = { v: 1, version: 1, accounts: [['alpha', 87, 2], ['bravo', 55, 1], ['charlie', 91, 2]], ids: [null, null, null] };

    const plain = await get('/api/v1/list');
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toMatchObject(want);
    expect(plain.json().generatedAt).toMatch(/Z$/);
    expect(plain.headers).toMatchObject({ etag: '"1"', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*', vary: 'Accept-Encoding' });
    expect(plain.headers['content-encoding']).toBeUndefined();

    const br = await t.app.inject({ url: '/api/v1/list', headers: { 'accept-encoding': 'gzip, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString())).toMatchObject(want);
    const gz = await t.app.inject({ url: '/api/v1/list', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toMatchObject(want);

    const nm = await get('/api/v1/list', { 'if-none-match': '"1"' });
    expect([nm.statusCode, nm.body, nm.headers.etag]).toEqual([304, '', '"1"']);
    expect((await get('/api/v1/list', { 'if-none-match': 'W/"0", "1"' })).statusCode).toBe(304);
    expect((await get('/api/v1/list', { 'if-none-match': '"0"' })).statusCode).toBe(200);
    expect((await get('/api/v1/list?x=1')).statusCode).toBe(400);
  });

  it('writes a snapshot only when the list changes and checks for one at most every 15 s', async () => {
    const table = { alpha: [0.874, 2] as [number, 2] };
    await score(table);
    const again = await score({ alpha: [0.8741, 2] });
    expect(again).toMatchObject({ listChanged: false, version: 1 });
    expect((await tdb.db.query('select version from list_snapshots')).rows.length).toBe(1);

    expect((await get('/api/v1/list')).json().version).toBe(1);
    await runScoreJob(tdb.db, fakeCompute({ alpha: [0.874, 2], bravo: [0.6, 1] }));
    t.clock.advance(14_000);
    expect((await get('/api/v1/list')).json().version).toBe(1);
    t.clock.advance(15_001);
    expect((await get('/api/v1/list')).json().version).toBe(2);
  });

  it('composes stored deltas, answers 304 for the newest version and 410 when a delta is gone', async () => {
    await score({ alpha: [0.9, 2], bravo: [0.5, 1], charlie: [0.7, 2] });
    await score({ alpha: [0.95, 2], bravo: [0.5, 1], delta: [0.6, 1] });
    await score({ alpha: [0.95, 2], bravo: [0.1, 0], delta: [0.6, 2], echo: [0.8, 2], charlie: [0.71, 2] });

    const d1 = await get('/api/v1/list/delta?since=1');
    expect(d1.statusCode).toBe(200);
    expect(d1.headers['cache-control']).toBe('public, max-age=60');
    expect(d1.headers['access-control-allow-origin']).toBe('*');
    expect(d1.json()).toEqual({
      v: 1,
      from: 1,
      version: 3,
      add: [['alpha', 95, 2], ['charlie', 71, 2], ['delta', 60, 2], ['echo', 80, 2]],
      addIds: [null, null, null, null],
      remove: ['bravo'],
    });
    expect((await get('/api/v1/list/delta?since=2')).json()).toEqual({
      v: 1,
      from: 2,
      version: 3,
      add: [['charlie', 71, 2], ['delta', 60, 2], ['echo', 80, 2]],
      addIds: [null, null, null],
      remove: ['bravo'],
    });
    const br = await get('/api/v1/list/delta?since=1', { 'accept-encoding': 'br' });
    expect(JSON.parse(br.headers['content-encoding'] === 'br' ? brotliDecompressSync(br.rawPayload).toString() : br.body)).toEqual(d1.json());

    // Applying the delta to version 1 gives exactly version 3.
    const v3 = (await get('/api/v1/list')).json().accounts as [string, number, number][];
    const v1 = new Map<string, [string, number, number]>([['alpha', ['alpha', 90, 2]], ['bravo', ['bravo', 50, 1]], ['charlie', ['charlie', 70, 2]]]);
    for (const e of d1.json().add) v1.set(e[0], e);
    for (const h of d1.json().remove) v1.delete(h);
    expect([...v1.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual(v3);

    expect((await get('/api/v1/list/delta?since=3')).statusCode).toBe(304);
    for (const since of ['99', '0']) {
      const gone = await get(`/api/v1/list/delta?since=${since}`);
      expect([gone.statusCode, gone.json().error.code]).toEqual([410, 'delta_gone']);
    }
    // Retention removed version 1: a client at version 1 can still update, one at 0 cannot.
    await tdb.db.query('delete from list_snapshots where version = 1');
    expect((await get('/api/v1/list/delta?since=1')).statusCode).toBe(200);
    for (const url of ['/api/v1/list/delta', '/api/v1/list/delta?since=abc', '/api/v1/list/delta?since=1&x=2']) expect((await get(url)).statusCode).toBe(400);
  });

  it('carries the X ids in the snapshot and the delta: an id change is a change of the entry', async () => {
    await tdb.db.query("update accounts set x_user_id = '1001' where handle = 'alpha'");
    await score({ alpha: [0.9, 2], bravo: [0.5, 1] });
    expect((await get('/api/v1/list')).json()).toMatchObject({ version: 1, accounts: [['alpha', 90, 2], ['bravo', 50, 1]], ids: ['1001', null] });

    // The X facts job learns the id of bravo: score and tier stay, the entry changes.
    await tdb.db.query("update accounts set x_user_id = '1002' where handle = 'bravo'");
    expect(await score({ alpha: [0.9, 2], bravo: [0.5, 1] })).toMatchObject({ listChanged: true, version: 2 });
    expect((await get('/api/v1/list/delta?since=1')).json()).toEqual({ v: 1, from: 1, version: 2, add: [['bravo', 50, 1]], addIds: ['1002'], remove: [] });
    // Composed over two deltas, the newest id wins.
    await tdb.db.query("update accounts set x_user_id = '1003' where handle = 'bravo'");
    await score({ alpha: [0.9, 2], bravo: [0.5, 1], charlie: [0.7, 2] });
    expect((await get('/api/v1/list/delta?since=1')).json()).toEqual({
      v: 1, from: 1, version: 3, add: [['bravo', 50, 1], ['charlie', 70, 2]], addIds: ['1003', null], remove: [],
    });
    expect((await get('/api/v1/list')).json()).toMatchObject({ accounts: [['alpha', 90, 2], ['bravo', 50, 1], ['charlie', 70, 2]], ids: ['1001', '1003', null] });
  });

  it('answers 410 for a delta stored before the X ids, so the client fetches the full list once', async () => {
    const body = Buffer.from(JSON.stringify({ v: 1, version: 1, generatedAt: '2026-11-08T00:00:00.000Z', accounts: [['alpha', 90, 2]] }));
    const { gzipSync, brotliCompressSync } = await import('node:zlib');
    await tdb.db.query("insert into list_snapshots (version, count, body_gzip, body_br, etag, delta) values (1, 1, $1, $2, '\"1\"', $3::jsonb)", [gzipSync(body), brotliCompressSync(body), JSON.stringify({ from: null, add: [['alpha', 90, 2]], remove: [] })]);
    await tdb.db.query("select setval(pg_get_serial_sequence('list_snapshots', 'version'), 1)");
    await tdb.db.query("update accounts set x_user_id = '1001' where handle = 'alpha'");
    // The old snapshot has no ids: the first publish carries the id as a change.
    expect(await score({ alpha: [0.9, 2] })).toMatchObject({ listChanged: true, version: 2 });
    expect((await tdb.db.query<{ delta: unknown }>('select delta from list_snapshots where version = 2')).rows[0]!.delta).toEqual({ from: 1, add: [['alpha', 90, 2]], addIds: ['1001'], remove: [] });
    await tdb.db.query("update list_snapshots set delta = '{\"from\": 1, \"add\": [[\"alpha\", 90, 2]], \"remove\": []}'::jsonb where version = 2");
    const gone = await get('/api/v1/list/delta?since=1');
    expect([gone.statusCode, gone.json().error.code]).toEqual([410, 'delta_gone']);
  });

  it('publishes inside the caller transaction: pending and moved accounts never enter, a gone one stays (SPEC 13.10 item 10), and a rollback leaves nothing', async () => {
    await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.9, x_user_id = '1' || length(handle) where handle in ('alpha', 'bravo', 'charlie')");
    await tdb.db.query("update accounts set identity = 'gone' where handle = 'bravo'");
    await tdb.db.query("update accounts set identity = 'moved', moved_to = 'echo' where handle = 'charlie'");
    // A row that says pending never enters, whatever its tier says.
    await tdb.db.query("update accounts set status = 'pending', tier = 1, score = 0.7 where handle = 'delta'");
    const now = new Date('2026-11-12T12:00:00.000Z');
    await expect(tdb.db.tx(async (q) => {
      await publishList(q, now);
      throw new Error('admin change failed');
    })).rejects.toThrow('admin change failed');
    expect((await tdb.db.query('select 1 from list_snapshots')).rows).toHaveLength(0);

    // A rolled-back publish used up its version number (sequences ignore rollbacks); each delta names its `from`, so a gap is harmless.
    expect(await tdb.db.tx((q) => publishList(q, now))).toEqual({ version: 2, changed: true, listed: 2 });
    expect([...(await loadLatestEntries(tdb.db))!.entries.values()]).toEqual([['alpha', 90, 2, '15'], ['bravo', 90, 2, '15']]);
    expect(await tdb.db.tx((q) => publishList(q, now))).toEqual({ version: 2, changed: false, listed: 2 });
    t.clock.advance(15_001);
    expect((await get('/api/v1/list')).json()).toEqual({ v: 1, version: 2, generatedAt: now.toISOString(), accounts: [['alpha', 90, 2], ['bravo', 90, 2]], ids: ['15', '15'] });
  });

  it.skipIf(backend !== 'postgres')('publishes one at a time on two connections: the second waits, and its delta starts at the version of the first', async () => {
    await tdb.db.query("update accounts set status = 'confirmed', tier = 2, score = 0.9 where handle = 'alpha'");
    await tdb.db.tx((q) => publishList(q, new Date()));
    const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await other.connect();
    try {
      // Connection 2: an admin change that publishes and has not committed yet.
      await other.query('begin');
      await other.query("update accounts set status = 'confirmed', tier = 2, score = 0.8 where handle = 'bravo'");
      const first = await publishList({ query: (text, params) => other.query(text, params as unknown[]) as never }, new Date());
      // Connection 1: the score job publishes another change at the same time.
      await tdb.db.query("update accounts set status = 'flagged', tier = 1, score = 0.6 where handle = 'charlie'");
      let settled = false;
      const second = tdb.db.tx((q) => publishList(q, new Date())).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await other.query('commit');
      const done = await second;
      expect(done.version).toBeGreaterThan(first.version!);
      const { rows } = await tdb.db.query<{ version: number; delta: { from: number; add: [string, number, number][] } }>('select version, delta from list_snapshots order by version');
      // Each delta starts at the version before it, so a client walks the chain without a gap.
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.delta.from).toBe(Number(rows[i - 1]!.version));
      expect(rows.at(-1)!.delta.add.map((e) => e[0])).toEqual(['charlie']);
    } finally {
      await other.query('rollback').catch(() => undefined);
      await other.end();
    }
  });

  it('SEC-2 reads no stored delta for a version that no kept delta starts at, and still composes a valid one', async () => {
    await score({ alpha: [0.9, 2] });
    await score({ alpha: [0.9, 2], bravo: [0.5, 1] });
    await score({ alpha: [0.9, 2], bravo: [0.5, 1], charlie: [0.7, 2] });
    let read = 0;
    const db = {
      ...tdb.db,
      query: async <R>(text: string, params?: readonly unknown[]) => {
        const r = await tdb.db.query<R>(text, params);
        if (text.includes('delta from list_snapshots')) read += r.rows.length;
        return r;
      },
    };
    const fresh = await makeApp(db);
    const delta = async (since: string) => {
      read = 0;
      const r = await fresh.app.inject({ url: `/api/v1/list/delta?since=${since}` });
      return [since, r.statusCode, read];
    };
    // Each answer is new (a 410 is never cached), so without the fix every such request read every kept delta.
    expect(await delta('0')).toEqual(['0', 410, 0]);
    await tdb.db.query('delete from list_snapshots where version = 1');
    expect(await delta('0')).toEqual(['0', 410, 0]);
    expect(await delta('1')).toEqual(['1', 200, 2]);
  });

  it('builds one delta for concurrent requests that want the same one', async () => {
    await score({ alpha: [0.9, 2] });
    await score({ alpha: [0.9, 2], bravo: [0.5, 1] });
    let builds = 0;
    const db = { ...tdb.db, query: <R>(text: string, params?: readonly unknown[]) => (text.startsWith('select version, delta') && builds++, tdb.db.query<R>(text, params)) };
    const fresh = await makeApp(db);
    const [a, b] = await Promise.all([1, 2].map(() => fresh.app.inject({ url: '/api/v1/list/delta?since=1' })));
    expect([a!.statusCode, b!.statusCode, b!.body]).toEqual([200, 200, a!.body]);
    expect(builds).toBe(1);
  });

  it('limits list, delta, config and stats to 120 per minute per network', async () => {
    await score({ alpha: [0.9, 2] });
    const ip = { 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < 40; i++) {
      await get('/api/v1/list', ip);
      await get('/api/v1/list/delta?since=1', ip);
      await get('/api/v1/stats', ip);
    }
    const r = await get('/api/v1/config', ip);
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
    expect(r.headers['retry-after']).toBe('1');
    expect((await get('/api/v1/list', { 'x-forwarded-for': '203.0.114.50' })).statusCode).toBe(200);
  });
});
