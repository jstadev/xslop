/**
 * Admin API (sections 5.6 and 13.8): scrypt login with a TOTP code, a cookie session with CSRF, Origin and idle
 * checks, the review queue, account decisions, appeals, installs, and the admin log of every change.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipLimit, type Ctx } from '../app.js';
import type { Queryable } from '../db.js';
import { publishList } from '../list.js';
import { randomToken, safeEqual, sha256Hex, totpStep, verifyPassword } from '../lib/crypto.js';
import { handleParams, HttpError, NO_NUL_RE, requireHandle, sendError, sendRateLimited, uuidParams } from '../lib/http.js';
import { STRIKE_MAX_CROWD } from '../scoring/network.js';
import { evidenceOf } from './public.js';

// __Host-: the browser accepts it only with Secure, Path=/ and no Domain, so no subdomain can set or shadow it.
const SESSION_COOKIE = '__Host-xs_admin';
const SESSION_SEC = 43_200;
/** A session also ends after this many minutes without a request (section 13.8). */
const SESSION_IDLE_MIN = 30;
/** The admin log names a session by the first hex characters of its token hash. */
const SESSION_ID_HEX = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// One scrypt check takes about 80 ms and 32 MB on the thread pool of 4, which also compresses list deltas and
// resolves the database host. Two at a time leave half of the pool free, however many networks send guesses.
const MAX_PASSWORD_CHECKS = 2;
/** The one key of the adminCodeFailures bucket. */
const CODE_FAILURES_KEY = 'all';
/** A listed account with this many "not slop" networks without standing goes to the disputed queue. */
const DISSENT_REVIEW_MIN = 3;

declare module 'fastify' {
  interface FastifyRequest {
    adminCsrf?: string;
    adminSession?: string;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const cookie = (value: string, maxAge: number) => `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const limitParam = { type: 'string', pattern: '^[0-9]{1,3}$' } as const;
const parseLimit = (s: string | undefined, def: number, max: number) => Math.min(max, Math.max(1, s ? Number(s) : def));
const iso = (d: Date | null) => d?.toISOString() ?? null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

interface AccountRow {
  handle: string;
  display_handle: string | null;
  status: string;
  tier: number;
  score: number;
  seed: boolean;
  override: string | null;
  override_at: Date | null;
  clear_penalty: boolean;
  cleared_at: Date | null;
  protected: boolean;
  identity: string;
  x_user_id: string | null;
  updated_at: Date;
  parts: unknown;
  ban_networks?: number;
}
const ACCOUNT_COLS = 'handle, display_handle, status, tier, score, seed, override, override_at, clear_penalty, cleared_at, protected, identity, x_user_id, updated_at, parts';
/** The networks that ban-voters counts and bans for the account of the row aliased `a`: those of its slop voters that are not banned. */
const BAN_NETWORKS_SQL = `(select count(distinct i.ip_hash)::int from votes v join installs i on i.id = v.install_id
  where v.handle = a.handle and v.value = 1 and i.banned_at is null) as ban_networks`;
const accountJson = (r: AccountRow) => ({
  handle: r.handle,
  displayHandle: r.display_handle,
  status: r.status,
  tier: r.tier,
  score: Math.round(r.score * 100),
  seed: r.seed,
  override: r.override,
  overrideAt: iso(r.override_at),
  clearPenalty: r.clear_penalty,
  clearedAt: iso(r.cleared_at),
  protected: r.protected,
  identity: r.identity,
  xUserId: r.x_user_id,
  updatedAt: r.updated_at.toISOString(),
  parts: r.parts,
  ...(r.ban_networks === undefined ? {} : { banNetworks: r.ban_networks }),
});

/** The columns that an admin decision changes or reads, kept in the admin log as the state before. */
interface AccountState {
  status: string;
  tier: number;
  score: number;
  seed: boolean;
  identity: string;
  override: string | null;
  override_at: Date | null;
  clear_penalty: boolean;
  cleared_at: Date | null;
  listed_at: Date | null;
  protected: boolean;
}
const STATE_COLS = 'status, tier, score, seed, identity, override, override_at, clear_penalty, cleared_at, listed_at, protected';

/** Locks the account row for the rest of the transaction and returns its state, or null when there is no row. */
async function lockAccount(q: Queryable, handle: string): Promise<AccountState | null> {
  const { rows } = await q.query<AccountState>(`select ${STATE_COLS} from accounts where handle = $1 for update`, [handle]);
  return rows[0] ?? null;
}

// listed_at moves here, not at the next score run: a vote cast after this answer must earn no reputation.
// A confirm withdraws an earlier clear (cleared_at), so a later reset does not bring the clear back.
// $2 is false for an account whose handle is gone or moved: it is never listed (section 13.3, rule 0).
const CONFIRM_SQL = `
  insert into accounts (handle, override, override_at, status, tier, score, listed_at) values ($1, 'confirm', now(), 'confirmed', 2, 1, now())
  on conflict (handle) do update set override = 'confirm', override_at = now(), cleared_at = null, updated_at = now(),
    status = 'confirmed', tier = 2, score = 1, listed_at = coalesce(accounts.listed_at, now())
  returning ${ACCOUNT_COLS}`;
const CLEAR_SQL = `
  insert into accounts (handle, override, override_at, status, tier, score, cleared_at, clear_penalty) values ($1, 'clear', now(), 'cleared', 0, 0, now(), $2)
  on conflict (handle) do update set override = 'clear', override_at = now(), status = 'cleared', tier = 0, score = 0, cleared_at = now(),
    clear_penalty = $2, listed_at = null, updated_at = now()
  returning ${ACCOUNT_COLS}`;
// The votes as they are at the decision (section 13.7), with the standing of each install at that time (13.10 item 5).
// A row that an earlier decision wrote stays: a vote deleted or flipped after it changes no strike and no penalty.
const keepVotes = (only: string) => `
  insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at, standing)
  select v.handle, v.install_id, i.ip_hash, v.value, v.updated_at, now(), (i.standing or i.trusted) and i.banned_at is null
  from votes v join installs i on i.id = v.install_id where v.handle = $1 ${only}
  on conflict (handle, install_id) do nothing`;
/** A clear keeps every vote. */
const KEEP_CLEARED_VOTES_SQL = keepVotes('');
/** A confirm keeps the "not slop" votes set before it: each one is a penalty of its install (13.10 item 3). */
const KEEP_DISSENT_SQL = keepVotes('and v.value = 0');
const UPDATES = { reset: 'override = null, override_at = null', protect: 'protected = true', unprotect: 'protected = false' } as const;

/** An admin clear or an accepted appeal. With the penalty (the default; never for a starter account) the votes go to cleared_votes. */
async function clearAccount(q: Queryable, handle: string, penalty: boolean | undefined): Promise<{ before: AccountState | null; row: AccountRow }> {
  const before = await lockAccount(q, handle);
  const withPenalty = (penalty ?? true) && !before?.seed;
  const { rows } = await q.query<AccountRow>(CLEAR_SQL, [handle, withPenalty]);
  if (withPenalty) await q.query(KEEP_CLEARED_VOTES_SQL, [handle]);
  return { before, row: rows[0]! };
}

// Counts the networks and bans their installs on one snapshot of the votes, so a vote that lands in between
// cannot raise the crowd past the limit after the check.
const BAN_VOTERS_SQL = `
  with voters as (
    select v.install_id, i.ip_hash from votes v join installs i on i.id = v.install_id
    where v.handle = $1 and v.value = 1 and i.banned_at is null
  ), crowd as (select count(distinct ip_hash)::int as networks from voters),
  banned as (
    update installs set banned_at = now()
    where banned_at is null and id in (select install_id from voters) and (select networks from crowd) <= $2
    returning id
  )
  select (select networks from crowd) as networks, array(select id::text from banned order by id) as ids`;

type Queue = 'pending' | 'disputed' | 'auto';
const QUEUE_WHERE: Record<Queue, string> = {
  pending: "a.status = 'pending'",
  disputed: `(a.seed and a.status = 'confirmed' and a.parts->>'disputed' = 'true')
             or (a.status in ('flagged', 'confirmed') and coalesce((a.parts->>'dissent')::numeric, 0) >= ${DISSENT_REVIEW_MIN})`,
  // Starter accounts were public from the first day: no vote confirmed them.
  auto: "a.confirmed_at > now() - interval '7 days' and a.override is null and not a.seed",
};
const QUEUE_ORDER: Record<Queue, string> = {
  // SPEC 13.10 item 8: anchors, checked evidence, the verified reply timing score, slop trust, handle.
  pending: `coalesce((a.parts->>'anchors')::numeric, 0) desc, coalesce((a.parts->>'evidence')::numeric, 0) desc,
            coalesce((a.parts->>'behaviour')::numeric, 0) desc, coalesce((a.parts->>'trust')::numeric, 0) desc, a.handle collate "C"`,
  disputed: "coalesce((a.parts->>'notSlop')::numeric, 0) desc, coalesce((a.parts->>'dissent')::numeric, 0) desc, a.handle",
  auto: 'a.confirmed_at desc, a.handle',
};

interface ReviewRow {
  handle: string;
  name: string | null;
  followers: number | null;
  x_user_id: string | null;
  identity: string;
  status: string;
  score: number;
  seed: boolean;
  protected: boolean;
  parts: Record<string, unknown> | null;
  first_vote_at: Date | null;
  last_vote_at: Date | null;
  ban_networks: number;
  total: number;
}

export function registerAdmin(app: FastifyInstance, ctx: Ctx): void {
  const L = ctx.limits;
  const admin = ctx.config.admin;
  const limit = ipLimit(ctx, L.admin);

  const sameOrigin = (req: FastifyRequest) => req.headers.origin === ctx.config.siteOrigin;

  /** Session check for every admin route; non-GET routes also need Origin and x-csrf (section 5.6). */
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!admin) return sendError(reply, 503, 'admin_disabled', 'The admin API is not configured.');
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !sameOrigin(req)) return sendError(reply, 403, 'bad_origin', 'The request origin is not allowed.');
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token || !TOKEN_RE.test(token)) return sendError(reply, 401, 'unauthorized', 'Log in first.');
    const hash = sha256Hex(token);
    // One statement checks the session and marks it seen: it ends 12 hours after the login or 30 minutes after its last request.
    const { rows } = await ctx.db.query<{ csrf: string }>(
      `update admin_sessions set seen_at = now()
       where token_hash = $1 and expires_at > now() and seen_at > now() - make_interval(mins => $2) returning csrf`,
      [hash, SESSION_IDLE_MIN],
    );
    const s = rows[0];
    if (!s) return sendError(reply, 401, 'unauthorized', 'Log in first.');
    if (write) {
      const sent = req.headers['x-csrf'];
      if (typeof sent !== 'string' || !safeEqual(sent, s.csrf)) return sendError(reply, 403, 'bad_csrf', 'The x-csrf header is missing or wrong.');
      // After the session checks, so only the admin can use this budget.
      const t = L.adminWrite.take(ctx.ipHashOf(req), ctx.now());
      if (!t.ok) return sendRateLimited(reply, t.retryAfterSec);
    }
    req.adminCsrf = s.csrf;
    req.adminSession = hash.slice(0, SESSION_ID_HEX);
  };
  const guarded = { onRequest: [limit, requireAdmin] };

  /**
   * Runs one admin change and writes its admin_log row with the state before, in one transaction, then one log line
   * with the action and its target (never a cookie, a token or an address). A change that fails leaves neither.
   */
  async function change<T>(req: FastifyRequest, action: string, target: string, run: (q: Queryable) => Promise<{ before: unknown; result: T }>): Promise<T> {
    const result = await ctx.db.tx(async (q) => {
      const r = await run(q);
      await q.query('insert into admin_log (session, action, target, before) values ($1, $2, $3, $4::jsonb)', [
        req.adminSession!,
        action,
        target,
        r.before === null ? null : JSON.stringify(r.before),
      ]);
      return r.result;
    });
    req.log.info({ action, target }, 'admin action');
    return result;
  }

  let passwordChecks = 0;
  /** The newest TOTP step that opened a session: a code of this step or an older one never works again. */
  let lastCodeStep = -Infinity;

  app.post(
    '/api/admin/login',
    {
      onRequest: limit,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!admin) return sendError(reply, 503, 'admin_disabled', 'The admin API is not configured.');
      if (!sameOrigin(req)) return sendError(reply, 403, 'bad_origin', 'The request origin is not allowed.');
      // Before the failure limit, so a busy answer costs the admin no attempt.
      if (passwordChecks >= MAX_PASSWORD_CHECKS) return sendRateLimited(reply, 1);
      const codes = L.adminCodeFailures.peek(CODE_FAILURES_KEY, ctx.now());
      if (!codes.ok) return sendRateLimited(reply, codes.retryAfterSec);
      const ip = ctx.ipHashOf(req);
      // Each attempt takes a token first, so parallel guesses cannot pass the 5-per-15-minutes limit.
      const t = L.adminLoginFailures.take(ip, ctx.now());
      if (!t.ok) return sendRateLimited(reply, t.retryAfterSec);
      const b = req.body as { username: string; password: string; code?: string };
      // scrypt runs for every attempt, so a bad user and a bad password take the same time.
      passwordChecks++;
      const pwOk = await verifyPassword(b.password, admin.hash).finally(() => passwordChecks--);
      const userOk = safeEqual(b.username, admin.user);
      // The code of the current step, or of one step before or after, works once (section 13.8).
      const step = admin.totp && b.code ? totpStep(admin.totp, b.code, ctx.now()) : null;
      const codeOk = !admin.totp || (step !== null && step > lastCodeStep);
      if (!pwOk || !userOk || !codeOk) {
        if (pwOk && userOk) L.adminCodeFailures.take(CODE_FAILURES_KEY, ctx.now());
        // A wrong code answers like a wrong password.
        return sendError(reply, 401, 'invalid_credentials', admin.totp ? 'The username, password or code is wrong.' : 'The username or password is wrong.');
      }
      if (step !== null) lastCodeStep = step;
      L.adminLoginFailures.refund(ip, ctx.now());

      const token = randomToken(32);
      const csrf = randomToken(32);
      const hash = sha256Hex(token);
      req.adminSession = hash.slice(0, SESSION_ID_HEX);
      await change(req, 'login', req.adminSession, async (q) => {
        await q.query("insert into admin_sessions (token_hash, csrf, expires_at, ip_hash) values ($1, $2, now() + interval '43200 seconds', $3)", [hash, csrf, ip]);
        return { before: null, result: null };
      });
      reply.header('set-cookie', cookie(token, SESSION_SEC));
      return { csrf };
    },
  );

  app.get('/api/admin/session', guarded, async (req) => ({ user: admin!.user, csrf: req.adminCsrf }));

  app.post('/api/admin/logout', guarded, async (req, reply) => {
    await change(req, 'logout', req.adminSession!, async (q) => {
      await q.query('delete from admin_sessions where token_hash = $1', [sha256Hex(readCookie(req.headers.cookie, SESSION_COOKIE)!)]);
      return { before: null, result: null };
    });
    reply.header('set-cookie', cookie('', 0));
    return reply.code(204).send();
  });

  app.get(
    '/api/admin/review',
    {
      ...guarded,
      schema: {
        querystring: { type: 'object', additionalProperties: false, required: ['queue'], properties: { queue: { enum: ['pending', 'disputed', 'auto'] }, limit: limitParam } },
      },
    },
    async (req) => {
      const q = req.query as { queue: Queue; limit?: string };
      const { rows } = await ctx.db.query<ReviewRow>(
        `select a.handle, p.name, p.followers, a.x_user_id, a.identity, a.status, a.score, a.seed, a.protected, a.parts,
                t.first_vote_at, t.last_vote_at, ${BAN_NETWORKS_SQL}, count(*) over ()::int as total
         from accounts a
         left join profiles p on p.handle = a.handle
         cross join lateral (select min(v.created_at) as first_vote_at, max(v.updated_at) as last_vote_at from votes v where v.handle = a.handle) t
         where ${QUEUE_WHERE[q.queue]}
         order by ${QUEUE_ORDER[q.queue]} limit $1`,
        [parseLimit(q.limit, 100, 500)],
      );
      const evidence = await evidenceOf(ctx.db, rows.map((r) => r.handle));
      return {
        // Every account of the queue, also past the limit (SPEC 13.10 item 8).
        total: rows[0]?.total ?? 0,
        items: rows.map((r) => {
          const p = r.parts ?? {};
          return {
            handle: r.handle,
            name: r.name,
            followers: r.followers,
            xUserId: r.x_user_id,
            identity: r.identity,
            status: r.status,
            want: str(p.want),
            gate: str(p.gate),
            networks: num(p.networks),
            anchors: num(p.anchors),
            notSlop: num(p.notSlop),
            dissent: num(p.dissent),
            trust: num(p.trust),
            score: Math.round(r.score * 100),
            seed: r.seed,
            protected: r.protected,
            behaviour: num(p.behaviour),
            sightings: num(p.sightings),
            fastReplyShare: num(p.fastReplyShare),
            evidence: evidence.get(r.handle) ?? [],
            banNetworks: r.ban_networks,
            firstVoteAt: iso(r.first_vote_at),
            lastVoteAt: iso(r.last_vote_at),
          };
        }),
      };
    },
  );

  app.get(
    '/api/admin/appeals',
    { ...guarded, schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { enum: ['open', 'accepted', 'rejected'] } } } } },
    async (req) => {
      const status = (req.query as { status?: string }).status ?? 'open';
      const { rows } = await ctx.db.query<{
        id: string;
        handle: string;
        email: string | null;
        message: string;
        code: string;
        status: string;
        created_at: Date;
        decided_at: Date | null;
        note: string | null;
        account_status: string;
        tier: number;
        score: number;
        seed: boolean;
        plain: number;
        standing: number;
      }>(
        // marks: the networks whose votes on the account say slop, by majority, read like the rows that an accept with
        // penalty stores (every vote, banned installs too). A network has standing when one of its slop votes comes from an
        // install with standing or trust that is not banned: the standing of its rows (SPEC 13.10 item 5, 13.12).
        `select p.id, p.handle, p.email, p.message, p.code, p.status, p.created_at, p.decided_at, p.note,
                a.status as account_status, a.tier, a.score, a.seed, m.plain, m.standing
         from appeals p join accounts a on a.handle = p.handle
         cross join lateral (
           select count(*) filter (where g.slop > g.not_slop and not g.standing)::int as plain,
                  count(*) filter (where g.slop > g.not_slop and g.standing)::int as standing from (
             select count(*) filter (where v.value = 1) as slop, count(*) filter (where v.value = 0) as not_slop,
                    bool_or(v.value = 1 and (i.standing or i.trusted) and i.banned_at is null) as standing
             from votes v join installs i on i.id = v.install_id
             where v.handle = p.handle group by i.ip_hash
           ) g
         ) m
         where p.status = $1 order by p.created_at desc limit 200`,
        [status],
      );
      return {
        appeals: rows.map((r) => ({
          appealId: r.id,
          handle: r.handle,
          email: r.email,
          message: r.message,
          code: r.code,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          decidedAt: iso(r.decided_at),
          note: r.note,
          account: { status: r.account_status, tier: r.tier, score: Math.round(r.score * 100), seed: r.seed },
          // An accept with penalty strikes every slop network without standing, and the slop networks with standing only
          // when there are at most STRIKE_MAX_CROWD of them (SPEC 13.12). A starter account gives no strike.
          marks: { networks: r.plain + r.standing, strikes: r.seed ? 0 : r.plain + (r.standing > STRIKE_MAX_CROWD ? 0 : r.standing) },
        })),
      };
    },
  );

  app.post(
    '/api/admin/appeals/:id/decide',
    {
      ...guarded,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { enum: ['accept', 'reject'] },
            note: { anyOf: [{ type: 'string', maxLength: 1000, pattern: NO_NUL_RE }, { type: 'null' }] },
            penalty: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const b = req.body as { decision: 'accept' | 'reject'; note?: string | null; penalty?: boolean };
      const status = b.decision === 'accept' ? 'accepted' : 'rejected';
      return change(req, b.decision, id, async (q) => {
        // The account row first, like POST /api/v1/appeals. In the other order an accept and a new appeal of the same
        // network each wait for the row that the other holds, and Postgres ends one of them with an error.
        await q.query('select 1 from accounts a join appeals p on p.handle = a.handle where p.id = $1 for update of a', [id]);
        const { rows } = await q.query<{ handle: string; decided_at: Date }>(
          "update appeals set status = $2, decided_at = now(), note = $3 where id = $1 and status = 'open' returning handle, decided_at",
          [id, status, b.note ?? null],
        );
        const r = rows[0];
        if (!r) {
          const exists = await q.query('select 1 from appeals where id = $1', [id]);
          throw exists.rowCount ? new HttpError(409, 'appeal_closed', 'This appeal is already decided.') : new HttpError(404, 'not_found', 'No appeal has this id.');
        }
        const result = { appealId: id, handle: r.handle, status, decidedAt: r.decided_at.toISOString() };
        if (b.decision === 'reject') return { before: { appeal: { status: 'open' } }, result };
        const { before } = await clearAccount(q, r.handle, b.penalty);
        // The account is cleared, so its other open appeals have their answer too. After the account update:
        // that row lock makes a new appeal wait, and then it finds no listing.
        await q.query("update appeals set status = 'accepted', decided_at = now() where handle = $1 and status = 'open'", [r.handle]);
        await publishList(q, new Date(ctx.now()));
        return { before: { appeal: { status: 'open' }, account: before }, result };
      });
    },
  );

  app.get(
    '/api/admin/accounts',
    {
      ...guarded,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { enum: ['none', 'pending', 'flagged', 'confirmed', 'cleared'] }, handle: { type: 'string', maxLength: 32 }, limit: limitParam },
        },
      },
    },
    async (req) => {
      const q = req.query as { status?: string; handle?: string; limit?: string };
      const prefix = q.handle !== undefined && q.handle.trim() !== '' ? requireHandle(q.handle) : null;
      const { rows } = await ctx.db.query<AccountRow>(
        `select ${ACCOUNT_COLS}, ${BAN_NETWORKS_SQL} from accounts a
         where ($1::text is null or status = $1) and ($2::text is null or starts_with(handle, $2))
         order by score desc, handle limit $3`,
        [q.status ?? null, prefix, parseLimit(q.limit, 100, 500)],
      );
      return { accounts: rows.map(accountJson) };
    },
  );

  app.post(
    '/api/admin/accounts/:handle',
    {
      ...guarded,
      schema: {
        params: handleParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: { action: { enum: ['confirm', 'clear', 'reset', 'protect', 'unprotect'] }, penalty: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const handle = requireHandle((req.params as { handle: string }).handle);
      const { action, penalty } = req.body as { action: 'confirm' | 'clear' | keyof typeof UPDATES; penalty?: boolean };
      return change<{ account: ReturnType<typeof accountJson>; list?: Awaited<ReturnType<typeof publishList>> }>(req, action, handle, async (q) => {
        // A confirm and a clear publish the list in this transaction, so a removal never waits for the score job (section 13.7).
        if (action === 'clear') {
          const { before, row } = await clearAccount(q, handle, penalty);
          return { before: { account: before }, result: { account: accountJson(row), list: await publishList(q, new Date(ctx.now())) } };
        }
        const before = await lockAccount(q, handle);
        if (action === 'confirm') {
          // A gone or moved account keeps the decision on its row; publishList leaves it out of the list.
          const { rows } = await q.query<AccountRow>(CONFIRM_SQL, [handle]);
          // The admin upholds the marks: the rows of an earlier clear give no strike and no reputation any more. The
          // "not slop" votes of now are stored, so a vote deleted or flipped after the confirm keeps its penalty.
          const { rows: clearedVotes } = await q.query('delete from cleared_votes where handle = $1 returning install_id, ip_hash, value, at, cleared_at, standing', [handle]);
          await q.query(KEEP_DISSENT_SQL, [handle]);
          return { before: { account: before, clearedVotes }, result: { account: accountJson(rows[0]!), list: await publishList(q, new Date(ctx.now())) } };
        }
        if (!before) throw new HttpError(404, 'not_found', 'No account has this handle.');
        const { rows } = await q.query<AccountRow>(`update accounts set ${UPDATES[action]}, updated_at = now() where handle = $1 returning ${ACCOUNT_COLS}`, [handle]);
        return { before: { account: before }, result: { account: accountJson(rows[0]!) } };
      });
    },
  );

  app.post('/api/admin/accounts/:handle/ban-voters', { ...guarded, schema: { params: handleParams } }, async (req) => {
    const handle = requireHandle((req.params as { handle: string }).handle);
    return change(req, 'ban-voters', handle, async (q) => {
      const { rows } = await q.query<{ networks: number; ids: string[] }>(BAN_VOTERS_SQL, [handle, STRIKE_MAX_CROWD]);
      const r = rows[0]!;
      // A large crowd is not a ring: its installs are judged one by one.
      if (r.networks > STRIKE_MAX_CROWD) throw new HttpError(409, 'crowd_too_large', `More than ${STRIKE_MAX_CROWD} networks marked this account. Ban single installs instead.`);
      return { before: { unbannedInstalls: r.ids }, result: { banned: r.ids.length } };
    });
  });

  app.get(
    '/api/admin/installs',
    {
      ...guarded,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { sort: { enum: ['reputation', 'created', 'votes'] }, limit: limitParam } } },
    },
    async (req) => {
      const q = req.query as { sort?: string; limit?: string };
      const order = q.sort === 'created' ? 'i.created_at desc' : q.sort === 'votes' ? 'c.slop + c.not_slop desc, i.created_at desc' : 'i.reputation asc, i.created_at desc';
      const { rows } = await ctx.db.query<{
        id: string;
        created_at: Date;
        reputation: number;
        banned_at: Date | null;
        last_seen_at: Date | null;
        ext_version: string | null;
        trusted: boolean;
        standing: boolean;
        good_marks: number;
        slop: number;
        not_slop: number;
        same_network: number;
      }>(
        `select i.id, i.created_at, i.reputation, i.banned_at, i.last_seen_at, i.ext_version, i.trusted, i.standing, i.good_marks, c.slop, c.not_slop,
                (select count(*) from installs j where j.ip_hash = i.ip_hash) as same_network
         from installs i
         cross join lateral (select count(*) filter (where v.value = 1)::int as slop, count(*) filter (where v.value = 0)::int as not_slop
                             from votes v where v.install_id = i.id) c
         order by ${order} limit $1`,
        [parseLimit(q.limit, 100, 500)],
      );
      return {
        installs: rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at.toISOString(),
          reputation: r.reputation,
          bannedAt: iso(r.banned_at),
          lastSeenAt: iso(r.last_seen_at),
          extVersion: r.ext_version,
          trusted: r.trusted,
          standing: r.standing,
          goodMarks: r.good_marks,
          votes: r.slop + r.not_slop,
          slopVotes: r.slop,
          notSlopVotes: r.not_slop,
          sameNetwork: r.same_network,
        })),
      };
    },
  );

  for (const [action, set] of [
    ['ban', 'banned_at = coalesce(banned_at, now())'],
    ['unban', 'banned_at = null'],
    // Only an admin sets trusted (section 13.2). The score job gives or takes standing at its next run.
    ['trust', 'trusted = true'],
    ['untrust', 'trusted = false'],
  ] as const) {
    app.post(`/api/admin/installs/:id/${action}`, { ...guarded, schema: { params: uuidParams } }, async (req) => {
      const id = (req.params as { id: string }).id;
      return change(req, action, id, async (q) => {
        const { rows: before } = await q.query<{ banned_at: Date | null; trusted: boolean }>('select banned_at, trusted from installs where id = $1 for update', [id]);
        if (!before[0]) throw new HttpError(404, 'not_found', 'No install has this id.');
        const { rows } = await q.query<{ banned_at: Date | null; trusted: boolean }>(`update installs set ${set} where id = $1 returning banned_at, trusted`, [id]);
        return { before: { install: before[0] }, result: { id, bannedAt: iso(rows[0]!.banned_at), trusted: rows[0]!.trusted } };
      });
    });
  }

  app.get(
    '/api/admin/log',
    { ...guarded, schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: limitParam } } } },
    async (req) => {
      const { rows } = await ctx.db.query<{ id: number; at: Date; session: string; action: string; target: string; before: unknown }>(
        'select id, at, session, action, target, before from admin_log order by id desc limit $1',
        [parseLimit((req.query as { limit?: string }).limit, 100, 500)],
      );
      return { entries: rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), session: r.session, action: r.action, target: r.target, before: r.before ?? null })) };
    },
  );

  app.get('/api/admin/overview', guarded, async () => {
    const { rows } = await ctx.db.query<{
      confirmed: number;
      flagged: number;
      pending: number;
      cleared: number;
      seed: number;
      votes: number;
      installs: number;
      banned: number;
      standing: number;
      trusted: number;
      sightings: number;
      appeals_open: number;
      list_version: number | null;
      moved24h: number;
      last_run_at: Date | null;
      last_ok_at: Date | null;
      detail: unknown;
      facts_run_at: Date | null;
      facts_ok_at: Date | null;
      facts_detail: unknown;
    }>(
      `select (select count(*) from accounts where status = 'confirmed') as confirmed,
              (select count(*) from accounts where status = 'flagged') as flagged,
              (select count(*) from accounts where status = 'pending') as pending,
              (select count(*) from accounts where status = 'cleared') as cleared,
              (select count(*) from accounts where seed) as seed,
              (select count(*) from votes) as votes,
              (select count(*) from installs) as installs,
              (select count(*) from installs where banned_at is not null) as banned,
              (select count(*) from installs where standing and banned_at is null) as standing,
              (select count(*) from installs where trusted) as trusted,
              (select count(*) from sightings) as sightings,
              (select count(*) from appeals where status = 'open') as appeals_open,
              (select max(version) from list_snapshots) as list_version,
              (select count(*) from accounts where identity = 'moved' and identity_at > now() - interval '24 hours') as moved24h,
              j.last_run_at, j.last_ok_at, j.detail,
              f.last_run_at as facts_run_at, f.last_ok_at as facts_ok_at, f.detail as facts_detail
       from (select 1) one left join jobs j on j.name = 'score' left join jobs f on f.name = 'profiles'`,
    );
    const r = rows[0]!;
    return {
      accounts: { confirmed: r.confirmed, flagged: r.flagged, pending: r.pending, cleared: r.cleared, seed: r.seed },
      votes: r.votes,
      installs: r.installs,
      bannedInstalls: r.banned,
      standingInstalls: r.standing,
      trustedInstalls: r.trusted,
      sightings: r.sightings,
      appealsOpen: r.appeals_open,
      listVersion: r.list_version === null ? null : Number(r.list_version),
      score: { lastRunAt: iso(r.last_run_at), lastOkAt: iso(r.last_ok_at), detail: r.detail ?? null },
      // moved24h: rows that the X facts job found under another X id in the last 24 hours; each one left the list.
      facts: { lastRunAt: iso(r.facts_run_at), lastOkAt: iso(r.facts_ok_at), detail: r.facts_detail ?? null, moved24h: r.moved24h },
    };
  });
}
