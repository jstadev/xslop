import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db.js';
import { CRITERIA } from '../src/scoring/criteria.js';
import { PREVIOUS_VIEW_MS, VIEW_CHECK_MS } from '../src/sloppers.js';
import { fromIp, makeApp, type TestApp } from './helpers/app.js';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';

interface Fixture {
  handle: string;
  status?: 'confirmed' | 'flagged' | 'none' | 'cleared' | 'pending';
  tier?: 0 | 1 | 2;
  score?: number;
  seed?: boolean;
  listedAt?: Date | null;
  parts?: Record<string, unknown> | null;
  name?: string | null;
  followers?: number | null;
  avatar?: boolean;
  slop?: number;
  notSlop?: number;
  xUserId?: string;
  seedSource?: string;
}

const INSTALLS = 12;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

async function addInstalls(db: Db): Promise<void> {
  await db.query(`insert into installs (id, public_key, ip_hash) select gen_random_uuid(), '{}'::jsonb, 'net' || i from generate_series(1, ${INSTALLS}) i`);
}

async function addAccount(db: Db, a: Fixture): Promise<void> {
  const status = a.status ?? 'confirmed';
  const tier = a.tier ?? (status === 'confirmed' ? 2 : status === 'flagged' ? 1 : 0);
  const parts = a.parts === undefined ? { reason: status === 'confirmed' ? 'votes_confirmed' : 'votes_flagged', networks: 4, needed: 0, raters: 3 } : a.parts;
  await db.query('insert into accounts (handle, status, tier, score, seed, listed_at, parts, x_user_id, seed_source) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)', [
    a.handle,
    status,
    tier,
    a.score ?? 0.5,
    a.seed ?? false,
    a.listedAt === undefined ? new Date('2026-10-01T00:00:00Z') : a.listedAt,
    parts === null ? null : JSON.stringify(parts),
    a.xUserId ?? null,
    a.seedSource ?? null,
  ]);
  if (a.name !== undefined || a.followers !== undefined || a.avatar) {
    await db.query('insert into profiles (handle, name, followers, avatar, avatar_type) values ($1, $2, $3, $4, $5)', [
      a.handle,
      a.name ?? null,
      a.followers ?? null,
      a.avatar ? JPEG : null,
      a.avatar ? 'image/jpeg' : null,
    ]);
  }
  const slop = a.slop ?? 0;
  const notSlop = a.notSlop ?? 0;
  if (slop + notSlop > 0) {
    await db.query(
      `insert into votes (install_id, handle, value, text)
       select id, $1, case when rn <= $2::int then 1 else 0 end, 'vote text that must stay private'
       from (select id, row_number() over (order by id) as rn from installs) t where rn <= $2::int + $3::int`,
      [a.handle, slop, notSlop],
    );
  }
}

describe.each(BACKENDS)('GET /api/v1/sloppers (%s)', (backend) => {
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

  const url = (q: Record<string, string>) => `/api/v1/sloppers?${new URLSearchParams(q).toString()}`;
  const get = (q: Record<string, string> = {}, headers: Record<string, string> = {}) => t.app.inject({ url: url(q), headers });
  const handles = (r: { json(): { items: { handle: string }[] } }) => r.json().items.map((i) => i.handle);

  async function add(fixtures: Fixture[]): Promise<void> {
    for (const f of fixtures) await addAccount(tdb.db, f);
  }

  /**
   * Waits until a request is served from a view rebuilt after the last data change. A view must exist
   * before the change. Polls come from their own network so they spend no token of the caller's bucket.
   */
  async function refreshed(): Promise<void> {
    const generatedAt = async () => {
      const r = await get({}, fromIp('198.51.100.7'));
      expect(r.statusCode).toBe(200);
      return r.json().generatedAt as string;
    };
    const before = await generatedAt();
    t.clock.advance(VIEW_CHECK_MS + 1);
    await vi.waitFor(async () => expect(await generatedAt()).not.toBe(before), { timeout: 15_000, interval: 20 });
  }

  /** Walks every page with `limit` and returns all handles in the order served. */
  async function walk(q: Record<string, string>, limit: number): Promise<{ handles: string[]; total: number }> {
    const out: string[] = [];
    let cursor: string | null = null;
    let total = -1;
    for (let page = 0; page < 200; page++) {
      const r = await get({ ...q, limit: String(limit), ...(cursor ? { cursor } : {}) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: { handle: string }[]; next: string | null; total: number };
      if (total >= 0) expect(body.total).toBe(total);
      total = body.total;
      out.push(...body.items.map((i) => i.handle));
      if (!body.next) return { handles: out, total };
      cursor = body.next;
    }
    throw new Error('the walk never ended');
  }

  it('serves listed accounts with the full public shape and nothing private', async () => {
    await addInstalls(tdb.db);
    await add([
      { handle: 'alpha', score: 0.914, seed: true, listedAt: new Date('2026-11-01T10:00:00Z'), name: 'Alpha One', followers: 1200, avatar: true, slop: 3, notSlop: 1, parts: { reason: 'seed', networks: 3, needed: 0 }, xUserId: '1234567890123456789', seedSource: 'x_list:2116659176894071283' },
      { handle: 'bravo', status: 'flagged', score: 0.55, parts: { reason: 'votes_flagged', networks: 2, needed: 1 } },
      { handle: 'hidden', status: 'none', score: 0.99 },
      { handle: 'cleared', status: 'cleared', score: 0.99 },
    ]);
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const body = r.json();
    expect(body.total).toBe(2);
    expect(body.next).toBeNull();
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(body.items).toEqual([
      {
        handle: 'alpha',
        name: 'Alpha One',
        avatar: '/api/v1/avatars/alpha',
        followers: 1200,
        status: 'confirmed',
        tier: 2,
        score: 91,
        seed: true,
        votes: { slop: 3, notSlop: 1 },
        networks: 3,
        needed: 0,
        listedAt: '2026-11-01T10:00:00.000Z',
        reason: 'seed',
        seedSource: 'x_list:2116659176894071283',
        waits: false,
        xUserId: '1234567890123456789',
      },
      {
        handle: 'bravo',
        name: null,
        avatar: null,
        followers: null,
        status: 'flagged',
        tier: 1,
        score: 55,
        seed: false,
        votes: { slop: 0, notSlop: 0 },
        networks: 2,
        needed: 1,
        listedAt: '2026-10-01T00:00:00.000Z',
        reason: 'votes_flagged',
        seedSource: null,
        waits: false,
        xUserId: null,
      },
    ]);
    const raw = r.body;
    for (const leak of ['vote text', 'net1', 'ip_hash', 'install']) expect(raw).not.toContain(leak);
    const ids = await tdb.db.query<{ id: string }>('select id from installs');
    for (const { id } of ids.rows) expect(raw).not.toContain(id);
  });

  it('names the list of a seed account in seedSource, and gives null for a vote row, a row with a bad source and a non-seed row that keeps a source', async () => {
    await add([
      { handle: 'from_site', seed: true, seedSource: 'site:clankwall.vogel.dev', parts: { reason: 'seed', networks: 0, needed: 0 } },
      { handle: 'from_list', seed: true, seedSource: 'x_list:2116659176894071283', parts: { reason: 'seed', networks: 0, needed: 0 } },
      { handle: 'bad_source', seed: true, seedSource: 'file:/etc/passwd', parts: { reason: 'seed', networks: 0, needed: 0 } },
      { handle: 'no_source', seed: true, parts: { reason: 'seed', networks: 0, needed: 0 } },
      { handle: 'by_votes', score: 0.7 },
      { handle: 'not_seed', seedSource: 'site:clankwall.vogel.dev' },
    ]);
    const items = (await get({ sort: 'handle' })).json().items as { handle: string; seed: boolean; seedSource: string | null }[];
    expect(Object.fromEntries(items.map((i) => [i.handle, i.seedSource]))).toEqual({
      bad_source: null,
      by_votes: null,
      from_list: 'x_list:2116659176894071283',
      from_site: 'site:clankwall.vogel.dev',
      no_source: null,
      not_seed: null,
    });
    expect(items.filter((i) => i.seedSource !== null).every((i) => i.seed)).toBe(true);
  });

  it('R13 shows no pending or moved account, shows a gone one, and marks only a flagged account that waits for an admin to confirm it (SPEC 13.9 items 1 and 13, 13.10 item 10)', async () => {
    await add([
      { handle: 'waits_review', status: 'flagged', parts: { reason: 'votes_flagged', networks: 5, needed: 0, want: 'confirmed' }, xUserId: '9876543210' },
      { handle: 'flagged_only', status: 'flagged', parts: { reason: 'votes_flagged', networks: 2, needed: 1, want: 'flagged' } },
      { handle: 'confirmed_want', parts: { reason: 'votes_confirmed', networks: 6, needed: 0, want: 'confirmed' } },
      { handle: 'pending_tier_1', status: 'pending', tier: 1, score: 0.99 },
      { handle: 'pending_tier_2', status: 'pending', tier: 2, score: 0.99 },
      { handle: 'moved_listed', score: 0.98 },
      { handle: 'gone_flagged', status: 'flagged', score: 0.97 },
    ]);
    // A moved account keeps its state on the row; the list and this page leave it out. A gone one stays on both.
    await tdb.db.query("update accounts set identity = case handle when 'moved_listed' then 'moved' else 'gone' end where handle in ('moved_listed', 'gone_flagged')");
    const r = await get({ sort: 'handle' });
    expect(r.json().total).toBe(4);
    expect(r.json().items.map((i: { handle: string; waits: boolean; xUserId: string | null }) => [i.handle, i.waits, i.xUserId])).toEqual([
      ['confirmed_want', false, null],
      ['flagged_only', false, null],
      ['gone_flagged', false, null],
      ['waits_review', true, '9876543210'],
    ]);
    expect(r.body).not.toContain('pending_tier');
    expect(r.body).not.toMatch(/moved_listed/);
    expect((await t.app.inject({ url: '/api/v1/sloppers?q=pending' })).json().total).toBe(0);
  });

  it('excludes a status and tier that do not pair, and gives an account without parts a safe reason', async () => {
    await add([
      { handle: 'bad_pair', status: 'confirmed', tier: 1 },
      { handle: 'no_parts', status: 'confirmed', parts: null },
    ]);
    const body = (await get()).json();
    expect(body.items.map((i: { handle: string }) => i.handle)).toEqual(['no_parts']);
    expect(body.items[0]).toMatchObject({ reason: 'pending', networks: 0, needed: 0 });
  });

  it('filters by status and sorts by score, recency, votes and handle with stable ties', async () => {
    await addInstalls(tdb.db);
    await add([
      { handle: 'tie_b', score: 0.8, listedAt: new Date('2026-10-02T00:00:00Z'), slop: 2 },
      { handle: 'tie_a', score: 0.8, listedAt: new Date('2026-10-02T00:00:00Z'), slop: 2 },
      { handle: 'high', score: 0.95, listedAt: new Date('2026-09-01T00:00:00Z'), slop: 1 },
      { handle: 'never', status: 'flagged', score: 0.4, listedAt: null, slop: 4 },
      { handle: 'zed', status: 'flagged', score: 0.6, listedAt: new Date('2026-11-05T00:00:00Z') },
    ]);
    expect(handles(await get())).toEqual(['high', 'tie_a', 'tie_b', 'zed', 'never']);
    expect(handles(await get({ sort: 'recent' }))).toEqual(['zed', 'tie_a', 'tie_b', 'high', 'never']);
    expect(handles(await get({ sort: 'votes' }))).toEqual(['never', 'tie_a', 'tie_b', 'high', 'zed']);
    expect(handles(await get({ sort: 'handle' }))).toEqual(['high', 'never', 'tie_a', 'tie_b', 'zed']);
    expect(handles(await get({ status: 'confirmed' }))).toEqual(['high', 'tie_a', 'tie_b']);
    expect(handles(await get({ status: 'flagged', sort: 'handle' }))).toEqual(['never', 'zed']);
    expect((await get({ status: 'flagged' })).json().total).toBe(2);
  });

  it('R2-3 counts each network once in the vote numbers and in the votes order, however many installs it has', async () => {
    await add([{ handle: 'farmed', score: 0.9 }, { handle: 'crowd', score: 0.5 }]);
    await tdb.db.query(`insert into installs (id, public_key, ip_hash) select gen_random_uuid(), '{}'::jsonb, case when i <= 9 then 'farm' else 'net' || i end from generate_series(1, 12) i`);
    await tdb.db.query("insert into votes (install_id, handle, value) select id, 'farmed', 1 from installs where ip_hash = 'farm'");
    await tdb.db.query("insert into votes (install_id, handle, value) select id, 'crowd', case when ip_hash = 'net12' then 0 else 1 end from installs where ip_hash <> 'farm'");
    const items = (await get({ sort: 'votes' })).json().items as { handle: string; votes: unknown }[];
    expect(items.map((i) => [i.handle, i.votes])).toEqual([
      ['crowd', { slop: 2, notSlop: 1 }],
      ['farmed', { slop: 1, notSlop: 0 }],
    ]);
  });

  it('searches handle and display name, case-insensitive, trimmed, with a leading @ allowed', async () => {
    await add([
      { handle: 'demo_quill_x1', name: 'Demo Writer Quill', score: 0.9 },
      { handle: 'demo_lumen_x2', name: 'Grâce LUMEN', score: 0.8 },
      { handle: 'demo_slopbot_x3', status: 'flagged', name: null, score: 0.7 },
    ]);
    expect(handles(await get({ q: 'quill' }))).toEqual(['demo_quill_x1']);
    expect(handles(await get({ q: 'QUILL' }))).toEqual(['demo_quill_x1']);
    expect(handles(await get({ q: '  @demo_quill  ' }))).toEqual(['demo_quill_x1']);
    expect(handles(await get({ q: 'lumen' }))).toEqual(['demo_lumen_x2']);
    expect(handles(await get({ q: 'bot' }))).toEqual(['demo_slopbot_x3']);
    expect(handles(await get({ q: 'no such thing' }))).toEqual([]);
    // Queries of one and two characters take the scan path and must find the same accounts.
    expect(handles(await get({ q: 'gr' }))).toEqual(['demo_lumen_x2']);
    expect(handles(await get({ q: 'b' }))).toEqual(['demo_slopbot_x3']);
    expect(handles(await get({ q: '_' }))).toEqual(['demo_quill_x1', 'demo_lumen_x2', 'demo_slopbot_x3']);
    expect((await get({ q: '   ' })).json().total).toBe(3);
    expect(handles(await get({ q: 'a', status: 'flagged' }))).toEqual([]);
    const filtered = (await get({ q: 'w', status: 'confirmed', sort: 'handle' })).json();
    expect(filtered).toMatchObject({ total: 1 });
    expect(filtered.items[0].handle).toBe('demo_quill_x1');
  });

  it('rejects every bad input with 400 and the error shape, and unknown parameters', async () => {
    await add([{ handle: 'alpha' }]);
    const bad = [
      '/api/v1/sloppers?limit=0',
      '/api/v1/sloppers?limit=101',
      '/api/v1/sloppers?limit=-1',
      '/api/v1/sloppers?limit=1.5',
      '/api/v1/sloppers?limit=abc',
      '/api/v1/sloppers?limit=01',
      '/api/v1/sloppers?limit=',
      '/api/v1/sloppers?limit=1&limit=2',
      '/api/v1/sloppers?status=gone',
      '/api/v1/sloppers?sort=random',
      '/api/v1/sloppers?cursor=short',
      '/api/v1/sloppers?cursor=!!!!!!!!!!!!!!!!',
      `/api/v1/sloppers?q=${'x'.repeat(41)}`,
      '/api/v1/sloppers?unknown=1',
    ];
    for (const u of bad) {
      const r = await t.app.inject({ url: u });
      expect(r.statusCode, u).toBe(400);
      expect(r.json().error.code, u).toBe('invalid_request');
      expect(r.headers['cache-control'], u).toBe('no-store');
    }
    for (const u of ['/api/v1/sloppers?limit=1', '/api/v1/sloppers?limit=100', `/api/v1/sloppers?q=${'x'.repeat(40)}`]) {
      expect((await t.app.inject({ url: u })).statusCode, u).toBe(200);
    }
  });

  it('limits each network to 120 requests per minute', async () => {
    const ip = fromIp('203.0.113.60');
    for (let i = 0; i < 120; i++) expect((await get({}, ip)).statusCode).toBe(200);
    const r = await get({}, ip);
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
    expect(r.headers['retry-after']).toBe('1');
    expect((await get({}, fromIp('203.0.114.60'))).statusCode).toBe(200);
  });

  it('touches the database once for a view, not once per request', async () => {
    await add(Array.from({ length: 30 }, (_, i) => ({ handle: `user${i}`, score: 0.5 })));
    let queries = 0;
    const counted: Db = {
      ...tdb.db,
      query: (text, params) => {
        queries++;
        return tdb.db.query(text, params);
      },
      tx: (fn) =>
        tdb.db.tx((q) => {
          queries++;
          return fn(q);
        }),
    };
    const t2 = await makeApp(counted);
    await t2.app.inject({ url: url({ limit: '10' }) });
    const afterBuild = queries;
    expect(afterBuild).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await t2.app.inject({ url: url({ limit: '10', q: 'user', sort: 'votes' }) });
    expect(queries).toBe(afterBuild);
  });

  it('drops an account that an admin clears at the next check, with no new list version', async () => {
    await add([
      { handle: 'stays', avatar: true },
      { handle: 'cleared_now', avatar: true },
    ]);
    // 'stays' holds the newest updated_at, so the clear below does not move max(updated_at).
    await tdb.db.query("update accounts set updated_at = now() + interval '1 hour' where handle = 'stays'");
    expect(handles(await get({ sort: 'handle' }))).toEqual(['cleared_now', 'stays']);
    expect((await t.app.inject({ url: '/api/v1/avatars/cleared_now' })).statusCode).toBe(200);

    await tdb.db.query("update accounts set status = 'cleared', tier = 0, updated_at = now() where handle = 'cleared_now'");
    await refreshed();
    expect(handles(await get({ sort: 'handle' }))).toEqual(['stays']);
    expect((await t.app.inject({ url: '/api/v1/avatars/cleared_now' })).statusCode).toBe(404);
  });

  it('answers 503 when the first view cannot be built', async () => {
    const down: Db = { query: () => Promise.reject(new Error('database is down')), tx: () => Promise.reject(new Error('down')), session: () => Promise.reject(new Error('down')), close: async () => undefined };
    const t2 = await makeApp(down);
    const r = await t2.app.inject({ url: '/api/v1/sloppers' });
    expect([r.statusCode, r.json().error.code]).toEqual([503, 'sloppers_unavailable']);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  describe('cursor', () => {
    beforeEach(async () => {
      await addInstalls(tdb.db);
      const many: Fixture[] = Array.from({ length: 137 }, (_, i) => ({
        handle: `acct_${String(i).padStart(3, '0')}`,
        status: i % 3 === 0 ? 'flagged' : 'confirmed',
        score: ((i * 7) % 60) / 100 + 0.2,
        listedAt: new Date(Date.UTC(2026, 9, 1 + (i % 25))),
        slop: i % 5,
        name: i % 2 === 0 ? `Person ${i}` : null,
      }));
      await add(many);
    });

    it.each([
      [{}, 25],
      [{ sort: 'recent' }, 50],
      [{ sort: 'votes' }, 7],
      [{ sort: 'handle' }, 100],
      [{ status: 'confirmed' }, 30],
      [{ status: 'flagged', sort: 'recent' }, 9],
      [{ q: 'person', sort: 'handle' }, 11],
      [{ q: 'acct_1', status: 'confirmed', sort: 'score' }, 13],
    ] as [Record<string, string>, number][])('walks every page of %o with no duplicate and no gap', async (q, limit) => {
      const all = await get({ ...q, limit: '100' });
      const { handles: seen, total } = await walk(q, limit);
      expect(total).toBe(all.json().total);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(seen).toEqual(await fullOrder(q));
    });

    /** The expected full order, computed independently from the fixture rows. */
    async function fullOrder(q: Record<string, string>): Promise<string[]> {
      const { rows } = await tdb.db.query<{ handle: string; status: string; score: number; listed_at: Date | null; slop: number; name: string | null }>(
        `select a.handle, a.status, a.score, a.listed_at, p.name,
                (select count(*)::int from votes v where v.handle = a.handle and v.value = 1) as slop
         from accounts a left join profiles p using (handle)`,
      );
      const search = (q.q ?? '').toLowerCase();
      const matches = rows.filter((r) => (q.status ? r.status === q.status : true) && (!search || r.handle.includes(search) || (r.name ?? '').toLowerCase().includes(search)));
      const key: Record<string, (r: (typeof rows)[number]) => number> = {
        score: (r) => -Math.round(r.score * 100),
        recent: (r) => -(r.listed_at?.getTime() ?? 0),
        votes: (r) => -r.slop,
        handle: () => 0,
      };
      const value = key[q.sort ?? 'score']!;
      return matches.sort((a, b) => value(a) - value(b) || (a.handle < b.handle ? -1 : 1)).map((r) => r.handle);
    }

    it('keeps its walk through one refresh, then returns 400 stale_cursor', async () => {
      const first = (await get({ limit: '40' })).json();
      expect(first.next).toEqual(expect.any(String));
      const firstHandles = first.items.map((i: { handle: string }) => i.handle) as string[];

      // A change that moves accounts in the order: the old cursor must not see the new order.
      await tdb.db.query("update accounts set score = 0.01, updated_at = now() where handle = 'acct_001'");
      await refreshed();
      const fresh = await get({ limit: '40' });
      const freshHandles = fresh.json().items.map((i: { handle: string }) => i.handle) as string[];
      expect(freshHandles).not.toContain('acct_001');
      expect(fresh.json().next).not.toBe(first.next);

      // The old cursor keeps walking its own view: same order, no duplicate, no gap.
      const rest: string[] = [];
      let cursor: string | null = first.next;
      while (cursor) {
        const page = await get({ limit: '40', cursor });
        expect(page.statusCode).toBe(200);
        rest.push(...handles(page));
        cursor = page.json().next;
      }
      const all = [...firstHandles, ...rest];
      expect(new Set(all).size).toBe(137);
      expect(all).toHaveLength(137);

      // A cursor from before the last two rebuilds is stale. It answers 400; it never crashes or repeats.
      await tdb.db.query("update accounts set score = 0.02, updated_at = now() where handle = 'acct_002'");
      await refreshed();
      const stale = await get({ limit: '40', cursor: first.next });
      expect([stale.statusCode, stale.json().error.code]).toEqual([400, 'stale_cursor']);
      expect(stale.headers['cache-control']).toBe('no-store');
    });

    it('serves the view before a rebuild for 10 minutes only: an account that left the list does not stay visible through an old cursor', async () => {
      const first = (await get({ limit: '40' })).json();
      const second = (await get({ limit: '40', cursor: first.next })).json();
      const leaving = handles({ json: () => second } as never)[0]!;
      // The account leaves the list (an admin clear, or votes that now wait for a person).
      await tdb.db.query("update accounts set status = 'pending', tier = 0, updated_at = now() where handle = $1", [leaving]);
      await refreshed();
      expect((await get({ limit: '40', cursor: first.next })).json().items.map((i: { handle: string }) => i.handle)).toContain(leaving);
      t.clock.advance(PREVIOUS_VIEW_MS);
      const late = await get({ limit: '40', cursor: first.next });
      expect([late.statusCode, late.json().error.code]).toEqual([400, 'stale_cursor']);
      expect(late.body).not.toContain(leaving);
    });

    it('rejects a forged cursor, a cursor from another query and one that points past the end', async () => {
      const first = (await get({ limit: '10', sort: 'score' })).json();
      const cursor = first.next as string;
      const otherQueries: Record<string, string>[] = [{ limit: '10', sort: 'recent', cursor }, { limit: '10', status: 'flagged', cursor }, { limit: '10', q: 'acct', cursor }];
      for (const q of otherQueries) {
        const r = await get(q);
        expect([r.statusCode, r.json().error.code]).toEqual([400, 'invalid_cursor']);
      }
      const bytes = Buffer.from(cursor, 'base64url');
      bytes.writeUInt32BE(0, 4); // offset 0 is never issued
      const zero = await get({ limit: '10', cursor: bytes.toString('base64url') });
      expect([zero.statusCode, zero.json().error.code]).toEqual([400, 'invalid_cursor']);
      bytes.writeUInt32BE(999_999, 4);
      const pastEnd = await get({ limit: '10', cursor: bytes.toString('base64url') });
      expect([pastEnd.statusCode, pastEnd.json().error.code]).toEqual([400, 'invalid_cursor']);
      bytes.writeUInt32BE(10, 4);
      bytes.writeUInt32BE(0xfffffff0, 0);
      const unknown = await get({ limit: '10', cursor: bytes.toString('base64url') });
      expect([unknown.statusCode, unknown.json().error.code]).toEqual([400, 'stale_cursor']);
    });

    it('picks up a new name from the profiles job without a list change', async () => {
      expect(handles(await get({ q: 'fresh name' }))).toEqual([]);
      await tdb.db.query("update profiles set name = 'Fresh Name', fetched_at = now() where handle = 'acct_001'");
      await refreshed();
      expect(handles(await get({ q: 'fresh name' }))).toEqual(['acct_001']);
    });
  });
});

describe.each(BACKENDS)('GET /api/v1/criteria (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
    t = await makeApp(tdb.db);
  }, 600_000);
  afterAll(async () => tdb?.close());

  it('serves the numbers from the code with cache headers and a strong ETag', async () => {
    const r = await t.app.inject({ url: '/api/v1/criteria' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(JSON.parse(JSON.stringify(CRITERIA)));
    expect(r.headers).toMatchObject({ 'cache-control': 'public, max-age=3600', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
    expect(r.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const again = await t.app.inject({ url: '/api/v1/criteria', headers: { 'if-none-match': r.headers.etag as string } });
    expect([again.statusCode, again.body]).toEqual([304, '']);
  });

  it('rejects unknown parameters and is rate limited', async () => {
    expect((await t.app.inject({ url: '/api/v1/criteria?x=1' })).statusCode).toBe(400);
    const ip = fromIp('203.0.113.61');
    for (let i = 0; i < 120; i++) await t.app.inject({ url: '/api/v1/criteria', headers: ip });
    expect((await t.app.inject({ url: '/api/v1/criteria', headers: ip })).statusCode).toBe(429);
  });
});
