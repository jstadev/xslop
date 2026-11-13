/** Applies the SQL migrations. Run once per release, before the seed import. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPgDb, type Db } from '../db.js';
import { migrationsDir, requireDatabaseUrl } from '../env.js';
import { sha256Hex } from '../lib/crypto.js';
import { isMain } from '../lib/main.js';

const MIGRATE_LOCK = 0x7a510002;
const FILE_RE = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

/** Applies new migrations in order, one transaction per file, under an advisory lock. Returns the applied names. */
export async function migrate(db: Db, dir = migrationsDir): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  return db.session(async (s) => {
    await s.query('select pg_advisory_lock($1)', [MIGRATE_LOCK]);
    try {
      await s.exec('create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())');
      const { rows } = await s.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations');
      const done = new Map(rows.map((r) => [r.name, r.checksum]));
      const applied: string[] = [];
      for (const f of files) {
        const sql = await readFile(join(dir, f), 'utf8');
        const sum = sha256Hex(sql);
        const prev = done.get(f);
        if (prev !== undefined) {
          if (prev !== sum) throw new Error(`migration ${f} changed after it was applied; add a new migration instead`);
          continue;
        }
        await s.exec('begin');
        try {
          await s.exec(sql);
          await s.query('insert into schema_migrations (name, checksum) values ($1, $2)', [f, sum]);
          await s.exec('commit');
        } catch (err) {
          await s.exec('rollback');
          throw new Error(`migration ${f} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        applied.push(f);
      }
      return applied;
    } finally {
      await s.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK]);
    }
  });
}

if (isMain(import.meta.url)) {
  const db = createPgDb(requireDatabaseUrl(), 1);
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
