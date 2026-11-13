/** The database interface of the server (query, transaction, dedicated session) and its node-postgres pool. */
import pg from 'pg';

interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** One dedicated connection: session-level advisory locks, multi-statement scripts, transactions. */
export interface Session extends Queryable {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  session<T>(fn: (s: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// int8 (count(*), bigserial) as a JS number, like PGlite. Values stay far below 2^53.
const INT8_OID = 20;
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

async function inTx<T>(c: pg.PoolClient, fn: (q: Queryable) => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    const out = await fn(wrapClient(c));
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  }
}

function wrapClient(c: pg.PoolClient | pg.Pool): Queryable {
  return {
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await c.query(text, params as unknown[] | undefined);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
    },
  };
}

export function createPgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, types, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // An idle client error must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  const base = wrapClient(pool);
  return {
    query: base.query,
    async tx(fn) {
      const c = await pool.connect();
      try {
        return await inTx(c, fn);
      } finally {
        c.release();
      }
    },
    async session(fn) {
      const c = await pool.connect();
      let broken = false;
      try {
        const q = wrapClient(c);
        return await fn({
          query: q.query,
          exec: async (sql) => {
            await c.query(sql);
          },
          tx: (f) => inTx(c, f),
        });
      } catch (err) {
        broken = true;
        throw err;
      } finally {
        // Destroy the connection on error so no session lock or open transaction leaks back to the pool.
        c.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** bytea arrives as Buffer from pg and as Uint8Array from PGlite. */
export function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('expected bytea');
}
