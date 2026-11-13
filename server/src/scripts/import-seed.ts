/** Imports the seed lists (section 10, `seed/README.md`). Run once per release, after the migrations. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPgDb, type Queryable } from '../db.js';
import { releaseRoot, requireDatabaseUrl } from '../env.js';
import { HANDLE_RE } from '../lib/http.js';
import { isMain } from '../lib/main.js';

const seedDir = join(releaseRoot, 'seed');

/** Every list file of the seed directory, in name order: the first file that names an account gives its source. */
export async function seedFiles(dir = seedDir): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
}

interface SeedProfile {
  createdAt: string;
  followers: number;
  following: number;
  posts: number;
  verifiedType: string;
}

interface SeedRow {
  handle: string;
  xUserId: string;
  displayHandle: string;
  source: string;
  /** Null for a `site` file: such a list gives only the X id and the handle. */
  profile: SeedProfile | null;
}

const X_ID_RE = /^[0-9]{1,20}$/;
/** Host name: dot-separated labels of a-z, 0-9 and inner `-`, at least two labels. */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/**
 * Validates one list file; one bad row stops the import before anything is written. Two kinds of source:
 * `x_list` (numeric list id; each account has id, handle, createdAt, verifiedType and the three counts) and
 * `site` (host name; each account has exactly id and handle, and its profile is null).
 */
export function parseSeed(raw: unknown): SeedRow[] {
  const f = raw as { source?: { kind?: unknown; id?: unknown }; accounts?: unknown };
  const kind = f?.source?.kind;
  const sid = f?.source?.id;
  const site = kind === 'site';
  if ((!site && kind !== 'x_list') || typeof sid !== 'string' || !(site ? HOST_RE : X_ID_RE).test(sid) || !Array.isArray(f.accounts)) {
    throw new Error('seed file must have source.kind "x_list" with a numeric source.id, or "site" with a host name, and an accounts array');
  }
  const source = `${kind}:${sid}`;
  const handles = new Set<string>();
  const ids = new Set<string>();
  return f.accounts.map((a: Record<string, unknown>, i: number): SeedRow => {
    const display = a?.handle;
    const handle = typeof display === 'string' ? display.toLowerCase() : '';
    const ok =
      typeof display === 'string' &&
      HANDLE_RE.test(handle) &&
      typeof a.id === 'string' &&
      X_ID_RE.test(a.id) &&
      (site
        ? Object.keys(a).length === 2
        : isStr(a.createdAt, 40) &&
          !Number.isNaN(Date.parse(a.createdAt)) &&
          isCount(a.followers) &&
          isCount(a.following) &&
          isCount(a.posts) &&
          isStr(a.verifiedType, 32));
    if (!ok) throw new Error(`seed account #${i} is not valid`);
    if (handles.has(handle)) throw new Error(`seed handle ${handle} appears twice`);
    if (ids.has(a.id as string)) throw new Error(`seed X id ${a.id as string} appears twice`);
    handles.add(handle);
    ids.add(a.id as string);
    return {
      handle,
      xUserId: a.id as string,
      displayHandle: display as string,
      source,
      profile: site
        ? null
        : {
            createdAt: a.createdAt as string,
            followers: a.followers as number,
            following: a.following as number,
            posts: a.posts as number,
            verifiedType: a.verifiedType as string,
          },
    };
  });
}

/**
 * Upserts every account of every list file with seed=true and seed_source = <source.kind>:<source.id> (section 10; profile is
 * SQL NULL for a `site` file). Idempotent: an
 * unchanged row is not rewritten. Never touches override, cleared_at, status, identity or votes, and never changes a stored X id.
 * The X id decides, not the handle: a handle that now holds another X id, or an X id that another row holds (the account
 * renamed, SPEC 13.6), is left alone, so the next owner of a handle never becomes a starter account. A new seed row gets
 * listed_at = now(), so votes cast after the import earn no reputation (a seed is on the list from day one).
 */
export async function importSeed(q: Queryable, files?: readonly string[]): Promise<{ files: number; total: number; changed: number }> {
  const paths = files ?? (await seedFiles());
  const parsed = await Promise.all(paths.map(async (p) => parseSeed(JSON.parse(await readFile(p, 'utf8')))));
  const handles = new Set<string>();
  const ids = new Set<string>();
  const rows = parsed.flat().filter((r) => {
    if (handles.has(r.handle) || ids.has(r.xUserId)) return false;
    handles.add(r.handle);
    ids.add(r.xUserId);
    return true;
  });
  let changed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const r = await q.query(
      `insert into accounts (handle, x_user_id, display_handle, seed, seed_source, profile, listed_at)
       select h, x, d, true, s, p, now() from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[]) as u(h, x, d, s, p)
       where not exists (select 1 from accounts o where o.x_user_id = u.x and o.handle <> u.h)
       on conflict (handle) do update set x_user_id = excluded.x_user_id, display_handle = excluded.display_handle,
         seed = true, seed_source = excluded.seed_source, profile = excluded.profile,
         listed_at = case when accounts.seed then accounts.listed_at else coalesce(accounts.listed_at, now()) end, updated_at = now()
       where (accounts.x_user_id is null or accounts.x_user_id = excluded.x_user_id)
         and (accounts.x_user_id, accounts.display_handle, accounts.seed, accounts.seed_source, accounts.profile)
           is distinct from (excluded.x_user_id, excluded.display_handle, true, excluded.seed_source, excluded.profile)`,
      [part.map((r) => r.handle), part.map((r) => r.xUserId), part.map((r) => r.displayHandle), part.map((r) => r.source), part.map((r) => (r.profile ? JSON.stringify(r.profile) : null))],
    );
    changed += r.rowCount;
  }
  return { files: paths.length, total: rows.length, changed };
}

if (isMain(import.meta.url)) {
  const db = createPgDb(requireDatabaseUrl(), 1);
  try {
    const r = await importSeed(db);
    console.log(`seed files: ${r.files}, seed accounts: ${r.total}, written: ${r.changed}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
