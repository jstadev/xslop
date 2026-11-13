/**
 * The two public X sources of the X facts job (SPEC 13.6): the embed answer of X and fxtwitter. Fixed hosts, no key,
 * no redirect, a timeout and a byte cap on every answer, one request per PACE_MS, and strict parsing: a value from an
 * answer reaches a URL only after a pattern check.
 */
import { HANDLE_RE } from './http.js';

export const PACE_MS = 2_000;
/** fxtwitter answers 404 for live accounts (35 of 64 requests on 2026-11-09), so a profile is missing only after this many 404s. */
export const TRIES_PER_PROFILE = 3;
export const MAX_AVATAR_BYTES = 256 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const EMBED_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const FX_BASE = 'https://api.fxtwitter.com/';
const AVATAR_HOST = 'pbs.twimg.com';
const USER_AGENT = 'xslop-xfacts/2';

const ID_RE = /^[0-9]{1,20}$/;
const MAX_FOLLOWERS = 2_147_483_647;
const MAX_NAME_LENGTH = 100;
// Controls and bidi overrides can disguise a display name inside the surrounding text.
const NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const AVATAR_PATH_RE = /^\/profile_images\/[0-9]{1,30}\/[A-Za-z0-9_.%~-]{1,120}\.(?:jpe?g|png|webp)$/i;
const AVATAR_SIZE_RE = /_(?:normal|bigger|mini|[0-9]{2,4}x[0-9]{2,4})(?=\.[a-z]+$)/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface XProfile {
  xId: string;
  name: string | null;
  followers: number | null;
  avatarUrl: string | null;
}

export interface XPost {
  authorId: string;
  /** The current handle of the author, lower case. */
  authorHandle: string;
  inReplyTo: string | null;
  /** `embed` is the answer of X itself; only it can confirm a rename (SPEC 13.6). */
  via: 'embed' | 'fxtwitter';
}

export type Miss = 'missing' | 'failed' | 'rate_limited';

export interface Avatar {
  bytes: Buffer;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface XSourceDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface XSource {
  profile(handle: string): Promise<XProfile | Miss>;
  post(tweetId: string): Promise<XPost | Miss>;
  avatar(url: string): Promise<Avatar | null>;
  /** Requests sent so far. */
  readonly requests: number;
}

/** The token that the embed answer of X asks for. */
export function embedToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** The image type from the file's own first bytes; the Content-Type header is never trusted. */
export function detectImageType(b: Buffer): Avatar['type'] | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The 96 px avatar URL on the fixed image host, or null. Nothing from the input URL survives except its checked path. */
export function avatarUrlOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || !AVATAR_PATH_RE.test(url.pathname)) return null;
  return `https://${AVATAR_HOST}${url.pathname.replace(AVATAR_SIZE_RE, '_x96')}`;
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const id = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);
/** A handle in any case, as lower case; null when it is not a handle. */
const handleOf = (v: unknown): string | null => (typeof v === 'string' && HANDLE_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(NAME_CONTROLS, '').trim();
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

function cleanFollowers(raw: unknown): number | null {
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= MAX_FOLLOWERS ? (raw as number) : null;
}

/** fxtwitter profile. Bad optional fields stay null; another account or a bad id rejects the answer. */
function parseProfile(data: unknown, handle: string): XProfile | null {
  const u = record(record(data)?.user);
  const xId = id(u?.id);
  if (!u || !xId || handleOf(u.screen_name) !== handle) return null;
  return { xId, name: cleanName(u.name), followers: cleanFollowers(u.followers), avatarUrl: avatarUrlOf(u.avatar_url) };
}

/** null, absent or a post id; anything else rejects the answer. */
function replyOf(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return id(v) ?? undefined;
}

function postOf(postId: unknown, wanted: string, author: Record<string, unknown> | null, authorId: unknown, reply: unknown, via: XPost['via']): XPost | 'failed' {
  const a = id(authorId);
  const h = handleOf(author?.screen_name);
  const inReplyTo = replyOf(reply);
  return postId === wanted && a && h && inReplyTo !== undefined ? { authorId: a, authorHandle: h, inReplyTo, via } : 'failed';
}

/** The embed answer of X: a post, a tombstone (deleted, withheld or not visible) or anything else. */
function parseEmbed(data: unknown, wanted: string): XPost | Miss {
  const d = record(data);
  if (d?.__typename === 'TweetTombstone') return 'missing';
  if (d?.__typename !== 'Tweet') return 'failed';
  const user = record(d.user);
  return postOf(d.id_str, wanted, user, user?.id_str, d.in_reply_to_status_id_str, 'embed');
}

function parseFxPost(data: unknown, wanted: string): XPost | Miss {
  const t = record(record(data)?.tweet);
  const author = record(t?.author);
  return postOf(t?.id, wanted, author, author?.id, t?.replying_to_status, 'fxtwitter');
}

/** Reads at most `maxBytes` of the body; returns null above the limit and stops reading at once. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return null;
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await res.body.cancel();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export function createXSource(deps: XSourceDeps): XSource {
  let last = -Infinity;
  let requests = 0;

  /** Every request of a run goes through here, so the pace holds over both sources and the image host. */
  async function get(url: string, accept: string): Promise<Response> {
    const wait = last + PACE_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    last = deps.now();
    requests++;
    return deps.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept, 'user-agent': USER_AGENT } });
  }

  /** The parsed JSON of a 200 answer, or what the status means. A fetch that fails for any reason is `failed`. */
  async function getJson(url: string): Promise<{ data: unknown } | Miss> {
    try {
      const res = await get(url, 'application/json');
      if (res.status !== 200) {
        await res.body?.cancel();
        return res.status === 429 ? 'rate_limited' : res.status === 404 ? 'missing' : 'failed';
      }
      const body = await readCapped(res, MAX_JSON_BYTES);
      return body ? { data: JSON.parse(body.toString('utf8')) } : 'failed';
    } catch {
      return 'failed';
    }
  }

  return {
    get requests() {
      return requests;
    },

    async profile(handle) {
      if (!HANDLE_RE.test(handle)) return 'failed';
      for (let attempt = 1; attempt <= TRIES_PER_PROFILE; attempt++) {
        const r = await getJson(`${FX_BASE}${handle}`);
        if (r === 'missing') continue;
        if (typeof r === 'string') return r;
        return parseProfile(r.data, handle) ?? 'failed';
      }
      return 'missing';
    },

    /** The embed answer first; fxtwitter when it fails. `missing` only when both say so; a rate limit ends at once. */
    async post(tweetId) {
      if (!ID_RE.test(tweetId)) return 'failed';
      const a = await getJson(`${EMBED_URL}?id=${tweetId}&token=${embedToken(tweetId)}`);
      const first = typeof a === 'string' ? a : parseEmbed(a.data, tweetId);
      if (typeof first === 'object' || first === 'rate_limited') return first;
      const b = await getJson(`${FX_BASE}status/${tweetId}`);
      const second = typeof b === 'string' ? b : parseFxPost(b.data, tweetId);
      if (typeof second === 'object' || second === 'rate_limited') return second;
      return first === 'missing' && second === 'missing' ? 'missing' : 'failed';
    },

    async avatar(url) {
      if (avatarUrlOf(url) !== url) return null;
      try {
        const res = await get(url, 'image/*');
        if (res.status !== 200) {
          await res.body?.cancel();
          return null;
        }
        const bytes = await readCapped(res, MAX_AVATAR_BYTES);
        const type = bytes && detectImageType(bytes);
        return bytes && type ? { bytes, type } : null;
      } catch {
        return null;
      }
    },
  };
}
