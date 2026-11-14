/** Builds the Fastify app: JSON-only parsing, the error shape, the headers of every answer, and the route groups. */
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { Db } from './db.js';
import type { AppConfig } from './env.js';
import { ipHash } from './lib/crypto.js';
import { HttpError, sendError, sendRateLimited } from './lib/http.js';
import { createLimits, type Limits, type TokenBucket } from './lib/ratelimit.js';
import { ListCache } from './list.js';
import { SloppersCache } from './sloppers.js';
import { registerAdmin } from './http/admin.js';
import { registerClient } from './http/client.js';
import { registerPublic } from './http/public.js';
import { registerSloppers } from './http/sloppers.js';
import { loadStatic, registerStatic, type StaticFiles } from './http/static.js';

interface AppDeps {
  db: Db;
  config: AppConfig;
  /** Clock in unix milliseconds; tests move it. */
  now?: () => number;
  /** Fastify logger options; false turns logging off. */
  logger?: FastifyServerOptions['logger'];
  /** Preloaded static files; loaded from config.staticRoot when absent. */
  files?: StaticFiles;
}

export interface Ctx {
  db: Db;
  config: AppConfig;
  now: () => number;
  limits: Limits;
  list: ListCache;
  sloppers: SloppersCache;
  files: StaticFiles;
  log: FastifyBaseLogger;
  ipHashOf(req: FastifyRequest): string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Sends Access-Control-Allow-Origin: * (section 5.7). */
    cors?: boolean;
  }
}

const BODY_LIMIT = 64 * 1024;
/** The whole request, headers and body. Fastify's default is no limit, and the proxy sets none for a body. */
const REQUEST_TIMEOUT_MS = 30_000;
const TIMEOUT_CHECK_MS = 5_000;

/** onRequest hook: one token per request from `bucket`, keyed by the client IP hash. */
export function ipLimit(ctx: Ctx, bucket: TokenBucket) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = bucket.take(ctx.ipHashOf(req), ctx.now());
    if (!r.ok) return sendRateLimited(reply, r.retryAfterSec);
  };
}

export const loggerOptions = {
  level: 'info',
  // Request logs carry method and URL only: no headers, no body, no IP (section 3).
  // A database error quotes the failing row in `detail` and `where`, so an error keeps only these fields.
  serializers: {
    req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    err: (err: Error & { code?: unknown }) => ({ type: err.name, message: err.message, code: err.code, stack: err.stack ?? '' }),
  },
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger: FastifyServerOptions['logger'] = deps.logger ?? loggerOptions;
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Node uses the larger of the two limits for the body, and its header limit is 60 s unless it is set here.
    http: { headersTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: TIMEOUT_CHECK_MS },
    // Caddy on the same host appends the client address; trust X-Forwarded-For only from loopback.
    trustProxy: ['127.0.0.1', '::1'],
    requestIdHeader: false,
    return503OnClosing: true,
    // A path that the router cannot decode never reaches a route, a hook or the error handler below.
    // Fastify's own answer repeats the path; this one has the error shape and the API headers.
    frameworkErrors: (_err, _req, reply) =>
      sendError(reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store'), 400, 'bad_request', 'The request is not valid.'),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });

  const now = deps.now ?? Date.now;
  // The name only: a value can hold a token that someone pasted by mistake.
  for (const name of deps.config.ignored) app.log.warn({ variable: name }, 'ignored a bad optional variable: it is not a store listing URL');
  const files = deps.files ?? (await loadStatic(deps.config.staticRoot, deps.config.configFile, deps.config.stores));
  const ctx: Ctx = {
    db: deps.db,
    config: deps.config,
    now,
    limits: createLimits(),
    list: new ListCache(deps.db, now, (err) => app.log.error({ err }, 'list refresh failed')),
    sloppers: new SloppersCache(deps.db, now, app.log),
    files,
    log: app.log,
    ipHashOf: (req) => ipHash(deps.config.ipSalt, req.ip),
  };

  // JSON only. The raw bytes are kept for the request signature (section 5.1).
  app.removeAllContentTypeParsers();
  const parseJson = app.getDefaultJsonParser('error', 'error') as unknown as (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void;
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    parseJson(req, body, done);
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    // Every answer that states no cache rule of its own. The raw URL is no test for "an API answer":
    // the router decodes the path first, so /%61pi/admin/session reaches the API route.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (req.routeOptions.config?.cors) reply.header('access-control-allow-origin', '*');
  });

  app.addHook('onResponse', async (req, reply) => {
    const code = reply.statusCode;
    if (code >= 400 && code !== 404) req.log.info({ route: req.routeOptions.url, statusCode: code, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number; code?: string }, req, reply) => {
    if (err.validation) return sendError(reply, 400, 'invalid_request', err.message);
    if (err instanceof HttpError) return sendError(reply, err.status, err.code, err.message);
    switch (err.code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return sendError(reply, 413, 'body_too_large', 'The request body is larger than 64 KB.');
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return sendError(reply, 415, 'unsupported_media_type', 'Send the body as application/json.');
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return sendError(reply, 400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return sendError(reply, err.statusCode, 'bad_request', 'The request is not valid.');
    }
    req.log.error({ err }, 'request failed');
    return sendError(reply, 500, 'internal_error', 'Something went wrong. Try again later.');
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'not_found', 'Nothing is here.'));

  registerPublic(app, ctx);
  registerClient(app, ctx);
  registerSloppers(app, ctx);
  registerAdmin(app, ctx);
  registerStatic(app, ctx);
  return app;
}
