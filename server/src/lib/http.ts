/** Input rules shared by the routes (handles, ids, dates) and the error shape of the API. */
import type { FastifyReply } from 'fastify';

export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
export const TWEET_ID_RE = '^[0-9]{1,20}$';
export const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// ISO 8601 UTC date-time, for example 2026-11-07T16:15:00.795Z or with an explicit offset.
const ISO_RE = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$';

/** Input is trimmed, a leading @ is removed, then lower-cased; null when it is not a valid handle. */
function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

export function requireHandle(raw: unknown): string {
  const h = normalizeHandle(raw);
  if (!h) throw new HttpError(400, 'invalid_handle', 'The handle must be 1 to 15 letters, digits or underscores.');
  return h;
}

/** First millisecond of the X post ids that carry their time (2010-11-04T01:42:54.657Z). */
const POST_ID_EPOCH_MS = 1288834974657;

/** The time that an X post id holds in its upper bits. An id from before 2010-11-04 holds none and reads as that day. */
export function postTime(tweetId: string): Date {
  return new Date(Number(BigInt(tweetId) >> 22n) + POST_ID_EPOCH_MS);
}

export function parseIso(s: string | null | undefined): Date | null {
  if (s == null) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Postgres text cannot hold a NUL byte: without this pattern the insert fails and the client gets a 500. */
export const NO_NUL_RE = '^[^\\u0000]*$';
export const handleInput = { type: 'string', minLength: 1, maxLength: 32 } as const;
export const tweetId = { type: 'string', pattern: TWEET_ID_RE } as const;
export const nullableTweetId = { anyOf: [tweetId, { type: 'null' }] } as const;
export const isoDate = { type: 'string', maxLength: 40, pattern: ISO_RE } as const;
export const nullableIso = { anyOf: [isoDate, { type: 'null' }] } as const;
export const handleParams = {
  type: 'object',
  additionalProperties: false,
  required: ['handle'],
  properties: { handle: handleInput },
} as const;
export const uuidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_RE } },
} as const;
export const noQuery = { type: 'object', additionalProperties: false, properties: {} } as const;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send(errorBody(code, message));
}

export function sendRateLimited(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  reply.header('retry-after', String(retryAfterSec));
  return sendError(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
