import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';
import { createPgDb, type Db, type Queryable, type Session } from '../../src/db.js';
import { migrate } from '../../src/scripts/migrate.js';

/** PGlite adapter for the Db interface (tests only; PGlite is a dev dependency). */
export function pgliteDb(p: PGlite): Db {
  const wrap = (x: PGlite | Transaction): Queryable => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await x.query<R>(text, params as unknown[] | undefined);
      return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
    },
  });
  const base = wrap(p);
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => p.transaction((t) => fn(wrap(t)));
  const session: Session = { query: base.query, exec: async (sql) => void (await p.exec(sql)), tx };
  return { query: base.query, tx, session: (fn) => fn(session), close: () => p.close() };
}

type Backend = 'pglite' | 'postgres';
export const BACKENDS: Backend[] = process.env.TEST_DATABASE_URL ? ['pglite', 'postgres'] : ['pglite'];

const TABLES = ['events', 'job_runs', 'jobs', 'used_challenges', 'admin_log', 'admin_sessions', 'appeals', 'list_snapshots', 'sightings', 'votes', 'cleared_votes', 'evidence', 'profiles', 'accounts', 'installs', 'standing_spent'];
/** Trigger functions of the migrations. A table drop does not remove them, so the next migrate would fail. */
const FUNCTIONS = ['xslop_move_first_public', 'xslop_keep_standing_spent'];
const TEST_LOCK = 0x7a51ffff;

export interface TestDb {
  db: Db;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A migrated database for one test file. Real Postgres: the shared throwaway schema is guarded
 * (current_schema must end in _test) and one session lock runs the files one at a time.
 */
export async function openTestDb(kind: Backend): Promise<TestDb> {
  if (kind === 'pglite') {
    const p = new PGlite();
    await p.waitReady;
    const db = pgliteDb(p);
    await migrate(db);
    return { db, reset: () => truncate(db), close: () => db.close() };
  }
  const url = process.env.TEST_DATABASE_URL!;
  const lock = new pg.Client({ connectionString: url });
  await lock.connect();
  const schema = (await lock.query<{ s: string | null }>('select current_schema() as s')).rows[0]?.s;
  if (!schema || !schema.endsWith('_test')) {
    await lock.end();
    throw new Error(`refusing to run tests: current_schema() is ${schema}, expected a *_test schema`);
  }
  // The role ends a statement after 30 s. The files of one run wait here for each other for longer than that.
  await lock.query('set statement_timeout = 0');
  await lock.query('select pg_advisory_lock($1)', [TEST_LOCK]);
  const drop = async () => {
    await lock.query(`drop table if exists ${[...TABLES, 'schema_migrations'].map((t) => `${schema}.${t}`).join(', ')} cascade`);
    await lock.query(`drop function if exists ${FUNCTIONS.map((f) => `${schema}.${f}()`).join(', ')} cascade`);
  };
  await drop();
  const db = createPgDb(url, 4);
  await migrate(db);
  return {
    db,
    reset: () => truncate(db),
    close: async () => {
      await db.close();
      await drop();
      await lock.query('select pg_advisory_unlock($1)', [TEST_LOCK]);
      await lock.end();
    },
  };
}

async function truncate(db: Db): Promise<void> {
  await db.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
}
