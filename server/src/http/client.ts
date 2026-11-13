/** Signed extension routes (sections 5.2 and 5.3): votes, the caller's own votes, and observations with their caps. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipLimit, type Ctx } from '../app.js';
import { handleInput, handleParams, HttpError, isoDate, NO_NUL_RE, noQuery, nullableIso, nullableTweetId, parseIso, postTime, requireHandle, sendRateLimited, tweetId } from '../lib/http.js';
import { SIGHTINGS_KEY, takeAll } from '../lib/ratelimit.js';
import { isListed } from './public.js';
import { createSignedGuard } from './signed.js';

const FUTURE_MS = 10 * 60_000;
const PAST_MS = 30 * 24 * 3_600_000;
const CAP_LOG_EVERY_MS = 3_600_000;

interface VoteBody {
  handle: string;
  value: 'slop' | 'not_slop';
  tweetId: string;
  parentTweetId?: string | null;
  postedAt?: string | null;
  context: 'reply' | 'post';
}

interface Observation {
  handle: string;
  tweetId: string;
  parentTweetId: string | null;
}

const unit = { type: 'number', minimum: 0, maximum: 1 } as const;
const observationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['handle', 'tweetId', 'parentTweetId'],
  properties: {
    handle: handleInput,
    tweetId,
    parentTweetId: nullableTweetId,
    // The fields of builds before 1.2 (section 13.8): accepted, so their batches land, and never stored.
    parentHandle: { anyOf: [handleInput, { type: 'null' }] },
    replyAt: isoDate,
    parentAt: nullableIso,
    textLen: { type: 'integer', minimum: 0, maximum: 2000 },
    simhash: { type: 'string', pattern: '^[0-9a-f]{16}$' },
    genericScore: unit,
    overlapScore: unit,
    hasMedia: { type: 'boolean' },
    verified: { type: 'boolean' },
  },
} as const;

export function registerClient(app: FastifyInstance, ctx: Ctx): void {
  const L = ctx.limits;
  const signed = createSignedGuard(ctx);
  // onRequest: runs before the body is read, so a flood costs no database query and no signature check.
  const signedIp = ipLimit(ctx, L.signed);

  /**
   * Votes and deletes share one budget: 120 per hour per install, and 200 per day per network of registration.
   * An install with standing has 120 per day of its own instead of the network's (section 13.8).
   */
  const votesLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, ipHash, standing } = req.install!;
    const r = takeAll(ctx.now(), 1, [[L.votesHour, id], standing ? [L.votesStandingDay, id] : [L.votesNetworkDay, ipHash]]);
    if (!r.ok) return sendRateLimited(reply, r.retryAfterSec);
  };
  const meLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = L.me.take(req.install!.id, ctx.now());
    if (!r.ok) return sendRateLimited(reply, r.retryAfterSec);
  };

  app.post(
    '/api/v1/votes',
    {
      onRequest: signedIp,
      preValidation: [signed, votesLimit],
      schema: {
        querystring: noQuery,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['handle', 'value', 'tweetId', 'context'],
          properties: {
            handle: handleInput,
            value: { enum: ['slop', 'not_slop'] },
            tweetId,
            parentTweetId: nullableTweetId,
            // Installed extensions of older builds still send the post text: it is accepted, so their votes count, and never stored.
            text: { anyOf: [{ type: 'string', maxLength: 560, pattern: NO_NUL_RE }, { type: 'null' }] },
            postedAt: nullableIso,
            context: { enum: ['reply', 'post'] },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as VoteBody;
      const handle = requireHandle(b.handle);
      const postedAt = parseIso(b.postedAt);
      if (b.postedAt != null && !postedAt) throw new HttpError(400, 'invalid_request', 'body/postedAt is not a valid date');
      await ctx.db.query('insert into accounts (handle) values ($1) on conflict do nothing', [handle]);
      // updated_at is the time of the current value: a re-vote with the same value keeps it, so new
      // evidence cannot move a vote forward, and reputation sees when the value was set.
      await ctx.db.query(
        `insert into votes (install_id, handle, value, tweet_id, parent_tweet_id, posted_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (install_id, handle) do update set value = excluded.value, tweet_id = excluded.tweet_id,
           parent_tweet_id = excluded.parent_tweet_id, text = null, posted_at = excluded.posted_at,
           updated_at = case when votes.value is distinct from excluded.value then excluded.updated_at else votes.updated_at end`,
        [req.install!.id, handle, b.value === 'slop' ? 1 : 0, b.tweetId, b.parentTweetId ?? null, postedAt],
      );
      // The public state only, as GET /api/v1/accounts/:handle answers it: a pending, cleared or moved account reads as none (SPEC 13.3).
      const { rows } = await ctx.db.query<{ status: string; tier: number; identity: string }>('select status, tier, identity from accounts where handle = $1', [handle]);
      return { handle, value: b.value, account: isListed(rows[0]) ? { status: rows[0]!.status, tier: rows[0]!.tier } : { status: 'none', tier: 0 } };
    },
  );

  app.delete('/api/v1/votes/:handle', { onRequest: signedIp, preValidation: [signed, votesLimit], schema: { params: handleParams, querystring: noQuery } }, async (req, reply) => {
    const handle = requireHandle((req.params as { handle: string }).handle);
    await ctx.db.query('delete from votes where install_id = $1 and handle = $2', [req.install!.id, handle]);
    return reply.code(204).send();
  });

  app.get('/api/v1/me', { onRequest: signedIp, preValidation: [signed, meLimit], schema: { querystring: noQuery } }, async (req) => {
    const inst = req.install!;
    const { rows } = await ctx.db.query<{ handle: string; value: number; updated_at: Date }>(
      'select handle, value, updated_at from votes where install_id = $1 order by updated_at desc limit 5000',
      [inst.id],
    );
    return {
      installId: inst.id,
      createdAt: inst.createdAt.toISOString(),
      reputation: inst.reputation,
      standing: inst.standing,
      goodMarks: inst.goodMarks,
      trusted: inst.trusted,
      votes: rows.map((r) => ({ handle: r.handle, value: r.value === 1 ? 'slop' : 'not_slop', at: r.updated_at.toISOString() })),
    };
  });

  /** One warning an hour per cap on stored sightings, however many batches it drops. */
  const capLoggedAt = new Map<string, number>();
  const warnCap = (message: string, capacity: number, now: number) => {
    if (now - (capLoggedAt.get(message) ?? -Infinity) < CAP_LOG_EVERY_MS) return;
    capLoggedAt.set(message, now);
    ctx.log.warn({ capacity }, message);
  };
  app.post(
    '/api/v1/observations',
    {
      onRequest: signedIp,
      preValidation: signed,
      schema: {
        querystring: noQuery,
        body: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 100, items: observationSchema } } },
      },
    },
    async (req, reply) => {
      const items = (req.body as { items: Observation[] }).items;
      const now = ctx.now();
      const { id: install, ipHash: network } = req.install!;
      const r = takeAll(now, items.length, [[L.observations, install], [L.observationsIp, ctx.ipHashOf(req)]]);
      if (!r.ok) return sendRateLimited(reply, r.retryAfterSec);

      // Validate the whole batch first, so a rejected batch uses no per-handle budget.
      const rows: { handle: string; values: unknown[] }[] = [];
      for (const o of items) {
        const handle = requireHandle(o.handle);
        // The time comes from the post id, never from the client (section 13.8). A post outside the window is dropped,
        // not fatal: the batch still lands. An id from before 2010-11-04 has no time and reads as that day, so it is dropped too.
        const replyAt = postTime(o.tweetId);
        const t = replyAt.getTime();
        if (t > now + FUTURE_MS || t < now - PAST_MS) continue;
        rows.push({ handle, values: [o.tweetId, handle, o.parentTweetId, replyAt] });
      }
      // A cap on stored sightings is reached, the hourly one of all networks together or the daily one of this
      // install's network: the batch is dropped, like the extra sightings of one handle. No error: the extension
      // would hold its votes back behind a retry. The handles keep their budget.
      const allFull = !L.sightingsStored.peek(SIGHTINGS_KEY, now, rows.length).ok;
      if (allFull || !L.sightingsNetworkDay.peek(network, now, rows.length).ok) {
        if (allFull) warnCap('the hourly cap on stored sightings is reached; observations are dropped', L.sightingsStored.capacity, now);
        else warnCap('one network reached its daily cap on stored sightings; its observations are dropped', L.sightingsNetworkDay.capacity, now);
        return reply.code(202).send({ accepted: 0 });
      }
      // At most 3 sightings per handle per install in 24 hours, and 9 per handle for all installs of one network.
      // The rest is dropped and never stored.
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (const row of rows) {
        if (!L.sightingsPerHandle.hit(`${install}:${row.handle}`, now) || !L.sightingsPerHandleNetwork.hit(`${network}:${row.handle}`, now)) continue;
        tuples.push(`(${row.values.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
        params.push(...row.values);
      }
      L.sightingsStored.take(SIGHTINGS_KEY, now, tuples.length);
      L.sightingsNetworkDay.take(network, now, tuples.length);
      let accepted = 0;
      if (tuples.length > 0) {
        // No install id is written with a sighting, by design (section 4). The X facts job verifies it later (verified_at).
        const res = await ctx.db.query(
          `insert into sightings (tweet_id, handle, parent_tweet_id, reply_at) values ${tuples.join(', ')} on conflict (tweet_id) do nothing`,
          params,
        );
        accepted = res.rowCount;
      }
      return reply.code(202).send({ accepted });
    },
  );
}
