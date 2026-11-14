import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db, Session } from '../src/db.js';
import { migrate } from '../src/scripts/migrate.js';

const MIGRATE_LOCK = 0x7a510002;

function fakeDb(log: { text: string; params?: readonly unknown[] }[]): Db {
  const applied = new Map<string, string>();
  const session: Session = {
    async query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      log.push({ text, params });
      if (text.startsWith('select name, checksum')) {
        const rows = [...applied].map(([name, checksum]) => ({ name, checksum }));
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (text.startsWith('insert into schema_migrations')) {
        applied.set(String(params?.[0]), String(params?.[1]));
        return { rows: [] as R[], rowCount: 1 };
      }
      return { rows: [] as R[], rowCount: 0 };
    },
    async exec(sql) {
      log.push({ text: sql });
    },
    tx(fn) {
      return fn(session);
    },
  };
  return { query: session.query, tx: session.tx, session: (fn) => fn(session), close: async () => undefined };
}

describe('migrate advisory lock', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('locks and unlocks with the schema as the second key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'xslop-migrate-'));
    await writeFile(join(dir, '001_probe.sql'), 'select 1\n');
    const log: { text: string; params?: readonly unknown[] }[] = [];
    const applied = await migrate(fakeDb(log), dir);
    expect(applied).toEqual(['001_probe.sql']);
    const lock = log.find((q) => q.text.includes('pg_advisory_lock'));
    const unlock = log.find((q) => q.text.includes('pg_advisory_unlock'));
    expect(lock).toEqual({ text: 'select pg_advisory_lock($1::int, hashtext(current_schema()))', params: [MIGRATE_LOCK] });
    expect(unlock).toEqual({ text: 'select pg_advisory_unlock($1::int, hashtext(current_schema()))', params: [MIGRATE_LOCK] });
  });
});
