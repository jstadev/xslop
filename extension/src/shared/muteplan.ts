// Mute rules, pure: what the paced sync calls next, when, and what each X result means (SPEC 7.7, 12.3). No I/O.
import type { MuteConfig } from './config';
import { NOT_LOGGED_IN, type MuteResult, type XResult } from './messages';
import { idMap } from './list';
import { EMPTY_MUTE, type MuteRecord, type MuteState, type Settings, type StoredList, type Vote } from './types';
import { HANDLE_RE, isStr, isXCode, isXId, isXStatus, localDay } from './util';

export const DAY_MS = 86_400_000;
/** The time an instant mute or unmute gets to report its result before the paced sync takes over. */
export const INSTANT_GRACE_MS = 60_000;
/** The wait before the paced sync tries a mute that X refused on the instant path. */
export const INSTANT_RETRY_MS = 15 * 60_000;
/** xslop reads your own mutes from X at most this often. */
export const OWN_SNAPSHOT_MS = 6 * 3_600_000;
/** A runaway guard for the retry queue and the wrong ids: stale entries cannot pile up. */
const RETRY_MAX = 2000;
/** X's code on 403 for "you can't mute yourself". */
export const X_SELF_CODE = 271;
/** X's codes on 403 or 404 that concern this one account and say nothing about your session: 50 no such user, 63 suspended, 271 it is you, 272 you do not mute it. */
const ACCOUNT_CODES = [50, 63, X_SELF_CODE, 272];
const accountCode = (code: number | null): boolean => code !== null && ACCOUNT_CODES.includes(code);

/**
 * A create goes by the X user id that the list carries for the handle, else by handle (SPEC 13.6). A destroy goes by
 * the X user id in xslop's record (null in records from before ids).
 */
export interface Plan { op: 'create' | 'destroy'; handle: string; id: string | null }

export const isOk = (status: number): boolean => status >= 200 && status < 300;
export const isAccountAnswer = (status: number, code: number | null): boolean => status === 403 && accountCode(code);
const refusal = (status: number, code: number | null): 'missing' | 'rejected' => ((status === 404 || status === 403) && code !== X_SELF_CODE ? 'missing' : 'rejected');
const notHandle = (handle: string) => (e: [string, unknown]): boolean => e[0] !== handle;

/** Stored mute state with only the known fields (older versions stored more). */
export function cleanMute(x: Partial<MuteState> | undefined): MuteState {
  const all: Record<string, unknown> = { ...EMPTY_MUTE, ...x };
  return Object.fromEntries(Object.keys(EMPTY_MUTE).map((k) => [k, all[k]])) as unknown as MuteState;
}

/** True when both states hold the same values; arrays that did not change keep their identity. */
export const sameMute = (a: MuteState, b: MuteState): boolean =>
  (Object.keys(EMPTY_MUTE) as (keyof MuteState)[]).every((k) => a[k] === b[k]);

/** Accounts that xslop wants muted, in order: your slop votes (newest first), then global tier 2 by score. */
export function targets(settings: Settings, votes: readonly Vote[], list: StoredList | null): { order: string[]; allow: Set<string> } {
  const allow = new Set<string>();
  const personal: Vote[] = [];
  for (const v of votes) (v.v === 0 ? allow.add(v.h) : personal.push(v));
  personal.sort((a, b) => b.at - a.at);
  const order = personal.map((v) => v.h);
  if (list && settings.strictness !== 'off') {
    const seen = new Set(order);
    const global = list.accounts.filter((r) => r[2] === 2 && !seen.has(r[0]) && !allow.has(r[0]));
    global.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const r of global) order.push(r[0]);
  }
  return { order, allow };
}

function destroyDue(r: MuteRecord, h: string, st: MuteState, settings: Settings, want: Set<string>, allow: Set<string>, now: number): boolean {
  if (st.undoAll || allow.has(h)) return true;
  if (r.undoAt === undefined) return !want.has(h);
  // You took back the mark: an instant unmute gets its time first, then only bulk sync can keep the mute.
  return now - r.undoAt >= INSTANT_GRACE_MS && !(settings.mute && want.has(h));
}

/**
 * The next call of the paced sync: undo mutes that are no longer wanted first, then new mutes. A new mute
 * needs bulk sync on (`settings.mute`) or an instant mute that is due in the retry queue.
 */
export function nextOp(st: MuteState, settings: Settings, votes: readonly Vote[], list: StoredList | null, now: number): Plan | null {
  const { order, allow } = targets(settings, votes, list);
  const want = new Set(order);
  for (const [h, r] of st.muted) if (destroyDue(r, h, st, settings, want, allow, now)) return { op: 'destroy', handle: h, id: r.id };
  if (st.undoAll) return null;
  const muted = new Set(st.muted.map((e) => e[0]));
  const mutedIds = new Set(st.muted.map((e) => e[1].id));
  const skipped = new Set(st.skipped.map((e) => e[0]));
  const queued = new Map(st.retry);
  const wrong = new Map(st.wrongIds);
  const ids = idMap(list);
  for (const h of order) {
    const id = ids.get(h) ?? null;
    // An id that xslop muted under another handle is muted already; one record per account.
    if (muted.has(h) || skipped.has(h) || (id !== null && (mutedIds.has(id) || wrong.get(h) === id))) continue;
    const due = queued.get(h);
    if (due === undefined ? settings.mute : due <= now) return { op: 'create', handle: h, id };
  }
  return null;
}

/**
 * A rename does not undo a mute (SPEC 13.6): a record whose handle xslop no longer wants moves to the wanted handle
 * that the list now gives its X id, when that handle has no record. No X call. A mark that you took back still undoes.
 */
export function followRenames(st: MuteState, settings: Settings, votes: readonly Vote[], list: StoredList | null): MuteState {
  if (st.undoAll || !list?.ids) return st;
  const byId = new Map<string, string>();
  for (const [h, id] of idMap(list)) byId.set(id, h);
  const renamed = ([h, r]: [string, MuteRecord]): string | null => {
    const to = r.id === null || r.undoAt !== undefined ? undefined : byId.get(r.id);
    return to !== undefined && to !== h ? to : null;
  };
  // The common case has no rename: skip the sort of the whole list.
  if (!st.muted.some(renamed)) return st;
  const { order, allow } = targets(settings, votes, list);
  const want = new Set(order);
  const have = new Map(st.muted);
  let changed = false;
  const muted: [string, MuteRecord][] = [];
  for (const e of st.muted) {
    const to = renamed(e);
    const there = to === null ? undefined : have.get(to);
    if (to === null || want.has(e[0]) || allow.has(e[0]) || !want.has(to) || (there && there.id !== e[1].id)) {
      muted.push(e);
      continue;
    }
    changed = true;
    // A record of the new handle with the same id holds this mute already (you marked the account under its new name).
    if (!there) {
      have.set(to, e[1]);
      muted.push([to, e[1]]);
    }
  }
  return changed ? { ...st, muted } : st;
}

/** The next time that waiting work comes due after `now`, or null when nothing waits. */
export function nextDue(st: MuteState, now: number): number | null {
  let at: number | null = null;
  const consider = (t: number): void => {
    if (t > now && (at === null || t < at)) at = t;
  };
  for (const [, due] of st.retry) consider(due);
  for (const [, r] of st.muted) if (r.undoAt !== undefined) consider(r.undoAt + INSTANT_GRACE_MS);
  return at;
}

function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Reset the daily counter when the local day changed. */
export function rollDay(st: MuteState, now: number): MuteState {
  const day = localDay(now);
  return st.day === day ? st : { ...st, day, count: 0 };
}

/**
 * Earliest time the next call may run: pacing and pause for every call, the daily cap for a mute only.
 * An unmute repairs a listing that ended or a mark that you took back, so it never waits for the next day.
 */
export function earliest(st: MuteState, cfg: MuteConfig, now: number, op: Plan['op']): number {
  let at = Math.max(st.nextAt, st.pausedUntil);
  if (op === 'create' && st.day === localDay(now) && st.count >= cfg.maxPerDay) at = Math.max(at, nextLocalMidnight(now));
  return at;
}

/** Gap after a call: at least minIntervalSec, plus up to `jitter` of it at random. */
export const gapMs = (cfg: MuteConfig, rand: number): number => Math.round(cfg.minIntervalSec * 1000 * (1 + cfg.jitter * rand));

const pause = (st: MuteState, now: number, reason: string): MuteState =>
  ({ ...st, pausedUntil: now + DAY_MS, reason, fails: 0, nextAt: now + DAY_MS, waiting: null });

/** Rules shared by every X call: no tab, no login, stop rules (SPEC 7.7). Null when the call reached X and X answered. */
function stopRules(st: MuteState, r: XResult | null, cfg: MuteConfig, now: number, rand: number): MuteState | null {
  const next = now + gapMs(cfg, rand);
  if (!r) return { ...st, waiting: 'tab', nextAt: next };
  if (r.status === 0 && r.code === NOT_LOGGED_IN) return { ...st, waiting: 'login', nextAt: next };
  // A 404 or a 403 that names no account is X refusing the REST call itself (SPEC 12.3), not an answer about this account.
  if (r.status === 401 || r.status === 429 || ((r.status === 403 || r.status === 404) && !accountCode(r.code))) {
    return pause(st, now, `X answered ${r.status}${r.status === 429 ? ' (too many requests)' : ''}. Mute sync pauses for 24 hours.`);
  }
  if (r.status === 0 || r.status >= 500) {
    const fails = st.fails + 1;
    if (fails >= 3) return pause(st, now, 'X failed three times in a row. Mute sync pauses for 24 hours.');
    return { ...st, waiting: null, fails, nextAt: next };
  }
  return null;
}

/** A record without a user id cannot be undone safely (the handle may belong to someone else now): drop it, no X call. */
export function dropNoId(st: MuteState, handle: string): MuteState {
  return { ...st, muted: st.muted.filter((e) => e[0] !== handle), lost: st.lost + 1 };
}

/** The read of your own mutes reached its page cap: xslop cannot check them all, so mute sync stops. */
export const capStop = (st: MuteState): MuteState => ({
  ...st, waiting: null,
  reason: 'You mute too many accounts on X for xslop to check them all, so mute sync is off.',
});

/**
 * Apply the result of one create/destroy call of the paced sync to the state. `own` holds the user ids
 * that you muted yourself, read right before a create: xslop never records one of them. Only a mute
 * counts toward the daily cap.
 */
export function applyResult(
  st: MuteState, plan: Plan, r: XResult | null, cfg: MuteConfig, now: number, rand: number, own: ReadonlySet<string> = new Set(),
): MuteState {
  const stop = stopRules(st, r, cfg, now, rand);
  if (stop || !r) return stop ?? st;
  const muted = new Map(st.muted);
  const skipped = new Map(st.skipped);
  let yours = st.own;
  if (isOk(r.status)) {
    if (plan.op === 'destroy') muted.delete(plan.handle);
    else if (r.id && own.has(r.id)) skipped.set(plan.handle, 'own');
    else {
      muted.set(plan.handle, { at: now, id: r.id });
      yours = st.own.filter((id) => id !== r.id);
    }
  } else if (plan.op === 'destroy') {
    // X has no such account, refuses the unmute, or you unmuted it yourself: drop it from the record.
    muted.delete(plan.handle);
  } else {
    skipped.set(plan.handle, refusal(r.status, r.code));
  }
  return {
    ...st, muted: [...muted], skipped: [...skipped], own: yours, retry: st.retry.filter(notHandle(plan.handle)),
    count: st.count + (plan.op === 'create' ? 1 : 0), fails: 0, reason: null, waiting: null, nextAt: now + gapMs(cfg, rand),
  };
}

/** A mute by user id that X answered with an account on your allow list (SPEC 13.10 item 9). */
export interface WrongId {
  /** [handle, id] of the list. */
  pair: [string, string];
  /** The unmute to make at once: by the id that X returned, under the handle that X named. */
  undo: Plan;
}

/**
 * The list gave a handle the id of an account that you marked not slop: X answered the mute by that id with the
 * account. Null for any other answer, and for an account that you muted yourself before (that mute stays yours).
 */
export function wrongIdOf(plan: Plan, r: XResult | null, votes: readonly Vote[], own: ReadonlySet<string>): WrongId | null {
  if (plan.op !== 'create' || plan.id === null || !r || !isOk(r.status) || !r.id || !r.name || own.has(r.id)) return null;
  const name = r.name;
  if (!votes.some((v) => v.v === 0 && v.h === name)) return null;
  return { pair: [plan.handle, plan.id], undo: { op: 'destroy', handle: name, id: r.id } };
}

/**
 * The state after `applyResult` for a wrong id: the record of the mute moves to the handle that X named, where the
 * unmute removes it (or, when that call fails, the paced sync unmutes it as an account on your allow list), and the
 * pair of the list is noted, so that xslop does not mute by that id again while the list gives it to that handle.
 */
export function noteWrongId(st: MuteState, w: WrongId): MuteState {
  const [handle] = w.pair;
  const muted = new Map(st.muted);
  const rec = muted.get(handle);
  muted.delete(handle);
  if (rec) muted.set(w.undo.handle, rec);
  return { ...st, muted: [...muted], wrongIds: [...st.wrongIds.filter(notHandle(handle)), w.pair].slice(-RETRY_MAX) };
}

/** A failed read of your own mutes: same stop rules; any other answer pauses, because the path may be stale. */
export function applyReadFailure(st: MuteState, r: XResult | null, cfg: MuteConfig, now: number, rand: number): MuteState {
  return stopRules(st, r, cfg, now, rand) ??
    pause(st, now, 'xslop could not read the accounts that you muted yourself. Mute sync pauses for 24 hours.');
}

/** Whether an X result means that the X login of that tab is gone. */
export const loginGone = (status: number, code: number | null): boolean => status === 401 || (status === 0 && code === NOT_LOGGED_IN);

/** Store your own mutes as X returned them, without the accounts that xslop muted itself. */
export function applyOwnSnapshot(st: MuteState, ids: ReadonlySet<string>, now: number): MuteState {
  const made = new Set(st.muted.flatMap((e) => (e[1].id ? [e[1].id] : [])));
  return { ...st, own: [...ids].filter((id) => !made.has(id)), ownAt: now, waiting: st.waiting === 'login' ? null : st.waiting };
}

/** The read of your own mutes failed. X answered, so it counts as the read of this period, or you are logged out. */
export function applyOwnFailure(st: MuteState, status: number, code: number | null, now: number): MuteState {
  if (loginGone(status, code)) return { ...st, waiting: 'login', ownAt: status === 401 ? now : st.ownAt };
  return status === 0 ? st : { ...st, ownAt: now };
}

/**
 * A result of the content script's instant call. It never touches the paced limits (`count`, `nextAt`,
 * `pausedUntil`, `fails`). Refused: the handle waits for a later paced retry.
 */
export function applyInstant(st: MuteState, m: MuteResult, now: number): MuteState {
  const waiting = loginGone(m.status, m.code) ? 'login' as const : m.status !== 0 && st.waiting === 'login' ? null : st.waiting;
  const muted = new Map(st.muted);
  if (m.op === 'destroy') {
    if (isOk(m.status) || isAccountAnswer(m.status, m.code)) muted.delete(m.handle);
    return { ...st, muted: [...muted], waiting };
  }
  const retry = st.retry.filter(notHandle(m.handle));
  const skipped = new Map(st.skipped);
  if (isOk(m.status)) {
    skipped.delete(m.handle);
    if (m.id && st.own.includes(m.id)) {
      skipped.set(m.handle, 'own');
      muted.delete(m.handle);
    } else muted.set(m.handle, { at: now, id: m.id ?? muted.get(m.handle)?.id ?? null });
    return { ...st, muted: [...muted], skipped: [...skipped], retry, waiting };
  }
  if (isAccountAnswer(m.status, m.code)) {
    skipped.set(m.handle, refusal(m.status, m.code));
    return { ...st, skipped: [...skipped], retry, waiting };
  }
  return { ...st, retry: withRetry(retry, m.handle, now + INSTANT_RETRY_MS), waiting };
}

function withRetry(retry: [string, number][], handle: string, due: number): [string, number][] {
  const next = [...retry, [handle, due] as [string, number]];
  return next.length > RETRY_MAX ? next.slice(next.length - RETRY_MAX) : next;
}

/**
 * You marked an account: a mute you took back before stands again. With `queue` (instant mute on), the
 * instant call gets its time first; if no result comes, the paced sync mutes the account later.
 */
export function expectInstant(st: MuteState, handle: string, now: number, queue: boolean): MuteState {
  const muted = st.muted.map((e): [string, MuteRecord] => (e[0] === handle ? [handle, { at: e[1].at, id: e[1].id }] : e));
  const known = st.muted.some((e) => e[0] === handle) || st.skipped.some((e) => e[0] === handle) || st.retry.some((e) => e[0] === handle);
  return !queue || known ? { ...st, muted } : { ...st, muted, retry: withRetry(st.retry, handle, now + INSTANT_GRACE_MS) };
}

/** You took back a mark or allowed the account: forget the pending mute and, with `stamp`, undo the recorded one. */
export function takeBack(st: MuteState, handle: string, now: number, stamp: boolean): MuteState {
  const retry = st.retry.filter(notHandle(handle));
  if (!stamp) return { ...st, retry };
  return { ...st, retry, muted: st.muted.map((e): [string, MuteRecord] => (e[0] === handle ? [handle, { ...e[1], undoAt: now }] : e)) };
}

/** The user id to unmute for a handle, or null when xslop has no record with an id (your own mutes stay yours). */
export const recordedId = (st: MuteState, handle: string): string | null =>
  st.muted.find((e) => e[0] === handle)?.[1].id ?? null;

/** True when an account with no recorded id stays muted on X after an undo: xslop's mute has no id, or the mute is yours. */
export const muteStays = (st: MuteState, handle: string): boolean =>
  st.muted.some((e) => e[0] === handle) || st.skipped.some((e) => e[0] === handle && e[1] === 'own');

export function parseXResult(x: unknown): XResult | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const ok = isXStatus(r.status) && (r.id === null || isXId(r.id)) && isXCode(r.code) &&
    (r.ids === null || (Array.isArray(r.ids) && r.ids.length <= 5000 && r.ids.every(isXId))) &&
    (r.next === null || (isStr(r.next, 30, 1) && /^-?[0-9]+$/.test(r.next as string))) &&
    (r.name === null || (typeof r.name === 'string' && HANDLE_RE.test(r.name)));
  return ok ? (r as unknown as XResult) : null;
}
