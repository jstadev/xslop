// Session state of the console and the admin request helper: x-csrf on writes, one live request per view, and a return
// to the login form on 401 (logout, 30 idle minutes, 12 hours).

import { ApiError, request, type RequestOptions } from '../lib/api.ts';
import { readRules, type Rules } from './model.ts';
import { isRow, type Row } from './rows.ts';

export const session = {
  csrf: '',
  user: '',
  /** The newest answer of GET /api/admin/overview: the counts of the menu and the rule numbers of every sentence. */
  overview: null as Row | null,
  rules: null as Rules | null,
};

export class SessionEnded extends Error {}

let ended: (message: string) => void = () => undefined;
export function onSessionEnd(fn: (message: string) => void): void {
  ended = fn;
}

const live = new Map<string, AbortController>();

/** A signal for the request group `key`. A newer group of the same key aborts the older one. */
export function latest(key: string): AbortSignal {
  live.get(key)?.abort();
  const controller = new AbortController();
  live.set(key, controller);
  return controller.signal;
}

export function abortAll(): void {
  for (const controller of live.values()) controller.abort();
  live.clear();
}

export async function api(path: string, opts: RequestOptions = {}): Promise<unknown> {
  const write = opts.method !== undefined && opts.method !== 'GET';
  try {
    return await request(path, write ? { ...opts, headers: { ...opts.headers, 'x-csrf': session.csrf } } : opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.endsWith('/login')) {
      ended('Your session ended. Log in again.');
      throw new SessionEnded();
    }
    throw err;
  }
}

let overviewAt = 0;
let pending: { signal: AbortSignal; promise: Promise<Row> } | null = null;
let listener: () => void = () => undefined;

/** `fn` runs after each overview that arrived: the menu counts follow it. */
export function onOverview(fn: () => void): void {
  listener = fn;
}

/** Reads the overview and keeps it for the menu counts and the rule numbers. */
export function loadOverview(signal: AbortSignal): Promise<Row> {
  const promise = api('/api/admin/overview', { signal }).then((body) => {
    const fresh = isRow(body) ? body : {};
    session.overview = fresh;
    session.rules = readRules(fresh.rules);
    overviewAt = Date.now();
    listener();
    return fresh;
  });
  pending = { signal, promise };
  void promise.catch(() => undefined).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  return promise;
}

/** The overview of this request group: the one in flight, else the kept one, else a fresh one. */
export function overview(signal: AbortSignal): Promise<Row> {
  if (pending && pending.signal === signal) return pending.promise;
  return session.overview ? Promise.resolve(session.overview) : loadOverview(signal);
}

/** Milliseconds since the kept overview arrived; a write sets it back so the next view reads the counts again. */
export const overviewAge = (): number => Date.now() - overviewAt;
export function staleOverview(): void {
  overviewAt = 0;
}

export function clearSession(): void {
  abortAll();
  pending = null;
  overviewAt = 0;
  session.csrf = '';
  session.user = '';
  session.overview = null;
  session.rules = null;
}
