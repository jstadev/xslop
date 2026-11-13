import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKENDS, openTestDb, type TestDb } from './helpers/db.js';
import { fromIp, makeApp, register, signed, vote, type Identity, type TestApp } from './helpers/app.js';

const HOUR = 3_600_000;
const POST_ID_EPOCH = 1288834974657;
/** The X post id of a post written at `ms`; `n` keeps the ids of one test apart. */
const postId = (ms: number, n = 0) => String((BigInt(ms - POST_ID_EPOCH - (n >> 12)) << 22n) | BigInt(n & 4095));
/** One time for the whole file, so that sighting(i) always gives the same post id. */
const T0 = Date.now();
const sighting = (i: number, over: Record<string, unknown> = {}) => ({
  handle: `Replyguy_${i}`,
  tweetId: postId(T0 - 60_000, i),
  parentTweetId: postId(T0 - 75_000, i),
  ...over,
});
/** The fields that builds before 1.2 send with each item. */
const oldFields = {
  parentHandle: '@Author',
  replyAt: new Date(Date.now() - 60_000).toISOString(),
  parentAt: new Date(Date.now() - 75_000).toISOString(),
  textLen: 42,
  simhash: '0123456789abcdef',
  genericScore: 0.8,
  overlapScore: 0.1,
  hasMedia: false,
  verified: true,
};

describe.each(BACKENDS)('votes, me and observations (%s)', (backend) => {
  let tdb: TestDb;
  let t: TestApp;
  let id: Identity;
  beforeAll(async () => {
    tdb = await openTestDb(backend);
  }, 600_000);
  afterAll(async () => tdb?.close());
  beforeEach(async () => {
    await tdb.reset();
    t = await makeApp(tdb.db);
    id = await register(t);
  });

  describe('POST /api/v1/votes', () => {
    it('stores a vote, creates the account and normalizes the handle', async () => {
      const r = await signed(t, id, 'POST', '/api/v1/votes', vote('  @SlopKing_99 '));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ handle: 'slopking_99', value: 'slop', account: { status: 'none', tier: 0 } });
      const { rows } = await tdb.db.query<{ value: number; tweet_id: string }>('select value, tweet_id from votes where handle = $1', ['slopking_99']);
      expect(rows).toEqual([{ value: 1, tweet_id: '1850000000000000001' }]);
      expect((await tdb.db.query('select 1 from accounts where handle = $1', ['slopking_99'])).rows.length).toBe(1);
    });
    it('R3 accepts the post text that an older extension still sends, and stores none of it on insert or on update', async () => {
      const stored = async () => (await tdb.db.query<{ text: string | null }>('select text from votes order by handle')).rows.map((r) => r.text);
      expect((await signed(t, id, 'POST', '/api/v1/votes', vote('known'))).statusCode).toBe(200);
      expect(await stored()).toEqual([null]);
      // A row from before this change loses its text at the next vote of that install on that account.
      await tdb.db.query("update votes set text = 'stored before the change'");
      expect((await signed(t, id, 'POST', '/api/v1/votes', vote('known', 'not_slop'))).statusCode).toBe(200);
      expect(await stored()).toEqual([null]);
      // The current extension sends no text field.
      const current = { handle: 'other', value: 'slop', tweetId: '1850000000000000002', parentTweetId: null, postedAt: null, context: 'post' };
      expect((await signed(t, id, 'POST', '/api/v1/votes', current)).statusCode).toBe(200);
      expect(await stored()).toEqual([null, null]);
    });
    it('upserts one vote per install and handle, and reports the account state', async () => {
      await tdb.db.query("insert into accounts (handle, status, tier) values ('known', 'confirmed', 2)");
      await signed(t, id, 'POST', '/api/v1/votes', vote('known'));
      const r = await signed(t, id, 'POST', '/api/v1/votes', vote('known', 'not_slop', { text: null, parentTweetId: null, postedAt: null }));
      expect(r.json()).toEqual({ handle: 'known', value: 'not_slop', account: { status: 'confirmed', tier: 2 } });
      const { rows } = await tdb.db.query<{ value: number; text: string | null }>('select value, text from votes where handle = $1', ['known']);
      expect(rows).toEqual([{ value: 0, text: null }]);
    });
    it('SEC-1 answers the public state of the account only: pending, cleared and moved read as none, like the public lookup (SPEC 13.3)', async () => {
      await tdb.db.query(`insert into accounts (handle, status, tier, identity) values
        ('waits_review', 'pending', 0, 'ok'), ('was_cleared', 'cleared', 0, 'ok'), ('moved_away', 'confirmed', 2, 'moved'), ('gone_listed', 'flagged', 1, 'gone')`);
      for (const [handle, want] of [
        ['waits_review', { status: 'none', tier: 0 }],
        ['was_cleared', { status: 'none', tier: 0 }],
        ['moved_away', { status: 'none', tier: 0 }],
        ['gone_listed', { status: 'flagged', tier: 1 }],
      ] as const) {
        // A "not slop" vote of an install without standing counts nowhere, so without the fix it is a free probe of the review queue.
        const r = await signed(t, id, 'POST', '/api/v1/votes', vote(handle, 'not_slop'));
        const lookup = (await t.app.inject({ url: `/api/v1/accounts/${handle}` })).json();
        expect([handle, r.json().account, { status: lookup.status, tier: lookup.tier }]).toEqual([handle, want, want]);
      }
    });
    it('keeps updated_at on a re-vote with the same value and moves it when the value changes', async () => {
      await signed(t, id, 'POST', '/api/v1/votes', vote('known'));
      await tdb.db.query("update votes set created_at = created_at - interval '2 days', updated_at = updated_at - interval '2 days'");
      const row = async () => (await tdb.db.query<{ updated_at: Date; created_at: Date; tweet_id: string }>('select updated_at, created_at, tweet_id from votes')).rows[0]!;
      const before = await row();
      await signed(t, id, 'POST', '/api/v1/votes', vote('known', 'slop', { tweetId: '1850000000000000002' }));
      const same = await row();
      expect([same.updated_at.getTime(), same.created_at.getTime(), same.tweet_id]).toEqual([before.updated_at.getTime(), before.created_at.getTime(), '1850000000000000002']);
      await signed(t, id, 'POST', '/api/v1/votes', vote('known', 'not_slop'));
      const changed = await row();
      expect(changed.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime() + HOUR);
      expect(changed.created_at.getTime()).toBe(before.created_at.getTime());
    });
    it('rejects bad input', async () => {
      const cases = [
        vote('bad handle!'),
        vote('a'.repeat(16)),
        vote('ok', 'maybe' as 'slop'),
        vote('ok', 'slop', { tweetId: '12ab' }),
        vote('ok', 'slop', { text: 'x'.repeat(561) }),
        vote('ok', 'slop', { text: 'null byte \u0000 in the text' }),
        vote('ok', 'slop', { postedAt: 'yesterday' }),
        vote('ok', 'slop', { context: 'dm' }),
        vote('ok', 'slop', { extra: 1 }),
        { handle: 'ok', value: 'slop' },
      ];
      for (const body of cases) {
        const r = await signed(t, id, 'POST', '/api/v1/votes', body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(['invalid_request', 'invalid_handle']).toContain(r.json().error.code);
      }
      expect((await tdb.db.query('select 1 from votes')).rows.length).toBe(0);
    });
    it('needs a signature', async () => {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/votes', payload: vote('x') });
      expect([r.statusCode, r.json().error.code]).toEqual([401, 'missing_signature']);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });
    it('limits each install to 120 votes per hour', async () => {
      for (let i = 0; i < 120; i++) expect((await signed(t, id, 'POST', '/api/v1/votes', vote(`h${i}`))).statusCode).toBe(200);
      const r = await signed(t, id, 'POST', '/api/v1/votes', vote('h120'));
      expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
      expect(Number(r.headers['retry-after'])).toBe(30);
      const other = await register(t, '198.51.100.99');
      expect((await signed(t, other, 'POST', '/api/v1/votes', vote('h0'))).statusCode).toBe(200);
      expect((await signed(t, id, 'DELETE', '/api/v1/votes/h0')).statusCode).toBe(429);
      t.clock.advance(30_000);
      expect((await signed(t, id, 'DELETE', '/api/v1/votes/h0')).statusCode).toBe(204);
    }, 120_000);
    it('R13 gives an install with standing its own 120 stored votes a day: new installs on its address cannot use them up (SPEC 13.9 item 9)', async () => {
      const crowd = [await register(t), await register(t)];
      await tdb.db.query('update installs set standing = true where id = $1', [id.installId]);
      for (let i = 0; i < 200; i++) expect((await signed(t, crowd[i % 2]!, 'POST', '/api/v1/votes', vote(`junk${i}`))).statusCode).toBe(200);
      expect((await signed(t, crowd[0]!, 'POST', '/api/v1/votes', vote('over'))).statusCode).toBe(429);
      for (let i = 0; i < 120; i++) expect((await signed(t, id, 'POST', '/api/v1/votes', vote(`real${i}`))).statusCode).toBe(200);
      // The day limit of the install holds now (one vote back every 720 s), not the hour limit (every 30 s).
      const r = await signed(t, id, 'POST', '/api/v1/votes', vote('real120'));
      expect([r.statusCode, r.headers['retry-after']]).toEqual([429, '720']);
    }, 120_000);
    it('R2-2 limits each network to 200 stored votes per day across its installs', async () => {
      const ids = [id, await register(t), await register(t)];
      for (let i = 0; i < 200; i++) expect((await signed(t, ids[i % 3]!, 'POST', '/api/v1/votes', vote(`h${i}`))).statusCode).toBe(200);
      const over = await signed(t, ids[1]!, 'POST', '/api/v1/votes', vote('over'));
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('rate_limited');
      // One token comes back every 432 s: the extension keeps the vote in its outbox and sends it then.
      expect(Number(over.headers['retry-after'])).toBe(432);
      expect((await tdb.db.query<{ n: number }>('select count(*) as n from votes')).rows[0]!.n).toBe(200);
      const elsewhere = await register(t, '203.0.113.99');
      expect((await signed(t, elsewhere, 'POST', '/api/v1/votes', vote('over'))).statusCode).toBe(200);
      t.clock.advance(432_000);
      expect((await signed(t, ids[1]!, 'POST', '/api/v1/votes', vote('over'))).statusCode).toBe(200);
      expect((await signed(t, ids[2]!, 'POST', '/api/v1/votes', vote('over'))).statusCode).toBe(429);
    }, 120_000);
  });

  describe('DELETE /api/v1/votes/:handle and GET /api/v1/me', () => {
    it('deletes a vote and lists the newest votes first', async () => {
      await signed(t, id, 'POST', '/api/v1/votes', vote('first'));
      await signed(t, id, 'POST', '/api/v1/votes', vote('second', 'not_slop'));
      const me = await signed(t, id, 'GET', '/api/v1/me');
      expect(me.json().votes.map((v: { handle: string; value: string }) => [v.handle, v.value])).toEqual([
        ['second', 'not_slop'],
        ['first', 'slop'],
      ]);
      expect(me.json().createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      const d = await signed(t, id, 'DELETE', '/api/v1/votes/@First');
      expect(d.statusCode).toBe(204);
      expect(d.body).toBe('');
      expect((await signed(t, id, 'DELETE', '/api/v1/votes/first')).statusCode).toBe(204);
      expect((await signed(t, id, 'DELETE', '/api/v1/votes/no%20way')).statusCode).toBe(400);
      expect((await signed(t, id, 'GET', '/api/v1/me')).json().votes.map((v: { handle: string }) => v.handle)).toEqual(['second']);
    });
    it('limits /me to 30 per hour', async () => {
      for (let i = 0; i < 30; i++) await signed(t, id, 'GET', '/api/v1/me');
      expect((await signed(t, id, 'GET', '/api/v1/me')).statusCode).toBe(429);
    });
  });

  describe('POST /api/v1/observations', () => {
    it('R13 stores the post, its parent and the time in the post id, unverified and without the install id', async () => {
      const written = Date.UTC(2026, 10, 1, 9, 30, 15, 250);
      const now = written + 3 * HOUR;
      t.clock.t = now;
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [sighting(1, { tweetId: postId(written, 1) }), sighting(2, { parentTweetId: null, tweetId: postId(written, 2) })] });
      expect([r.statusCode, r.json()]).toEqual([202, { accepted: 2 }]);
      const { rows } = await tdb.db.query<Record<string, unknown>>('select * from sightings order by tweet_id');
      expect(rows.map((x) => [x.handle, x.parent_tweet_id === null, (x.reply_at as Date).toISOString(), x.verified_at, x.parent_at, x.latency_sec])).toEqual([
        ['replyguy_1', false, '2026-11-01T09:30:15.250Z', null, null, null],
        ['replyguy_2', true, '2026-11-01T09:30:15.250Z', null, null, null],
      ]);
      // Privacy by design: no column holds the install id, and no value carries it.
      const cols = await tdb.db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'sightings'");
      expect(cols.rows.map((c) => c.column_name)).not.toContain('install_id');
      expect(JSON.stringify(rows)).not.toContain(id.installId);
    });
    it('R13 ignores duplicates, drops posts outside the time window and ids from before the ids carried a time, whatever replyAt says', async () => {
      await signed(t, id, 'POST', '/api/v1/observations', { items: [sighting(1)] });
      const items = [
        sighting(1),
        sighting(3),
        sighting(4, { tweetId: postId(t.clock.now() + 11 * 60_000, 4) }),
        sighting(5, { tweetId: postId(t.clock.now() - 31 * 86_400_000, 5), ...oldFields, replyAt: new Date(t.clock.now()).toISOString() }),
        sighting(6, { tweetId: '20' }),
        sighting(7, { tweetId: '29700000000' }),
        sighting(8, { tweetId: postId(t.clock.now() - 29 * 86_400_000, 8) }),
      ];
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items });
      expect(r.json()).toEqual({ accepted: 2 });
      const { rows } = await tdb.db.query<{ handle: string }>('select handle from sightings order by handle');
      expect(rows.map((x) => x.handle)).toEqual(['replyguy_1', 'replyguy_3', 'replyguy_8']);
    });
    it('R13 accepts the fields of older builds and stores none of them', async () => {
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [sighting(1, oldFields), sighting(2, { ...oldFields, parentHandle: null, parentAt: null })] });
      expect([r.statusCode, r.json()]).toEqual([202, { accepted: 2 }]);
      const { rows } = await tdb.db.query<Record<string, unknown>>(
        'select parent_handle, parent_at, latency_sec, text_len, simhash, generic_score, overlap_score, has_media, verified, verified_at from sightings',
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(Object.values(row).every((v) => v === null)).toBe(true);
    });
    it('rejects bad items and batch sizes', async () => {
      const bad = [
        { items: [] },
        { items: Array.from({ length: 101 }, (_, i) => sighting(i)) },
        { items: [sighting(1, { simhash: 'XYZ' })] },
        { items: [sighting(1, { textLen: 2001 })] },
        { items: [sighting(1, { genericScore: 1.5 })] },
        { items: [sighting(1, { replyAt: 'yesterday' })] },
        { items: [sighting(1, { handle: 'not valid' })] },
        { items: [sighting(1, { tweetId: '12ab' })] },
        { items: [sighting(1, { tweetId: '1'.repeat(21) })] },
        { items: [{ handle: 'replyguy_1', tweetId: postId(T0) }] },
        { items: [sighting(1, { text: 'the reply text must never be sent' })] },
        { items: [sighting(1)], extra: true },
      ];
      for (const body of bad) {
        const r = await signed(t, id, 'POST', '/api/v1/observations', body);
        expect(r.statusCode).toBe(400);
      }
      expect((await tdb.db.query('select 1 from sightings')).rows.length).toBe(0);
    });
    it('stores each sighting time rounded down to the hour, so a batch shares no exact time', async () => {
      await signed(t, id, 'POST', '/api/v1/observations', { items: [sighting(1), sighting(2), sighting(3)] });
      const { rows } = await tdb.db.query<{ created_at: Date }>('select created_at from sightings');
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r.created_at.getTime() % HOUR).toBe(0);
    });
    it('keeps at most 3 sightings per handle per install in 24 hours and stores none of the rest', async () => {
      const same = (i: number) => sighting(i, { handle: 'Replyguy_1' });
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [1, 2, 3, 4, 5].map(same) });
      expect([r.statusCode, r.json()]).toEqual([202, { accepted: 3 }]);
      const other = await register(t, '198.51.100.99');
      expect((await signed(t, other, 'POST', '/api/v1/observations', { items: [same(6)] })).json()).toEqual({ accepted: 1 });
      expect((await signed(t, id, 'POST', '/api/v1/observations', { items: [same(7), sighting(8)] })).json()).toEqual({ accepted: 1 });
      t.clock.advance(24 * HOUR + 1);
      expect((await signed(t, id, 'POST', '/api/v1/observations', { items: [same(9)] })).json()).toEqual({ accepted: 1 });
      const { rows } = await tdb.db.query<{ tweet_id: string }>("select tweet_id from sightings where handle = 'replyguy_1' order by tweet_id");
      expect(rows.map((x) => x.tweet_id)).toEqual([1, 2, 3, 6, 9].map((i) => same(i).tweetId));
    });
    it('R2-3 keeps at most 9 sightings per handle per network of registration in 24 hours, however many installs it has', async () => {
      const same = (i: number) => sighting(i, { handle: 'Replyguy_1' });
      const send = async (who: Identity, from: string, ...tweets: number[]) =>
        (await signed(t, who, 'POST', '/api/v1/observations', { items: tweets.map(same) }, { headers: fromIp(from) })).json();
      // Four installs of one /24. Each one sends from an address of another network.
      const farm = [id, await register(t, '198.51.100.90'), await register(t, '198.51.100.91'), await register(t, '198.51.100.92')];
      for (let k = 0; k < 3; k++) expect(await send(farm[k]!, `192.0.${k}.1`, k * 10 + 1, k * 10 + 2, k * 10 + 3)).toEqual({ accepted: 3 });
      expect(await send(farm[3]!, '192.0.3.1', 31, 32, 33)).toEqual({ accepted: 0 });
      expect((await signed(t, farm[3]!, 'POST', '/api/v1/observations', { items: [sighting(40)] })).json()).toEqual({ accepted: 1 });
      const elsewhere = await register(t, '203.0.113.99');
      expect(await send(elsewhere, '198.51.100.7', 51, 52, 53)).toEqual({ accepted: 3 });
      t.clock.advance(24 * HOUR + 1);
      expect(await send(farm[3]!, '192.0.3.1', 61)).toEqual({ accepted: 1 });
      const { rows } = await tdb.db.query<{ n: number }>("select count(*)::int as n from sightings where handle = 'replyguy_1'");
      expect(rows[0]!.n).toBe(13);
    });
    it('limits each install to 1500 items per hour', async () => {
      for (let b = 0; b < 15; b++) {
        const r = await signed(t, id, 'POST', '/api/v1/observations', { items: Array.from({ length: 100 }, (_, i) => sighting(b * 100 + i)) });
        expect(r.statusCode).toBe(202);
      }
      const r = await signed(t, id, 'POST', '/api/v1/observations', { items: [sighting(99999)] });
      expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
      expect((await tdb.db.query<{ n: number }>('select count(*) as n from sightings')).rows[0]!.n).toBe(1500);
    }, 120_000);
    it('limits each network to 3000 items per hour across its installs', async () => {
      const net = { headers: fromIp('203.0.113.50') };
      const ids = [id, await register(t, '198.51.100.98'), await register(t, '198.51.100.97')];
      let n = 0;
      const batch = (size = 100) => ({ items: Array.from({ length: size }, () => sighting(n++)) });
      for (const who of ids.slice(0, 2)) {
        for (let b = 0; b < 15; b++) expect((await signed(t, who, 'POST', '/api/v1/observations', batch(), net)).statusCode).toBe(202);
      }
      const r = await signed(t, ids[2]!, 'POST', '/api/v1/observations', batch(1), net);
      expect([r.statusCode, r.json().error.code]).toEqual([429, 'rate_limited']);
      expect((await signed(t, ids[2]!, 'POST', '/api/v1/observations', batch(1), { headers: fromIp('203.0.114.50') })).statusCode).toBe(202);
      expect((await tdb.db.query<{ n: number }>('select count(*) as n from sightings')).rows[0]!.n).toBe(3001);
    }, 120_000);
  });
});
