import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationsDir } from '../src/env.js';
import { runScoreJob } from '../src/jobs/score-job.js';
import { loadLatestEntries } from '../src/list.js';
import { computeScores } from '../src/scoring/index.js';
import { importSeed, parseSeed, seedFiles } from '../src/scripts/import-seed.js';
import { migrate } from '../src/scripts/migrate.js';
import type { Db } from '../src/db.js';
import { BACKENDS, openTestDb, pgliteDb, type TestDb } from './helpers/db.js';
import { makeApp, register, signed, vote } from './helpers/app.js';

const ALL = ['001_init.sql', '002_hardening.sql', '003_profiles.sql', '004_judging_v2.sql', '005_x_user_id_index.sql', '006_history.sql', '007_first_public.sql'];

/** A PGlite database migrated up to and with `last`. */
async function migratedTo(last: string): Promise<Db> {
  const db = pgliteDb(new PGlite());
  const dir = await mkdtemp(join(tmpdir(), 'xslop-mig-'));
  for (const f of ALL.slice(0, ALL.indexOf(last) + 1)) await writeFile(join(dir, f), await readFile(join(migrationsDir, f), 'utf8'));
  await migrate(db, dir);
  return db;
}

/** A list file in the seed format. */
const listFile = async (dir: string, name: string, sourceId: string, accounts: [handle: string, id: string][]) => {
  const path = join(dir, name);
  const rows = accounts.map(([handle, id]) => ({ id, handle, createdAt: '2026-01-01T00:00:00.000Z', verifiedType: 'none', followers: 1, following: 2, posts: 3 }));
  await writeFile(path, JSON.stringify({ source: { kind: 'x_list', id: sourceId, name: 'test list' }, accounts: rows }));
  return path;
};

/** A `site` list file: only the X id and the handle. */
const siteFile = async (dir: string, name: string, host: string, accounts: [handle: string, id: string][]) => {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ source: { kind: 'site', id: host, name: 'test site' }, accounts: accounts.map(([handle, id]) => ({ id, handle })) }));
  return path;
};

describe('parseSeed of a site file', () => {
  const file = (patch: Record<string, unknown> = {}, accounts: unknown[] = [{ id: '1', handle: 'Alpha_Handle' }]) => ({ source: { kind: 'site', id: 'clankwall.vogel.dev', ...patch }, accounts });

  it('accepts a valid file: source site:<host>, a null profile, the handle in lower case', () => {
    expect(parseSeed(file())).toEqual([{ handle: 'alpha_handle', xUserId: '1', displayHandle: 'Alpha_Handle', source: 'site:clankwall.vogel.dev', profile: null }]);
    for (const id of ['a.b', 'sub-1.example.co.uk', 'x'.repeat(63) + '.com']) expect(parseSeed(file({ id }, []))).toEqual([]);
  });

  it('refuses a bad host', () => {
    for (const id of ['Clankwall.vogel.dev', 'nodot', 'http://clankwall.vogel.dev', 'clankwall.vogel.dev/path', '', '-a.com', 'a-.com', 'a..com', '.a.com', 'a.com.', 'a b.com', `${'a'.repeat(250)}.com`, 5, null]) {
      expect(() => parseSeed(file({ id }, [])), String(id)).toThrow(/seed file must have/);
    }
  });

  it('refuses an account with an extra key, a missing key or a bad value', () => {
    const bad: unknown[] = [
      { id: '1', handle: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: '1', handle: 'alpha', extra: 1 },
      { handle: 'alpha' },
      { id: '1' },
      { id: '12e3', handle: 'alpha' },
      { id: '1', handle: 'way_too_long_handle_x' },
      { id: 1, handle: 'alpha' },
      { id: '1', handle: 5 },
      null,
    ];
    for (const a of bad) expect(() => parseSeed(file({}, [a])), JSON.stringify(a)).toThrow(/seed account #0 is not valid/);
    expect(() => parseSeed(file({}, [{ id: '1', handle: 'alpha' }, { id: '2', handle: 'ALPHA' }]))).toThrow(/appears twice/);
    expect(() => parseSeed(file({}, [{ id: '1', handle: 'alpha' }, { id: '1', handle: 'beta' }]))).toThrow(/X id .* appears twice/);
  });

  it('keeps the x_list kind exact: a site account is not an x_list account and the reverse', () => {
    expect(() => parseSeed({ source: { kind: 'x_list', id: '1' }, accounts: [{ id: '1', handle: 'alpha' }] })).toThrow(/seed account #0/);
    expect(() => parseSeed({ source: { kind: 'x_list', id: 'clankwall.vogel.dev' }, accounts: [] })).toThrow(/seed file must have/);
  });

  it('parses every file of the real seed folder, with the Clankwall file as the second list', async () => {
    const files = await seedFiles();
    expect(files.map((f) => f.split('/').at(-1))).toEqual(['ai-slop-list.json', 'clankwall.json']);
    const counts = await Promise.all(files.map(async (f) => parseSeed(JSON.parse(await readFile(f, 'utf8'))).length));
    expect(counts).toEqual([793, 1430]);
    const clank = parseSeed(JSON.parse(await readFile(files[1]!, 'utf8')));
    expect(clank.every((r) => r.source === 'site:clankwall.vogel.dev' && r.profile === null)).toBe(true);
    const first = new Set(parseSeed(JSON.parse(await readFile(files[0]!, 'utf8'))).flatMap((r) => [r.xUserId]));
    expect(clank.filter((r) => !first.has(r.xUserId))).toHaveLength(1046);
  });
});

describe.each(BACKENDS)('migrations and seed import (%s)', (backend) => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => tdb.reset());

  it('applies each migration once and refuses an edited one', async () => {
    expect(await migrate(tdb.db)).toEqual([]);
    const { rows } = await tdb.db.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(ALL);
    expect(rows[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    // SEC-3: the X facts job and the seed import look accounts up by X id (SPEC 13.11 names the index).
    const idx = await tdb.db.query<{ def: string }>("select indexdef as def from pg_indexes where schemaname = current_schema() and tablename = 'accounts' and indexdef like '%(x_user_id)%'");
    expect(idx.rows.map((r) => r.def.replace(/ ON [a-z_]+\./, ' ON '))).toEqual(['CREATE INDEX accounts_x_user_id_idx ON accounts USING btree (x_user_id) WHERE (x_user_id IS NOT NULL)']);

    const dir = await mkdtemp(join(tmpdir(), 'xslop-mig-'));
    await writeFile(join(dir, '001_init.sql'), `${await readFile(join(migrationsDir, '001_init.sql'), 'utf8')}\n-- edited`);
    await expect(migrate(tdb.db, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('rolls back a failing migration as a whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xslop-mig-'));
    await writeFile(join(dir, '001_init.sql'), await readFile(join(migrationsDir, '001_init.sql'), 'utf8'));
    await writeFile(join(dir, '002_bad.sql'), 'create table half_done (id int);\nselect no_such_function();');
    await expect(migrate(tdb.db, dir)).rejects.toThrow(/002_bad.sql failed/);
    expect((await tdb.db.query("select 1 from information_schema.tables where table_name = 'half_done'")).rows).toHaveLength(0);
    expect((await tdb.db.query("select 1 from schema_migrations where name = '002_bad.sql'")).rows).toHaveLength(0);
  });

  it.skipIf(backend !== 'pglite')('applies 002 on top of 001 data: listed_at, sighting hours, appeal index', async () => {
    const db = await migratedTo('001_init.sql');
    try {
      await db.query("insert into accounts (handle, status, tier) values ('listed', 'confirmed', 2), ('plain', 'none', 0)");
      await db.query("insert into sightings (tweet_id, handle, reply_at, created_at) values ('1', 'listed', now(), '2026-11-07T12:34:56.789Z')");
      await db.query("insert into appeals (id, handle, message, code, ip_hash) values ('00000000-0000-4000-8000-000000000001', 'listed', 'm', 'xslop-AAAAAA', 'net1')");
      expect(await migrate(db)).toEqual(ALL.slice(1));
      const acc = await db.query<{ handle: string; listed: boolean }>('select handle, listed_at is not null as listed from accounts order by handle');
      expect(acc.rows).toEqual([{ handle: 'listed', listed: true }, { handle: 'plain', listed: false }]);
      expect((await db.query<{ c: Date }>('select created_at as c from sightings')).rows[0]!.c.toISOString()).toBe('2026-11-07T12:00:00.000Z');
      const second = "insert into appeals (id, handle, message, code, ip_hash) values ($1, 'listed', 'm', 'xslop-BBBBBB', $2)";
      await db.query(second, ['00000000-0000-4000-8000-000000000002', 'net2']);
      await expect(db.query(second, ['00000000-0000-4000-8000-000000000003', 'net1'])).rejects.toThrow(/duplicate key/);
    } finally {
      await db.close();
    }
  });

  it.skipIf(backend !== 'pglite')('applies 004 on a database at 003 with rows in every table; the old writers still work; the job and the list work on it', async () => {
    const db = await migratedTo('003_profiles.sql');
    try {
      const [i1, i2, i3] = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
      await db.query(`insert into installs (id, public_key, ip_hash, created_at, reputation) values
        ($1, '{}', 'net1', now() - interval '30 days', 0.5), ($2, '{}', 'net2', now() - interval '30 days', 0.5), ($3, '{}', 'net3', now() - interval '30 days', 0.5)`, [i1, i2, i3]);
      await db.query(`insert into accounts (handle, x_user_id, seed, seed_source, status, score, tier, override, cleared_at, listed_at, updated_at) values
        ('old_seed', '11', true, 'x_list:1', 'confirmed', 0.9, 2, null, null, '2026-11-08T00:00:00Z', now()),
        ('seed_cleared', '12', true, 'x_list:1', 'cleared', 0, 0, 'clear', '2026-11-09T00:00:00Z', null, now()),
        ('vote_cleared', null, false, null, 'cleared', 0, 0, 'clear', '2026-11-09T00:00:00Z', null, now()),
        ('vote_reset', null, false, null, 'none', 0, 0, null, '2026-11-09T00:00:00Z', null, now()),
        ('admin_listed', null, false, null, 'confirmed', 1, 2, 'confirm', null, '2026-11-10T00:00:00Z', now()),
        ('crowd_listed', null, false, null, 'confirmed', 0.7, 2, null, null, '2026-11-11T00:00:00Z', now())`);
      // Votes before and after the clears: only the ones before a clear go into cleared_votes.
      await db.query(`insert into votes (install_id, handle, value, updated_at) values
        ($1, 'vote_cleared', 1, '2026-11-08T00:00:00Z'), ($2, 'vote_cleared', 0, '2026-11-08T12:00:00Z'), ($3, 'vote_cleared', 1, '2026-11-10T00:00:00Z'),
        ($1, 'vote_reset', 1, '2026-11-08T00:00:00Z'), ($1, 'seed_cleared', 1, '2026-11-08T00:00:00Z'), ($1, 'admin_listed', 0, '2026-11-08T00:00:00Z'),
        ($1, 'crowd_listed', 1, '2026-11-10T00:00:00Z')`, [i1, i2, i3]);
      await db.query("insert into sightings (tweet_id, handle, reply_at, simhash) values ('1', 'crowd_listed', now() - interval '1 hour', '0000000000000000')");
      await db.query("insert into appeals (id, handle, message, code, ip_hash) values ('00000000-0000-4000-8000-0000000000aa', 'old_seed', 'This is a real person.', 'xslop-AAAAAA', 'net1')");
      await db.query("insert into admin_sessions (token_hash, csrf, expires_at, ip_hash) values ('t', 'c', now() + interval '1 hour', 'h')");
      await db.query("insert into used_challenges values ('c', now() + interval '5 minutes')");
      await db.query(`insert into jobs (name, last_run_at, last_ok_at, detail) values ('score', now(), now(), '{}')`);
      await db.query("insert into profiles (handle, x_id, name, followers) values ('old_seed', '11', 'Old Seed', 10)");
      const body = Buffer.from(JSON.stringify({ v: 1, version: 1, generatedAt: '2026-11-08T00:00:00.000Z', accounts: [['admin_listed', 100, 2], ['crowd_listed', 70, 2], ['old_seed', 90, 2]] }));
      await db.query("insert into list_snapshots (count, body_gzip, body_br, etag, delta) values (3, $1, $2, '\"1\"', null)", [gzipSync(body), brotliCompressSync(body)]);

      expect(await migrate(db)).toEqual(['004_judging_v2.sql', '005_x_user_id_index.sql', '006_history.sql', '007_first_public.sql']);

      expect((await db.query('select trusted, standing, good_marks from installs where id = $1', [i1])).rows[0]).toEqual({ trusted: false, standing: false, good_marks: 0 });
      const accounts = Object.fromEntries((await db.query<Record<string, unknown> & { handle: string }>(
        'select handle, override_at, clear_penalty, confirmed_at, identity, identity_at, moved_to, protected from accounts',
      )).rows.map((r) => [r.handle, r]));
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      expect(Object.fromEntries(Object.entries(accounts).map(([h, r]) => [h, [iso(r.override_at), r.clear_penalty, iso(r.confirmed_at)]]))).toEqual({
        old_seed: [null, false, null],
        seed_cleared: ['2026-11-09T00:00:00.000Z', false, null],
        vote_cleared: ['2026-11-09T00:00:00.000Z', true, null],
        vote_reset: [null, true, null],
        admin_listed: ['2026-11-10T00:00:00.000Z', true, null],
        crowd_listed: [null, true, '2026-11-11T00:00:00.000Z'],
      });
      expect(Object.values(accounts).every((r) => r.identity === 'unknown' && r.identity_at === null && r.moved_to === null && r.protected === false)).toBe(true);
      // Rows from before 004 carry no standing: no install had standing before the column existed (SPEC 13.10 item 5).
      const cleared = await db.query<{ handle: string; install_id: string; ip_hash: string; value: number; standing: boolean }>(
        'select handle, install_id, ip_hash, value, standing from cleared_votes order by handle, install_id',
      );
      expect(cleared.rows).toEqual([
        { handle: 'vote_cleared', install_id: i1, ip_hash: 'net1', value: 1, standing: false },
        { handle: 'vote_cleared', install_id: i2, ip_hash: 'net2', value: 0, standing: false },
        { handle: 'vote_reset', install_id: i1, ip_hash: 'net1', value: 1, standing: false },
      ]);
      // A second run applies nothing and changes no row.
      const snapshot = async () => JSON.stringify((await db.query('select * from accounts order by handle')).rows) + JSON.stringify((await db.query('select * from cleared_votes order by handle, install_id')).rows);
      const before = await snapshot();
      expect(await migrate(db)).toEqual([]);
      expect(await snapshot()).toBe(before);
      expect((await db.query<{ seen: boolean }>('select seen_at is not null as seen from admin_sessions')).rows).toEqual([{ seen: true }]);
      expect((await db.query<{ v: Date | null }>('select verified_at as v from sightings')).rows).toEqual([{ v: null }]);
      for (const t of ['evidence', 'cleared_votes', 'admin_log']) expect((await db.query(`select 1 from information_schema.tables where table_name = '${t}'`)).rows).toHaveLength(1);
      await expect(db.query("update accounts set status = 'listed' where handle = 'old_seed'")).rejects.toThrow(/check constraint/);
      await expect(db.query("update accounts set x_user_id = '12ab' where handle = 'old_seed'")).rejects.toThrow(/check constraint/);
      await expect(db.query("update accounts set identity = 'renamed' where handle = 'old_seed'")).rejects.toThrow(/check constraint/);

      // The previous release writes during the switch: its admin clear, its vote and its session row still work.
      await db.query("update accounts set status = 'cleared', tier = 0, cleared_at = now(), override = 'clear', listed_at = null, updated_at = now() where handle = 'crowd_listed'");
      await db.query("insert into accounts (handle) values ('new_target') on conflict (handle) do nothing");
      await db.query("insert into votes (install_id, handle, value, tweet_id, text) values ($1, 'new_target', 1, '1850000000000000001', null)", [i2]);
      await db.query("insert into admin_sessions (token_hash, csrf, expires_at, ip_hash) values ('t2', 'c', now() + interval '1 hour', 'h')");

      const r = await runScoreJob(db, computeScores);
      expect(r).toMatchObject({ skipped: false, listed: 2, listChanged: true, version: 2 });
      // The first publish after 004 carries the X ids as a change of the entries that have one.
      expect([...(await loadLatestEntries(db))!.entries.values()]).toEqual([['admin_listed', 100, 2, null], ['old_seed', expect.any(Number), 2, '11']]);
      const delta = (await db.query<{ delta: { from: number; add: unknown[]; addIds: unknown[]; remove: string[] } }>('select delta from list_snapshots where version = 2')).rows[0]!.delta;
      expect(delta).toEqual({ from: 1, add: [['old_seed', expect.any(Number), 2]], addIds: ['11'], remove: ['crowd_listed'] });
      const t = await makeApp(db);
      expect((await t.app.inject({ url: '/api/v1/list' })).json()).toMatchObject({ version: 2, ids: [null, '11'] });
      expect((await t.app.inject({ url: '/api/v1/list/delta?since=1' })).json()).toMatchObject({ add: [['old_seed', expect.any(Number), 2]], addIds: ['11'], remove: ['crowd_listed'] });
    } finally {
      await db.close();
    }
  }, 120_000);

  it('imports every seed account of the repository, idempotently, without touching overrides, clears or votes', async () => {
    const files = await seedFiles();
    expect(files.map((f) => f.split('/').at(-1))).toContain('ai-slop-list.json');
    const raw = JSON.parse(await readFile(files[0]!, 'utf8')) as { source: { id: string }; accounts: { id: string; handle: string }[] };
    const [first, second, third] = raw.accounts.map((a) => ({ ...a, key: a.handle.toLowerCase() }));
    const imported = await importSeed(tdb.db);
    expect(imported).toEqual({ files: files.length, total: imported.total, changed: imported.total });
    expect(imported.total).toBeGreaterThanOrEqual(793 + 1046);
    // A seed is on the list from the import on: votes after it earn no reputation.
    const listed = (await tdb.db.query<{ n: number; t: Date }>('select count(*)::int as n, max(listed_at) as t from accounts where listed_at is not null')).rows[0]!;
    expect(listed.n).toBe(imported.total);
    const row = (await tdb.db.query<{ display_handle: string; x_user_id: string; seed: boolean; seed_source: string; profile: Record<string, unknown>; status: string }>(
      'select display_handle, x_user_id, seed, seed_source, profile, status from accounts where handle = $1', [first!.key],
    )).rows[0]!;
    expect(row).toMatchObject({ display_handle: first!.handle, x_user_id: first!.id, seed: true, seed_source: `x_list:${raw.source.id}`, status: 'none' });
    expect(Object.keys(row.profile).sort()).toEqual(['createdAt', 'followers', 'following', 'posts', 'verifiedType']);

    const t = await makeApp(tdb.db);
    const id = await register(t);
    await signed(t, id, 'POST', '/api/v1/votes', vote(second!.key, 'not_slop'));
    await tdb.db.query("update accounts set override = 'clear', override_at = now(), cleared_at = now(), status = 'cleared' where handle = $1", [second!.key]);
    const updatedBefore = (await tdb.db.query<{ updated_at: Date }>('select updated_at from accounts where handle = $1', [third!.key])).rows[0]!.updated_at;

    expect(await importSeed(tdb.db)).toEqual({ ...imported, changed: 0 });
    const kept = (await tdb.db.query<{ override: string; status: string; cleared: boolean; seed: boolean }>('select override, status, cleared_at is not null as cleared, seed from accounts where handle = $1', [second!.key])).rows[0]!;
    expect(kept).toEqual({ override: 'clear', status: 'cleared', cleared: true, seed: true });
    expect((await tdb.db.query('select 1 from votes')).rows).toHaveLength(1);
    expect((await tdb.db.query<{ updated_at: Date }>('select updated_at from accounts where handle = $1', [third!.key])).rows[0]!.updated_at).toEqual(updatedBefore);
    expect((await tdb.db.query<{ t: Date }>('select max(listed_at) as t from accounts')).rows[0]!.t).toEqual(listed.t);
  });

  it('imports every list file: the first file that names an account gives its source; the X id decides, not the handle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xslop-seed-'));
    const a = await listFile(dir, 'a-first.json', '111', [['Alpha_Handle', '1'], ['beta_handle', '2'], ['gamma_handle', '3'], ['kept_id', '6']]);
    const b = await listFile(dir, 'b-second.json', '222', [['beta_handle', '20'], ['delta_handle', '4'], ['other_handle', '1'], ['renamed_away', '5']]);
    await writeFile(join(dir, 'notes.txt'), 'not a list');
    // The handle gamma_handle belongs to another X account now; the account with id 5 renamed (the X facts job moved its row).
    await tdb.db.query("insert into accounts (handle, x_user_id) values ('gamma_handle', '99'), ('new_name', '5')");
    // An account with an admin clear and no X id yet; a starter account whose stored X id differs from the file.
    await tdb.db.query("insert into accounts (handle, override, override_at, cleared_at, status) values ('delta_handle', 'clear', now(), now(), 'cleared')");
    await tdb.db.query("insert into accounts (handle, x_user_id, seed, seed_source) values ('kept_id', '60', true, 'x_list:1')");

    expect((await seedFiles(dir)).map((f) => f.split('/').at(-1))).toEqual(['a-first.json', 'b-second.json']);
    expect(await importSeed(tdb.db, await seedFiles(dir))).toEqual({ files: 2, total: 6, changed: 3 });
    const rows = Object.fromEntries((await tdb.db.query<{ handle: string; x_user_id: string | null; seed: boolean; seed_source: string | null; display_handle: string | null; override: string | null; status: string }>(
      'select handle, x_user_id, seed, seed_source, display_handle, override, status from accounts',
    )).rows.map((r) => [r.handle, r]));
    expect(Object.keys(rows).sort()).toEqual(['alpha_handle', 'beta_handle', 'delta_handle', 'gamma_handle', 'kept_id', 'new_name']);
    expect(rows.alpha_handle).toMatchObject({ x_user_id: '1', seed: true, seed_source: 'x_list:111', display_handle: 'Alpha_Handle' });
    expect(rows.beta_handle).toMatchObject({ x_user_id: '2', seed: true, seed_source: 'x_list:111' });
    expect(rows.delta_handle).toMatchObject({ x_user_id: '4', seed: true, seed_source: 'x_list:222', override: 'clear', status: 'cleared' });
    expect(rows.gamma_handle).toMatchObject({ x_user_id: '99', seed: false, seed_source: null });
    expect(rows.kept_id).toMatchObject({ x_user_id: '60', seed: true, seed_source: 'x_list:1' });
    expect(rows.new_name).toMatchObject({ x_user_id: '5', seed: false });

    expect(await importSeed(tdb.db, [a, b])).toEqual({ files: 2, total: 6, changed: 0 });
  });

  it('imports a site file with seed_source site:<host> and a NULL profile; the first file wins when two share an account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xslop-seed-'));
    await listFile(dir, 'a-list.json', '111', [['Shared_One', '1'], ['list_only', '2']]);
    await siteFile(dir, 'b-site.json', 'clankwall.vogel.dev', [['shared_one', '1'], ['site_only', '3'], ['Mixed_Case', '4']]);
    const files = await seedFiles(dir);
    expect(await importSeed(tdb.db, files)).toEqual({ files: 2, total: 4, changed: 4 });
    const rows = Object.fromEntries((await tdb.db.query<{ handle: string; x_user_id: string; display_handle: string; seed: boolean; seed_source: string; profile: unknown; profile_null: boolean; status: string; listed: boolean }>(
      'select handle, x_user_id, display_handle, seed, seed_source, profile, profile is null as profile_null, status, listed_at is not null as listed from accounts',
    )).rows.map((r) => [r.handle, r]));
    expect(Object.keys(rows).sort()).toEqual(['list_only', 'mixed_case', 'shared_one', 'site_only']);
    expect(rows.site_only).toMatchObject({ x_user_id: '3', display_handle: 'site_only', seed: true, seed_source: 'site:clankwall.vogel.dev', profile_null: true, status: 'none', listed: true });
    expect(rows.site_only!.profile).toBeNull();
    expect(rows.mixed_case).toMatchObject({ display_handle: 'Mixed_Case', seed_source: 'site:clankwall.vogel.dev', profile_null: true });
    expect(rows.shared_one).toMatchObject({ seed_source: 'x_list:111', profile_null: false });
    expect(rows.list_only).toMatchObject({ seed_source: 'x_list:111', profile_null: false });
    expect(await importSeed(tdb.db, files)).toEqual({ files: 2, total: 4, changed: 0 });

    // The score job confirms a seed account of a site file like any other, with no profile (SPEC 13.3 rule 3).
    await runScoreJob(tdb.db, computeScores);
    const status = (await tdb.db.query<{ handle: string; status: string; tier: number; reason: string }>(
      "select handle, status, tier, parts->>'reason' as reason from accounts order by handle",
    )).rows;
    expect(status.every((r) => r.status === 'confirmed' && r.tier === 2 && r.reason === 'seed')).toBe(true);
    expect(status).toHaveLength(4);
  });

  it('refuses a malformed site file before writing anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xslop-seed-'));
    const good = await listFile(dir, 'a-good.json', '7', [['good_handle', '70']]);
    await writeFile(join(dir, 'b-bad.json'), JSON.stringify({ source: { kind: 'site', id: 'Bad Host' }, accounts: [{ id: '1', handle: 'ok_handle' }] }));
    await writeFile(join(dir, 'c-bad.json'), JSON.stringify({ source: { kind: 'site', id: 'good.example' }, accounts: [{ id: '1', handle: 'ok_handle' }, { id: '2', handle: 'extra_key', followers: 3 }] }));
    await expect(importSeed(tdb.db, [good, join(dir, 'b-bad.json')])).rejects.toThrow(/seed file must have/);
    await expect(importSeed(tdb.db, [good, join(dir, 'c-bad.json')])).rejects.toThrow(/seed account #1/);
    expect((await tdb.db.query('select 1 from accounts')).rows).toHaveLength(0);
  });

  it('refuses a malformed seed file before writing anything', async () => {
    const [file] = await seedFiles();
    const raw = JSON.parse(await readFile(file!, 'utf8'));
    const dir = await mkdtemp(join(tmpdir(), 'xslop-seed-'));
    const good = await listFile(dir, 'a-good.json', '7', [['good_handle', '70']]);
    const bad = { ...raw, accounts: [...raw.accounts.slice(0, 5), { ...raw.accounts[0], handle: 'way_too_long_handle_x' }] };
    await writeFile(join(dir, 'b-bad.json'), JSON.stringify(bad));
    await expect(importSeed(tdb.db, [good, join(dir, 'b-bad.json')])).rejects.toThrow(/seed account #5/);
    expect((await tdb.db.query('select 1 from accounts')).rows).toHaveLength(0);
    expect(() => parseSeed({ source: { kind: 'x_list', id: '1' }, accounts: [raw.accounts[0], raw.accounts[0]] })).toThrow(/appears twice/);
    expect(() => parseSeed({ source: { kind: 'x_list', id: '1' }, accounts: [raw.accounts[0], { ...raw.accounts[0], handle: 'other_handle' }] })).toThrow(/X id .* appears twice/);
    expect(() => parseSeed({ source: { kind: 'file', id: '1' }, accounts: [] })).toThrow();
    expect(() => parseSeed({ source: { kind: 'x_list', id: '1; drop' }, accounts: [] })).toThrow();
    expect(() => parseSeed({ source: { kind: 'x_list', id: '1' }, accounts: [{ ...raw.accounts[0], id: '12e3' }] })).toThrow(/seed account #0/);
  });
});
