// Client identity (SPEC 7.2) and HTTP access to the xslop API (SPEC 5.1).
import { API_BASE, VERSION, ext } from '../shared/ext';
import { UUID_RE, isInt, isIso, isObj, isStr } from '../shared/util';
import type { Identity } from '../shared/types';
import { POW_MAX, signRequest, solvePow } from './crypto';
import { idbGet, idbSet } from './idb';
import { save, state } from './store';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterSec: number | null = null) {
    super(`${status} ${code}`);
  }
}

interface KeyRecord {
  privateKey: CryptoKey;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

const KEY_ID = 'device';
let keyRec: Promise<KeyRecord> | null = null;
/** Server clock minus local clock, from the Date header, applied only when it is over 30 s. */
let skewMs = 0;

async function makeKey(): Promise<KeyRecord> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('key export failed');
  const rec: KeyRecord = { privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
  await idbSet(KEY_ID, rec);
  return rec;
}

/** Keep the key promise; a failed one is forgotten, so a later call can try again. */
function remember(key: Promise<KeyRecord>): Promise<KeyRecord> {
  keyRec = key.catch((e: unknown) => {
    keyRec = null;
    throw e;
  });
  return keyRec;
}

const deviceKey = (): Promise<KeyRecord> =>
  keyRec ?? remember(idbGet<KeyRecord>(KEY_ID).then((k) => (k?.privateKey instanceof CryptoKey && k.publicJwk ? k : makeKey())));

function noteDate(res: Response): void {
  const d = Date.parse(res.headers.get('date') ?? '');
  if (!Number.isFinite(d)) return;
  const off = d - Date.now();
  skewMs = Math.abs(off) > 30_000 ? off : 0;
}

const now = (): number => Date.now() + skewMs;

/** The JSON of an answer of at most `max` bytes. A longer answer is refused while it arrives, before it fills the memory. */
export async function readJson(res: Response, max = 65_536): Promise<unknown> {
  const reader = res.body?.getReader();
  const text = new TextDecoder();
  let json = '';
  let size = 0;
  for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
    size += part.value.length;
    if (size > max) {
      await reader!.cancel();
      throw new Error('answer_too_large');
    }
    json += text.decode(part.value, { stream: true });
  }
  return JSON.parse(json + text.decode());
}

async function errorOf(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const j: unknown = await readJson(res);
    if (isObj(j) && isObj(j.error) && isStr(j.error.code, 64, 1) && /^[a-z0-9_]+$/.test(j.error.code)) code = j.error.code;
  } catch {
    // Body is not JSON; keep the status code.
  }
  const ra = Number(res.headers.get('retry-after'));
  return new ApiError(res.status, code, Number.isFinite(ra) && ra > 0 ? ra : null);
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(API_BASE + path, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  noteDate(res);
  return res;
}

/** Unsigned GET for public routes. Returns the response for 200 and 304; throws ApiError otherwise. */
export async function publicGet(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await call(path, { method: 'GET', headers });
  if (res.status !== 200 && res.status !== 304 && res.status !== 410) throw await errorOf(res);
  return res;
}

let installing: Promise<Identity> | null = null;
/** Challenges to try per registration. After that only the list alarm (every 10 minutes) tries again. */
const POW_ROUNDS = 2;
const POW_PAUSE_MS = 10 * 60_000;
let powRetryAt = 0;

/** Register this install once: key pair, proof of work (purpose=install), POST /api/v1/installs. */
export function ensureInstall(): Promise<Identity> {
  installing ??= (async () => {
    const s = await state();
    if (s.identity) return s.identity;
    // Not an ApiError: the outbox keeps your votes and retries, it does not drop them.
    if (Date.now() < powRetryAt) throw new Error('pow_timeout');
    const key = await deviceKey();
    for (let round = 0; round < POW_ROUNDS; round++) {
      const chRes = await publicGet('/api/v1/challenge?purpose=install');
      const ch: unknown = await readJson(chRes);
      if (!isObj(ch) || !isStr(ch.challenge, 2000, 10) || !isInt(ch.difficulty, 0, POW_MAX)) throw new Error('bad_challenge');
      const started = Date.now();
      let lastPing = started;
      const nonce = await solvePow(ch.challenge, ch.difficulty, {
        tick: async () => {
          const t = Date.now();
          // Any extension API call resets the service worker idle timer while the work runs.
          if (t - lastPing > 5000) {
            lastPing = t;
            await ext.runtime.getPlatformInfo();
          }
          return t - started < 9 * 60_000; // the challenge lives 10 minutes
        },
      });
      if (!nonce) continue;
      const body = JSON.stringify({ publicKey: key.publicJwk, challenge: ch.challenge, nonce, extVersion: VERSION });
      const res = await call('/api/v1/installs', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.status !== 201) throw await errorOf(res);
      const j: unknown = await readJson(res);
      if (!isObj(j) || typeof j.installId !== 'string' || !UUID_RE.test(j.installId) || !isIso(j.createdAt)) throw new ApiError(201, 'bad_install');
      const identity: Identity = { installId: j.installId.toLowerCase(), createdAt: j.createdAt };
      await save('identity', identity);
      await save('status', { ...s.status, installError: null, banned: false });
      return identity;
    }
    powRetryAt = Date.now() + POW_PAUSE_MS;
    throw new Error('pow_timeout');
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/** Forget the install (and, with newKey, the key pair); the next signed call registers again. */
export async function resetInstall(newKey: boolean): Promise<void> {
  if (newKey) await remember(makeKey());
  await save('identity', null);
}

/** Signed request (SPEC 5.1). Returns the response for 2xx and 304; throws ApiError otherwise. */
export async function signedFetch(method: 'GET' | 'POST' | 'DELETE', pathWithQuery: string, body?: unknown): Promise<Response> {
  const id = await ensureInstall();
  const key = await deviceKey();
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { ...(await signRequest(key.privateKey, id.installId, method, pathWithQuery, raw, now())) };
  if (raw) headers['content-type'] = 'application/json';
  const res = await call(pathWithQuery, { method, headers, body: raw || undefined });
  if (res.status >= 300 && res.status !== 304) throw await errorOf(res);
  return res;
}
