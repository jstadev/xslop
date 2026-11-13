// Input checks and small helpers shared by every context.

export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
const TWEET_ID_RE = /^[0-9]{1,20}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The x.com web bearer: base64url characters and percent escapes, 100 to 200 long. */
export const BEARER_RE = /^[A-Za-z0-9_%-]{100,200}$/;
/** A numeric X user id. */
export const X_ID_RE = /^[0-9]{1,25}$/;

/** SPEC 5: trim, drop one leading "@", lower-case, then ^[a-z0-9_]{1,15}$. */
export function normHandle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let h = input.trim();
  if (h.startsWith('@')) h = h.slice(1);
  h = h.toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** True when every own key of `o` is in `keys`. */
export function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return false;
  return true;
}

export const isStr = (x: unknown, max: number, min = 0): x is string =>
  typeof x === 'string' && x.length >= min && x.length <= max;

export const isInt = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

export const isNum = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;

export const isTweetId = (x: unknown): x is string => typeof x === 'string' && TWEET_ID_RE.test(x);

export const isXId = (x: unknown): x is string => typeof x === 'string' && X_ID_RE.test(x);

/** The HTTP status of an X call; 0 when no response came back. */
export const isXStatus = (x: unknown): x is number => isInt(x, 0, 999);

/** The X error code of a call, or a negative local reason (for example -1: not logged in). Null when there is none. */
export const isXCode = (x: unknown): x is number | null => x === null || isInt(x, -10, 100_000);

/** An ISO 8601 date-time that Date can read. */
export const isIso = (x: unknown): x is string =>
  typeof x === 'string' && x.length >= 10 && x.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x));

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Local calendar day, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Compare dotted numeric versions: negative when a < b. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
