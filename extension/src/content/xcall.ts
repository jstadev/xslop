// Calls to X's web API, made from the page in your own X session (SPEC 7.7, 12.3).
import { X_ORIGINS } from '../shared/hosts';
import { NOT_LOGGED_IN, type XCall, type XOp, type XResult } from '../shared/messages';
import { X_ID_RE, isInt, isObj } from '../shared/util';

/** The only X endpoints that xslop calls. The remote config cannot change them. */
const X_PATHS: Readonly<Record<XOp, string>> = {
  create: '/i/api/1.1/mutes/users/create.json',
  destroy: '/i/api/1.1/mutes/users/destroy.json',
  ids: '/i/api/1.1/mutes/users/ids.json',
};

const CALL_TIMEOUT_MS = 15_000;

/** Status 0 means X never answered. These codes and the ones in messages.ts say why. */
const BAD_ORIGIN = -2;
const NO_TARGET = -3;

const fail = (status: number, code: number | null = null): XResult => ({ status, id: null, code, ids: null, next: null, name: null });
/** A handle as X writes it: any letter case. Tested before the lower-casing, which maps some other characters to ASCII. */
const X_NAME_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * By user id when the call has one: an unmute always (the id that X returned for the mute), a mute when the list knows
 * the id. So a renamed handle cannot redirect either. Else a mute goes by handle.
 */
function formBody(m: XCall): string | null {
  if (m.userId) return new URLSearchParams({ user_id: m.userId }).toString();
  return m.op === 'create' && m.handle ? new URLSearchParams({ screen_name: m.handle }).toString() : null;
}

function readAnswer(status: number, j: unknown, op: XOp): XResult {
  const out = fail(status);
  if (!isObj(j)) return out;
  if (typeof j.id_str === 'string' && X_ID_RE.test(j.id_str)) out.id = j.id_str;
  if (typeof j.screen_name === 'string' && X_NAME_RE.test(j.screen_name)) out.name = j.screen_name.toLowerCase();
  const err = Array.isArray(j.errors) && isObj(j.errors[0]) ? j.errors[0].code : null;
  // Only a code in X's own range: the background refuses any other result as a whole, and then no stop rule runs.
  if (isInt(err, 0, 100_000)) out.code = err;
  // A page is read whole or not at all: a lost id would make a mute of yours look like one that xslop may undo.
  if (op === 'ids' && Array.isArray(j.ids) && j.ids.length <= 5000 && j.ids.every((s) => typeof s === 'string' && X_ID_RE.test(s))) {
    out.ids = j.ids as string[];
    const next = j.next_cursor_str;
    out.next = typeof next === 'string' && /^-?[0-9]{1,25}$/.test(next) ? next : null;
  }
  return out;
}

/** X's CSRF token from the ct0 cookie; null when the cookie is missing or does not decode. */
function csrfToken(): string | null {
  const raw = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function request(m: XCall, origin: string, csrf: string): Promise<XResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${m.bearer}`,
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
  };
  const url = `${origin}${X_PATHS[m.op]}`;
  const init: RequestInit = { method: 'GET', headers, credentials: 'include', redirect: 'error' };
  let target = url;
  if (m.op === 'ids') {
    target = `${url}?${new URLSearchParams({ count: '5000', stringify_ids: 'true', cursor: m.cursor ?? '-1' })}`;
  } else {
    const body = formBody(m);
    if (!body) return fail(0, NO_TARGET);
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.method = 'POST';
    init.body = body;
  }
  let res: Response;
  try {
    res = await fetch(target, init);
  } catch {
    return fail(0);
  }
  const j: unknown = await res.json().catch(() => null);
  return readAnswer(res.status, j, m.op);
}

/** Calls X from the current page. An undo waits for the mute before it, so a hung call counts as a network error. */
export async function xcall(m: XCall): Promise<XResult> {
  const origin = location.origin;
  if (!X_ORIGINS.includes(origin)) return fail(0, BAD_ORIGIN);
  const csrf = csrfToken();
  if (!csrf) return fail(0, NOT_LOGGED_IN);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<XResult>((resolve) => {
    timer = setTimeout(() => resolve(fail(0)), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request(m, origin, csrf), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
