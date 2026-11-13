/** Public routes (sections 5.1, 5.4, 5.5): challenge, install registration, account lookup, appeals, stats, config, health, list. */
import { createPublicKey, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipLimit, type Ctx } from '../app.js';
import type { Queryable } from '../db.js';
import { checkChallenge, issueChallenge, sha256Hex, type Purpose } from '../lib/crypto.js';
import { etagMatches, sendVariant } from '../lib/encoding.js';
import { handleInput, handleParams, HttpError, NO_NUL_RE, noQuery, requireHandle, sendError, sendRateLimited, uuidParams } from '../lib/http.js';
import { sendAsset } from './static.js';

const HEALTH_MAX_AGE_MS = 20 * 60_000;
const STATS_TTL_MS = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/**
 * Installs per network (ip_hash) in 30 days. The hourly bucket alone renews forever. An office, a campus or a
 * phone carrier shares one /24, so the number is far above a household. More installs give a network no more
 * voice, votes, sightings or public vote count: each of those has its own limit per network.
 */
const INSTALLS_PER_NETWORK_30D = 1000;
/** First key of the two-key advisory lock that serializes registrations of one network (the second key is the network). */
const INSTALL_BUDGET_LOCK = 0x7a51;
/** The longest wait that a full install budget reports. An installed extension holds its whole outbox for the value it gets. */
const MAX_BUDGET_WAIT_SEC = 3600;
/** Evidence posts that a public answer or a review item shows per account. */
const EVIDENCE_MAX = 3;

const powFields = {
  challenge: { type: 'string', minLength: 16, maxLength: 512 },
  nonce: { type: 'string', pattern: '^[\\x21-\\x7e]{1,32}$' },
} as const;

/** Verifies the MAC, purpose, expiry and proof of work: no database work before it. Returns the expiry. */
function checkPow(ctx: Ctx, token: string, nonce: string, purpose: Purpose): number {
  const c = checkChallenge(ctx.config.secret, token, nonce, purpose, ctx.config.powBits, ctx.now());
  if (c.ok) return c.exp;
  const msg = { invalid_challenge: 'The challenge is not valid.', challenge_expired: 'The challenge expired. Fetch a new one.', bad_proof: 'The proof of work does not solve the challenge.' };
  throw new HttpError(400, c.reason, msg[c.reason]);
}

/** Marks a checked challenge used inside the caller's transaction: each challenge works once. */
async function useChallenge(q: Queryable, token: string, exp: number): Promise<void> {
  const r = await q.query('insert into used_challenges (challenge_hash, expires_at) values ($1, $2) on conflict do nothing', [sha256Hex(token), new Date(exp * 1000)]);
  if (r.rowCount === 0) throw new HttpError(409, 'challenge_used', 'This challenge was already used. Fetch a new one.');
}

type Evidence = { tweetId: string; at: string };

/**
 * The evidence of each account (section 13.8): posts that its slop votes name and that the server verified as
 * written by the account (an `ok` evidence row). One per network, newest vote first, at most 3 per account.
 */
export async function evidenceOf(q: Queryable, handles: readonly string[]): Promise<Map<string, Evidence[]>> {
  const out = new Map<string, Evidence[]>();
  if (handles.length === 0) return out;
  const { rows } = await q.query<{ handle: string; tweet_id: string; created_at: Date }>(
    `select handle, tweet_id, created_at from (
       select handle, tweet_id, created_at, row_number() over (partition by handle order by created_at desc) as n from (
         select distinct on (v.handle, i.ip_hash) v.handle, v.tweet_id, v.created_at
         from votes v
         join installs i on i.id = v.install_id
         join evidence e on e.tweet_id = v.tweet_id and e.handle = v.handle and e.ok
         where v.handle = any($1::text[]) and v.value = 1 and i.banned_at is null
         order by v.handle, i.ip_hash, v.created_at desc
       ) per_network
     ) ranked where n <= $2 order by handle, created_at desc`,
    [handles, EVIDENCE_MAX],
  );
  for (const r of rows) {
    const list = out.get(r.handle) ?? [];
    list.push({ tweetId: r.tweet_id, at: r.created_at.toISOString() });
    out.set(r.handle, list);
  }
  return out;
}

/** Every public answer about an account that is not flagged or confirmed: no number at all (section 13.8). */
/** The rule of the list itself (`publishList`): a moved account keeps its state on the row but is not listed. A gone one stays (SPEC 13.10 item 10). */
export const isListed = (a: { status: string; tier: number; identity: string } | undefined): boolean =>
  a !== undefined && a.tier >= 1 && (a.status === 'flagged' || a.status === 'confirmed') && a.identity !== 'moved';

const notListed = (handle: string) => ({
  handle,
  status: 'none',
  tier: 0,
  score: 0,
  seed: false,
  votes: { slop: 0, notSlop: 0 },
  sightings: 0,
  signals: null,
  evidence: [],
  appealOpen: false,
});

export function registerPublic(app: FastifyInstance, ctx: Ctx): void {
  const L = ctx.limits;
  const publicList = ipLimit(ctx, L.publicList);

  app.get(
    '/api/v1/challenge',
    {
      onRequest: ipLimit(ctx, L.challenge),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { purpose: { enum: ['install', 'appeal'] } } } },
    },
    async (req) => {
      const purpose = (req.query as { purpose?: Purpose }).purpose ?? 'install';
      return { challenge: issueChallenge(ctx.config.secret, purpose, ctx.now()).token, difficulty: ctx.config.powBits };
    },
  );

  const b64Coord = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } as const;
  app.post(
    '/api/v1/installs',
    {
      onRequest: ipLimit(ctx, L.installRequests),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['publicKey', 'challenge', 'nonce', 'extVersion'],
          properties: {
            publicKey: {
              type: 'object',
              additionalProperties: false,
              required: ['kty', 'crv', 'x', 'y'],
              properties: { kty: { const: 'EC' }, crv: { const: 'P-256' }, x: b64Coord, y: b64Coord },
            },
            ...powFields,
            extVersion: { type: 'string', pattern: '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; challenge: string; nonce: string; extVersion: string };
      const jwk = { kty: b.publicKey.kty, crv: b.publicKey.crv, x: b.publicKey.x, y: b.publicKey.y };
      try {
        createPublicKey({ key: jwk, format: 'jwk' });
      } catch {
        throw new HttpError(400, 'invalid_key', 'The public key is not a valid P-256 point.');
      }
      const exp = checkPow(ctx, b.challenge, b.nonce, 'install');
      const ip = ctx.ipHashOf(req);
      const id = randomUUID();
      const done = await ctx.db.tx(async (q) => {
        // One registration per network at a time: parallel requests cannot all read the same count and pass it together.
        await q.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [INSTALL_BUDGET_LOCK, ip]);
        // The hourly limit counts registrations that succeeded (section 13.8): checked here and taken after the insert,
        // under the lock, so empty or invalid requests cannot close registration for a network.
        const hourly = L.installs.peek(ip, ctx.now());
        if (!hourly.ok) return { wait: hourly.retryAfterSec };
        const budget = await q.query<{ n: number; wait: number | null }>(
          `select count(*)::int as n, ceil(extract(epoch from min(created_at) + interval '30 days' - now()))::int as wait
           from installs where ip_hash = $1 and created_at > now() - interval '30 days'`,
          [ip],
        );
        const used = budget.rows[0]!;
        if (used.n >= INSTALLS_PER_NETWORK_30D) return { wait: Math.min(MAX_BUDGET_WAIT_SEC, Math.max(1, used.wait ?? 1)) };
        await useChallenge(q, b.challenge, exp);
        const r = await q.query<{ created_at: Date }>(
          'insert into installs (id, public_key, ip_hash, ext_version) values ($1, $2::jsonb, $3, $4) returning created_at',
          [id, JSON.stringify(jwk), ip, b.extVersion],
        );
        L.installs.take(ip, ctx.now());
        return { createdAt: r.rows[0]!.created_at };
      });
      if (done.wait !== undefined) return sendRateLimited(reply, done.wait);
      return reply.code(201).send({ installId: id, createdAt: done.createdAt.toISOString() });
    },
  );

  app.get(
    '/api/v1/accounts/:handle',
    { onRequest: ipLimit(ctx, L.accounts), config: { cors: true }, schema: { params: handleParams, querystring: noQuery } },
    async (req) => {
      const handle = requireHandle((req.params as { handle: string }).handle);
      const { rows } = await ctx.db.query<{ status: string; tier: number; identity: string; score: number; seed: boolean; parts: { sightings?: number; fastReplyShare?: number } | null }>(
        'select status, tier, identity, score, seed, parts from accounts where handle = $1',
        [handle],
      );
      const a = rows[0];
      // Votes and sightings are free input, and a pending account waits for a person: only a listed account has numbers.
      if (!a || !isListed(a)) return notListed(handle);
      const { rows: counts } = await ctx.db.query<{ slop: number; not_slop: number; sightings: number; appeal_open: boolean }>(
        `select (select count(distinct i.ip_hash) from votes v join installs i on i.id = v.install_id where v.handle = $1 and v.value = 1 and i.banned_at is null)::int as slop,
                (select count(distinct i.ip_hash) from votes v join installs i on i.id = v.install_id where v.handle = $1 and v.value = 0 and i.banned_at is null)::int as not_slop,
                (select count(*) from sightings s where s.handle = $1 and s.verified_at is not null)::int as sightings,
                exists (select 1 from appeals p where p.handle = $1 and p.status = 'open') as appeal_open`,
        [handle],
      );
      const c = counts[0]!;
      // Reply timing of the sightings that the X facts job verified, as the score job measured it.
      const replies = a.parts?.sightings ?? 0;
      return {
        handle,
        status: a.status,
        tier: a.tier,
        score: Math.round(a.score * 100),
        seed: a.seed,
        votes: { slop: c.slop, notSlop: c.not_slop },
        sightings: c.sightings,
        signals: replies > 0 ? { fastReplyShare: a.parts?.fastReplyShare ?? 0, replies } : null,
        evidence: (await evidenceOf(ctx.db, [handle])).get(handle) ?? [],
        appealOpen: c.appeal_open,
      };
    },
  );

  app.post(
    '/api/v1/appeals',
    {
      onRequest: ipLimit(ctx, L.appealsPost),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['handle', 'message', 'challenge', 'nonce'],
          properties: {
            handle: handleInput,
            email: { anyOf: [{ type: 'string', maxLength: 254, pattern: '^[^\\s@\\u0000]{1,64}@[^\\s@\\u0000]{1,189}\\.[^\\s@\\u0000]{2,63}$' }, { type: 'null' }] },
            message: { type: 'string', minLength: 20, maxLength: 2000, pattern: NO_NUL_RE },
            ...powFields,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { handle: string; email?: string | null; message: string; challenge: string; nonce: string };
      const handle = requireHandle(b.handle);
      const message = b.message.trim();
      if (message.length < 20) throw new HttpError(400, 'invalid_request', 'body/message must have at least 20 characters');

      const id = randomUUID();
      let code = 'xslop-';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const exp = checkPow(ctx, b.challenge, b.nonce, 'appeal');
      try {
        await ctx.db.tx(async (q) => {
          // The account row lock puts this appeal before or after an admin decision, never in the middle: an accept
          // clears the account and closes its open appeals, and an appeal that comes after it finds no listing.
          const acct = await q.query<{ status: string; tier: number; identity: string }>('select status, tier, identity from accounts where handle = $1 for update', [handle]);
          if (!isListed(acct.rows[0])) throw new HttpError(404, 'not_listed', 'This account is not on the xslop list.');
          await useChallenge(q, b.challenge, exp);
          // No total per handle: strangers could hold every place and lock the owner out. The unique index allows
          // one open appeal per handle and network.
          await q.query('insert into appeals (id, handle, email, message, code, status, ip_hash) values ($1, $2, $3, $4, $5, $6, $7)', [
            id,
            handle,
            b.email ?? null,
            message,
            code,
            'open',
            ctx.ipHashOf(req),
          ]);
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'appeal_open', 'You already have an open appeal for this account.');
        throw err;
      }
      return reply.code(201).send({ appealId: id, code, status: 'open' });
    },
  );

  app.get('/api/v1/appeals/:id', { onRequest: ipLimit(ctx, L.appealsGet), schema: { params: uuidParams, querystring: noQuery } }, async (req, reply) => {
    const { rows } = await ctx.db.query<{ id: string; handle: string; status: string; created_at: Date; decided_at: Date | null }>(
      'select id, handle, status, created_at, decided_at from appeals where id = $1',
      [(req.params as { id: string }).id],
    );
    const r = rows[0];
    if (!r) return sendError(reply, 404, 'not_found', 'No appeal has this id.');
    return { appealId: r.id, handle: r.handle, status: r.status, createdAt: r.created_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null };
  });

  let stats: { at: number; body: Record<string, unknown> } | null = null;
  let statsLoading: Promise<Record<string, unknown>> | null = null;
  const loadStats = async () => {
    const { rows } = await ctx.db.query<Record<string, number>>(
      // The rule of the list: a status with its tier, never a moved account.
      `select (select count(*) from accounts where status = 'confirmed' and tier = 2 and identity <> 'moved') as confirmed,
              (select count(*) from accounts where status = 'flagged' and tier = 1 and identity <> 'moved') as flagged,
              (select count(*) from votes) as votes,
              (select count(*) from installs where banned_at is null) as installs,
              (select count(*) from sightings) as sightings`,
    );
    const r = rows[0]!;
    const body = { confirmed: r.confirmed, flagged: r.flagged, votes: r.votes, installs: r.installs, sightings: r.sightings, generatedAt: new Date(ctx.now()).toISOString() };
    stats = { at: ctx.now(), body };
    return body;
  };
  app.get('/api/v1/stats', { onRequest: publicList, config: { cors: true }, schema: { querystring: noQuery } }, async (_req, reply) => {
    let body = stats && ctx.now() - stats.at < STATS_TTL_MS ? stats.body : null;
    if (!body) {
      statsLoading ??= loadStats().finally(() => {
        statsLoading = null;
      });
      body = await statsLoading;
    }
    // Set after the load: an error response must stay out of shared caches.
    reply.header('cache-control', 'public, max-age=60');
    return body;
  });

  app.get('/api/v1/config', { onRequest: publicList, config: { cors: true }, schema: { querystring: noQuery } }, async (req, reply) => {
    if (!ctx.files.config) return sendError(reply, 503, 'config_unavailable', 'The extension config is not available on this server.');
    return sendAsset(req, reply, ctx.files.config);
  });

  app.get('/api/health', { onRequest: ipLimit(ctx, L.health), schema: { querystring: noQuery } }, async (_req, reply) => {
    let db = false;
    let scoredAt: Date | null = null;
    try {
      const { rows } = await ctx.db.query<{ last_ok_at: Date | null }>("select (select last_ok_at from jobs where name = 'score') as last_ok_at");
      db = true;
      scoredAt = rows[0]?.last_ok_at ?? null;
    } catch (err) {
      ctx.log.error({ err }, 'health check query failed');
    }
    const ok = db && scoredAt !== null && ctx.now() - scoredAt.getTime() < HEALTH_MAX_AGE_MS;
    return reply.code(ok ? 200 : 503).send({ ok, db, scoredAt: scoredAt?.toISOString() ?? null });
  });

  const listHeaders = (reply: FastifyReply) => reply.header('cache-control', 'public, max-age=60').header('content-type', 'application/json; charset=utf-8');
  const currentList = async (reply: FastifyReply) => {
    const s = await ctx.list.current().catch((err: unknown) => {
      ctx.log.error({ err }, 'list load failed');
      return null;
    });
    if (!s) sendError(reply, 503, 'list_unavailable', 'The list is not available. Try again in a few minutes.');
    return s;
  };

  app.get('/api/v1/list', { onRequest: publicList, config: { cors: true }, schema: { querystring: noQuery } }, async (req: FastifyRequest, reply) => {
    const s = await currentList(reply);
    if (!s) return reply;
    listHeaders(reply).header('etag', s.etag);
    if (etagMatches(req, s.etag)) return reply.code(304).send();
    return sendVariant(req, reply, { gzip: s.gzip, br: s.br, identity: () => ctx.list.identity(s) });
  });

  app.get(
    '/api/v1/list/delta',
    {
      onRequest: publicList,
      config: { cors: true },
      schema: { querystring: { type: 'object', additionalProperties: false, required: ['since'], properties: { since: { type: 'string', pattern: '^[0-9]{1,15}$' } } } },
    },
    async (req, reply) => {
      const s = await currentList(reply);
      if (!s) return reply;
      const d = await ctx.list.delta(s, Number((req.query as { since: string }).since));
      if (d.kind === 'gone') return sendError(reply, 410, 'delta_gone', 'This version is too old or unknown. Fetch the full list.');
      listHeaders(reply);
      if (d.kind === 'same') return reply.code(304).send();
      return sendVariant(req, reply, { gzip: d.body.gzip, br: d.body.br, identity: () => d.body.identity });
    },
  );
}
