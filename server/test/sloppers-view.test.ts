import { describe, expect, it } from 'vitest';
import { CostBoundedCache } from '../src/lib/lru.js';
import { TrigramIndex } from '../src/lib/trigram.js';
import { MAX_VIEW_ROWS, normalizeSearch, ViewBuilder, type SloppersView, type SlopperRow, type SlopperSort, type StatusFilter, type ViewFilter } from '../src/sloppers.js';

const row = (i: number): SlopperRow => ({
  handle: `user${String(i).padStart(6, '0')}`,
  name: i % 4 === 0 ? null : `Display Name ${i} ${['growth', 'prompt', 'scale', 'ship'][i % 4]}`,
  has_avatar: i % 3 === 0,
  followers: i % 7 === 0 ? null : i * 3,
  status: i % 5 === 0 ? 'flagged' : 'confirmed',
  score: ((i * 37) % 101) / 100,
  seed: i % 11 === 0,
  seed_source: i % 22 === 0 ? 'site:clankwall.vogel.dev' : 'x_list:2116659176894071283',
  listed_at: i % 13 === 0 ? null : new Date(1_760_000_000_000 + i * 1000),
  reason: i % 2 === 0 ? 'seed' : 'votes_confirmed',
  networks: i % 9,
  needed: i % 4,
  slop: i % 50,
  not_slop: i % 3,
  x_user_id: i % 6 === 0 ? null : String(1_000_000 + i),
  want: i % 10 === 5 ? 'confirmed' : null,
});

async function buildView(count: number): Promise<SloppersView> {
  const builder = new ViewBuilder();
  for (let i = 0; i < count; i++) builder.add(row(i));
  return builder.build('stamp', new Date('2026-11-09T00:00:00Z'));
}

const handlesOf = (v: SloppersView, search: string, status: StatusFilter = 'all', sort: SlopperSort = 'handle') =>
  v.page({ search, status, sort }, 0, 100).items.map((i) => i.handle);

const ALL_BY_SCORE: ViewFilter = { search: '', status: 'all', sort: 'score' };

describe('sloppers view', () => {
  it('carries the seed source of seed rows only', async () => {
    const view = await buildView(300);
    const items = view.page({ search: '', status: 'all', sort: 'handle' }, 0, 100).items;
    const rest = view.page({ search: '', status: 'all', sort: 'handle' }, 100, 100).items;
    for (const item of [...items, ...rest]) {
      const i = Number(item.handle.slice(4));
      expect(item.seedSource).toBe(i % 11 !== 0 ? null : i % 22 === 0 ? 'site:clankwall.vogel.dev' : 'x_list:2116659176894071283');
    }
    expect([...items, ...rest].filter((x) => x.seedSource === 'site:clankwall.vogel.dev').length).toBeGreaterThan(1);
  });

  it('matches a brute-force search and walks the sort orders without a duplicate or a gap', async () => {
    const view = await buildView(3000);
    const rows = Array.from({ length: 3000 }, (_, i) => row(i));
    const docs = rows.map((r) => (r.name ? `${r.handle}\n${r.name.toLowerCase()}` : r.handle));
    for (const q of ['growth', 'name 1', 'user00', 'zzzzzz', '99', '9', 'prompt', '_']) {
      const want = docs.flatMap((d, i) => (d.includes(q) ? [i] : [])).map((i) => rows[i]!.handle).slice(0, 100);
      expect(handlesOf(view, q), q).toEqual(want);
    }
    for (const sort of ['score', 'recent', 'votes', 'handle'] as const) {
      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = view.page({ search: '', status: 'flagged', sort }, offset, 80);
        for (const item of page.items) seen.add(item.handle);
        offset += page.items.length;
        if (!page.next) break;
      }
      const flagged = rows.filter((r) => r.status === 'flagged').length;
      expect(seen.size).toBe(flagged);
      expect(offset).toBe(flagged);
    }
  });

  it('renders nulls and clamps numbers from unexpected rows', async () => {
    const b = new ViewBuilder();
    b.add({ ...row(1), handle: 'odd', name: null, followers: null, listed_at: null, reason: 'NOT A CODE', networks: -4, needed: 1e12, score: 1.2 });
    const view = await b.build('s', new Date(0));
    expect(view.page(ALL_BY_SCORE, 0, 1).items[0]).toMatchObject({
      handle: 'odd',
      name: null,
      followers: null,
      listedAt: null,
      reason: 'pending',
      networks: 0,
      needed: 0xffffffff,
      score: 100,
    });
  });

  it('R13 marks waits only on a flagged row that wants confirmed, and keeps the X id of each row', async () => {
    const b = new ViewBuilder();
    b.add({ ...row(1), handle: 'confirmed', status: 'confirmed', want: 'confirmed', x_user_id: '7' });
    b.add({ ...row(5), handle: 'flagged', status: 'flagged', want: 'flagged', x_user_id: null });
    b.add({ ...row(5), handle: 'odd_want', status: 'flagged', want: { to: 'confirmed' }, x_user_id: null });
    b.add({ ...row(5), handle: 'waits', status: 'flagged', want: 'confirmed', x_user_id: '42' });
    const view = await b.build('s', new Date(0));
    expect(view.page({ search: '', status: 'all', sort: 'handle' }, 0, 10).items.map((i) => [i.handle, i.waits, i.xUserId])).toEqual([
      ['confirmed', false, '7'],
      ['flagged', false, null],
      ['odd_want', false, null],
      ['waits', true, '42'],
    ]);
  });

  it('finds an avatar by binary search and only for a listed account', async () => {
    const view = await buildView(1000);
    expect(view.hasAvatar('user000003')).toBe(true);
    expect(view.hasAvatar('user000001')).toBe(false);
    expect(view.hasAvatar('nobody')).toBe(false);
    expect(view.hasAvatar('zzzzzzzzzzzz')).toBe(false);
  });

  it('serves pages and searches fast at the full cap of 200,000 accounts', { timeout: 120_000 }, async () => {
    const started = performance.now();
    const view = await buildView(MAX_VIEW_ROWS);
    const buildMs = performance.now() - started;
    expect(view.size).toBe(MAX_VIEW_ROWS);
    // The build runs off the request path and yields; it must stay well below a score run.
    expect(buildMs).toBeLessThan(30_000);

    const median = (run: () => unknown) => {
      const samples: number[] = [];
      for (let i = 0; i < 400; i++) {
        const t0 = performance.now();
        run();
        samples.push(performance.now() - t0);
      }
      return samples.sort((a, b) => a - b)[samples.length >> 1]!;
    };
    // Plain pages: an offset into a precomputed order.
    expect(median(() => view.page(ALL_BY_SCORE, 150_000, 60))).toBeLessThan(1);
    // A selective search, cold the first time, then served from the search cache.
    expect(handlesOf(view, 'name 123457')).toEqual(['user123457']);
    expect(median(() => view.page({ ...ALL_BY_SCORE, search: 'name 123457' }, 0, 60))).toBeLessThan(1);
    // A new selective query each time: this is the cold path through the trigram index.
    let n = 1000;
    const cold = median(() => view.page({ ...ALL_BY_SCORE, search: `name ${n++ * 197 + 5}` }, 0, 60));
    expect(cold).toBeLessThan(5);
  });
});

describe('query normalization', () => {
  it('trims, removes a leading @ and lower-cases', () => {
    expect(normalizeSearch('  @Demo_Quill  ')).toBe('demo_quill');
    expect(normalizeSearch('@@x')).toBe('@x');
    expect(normalizeSearch('')).toBe('');
  });
});

describe('cost-bounded cache', () => {
  it('evicts the least recently used entries past the cost bound and the entry bound', () => {
    const c = new CostBoundedCache<number>(10, 2);
    c.set('a', 1, 4);
    c.set('b', 2, 4);
    expect(c.get('a')).toBe(1); // a is now the newest
    c.set('c', 3, 4);
    expect(c.get('b')).toBeUndefined();
    expect(c.size).toBe(2);
    expect(c.cost).toBe(8);
    c.set('big', 9, 11);
    expect(c.get('big')).toBeUndefined();
    expect(c.size).toBe(2);
    c.set('a', 7, 9);
    expect(c.get('a')).toBe(7);
    expect(c.cost).toBe(9);
    c.clear();
    expect(c.cost).toBe(0);
  });
});

describe('trigram index', () => {
  it('returns a superset of the exact matches and a small list for a selective needle', async () => {
    const docs = Array.from({ length: 2000 }, (_, i) => `doc${i}`);
    const index = await TrigramIndex.build(docs);
    const list = index.candidates('c1999');
    expect(Array.from(list)).toContain(1999);
    expect(list.length).toBeLessThan(2000);
    for (let k = 1; k < list.length; k++) expect(list[k]!).toBeGreaterThan(list[k - 1]!);
    expect(index.candidates('qqqq').length).toBe(0);
    expect(index.candidates('ab').length).toBe(0);
  });
  it('holds one posting per document and bucket', async () => {
    const index = await TrigramIndex.build(['aaaaaaaa']);
    expect(Array.from(index.candidates('aaa'))).toEqual([0]);
  });
});
