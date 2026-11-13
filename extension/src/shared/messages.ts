// Typed messages between content script, popup/onboarding and background, with strict validators.
import {
  BEARER_RE, HANDLE_RE, isInt, isIso, isObj, isStr, isTweetId, isXCode, isXId, isXStatus, normHandle, onlyKeys,
} from './util';
import type { ListRow, Observation, Settings, Vote, VoteBody } from './types';
import { parseDelta } from './list';

export const OBS_MAX = 100;
export const HIDDEN_MAX = 200;
export const VOTES_MAX = 10_000;

/** X never answered (status 0) because you are not logged in on this site. */
export const NOT_LOGGED_IN = -1;
/** X never answered (status 0) because xslop did not call: the per-minute limit or a stop. The paced queue takes over. */
export const NOT_CALLED = -4;

/** What X answered to an instant mute or unmute, reported by the content script (SPEC 12.3). */
export interface MuteResult {
  handle: string;
  /** The X user id. Null on a mute through X's own menu, which returns no id. */
  id: string | null;
  status: number;
  code: number | null;
  via: 'rest' | 'menu';
  op: 'create' | 'destroy';
}

/** The answer to `muteRecord`: the user id to unmute, or null when xslop may not unmute this account. */
export interface MuteRecordReply {
  id: string | null;
  /** The account stays muted on X: you muted it yourself, or xslop has no id for its mute. */
  stays: boolean;
}

export type ContentMsg =
  | ({ t: 'vote' } & VoteBody)
  | { t: 'unvote'; handle: string }
  | { t: 'observe'; items: Observation[] }
  | { t: 'hidden'; ids: string[] }
  | { t: 'hello' }
  | ({ t: 'muted' } & MuteResult)
  | { t: 'muteRecord'; handle: string };

export type PageMsg =
  | { t: 'settings'; patch: Partial<Settings> }
  | { t: 'unvote'; handle: string }
  | { t: 'restore'; vote: Vote }
  | { t: 'muteUndoAll' }
  | { t: 'syncNow' };

export type XOp = 'create' | 'destroy' | 'ids';
/** One X call. The content script picks the endpoint from `op`: create by user id when known, else by handle; destroy by user id; ids by cursor. */
export interface XCall { t: 'xcall'; op: XOp; handle: string | null; userId: string | null; cursor: string | null; bearer: string }
export interface XResult {
  status: number;
  id: string | null;
  code: number | null;
  ids: string[] | null;
  next: string | null;
  /** The handle of the account that X names in its answer, in lower case. Null when it names none, or one out of shape. */
  name: string | null;
}

export type BgMsg =
  | { t: 'settings'; settings: Settings }
  | { t: 'votes'; set: [string, 0 | 1][]; del: string[] }
  | { t: 'list'; from: number; version: number; add: ListRow[]; remove: string[] }
  | { t: 'listReload' }
  | { t: 'config' }
  | XCall;

const handleOk = (x: unknown): x is string => typeof x === 'string' && HANDLE_RE.test(x);
const nullable = <T>(x: unknown, ok: (y: unknown) => y is T): x is T | null => x === null || ok(x);

function parseVoteBody(o: Record<string, unknown>): VoteBody | null {
  const handle = normHandle(o.handle);
  if (!handle || (o.value !== 'slop' && o.value !== 'not_slop') || !isTweetId(o.tweetId)) return null;
  if (!nullable(o.parentTweetId, isTweetId) || !nullable(o.postedAt, isIso)) return null;
  if (o.context !== 'reply' && o.context !== 'post') return null;
  return { handle, value: o.value, tweetId: o.tweetId, parentTweetId: o.parentTweetId, postedAt: o.postedAt, context: o.context };
}

/** An observation has these three fields and no other (SPEC 13.8). */
function parseObservation(x: unknown): Observation | null {
  if (!isObj(x) || !onlyKeys(x, ['handle', 'tweetId', 'parentTweetId'])) return null;
  const { handle, tweetId, parentTweetId } = x;
  return handleOk(handle) && isTweetId(tweetId) && nullable(parentTweetId, isTweetId) ? { handle, tweetId, parentTweetId } : null;
}

export function parseContentMsg(x: unknown): ContentMsg | null {
  if (!isObj(x) || typeof x.t !== 'string') return null;
  switch (x.t) {
    case 'vote': {
      if (!onlyKeys(x, ['t', 'handle', 'value', 'tweetId', 'parentTweetId', 'postedAt', 'context'])) return null;
      const v = parseVoteBody(x);
      return v && { t: 'vote', ...v };
    }
    case 'unvote': {
      const handle = normHandle(x.handle);
      return handle && onlyKeys(x, ['t', 'handle']) ? { t: 'unvote', handle } : null;
    }
    case 'observe': {
      if (!onlyKeys(x, ['t', 'items']) || !Array.isArray(x.items) || x.items.length < 1 || x.items.length > OBS_MAX) return null;
      const items: Observation[] = [];
      for (const i of x.items) {
        const o = parseObservation(i);
        if (!o) return null;
        items.push(o);
      }
      return { t: 'observe', items };
    }
    case 'hidden': {
      const ids = x.ids;
      const ok = onlyKeys(x, ['t', 'ids']) && Array.isArray(ids) && ids.length >= 1 && ids.length <= HIDDEN_MAX && ids.every(isTweetId);
      return ok ? { t: 'hidden', ids: ids as string[] } : null;
    }
    case 'hello':
      return onlyKeys(x, ['t']) ? { t: 'hello' } : null;
    case 'muted': {
      const handle = normHandle(x.handle);
      const { id, status, code, via, op } = x;
      const ok = onlyKeys(x, ['t', 'handle', 'id', 'status', 'code', 'via', 'op']) && nullable(id, isXId) && isXStatus(status) && isXCode(code) &&
        (via === 'rest' || via === 'menu') && (op === 'create' || op === 'destroy');
      return handle && ok ? { t: 'muted', handle, id, status, code, via, op } : null;
    }
    case 'muteRecord': {
      const handle = normHandle(x.handle);
      return handle && onlyKeys(x, ['t', 'handle']) ? { t: 'muteRecord', handle } : null;
    }
  }
  return null;
}

function parseSettingsPatch(x: unknown): Partial<Settings> | null {
  if (!isObj(x) || !onlyKeys(x, ['strictness', 'display', 'share', 'mute', 'muteOnMark'])) return null;
  const p: Partial<Settings> = {};
  if ('strictness' in x) {
    if (x.strictness !== 'off' && x.strictness !== 'balanced' && x.strictness !== 'strict') return null;
    p.strictness = x.strictness;
  }
  if ('display' in x) {
    if (x.display !== 'collapse' && x.display !== 'remove') return null;
    p.display = x.display;
  }
  for (const k of ['share', 'mute', 'muteOnMark'] as const) {
    if (k in x) {
      if (typeof x[k] !== 'boolean') return null;
      p[k] = x[k];
    }
  }
  return p;
}

function parseVote(x: unknown): Vote | null {
  if (!isObj(x) || !onlyKeys(x, ['h', 'v', 'at', 'tweetId', 'parentTweetId', 'postedAt', 'context'])) return null;
  if (!handleOk(x.h) || (x.v !== 0 && x.v !== 1) || !isInt(x.at, 0, 8.64e15)) return null;
  const v = parseVoteBody({ ...x, handle: x.h, value: x.v === 1 ? 'slop' : 'not_slop' });
  return v && { h: v.handle, v: x.v, at: x.at, tweetId: v.tweetId, parentTweetId: v.parentTweetId, postedAt: v.postedAt, context: v.context };
}

export function parsePageMsg(x: unknown): PageMsg | null {
  if (!isObj(x) || typeof x.t !== 'string') return null;
  switch (x.t) {
    case 'settings': {
      const patch = onlyKeys(x, ['t', 'patch']) ? parseSettingsPatch(x.patch) : null;
      return patch && { t: 'settings', patch };
    }
    case 'unvote': {
      const handle = normHandle(x.handle);
      return handle && onlyKeys(x, ['t', 'handle']) ? { t: 'unvote', handle } : null;
    }
    case 'restore': {
      const vote = onlyKeys(x, ['t', 'vote']) ? parseVote(x.vote) : null;
      return vote && { t: 'restore', vote };
    }
    case 'muteUndoAll':
    case 'syncNow':
      return onlyKeys(x, ['t']) ? { t: x.t } : null;
  }
  return null;
}

export function parseBgMsg(x: unknown): BgMsg | null {
  if (!isObj(x) || typeof x.t !== 'string') return null;
  switch (x.t) {
    case 'settings': {
      const s = parseSettingsPatch(x.settings);
      return s && s.strictness && s.display && s.share !== undefined && s.mute !== undefined && s.muteOnMark !== undefined
        ? { t: 'settings', settings: s as Settings } : null;
    }
    case 'votes': {
      const { set, del } = x;
      if (!Array.isArray(set) || !Array.isArray(del) || set.length + del.length > VOTES_MAX) return null;
      for (const e of set) if (!Array.isArray(e) || e.length !== 2 || !handleOk(e[0]) || (e[1] !== 0 && e[1] !== 1)) return null;
      for (const h of del) if (!handleOk(h)) return null;
      return { t: 'votes', set: set as [string, 0 | 1][], del: del as string[] };
    }
    case 'list': {
      const d = parseDelta({ ...x, v: 1 });
      return d && { t: 'list', from: d.from, version: d.version, add: d.add, remove: d.remove };
    }
    case 'listReload':
    case 'config':
      return { t: x.t };
    case 'xcall': {
      const { op, handle, userId, cursor, bearer } = x;
      const ok = (op === 'create' || op === 'destroy' || op === 'ids') && nullable(handle, handleOk) && nullable(userId, isXId) &&
        nullable(cursor, (c): c is string => isStr(c, 30, 1) && /^-?[0-9]+$/.test(c as string)) &&
        typeof bearer === 'string' && BEARER_RE.test(bearer);
      return ok ? { t: 'xcall', op, handle, userId, cursor, bearer } : null;
    }
  }
  return null;
}
