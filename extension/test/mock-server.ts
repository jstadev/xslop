// Local stand-in for the xslop API routes that the extension calls (SPEC 5.1 to 5.5). It checks proof
// of work and request signatures the way the spec says the server does, and keeps state in memory.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

type Row = [string, number, number];
type Jwk = { kty: string; crv: string; x: string; y: string };

interface MockVote { value: 'slop' | 'not_slop'; body: Record<string, unknown>; at: number }
interface MockOptions {
  difficulty?: number;
  config?: unknown;
  list?: Row[];
  /** The X user id of listed handles (SPEC 13.8). */
  ids?: Record<string, string>;
}

const SECRET = randomBytes(32);
const HANDLE = /^[a-z0-9_]{1,15}$/;
const TWEET = /^[0-9]{1,20}$/;
const b64u = (b: Buffer): string => b.toString('base64url');

export const defaultConfig = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('../../server/config/extension-config.json', import.meta.url), 'utf8'));

/**
 * A page script that stands in for X's own tweet menu: a click on the caret opens a [role=menu] in
 * #layers, with X's items for that author. Escape closes it; a menu item closes it and records the click.
 * `window.__xMuted` holds the handles muted through the menu, so the item reads Mute or Unmute like on X.
 */
export const X_MENU_SCRIPT = `(() => {
  const w = window;
  w.__xMenuClicks = [];
  w.__xMuted = new Set();
  w.__xMenuItems = (h) => [
    'Follow @' + h,
    'Add or remove @' + h + ' from Lists',
    (w.__xMuted.has(h) ? 'Unmute @' : 'Mute @') + h,
    'Block @' + h,
    'Report post',
  ];
  document.addEventListener('click', (ev) => {
    const caret = ev.target.closest && ev.target.closest('[data-testid="caret"]');
    if (!caret) return;
    ev.stopPropagation();
    const article = caret.closest('article');
    const handle = article.querySelector('[data-testid="User-Name"] a[href^="/"]').getAttribute('href').slice(1);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-testid', 'Dropdown');
    menu.tabIndex = 0;
    for (const text of w.__xMenuItems(handle)) {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.tabIndex = 0;
      item.textContent = text;
      item.addEventListener('click', () => {
        w.__xMenuClicks.push(text);
        if (text.startsWith('Mute @')) w.__xMuted.add(handle);
        if (text.startsWith('Unmute @')) w.__xMuted.delete(handle);
        menu.remove();
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.remove(); });
    document.getElementById('layers').append(menu);
  });
})();`;

export class MockApi {
  url = '';
  difficulty: number;
  config: unknown;
  readonly installs = new Map<string, { jwk: Jwk; createdAt: string; ext: string }>();
  readonly votes = new Map<string, Map<string, MockVote>>();
  readonly deletes: { install: string; handle: string }[] = [];
  readonly observations: Record<string, unknown>[] = [];
  readonly rejected: { path: string; code: string }[] = [];
  readonly log: { method: string; path: string; status: number }[] = [];
  /** Answer the next N requests to a path prefix with this status. */
  readonly failures: { prefix: string; status: number; left: number; code?: string; retryAfter?: number }[] = [];
  /** False: answer like a server before SPEC 13, with no `ids` in the list and no `addIds` in a delta. */
  listIds = true;
  /** The fields that /me adds to its answer (SPEC 13.8). Null: an older server, which adds none. */
  me: Record<string, unknown> | null = { standing: false, goodMarks: 0, trusted: false };
  private readonly used = new Set<string>();
  private readonly nonces = new Map<string, number>();
  private readonly snapshots: { version: number; at: string; rows: Map<string, Row>; ids: Map<string, string> }[] = [];
  private server = createServer((req, res) => void this.handle(req, res));

  constructor(opts: MockOptions = {}) {
    this.difficulty = opts.difficulty ?? 12;
    this.config = opts.config ?? defaultConfig();
    this.publish(opts.list ?? [], opts.ids);
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** New list snapshot (the scoring job's output), with the X user id of the handles that have one. */
  publish(rows: Row[], ids: Record<string, string> = {}): number {
    const version = (this.snapshots.at(-1)?.version ?? 0) + 1;
    this.snapshots.push({ version, at: new Date().toISOString(), rows: new Map(rows.map((r) => [r[0], r])), ids: new Map(Object.entries(ids)) });
    return version;
  }

  get version(): number {
    return this.snapshots.at(-1)!.version;
  }

  votesFor(handle: string): MockVote[] {
    return [...this.votes.values()].flatMap((m) => (m.has(handle) ? [m.get(handle)!] : []));
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'cache-control': 'no-store', ...(data ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(data);
  }

  private error(res: ServerResponse, status: number, code: string, path: string): void {
    this.rejected.push({ path, code });
    this.send(res, status, { error: { code, message: code.replace(/_/g, ' ') } });
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 64 * 1024) throw new Error('too_large');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private challenge(purpose: string): { challenge: string; difficulty: number } {
    const payload = b64u(Buffer.from(JSON.stringify({ n: b64u(randomBytes(12)), exp: Math.floor(Date.now() / 1000) + 600, p: purpose })));
    return { challenge: `${payload}.${b64u(createHmac('sha256', SECRET).update(payload).digest())}`, difficulty: this.difficulty };
  }

  private checkPow(challenge: string, nonce: string, purpose: string): string | null {
    const [payload, mac] = challenge.split('.');
    if (!payload || !mac) return 'bad_challenge';
    const want = createHmac('sha256', SECRET).update(payload).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return 'bad_challenge';
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number; p: string };
    if (p.p !== purpose || p.exp < Date.now() / 1000) return 'challenge_expired';
    const key = createHash('sha256').update(challenge).digest('hex');
    if (this.used.has(key)) return 'challenge_used';
    if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 32) return 'bad_proof';
    const h = createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest();
    let bits = 0;
    for (const b of h) {
      if (b === 0) { bits += 8; continue; }
      bits += Math.clz32(b) - 24;
      break;
    }
    if (bits < this.difficulty) return 'bad_proof';
    this.used.add(key);
    return null;
  }

  /** SPEC 5.1 signed-request check. Returns the install id, or sends the error and returns null. */
  private checkSig(req: IncomingMessage, res: ServerResponse, raw: Buffer, path: string): string | null {
    const id = String(req.headers['x-xslop-install'] ?? '');
    const ts = String(req.headers['x-xslop-ts'] ?? '');
    const nonce = String(req.headers['x-xslop-nonce'] ?? '');
    const sig = String(req.headers['x-xslop-sig'] ?? '');
    const inst = this.installs.get(id);
    if (!inst) return this.error(res, 401, 'unknown_install', path), null;
    if (!/^[0-9]{1,16}$/.test(ts) || Math.abs(Number(ts) - Date.now()) > 300_000) return this.error(res, 401, 'bad_timestamp', path), null;
    if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) return this.error(res, 401, 'bad_nonce', path), null;
    const seen = `${id}:${nonce}`;
    if ((this.nonces.get(seen) ?? 0) > Date.now()) return this.error(res, 401, 'replayed_nonce', path), null;
    const data = Buffer.from(`XSLOP1\n${req.method}\n${req.url}\n${ts}\n${nonce}\n${b64u(createHash('sha256').update(raw).digest())}`, 'utf8');
    const sigBytes = Buffer.from(sig, 'base64url');
    let ok = false;
    try {
      ok = sigBytes.length === 64 && verify('sha256', data, { key: inst.jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, sigBytes);
    } catch {
      ok = false;
    }
    if (!ok) return this.error(res, 401, 'bad_signature', path), null;
    this.nonces.set(seen, Date.now() + 600_000);
    return id;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    res.on('finish', () => this.log.push({ method, path, status: res.statusCode }));
    let raw: Buffer;
    try {
      raw = await this.body(req);
    } catch {
      return this.error(res, 413, 'body_too_large', path);
    }
    const fail = this.failures.find((f) => f.left > 0 && path.startsWith(f.prefix));
    if (fail) {
      fail.left--;
      if (fail.retryAfter) res.setHeader('retry-after', String(fail.retryAfter));
      return this.error(res, fail.status, fail.code ?? (fail.status === 429 ? 'rate_limited' : 'injected'), path);
    }
    const json = (): Record<string, unknown> | null => {
      try {
        const j = JSON.parse(raw.toString('utf8'));
        return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
      } catch {
        return null;
      }
    };

    if (method === 'GET' && path === '/api/v1/challenge') {
      const purpose = url.searchParams.get('purpose') ?? 'install';
      if (purpose !== 'install' && purpose !== 'appeal') return this.error(res, 400, 'bad_purpose', path);
      return this.send(res, 200, this.challenge(purpose));
    }
    if (method === 'POST' && path === '/api/v1/installs') {
      const b = json();
      if (!b || Object.keys(b).some((k) => !['publicKey', 'challenge', 'nonce', 'extVersion'].includes(k))) return this.error(res, 400, 'bad_body', path);
      const k = b.publicKey as Record<string, unknown>;
      if (!k || Object.keys(k).sort().join() !== 'crv,kty,x,y' || k.kty !== 'EC' || k.crv !== 'P-256') return this.error(res, 400, 'bad_key', path);
      const pow = this.checkPow(String(b.challenge), b.nonce as string, 'install');
      if (pow) return this.error(res, 400, pow, path);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      this.installs.set(id, { jwk: k as Jwk, createdAt, ext: String(b.extVersion) });
      return this.send(res, 201, { installId: id, createdAt });
    }
    if (method === 'GET' && path === '/api/v1/config') return this.send(res, 200, this.config, { 'cache-control': 'public, max-age=600' });
    if (method === 'GET' && path === '/api/v1/list') {
      const s = this.snapshots.at(-1)!;
      const etag = `"${s.version}"`;
      if (req.headers['if-none-match'] === etag) return this.send(res, 304, undefined, { etag });
      const accounts = [...s.rows.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const ids = this.listIds ? { ids: accounts.map((r) => s.ids.get(r[0]) ?? null) } : {};
      return this.send(res, 200, { v: 1, version: s.version, generatedAt: s.at, accounts, ...ids }, { etag, 'cache-control': 'public, max-age=60' });
    }
    if (method === 'GET' && path === '/api/v1/list/delta') {
      const since = Number(url.searchParams.get('since'));
      const newest = this.snapshots.at(-1)!;
      if (since === newest.version) return this.send(res, 304);
      const old = this.snapshots.find((s) => s.version === since);
      if (!old) return this.error(res, 410, 'delta_gone', path);
      // An id change counts as a change of the entry (SPEC 13.8).
      const add = [...newest.rows.values()].filter((r) => old.rows.get(r[0])?.join() !== r.join() || old.ids.get(r[0]) !== newest.ids.get(r[0]));
      const remove = [...old.rows.keys()].filter((h) => !newest.rows.has(h));
      const addIds = this.listIds ? { addIds: add.map((r) => newest.ids.get(r[0]) ?? null) } : {};
      return this.send(res, 200, { v: 1, from: since, version: newest.version, add, ...addIds, remove });
    }

    const signed = (path === '/api/v1/votes' && method === 'POST') || (path.startsWith('/api/v1/votes/') && method === 'DELETE') ||
      (path === '/api/v1/observations' && method === 'POST') || (path === '/api/v1/me' && method === 'GET');
    if (!signed) return this.error(res, 404, 'not_found', path);
    const install = this.checkSig(req, res, raw, path);
    if (!install) return;
    const mine = this.votes.get(install) ?? new Map<string, MockVote>();
    this.votes.set(install, mine);

    if (path === '/api/v1/votes') {
      const b = json();
      const keys = ['handle', 'value', 'tweetId', 'parentTweetId', 'postedAt', 'context'];
      if (!b || Object.keys(b).some((k) => !keys.includes(k))) return this.error(res, 400, 'bad_body', path);
      const ok = typeof b.handle === 'string' && HANDLE.test(b.handle) && (b.value === 'slop' || b.value === 'not_slop') &&
        typeof b.tweetId === 'string' && TWEET.test(b.tweetId) && (b.parentTweetId === null || (typeof b.parentTweetId === 'string' && TWEET.test(b.parentTweetId))) &&
        (b.context === 'reply' || b.context === 'post');
      if (!ok) return this.error(res, 400, 'bad_vote', path);
      mine.set(b.handle as string, { value: b.value as MockVote['value'], body: b, at: Date.now() });
      return this.send(res, 200, { handle: b.handle, value: b.value, account: { status: 'none', tier: 0 } });
    }
    if (path.startsWith('/api/v1/votes/')) {
      const h = decodeURIComponent(path.slice('/api/v1/votes/'.length));
      if (!HANDLE.test(h)) return this.error(res, 400, 'bad_handle', path);
      mine.delete(h);
      this.deletes.push({ install, handle: h });
      return this.send(res, 204);
    }
    if (path === '/api/v1/observations') {
      const b = json();
      const items = b?.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 100 || Object.keys(b!).length !== 1) return this.error(res, 400, 'bad_body', path);
      // SPEC 13.8: an item is {handle, tweetId, parentTweetId}. The mock takes these three fields and no other, to prove that the extension sends no more.
      for (const i of items) {
        const ok = i && typeof i === 'object' && Object.keys(i).sort().join() === 'handle,parentTweetId,tweetId' && HANDLE.test(i.handle) &&
          TWEET.test(i.tweetId) && (i.parentTweetId === null || TWEET.test(i.parentTweetId));
        if (!ok) return this.error(res, 400, 'bad_item', path);
      }
      this.observations.push(...items);
      return this.send(res, 202, { accepted: items.length });
    }
    const inst = this.installs.get(install)!;
    return this.send(res, 200, {
      installId: install, createdAt: inst.createdAt, reputation: 0.5,
      votes: [...mine.entries()].map(([handle, v]) => ({ handle, value: v.value, at: new Date(v.at).toISOString() })),
      ...this.me,
    });
  }
}
