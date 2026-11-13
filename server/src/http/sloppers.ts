import type { FastifyInstance } from 'fastify';
import { ipLimit, type Ctx } from '../app.js';
import { handleParams, noQuery, requireHandle, sendError } from '../lib/http.js';
import { CRITERIA } from '../scoring/criteria.js';
import type { SlopperSort, StatusFilter } from '../sloppers.js';
import { makeAsset, sendAsset } from './static.js';

const DEFAULT_LIMIT = 60;

const sloppersQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 40 },
    status: { enum: ['all', 'confirmed', 'flagged'] },
    sort: { enum: ['score', 'recent', 'votes', 'handle'] },
    cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$' },
    limit: { type: 'string', pattern: '^([1-9][0-9]?|100)$' },
  },
} as const;

/** The public list page, the rules it follows, and the stored avatars (section 12.5). */
export function registerSloppers(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/v1/sloppers', { onRequest: ipLimit(ctx, ctx.limits.sloppers), schema: { querystring: sloppersQuery } }, async (req, reply) => {
    const q = req.query as { q?: string; status?: StatusFilter; sort?: SlopperSort; cursor?: string; limit?: string };
    const page = await ctx.sloppers.page({
      q: q.q ?? '',
      status: q.status ?? 'all',
      sort: q.sort ?? 'score',
      cursor: q.cursor ?? null,
      limit: q.limit ? Number(q.limit) : DEFAULT_LIMIT,
    });
    reply.header('cache-control', 'public, max-age=60');
    return page;
  });

  const criteria = makeAsset(Buffer.from(JSON.stringify(CRITERIA)), 'json', { 'cache-control': 'public, max-age=3600' });
  app.get('/api/v1/criteria', { onRequest: ipLimit(ctx, ctx.limits.publicList), schema: { querystring: noQuery } }, async (req, reply) => sendAsset(req, reply, criteria));

  app.get('/api/v1/avatars/:handle', { onRequest: ipLimit(ctx, ctx.limits.avatars), schema: { params: handleParams, querystring: noQuery } }, async (req, reply) => {
    const avatar = await ctx.sloppers.avatar(requireHandle((req.params as { handle: string }).handle));
    if (!avatar) return sendError(reply, 404, 'not_found', 'No avatar is stored for this account.');
    return sendAsset(req, reply, avatar);
  });
}
