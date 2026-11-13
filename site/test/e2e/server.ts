// Test server: serves site/dist with the SPEC 5.7 headers and a mocked xslop API.
// The proof of work and the admin CSRF/Origin rules are checked for real, so the client is tested end to end.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export interface Scenario {
  stats: 'ok' | 'down' | 'limited';
  latest: 'ok' | 'store' | 'down';
  sloppers: 'ok' | 'empty' | 'down' | 'limited';
  criteria: 'ok' | 'down';
  powBits: number;
  adminUser: string;
  adminPassword: string;
  /** The current RFC 6238 code when the login has a second factor, null when it has none. */
  adminCode: string | null;
}

interface MockAccount {
  handle: string;
  status: 'none' | 'pending' | 'flagged' | 'confirmed' | 'cleared';
  tier: 0 | 1 | 2;
  score: number;
  seed: boolean;
  votes: { slop: number; notSlop: number };
  sightings: number;
  signals: { fastReplyShare: number; replies: number } | null;
  /** `text` is only in an answer of the API before round 2. The page must ignore it. */
  evidence: { text?: string; tweetId: string; at: string }[];
  appealOpen: boolean;
  override: 'confirm' | 'clear' | null;
  protected: boolean;
  /** `parts.networks` of the engine: the slop voices that count. */
  networks: number;
  /** Networks of the slop voters that are not banned: the exact count that ban-voters checks and bans, 409 above 10 (13.12). */
  banNetworks: number;
}

/** SPEC 13.8 ReviewItem, plus the queue that the mock files it under. */
interface ReviewItem {
  queue: 'pending' | 'disputed' | 'auto';
  handle: string;
  name: string | null;
  followers: number | null;
  xUserId: string | null;
  identity: 'unknown' | 'ok' | 'gone' | 'moved';
  status: 'pending' | 'flagged' | 'confirmed';
  want: 'flagged' | 'confirmed' | null;
  gate: 'protected' | 'identity' | 'standing' | 'evidence' | 'brake' | 'dispute' | 'review' | null;
  networks: number;
  anchors: number;
  notSlop: number;
  dissent: number;
  trust: number;
  score: number;
  seed: boolean;
  protected: boolean;
  behaviour: number;
  sightings: number;
  fastReplyShare: number;
  evidence: { tweetId: string; at: string }[];
  banNetworks: number;
  firstVoteAt: string;
  lastVoteAt: string;
}

interface MockInstall {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  reputation: number;
  extVersion: string;
  bannedAt: string | null;
  trusted: boolean;
  standing: boolean;
  goodMarks: number;
  slopVotes: number;
  notSlopVotes: number;
}

interface LogEntry {
  id: number;
  at: string;
  session: string;
  action: string;
  target: string;
  before: unknown;
}

interface Appeal {
  id: string;
  /** The network of the sender: `here` for an appeal that this server received, `elsewhere` for a fixture. */
  network: 'here' | 'elsewhere';
  handle: string;
  email: string | null;
  message: string;
  code: string;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
  marks: { networks: number; strikes: number };
  penalty: boolean | null;
}

interface MockSlopper {
  handle: string;
  name: string | null;
  avatar: string | null;
  followers: number | null;
  status: 'flagged' | 'confirmed';
  tier: 1 | 2;
  score: number;
  seed: boolean;
  votes: { slop: number; notSlop: number };
  networks: number;
  needed: number;
  listedAt: string | null;
  reason: string;
  waits: boolean;
  xUserId: string | null;
}

export interface MockState {
  scenario: Scenario;
  accounts: Map<string, MockAccount>;
  sloppers: MockSlopper[];
  appeals: Appeal[];
  review: ReviewItem[];
  installs: MockInstall[];
  adminLog: LogEntry[];
  usedChallenges: Set<string>;
  usedCodes: Set<string>;
  sessions: Map<string, string>;
  log: { method: string; path: string; csrf: string | null; origin: string | null; body: unknown }[];
}

const SECRET = randomBytes(32);
const b64u = (buf: Buffer) => buf.toString('base64url');

function issueChallenge(purpose: string): string {
  const payload = b64u(Buffer.from(JSON.stringify({ n: b64u(randomBytes(12)), exp: Math.floor(Date.now() / 1000) + 600, p: purpose })));
  return `${payload}.${b64u(createHmac('sha256', SECRET).update(payload).digest())}`;
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) bits += 8;
    else return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Verifies token signature, purpose, expiry, single use and the proof itself, as SPEC 5.1 describes. */
function verifyPow(state: MockState, challenge: unknown, nonce: unknown, purpose: string): boolean {
  if (typeof challenge !== 'string' || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 32) return false;
  const [payload, sig] = challenge.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', SECRET).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number; p: string };
  if (data.p !== purpose || data.exp < Date.now() / 1000 || state.usedChallenges.has(challenge)) return false;
  const digest = createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest();
  if (leadingZeroBits(digest) < state.scenario.powBits) return false;
  state.usedChallenges.add(challenge);
  return true;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body === null ? undefined : JSON.stringify(body));
}

const error = (res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(res, status, { error: { code, message } }, headers);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 65536) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name && v) return v;
  }
  return null;
}

const FIRST_NAMES = ['Ava', 'Ben', 'Cleo', 'Dario', 'Elif', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Liam', 'Mara', 'Nils', 'Ona', 'Pavel', 'Quinn', 'Rosa', 'Sami', 'Tara', 'Uma', 'Viktor', 'Wren', 'Yara', 'Zane'];
const LAST_NAMES = ['Adler', 'Berg', 'Costa', 'Dumont', 'Eriksen', 'Fontaine', 'Gallo', 'Hart', 'Ito', 'Jansen', 'Keller', 'Lund', 'Moreau', 'Novak', 'Osei', 'Petrov', 'Quist', 'Rossi', 'Silva', 'Toth'];
const WORDS = ['growth', 'scale', 'hustle', 'mindset', 'ship', 'prompt', 'future', 'daily', 'build', 'venture', 'alpha', 'signal'];

// Fixtures for the name and paging tests: markup, very long text, a mixed-direction name, no name at all.
const SPECIAL_SLOPPERS: { handle: string; name: string | null; avatar: boolean }[] = [
  { handle: 'xss_probe_name', name: `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'"><b>bold</b>`, avatar: false },
  { handle: 'long_name_case', name: 'A very long display name that keeps going and does not contain any line break opportunity AAAAAAAAAAAAAAAAAAAAAA', avatar: true },
  { handle: 'bidi_name_case', name: 'admin\u202egnp.exe', avatar: true },
  { handle: 'no_name_at_all', name: null, avatar: false },
];

const REASONS: Record<MockSlopper['status'], string[]> = {
  confirmed: ['seed', 'votes_confirmed', 'override_confirm'],
  flagged: ['votes_flagged'],
};

/** A deterministic list: the same handles, orders and pages on every run. */
function mockSloppers(confirmed: number, flagged: number): MockSlopper[] {
  const out: MockSlopper[] = [];
  const now = Date.now();
  const total = confirmed + flagged;
  for (let i = 0; i < total; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length] ?? 'Ava';
    const last = LAST_NAMES[(i * 7) % LAST_NAMES.length] ?? 'Berg';
    const word = WORDS[(i * 3) % WORDS.length] ?? 'growth';
    const status: MockSlopper['status'] = i < confirmed ? 'confirmed' : 'flagged';
    const fixture = i >= 40 && i < 40 + SPECIAL_SLOPPERS.length ? SPECIAL_SLOPPERS[i - 40] : undefined;
    const handle = fixture?.handle ?? `${`${first}_${word}`.toLowerCase().slice(0, 11)}_${i}`;
    const networks = status === 'confirmed' ? 3 + (i % 40) : 2 + (i % 3);
    const slop = status === 'confirmed' ? 5 + (i * 11) % 180 : 3 + (i % 9);
    const hasAvatar = fixture ? fixture.avatar : i % 9 !== 7;
    const reasons = REASONS[status];
    const reason = reasons[i % reasons.length] ?? 'votes_confirmed';
    // The crowd test of confirmed passes and a gate holds the account: it needs no more networks.
    const waits = status === 'flagged' && i % 4 === 1;
    out.push({
      handle,
      name: fixture ? fixture.name : i % 13 === 5 ? null : `${first} ${last}`,
      avatar: hasAvatar ? `/api/v1/avatars/${handle}` : null,
      followers: i % 17 === 3 ? null : (i * 137) % 48_000,
      status,
      tier: status === 'confirmed' ? 2 : 1,
      score: status === 'confirmed' ? 66 + (i * 5) % 34 : 34 + (i * 7) % 28,
      seed: reason === 'seed',
      votes: { slop, notSlop: (i * 3) % 7 },
      networks,
      needed: status === 'flagged' && !waits ? 1 + (i % 4) : 0,
      listedAt: i % 11 === 2 ? null : new Date(now - (i + 3) * 3_600_000).toISOString(),
      reason,
      waits,
      xUserId: i % 3 === 2 ? null : (1_400_000_000_000_000_000n + BigInt(i) * 7919n).toString(),
    });
  }
  return out;
}

// The shape of GET /api/v1/criteria (lane engine writes the real text). The page renders whatever text it gets.
const CRITERIA = {
  version: 2,
  tiers: [
    {
      status: 'confirmed',
      title: 'Confirmed',
      summary: 'xslop hides the account for everyone who keeps the shared list on.',
      rules: [
        'Voters with standing on different networks mark the account, and the server checked the posts that they name.',
        'Accounts from the public seed list start as confirmed. Only an admin decision or an accepted appeal removes one.',
        'Marks of new installs wait in a review queue until a person decides.',
      ],
    },
    {
      status: 'flagged',
      title: 'Flagged',
      summary: 'xslop hides the account only for people who choose Strict mode.',
      rules: ['Voters on a few different networks mark the account, and at least one of them has standing.', 'Reply timing never changes a status.'],
    },
  ],
  weights: ['An install earns standing after a week and marks that a trusted decision approved.', 'Many installs on one network count as one voter.'],
  protections: ['"Not slop" votes count only from installs with standing.', 'A large account changes its public state only by an admin decision.'],
  appeal: 'Anyone on the list can appeal. You put a short code in your X bio, and an admin checks it by hand.',
};

const SLOPPER_SORTS = ['score', 'recent', 'votes', 'handle'] as const;
const SLOPPER_STATUSES = ['all', 'confirmed', 'flagged'] as const;
const SLOPPER_PARAMS = new Set(['q', 'status', 'sort', 'cursor', 'limit']);

/** The order of 12.5: the sort key, then the handle, so every page boundary is stable. */
function slopperOrder(sort: (typeof SLOPPER_SORTS)[number]): (a: MockSlopper, b: MockSlopper) => number {
  const byHandle = (a: MockSlopper, b: MockSlopper) => a.handle.localeCompare(b.handle);
  if (sort === 'handle') return byHandle;
  if (sort === 'votes') return (a, b) => b.votes.slop - a.votes.slop || byHandle(a, b);
  if (sort === 'recent') return (a, b) => Date.parse(b.listedAt ?? '0') - Date.parse(a.listedAt ?? '0') || byHandle(a, b);
  return (a, b) => b.score - a.score || byHandle(a, b);
}

function sloppersPage(state: MockState, res: ServerResponse, url: URL): void {
  const p = url.searchParams;
  if ([...p.keys()].some((k) => !SLOPPER_PARAMS.has(k))) return error(res, 400, 'unknown_param', 'Unknown query parameter.');
  const status = p.get('status') ?? 'all';
  const sort = p.get('sort') ?? 'score';
  const limitRaw = p.get('limit') ?? '60';
  const q = (p.get('q') ?? '').trim();
  if (!(SLOPPER_STATUSES as readonly string[]).includes(status) || !(SLOPPER_SORTS as readonly string[]).includes(sort)) return error(res, 400, 'bad_query', 'Bad status or sort.');
  if (!/^[0-9]{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) return error(res, 400, 'bad_limit', 'Bad limit.');
  if (q.length > 40) return error(res, 400, 'bad_q', 'Search text is too long.');
  const limit = Number(limitRaw);
  const needle = q.toLowerCase();
  const matches = state.sloppers
    .filter((s) => status === 'all' || s.status === status)
    .filter((s) => !needle || s.handle.includes(needle) || (s.name ?? '').toLowerCase().includes(needle))
    .sort(slopperOrder(sort as (typeof SLOPPER_SORTS)[number]));
  let start = 0;
  const cursor = p.get('cursor');
  if (cursor !== null) {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[0-9]+$/.test(decoded)) return error(res, 400, 'bad_cursor', 'Bad cursor.');
    start = Number(decoded);
  }
  const items = matches.slice(start, start + limit);
  const end = start + items.length;
  json(res, 200, { total: matches.length, generatedAt: new Date(Date.now() - 120_000).toISOString(), next: end < matches.length ? Buffer.from(String(end)).toString('base64url') : null, items });
}

const avatarCache = new Map<string, { png: Buffer; etag: string }>();

function hashOf(handle: string): number {
  let h = 2166136261;
  for (let i = 0; i < handle.length; i++) h = Math.imul(h ^ handle.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 96 px head-and-shoulders portrait, derived from the handle, so the mock list shows photo-like avatars without any network. */
function renderPortrait(handle: string): Buffer {
  const size = 96;
  const h = hashOf(handle);
  const pick = <T>(list: readonly T[], shift: number): T => list[(h >>> shift) % list.length] as T;
  const backdrops = [[32, 52, 88], [70, 44, 64], [28, 74, 70], [88, 62, 36], [52, 54, 60], [18, 40, 58], [80, 48, 48], [40, 66, 44]] as const;
  const skins = [[238, 201, 170], [210, 163, 124], [165, 113, 77], [120, 78, 52], [249, 219, 196]] as const;
  const hairs = [[28, 24, 22], [70, 45, 28], [150, 110, 60], [205, 170, 110], [130, 130, 135], [60, 50, 90]] as const;
  const shirts = [[50, 90, 160], [160, 60, 60], [60, 130, 110], [200, 190, 180], [40, 40, 50], [120, 90, 170]] as const;
  const back = pick(backdrops, 0);
  const skin = pick(skins, 4);
  const hair = pick(hairs, 8);
  const shirt = pick(shirts, 12);
  const headX = 48 + (((h >>> 16) % 9) - 4);
  const headY = 40 + (((h >>> 20) % 7) - 3);
  const headR = 19 + ((h >>> 24) % 5);
  const hairTop = 8 + ((h >>> 27) % 8);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let n = h;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let [r, g, b] = [back[0] + y * 0.5, back[1] + y * 0.45, back[2] + y * 0.4];
      const dx = x - headX;
      const dy = y - headY;
      const inHead = dx * dx + dy * dy * 0.85 < headR * headR;
      const shoulders = (x - headX) * (x - headX) * 0.55 + (y - 104) * (y - 104) * 0.9 < 1500;
      if (shoulders) [r, g, b] = [shirt[0], shirt[1], shirt[2]];
      if (inHead) [r, g, b] = y < headY - headR + hairTop ? [hair[0], hair[1], hair[2]] : [skin[0] - dy * 0.8, skin[1] - dy * 0.8, skin[2] - dy * 0.8];
      n = Math.imul(n, 1597334677) >>> 0;
      const grain = (n >>> 27) - 15;
      const at = y * (size * 3 + 1) + 1 + x * 3;
      raw[at] = Math.min(255, Math.max(0, r + grain));
      raw[at + 1] = Math.min(255, Math.max(0, g + grain));
      raw[at + 2] = Math.min(255, Math.max(0, b + grain));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function avatar(state: MockState, req: IncomingMessage, res: ServerResponse, handle: string): void {
  const slopper = state.sloppers.find((s) => s.handle === handle);
  if (!slopper?.avatar) return error(res, 404, 'not_found', 'No avatar.');
  let entry = avatarCache.get(handle);
  if (!entry) {
    const png = renderPortrait(handle);
    entry = { png, etag: `"${createHash('sha256').update(png).digest('base64url').slice(0, 27)}"` };
    avatarCache.set(handle, entry);
  }
  const headers = { etag: entry.etag, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': 'image/png' });
  res.end(entry.png);
}

const ACCOUNT_STATE = { override: null, protected: false } as const;

export function defaultState(overrides: Partial<Scenario> = {}): MockState {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const accounts = new Map<string, MockAccount>();
  const add = (a: MockAccount) => accounts.set(a.handle, a);
  add({
    ...ACCOUNT_STATE,
    handle: 'growthhacker42',
    status: 'confirmed',
    tier: 2,
    score: 93,
    seed: true,
    votes: { slop: 41, notSlop: 2 },
    sightings: 57,
    signals: { fastReplyShare: 0.82, replies: 14 },
    evidence: [
      { text: 'Great insight! This is a game-changer 🚀 <script>alert(1)</script>', tweetId: '1850000000000000001', at: iso(3_600_000) },
      { tweetId: '1850000000000000002', at: iso(7_200_000) },
    ],
    appealOpen: false,
    networks: 41,
    banNetworks: 41,
  });
  add({ ...ACCOUNT_STATE, handle: 'pendingperson', status: 'flagged', tier: 1, score: 61, seed: false, votes: { slop: 4, notSlop: 1 }, sightings: 3, signals: null, evidence: [], appealOpen: true, networks: 4, banNetworks: 4 });
  // Not listed: the public answer of 13.8 shows none of these numbers.
  add({ ...ACCOUNT_STATE, handle: 'xs_pending_demo', status: 'pending', tier: 0, score: 71, seed: false, votes: { slop: 9, notSlop: 1 }, sightings: 12, signals: { fastReplyShare: 0.9, replies: 12 }, evidence: [{ tweetId: '1850000000000000003', at: iso(9_000_000) }], appealOpen: false, networks: 9, banNetworks: 8 });
  add({ ...ACCOUNT_STATE, handle: 'xs_cleared_demo', status: 'cleared', tier: 0, score: 0, seed: false, votes: { slop: 3, notSlop: 0 }, sightings: 0, signals: null, evidence: [], appealOpen: false, override: 'clear', networks: 4, banNetworks: 3 });
  add({ ...ACCOUNT_STATE, handle: 'xs_cleared_many', status: 'cleared', tier: 0, score: 0, seed: false, votes: { slop: 30, notSlop: 2 }, sightings: 0, signals: null, evidence: [], appealOpen: false, override: 'clear', networks: 14, banNetworks: 10 });
  const item = (queue: ReviewItem['queue'], handle: string, patch: Partial<ReviewItem>): ReviewItem => ({
    queue,
    handle,
    name: null,
    followers: null,
    xUserId: null,
    identity: 'ok',
    status: 'pending',
    want: 'confirmed',
    gate: null,
    networks: 4,
    anchors: 0,
    notSlop: 0,
    dissent: 0,
    trust: 1,
    score: 70,
    seed: false,
    protected: false,
    behaviour: 0.4,
    sightings: 0,
    fastReplyShare: 0,
    evidence: [],
    banNetworks: 4,
    firstVoteAt: iso(86_400_000 * 2),
    lastVoteAt: iso(3_600_000),
    ...patch,
  });
  return {
    scenario: { stats: 'ok', latest: 'ok', sloppers: 'ok', criteria: 'ok', powBits: 12, adminUser: 'operator', adminPassword: 'correct horse battery staple 42', adminCode: null, ...overrides },
    accounts,
    sloppers: mockSloppers(812, 64),
    appeals: [
      { id: randomUUID(), network: 'elsewhere', handle: 'pendingperson', email: 'p@example.com', message: 'I write every reply myself. Please check my timeline.', code: 'xslop-AB12CD', status: 'open', createdAt: iso(5_400_000), decidedAt: null, note: null, marks: { networks: 4, strikes: 3 }, penalty: null },
    ],
    review: [
      item('pending', 'xs_pending_demo', { name: 'Pending Demo <b>Account</b>', followers: 1234, xUserId: '1400000000000000001', gate: 'evidence', networks: 9, anchors: 2, notSlop: 1, dissent: 4, trust: 2.1, score: 71, sightings: 12, fastReplyShare: 0.9, behaviour: 0.77, evidence: [{ tweetId: '1850000000000000003', at: iso(9_000_000) }], banNetworks: 8 }),
      // A broken date on a post must not break the table.
      item('pending', 'xs_unknown_demo', { identity: 'unknown', gate: 'identity', want: 'flagged', networks: 2, banNetworks: 2, anchors: 1, score: 52, evidence: [{ tweetId: '1850000000000000006', at: 'not a date' }] }),
      item('disputed', 'growthhacker42', { status: 'confirmed', want: null, seed: true, networks: 41, banNetworks: 41, anchors: 6, notSlop: 5, dissent: 12, score: 93, followers: 48_000, sightings: 14, fastReplyShare: 0.82 }),
      item('auto', 'xs_auto_confirm', { status: 'confirmed', want: null, networks: 5, banNetworks: 5, anchors: 3, score: 80, followers: 900, evidence: [{ tweetId: '1850000000000000004', at: iso(4_000_000) }, { tweetId: '1850000000000000005', at: iso(5_000_000) }] }),
    ],
    installs: [
      { id: randomUUID(), createdAt: iso(86_400_000 * 9), lastSeenAt: iso(600_000), reputation: 0.62, extVersion: '1.2.0', bannedAt: null, trusted: false, standing: true, goodMarks: 4, slopVotes: 31, notSlopVotes: 2 },
      { id: randomUUID(), createdAt: iso(3_600_000), lastSeenAt: iso(60_000), reputation: 0.05, extVersion: '1.2.0', bannedAt: null, trusted: false, standing: false, goodMarks: 0, slopVotes: 50, notSlopVotes: 0 },
    ],
    adminLog: [{ id: 1, at: iso(7_200_000), session: '0123456789abcdef', action: 'clear', target: 'xs_cleared_demo', before: { override: null, status: 'flagged', protected: false } }],
    usedChallenges: new Set(),
    usedCodes: new Set(),
    sessions: new Map(),
    log: [],
  };
}

/** A strict body reader for the admin writes: only the named keys, so a test proves the exact request shape. */
function bodyOf(body: unknown, allowed: string[]): Record<string, unknown> | null {
  if (body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return Object.keys(body).every((k) => allowed.includes(k)) ? (body as Record<string, unknown>) : null;
}

const LIMIT = /^[0-9]{1,3}$/;

const SHA_A = 'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef';
const SHA_B = SHA_A.split('').reverse().join('');

async function api(state: MockState, req: IncomingMessage, res: ServerResponse, url: URL, origin: string): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  let body: unknown = null;
  if (method === 'POST') {
    try {
      body = await readBody(req);
    } catch {
      return error(res, 400, 'bad_json', 'The body is not valid JSON.');
    }
  }
  state.log.push({ method, path: path + url.search, csrf: (req.headers['x-csrf'] as string) ?? null, origin: (req.headers.origin as string) ?? null, body });
  const s = state.scenario;

  if (method === 'GET' && path === '/api/v1/stats') {
    if (s.stats === 'down') return error(res, 503, 'unavailable', 'Stats are unavailable.');
    if (s.stats === 'limited') return error(res, 429, 'rate_limited', 'Too many requests.', { 'retry-after': '120' });
    return json(res, 200, { confirmed: 812, flagged: 64, votes: 15230, installs: 1904, sightings: 402113, generatedAt: new Date(Date.now() - 120_000).toISOString() });
  }
  if (method === 'GET' && path === '/downloads/latest.json') {
    if (s.latest === 'down') return error(res, 503, 'unavailable', 'Unavailable.');
    const base = {
      version: '1.0.0',
      chrome: { file: 'xslop-chrome-v1.0.0.zip', sha256: SHA_A, bytes: 86_016 },
      firefox: { file: 'xslop-firefox-v1.0.0.zip', sha256: SHA_B, bytes: 85_120 },
      safari: { file: 'xslop-safari-v1.0.0.zip', sha256: SHA_A, bytes: 84_224 },
    };
    return json(res, 200, s.latest === 'store' ? { ...base, chromeStoreUrl: 'https://chromewebstore.google.com/detail/xslop/abcdefghijklmnopabcdefghijklmnop', firefoxUrl: 'https://addons.mozilla.org/firefox/addon/xslop/' } : base);
  }
  if (method === 'GET' && path === '/api/v1/sloppers') {
    if (s.sloppers === 'down') return error(res, 503, 'unavailable', 'The list is unavailable.');
    if (s.sloppers === 'limited') return error(res, 429, 'rate_limited', 'Too many requests.', { 'retry-after': '120' });
    if (s.sloppers === 'empty') return json(res, 200, { total: 0, generatedAt: new Date().toISOString(), next: null, items: [] });
    return sloppersPage(state, res, url);
  }
  if (method === 'GET' && path === '/api/v1/criteria') {
    if (s.criteria === 'down') return error(res, 503, 'unavailable', 'The criteria are unavailable.');
    return json(res, 200, CRITERIA);
  }
  const avatarMatch = /^\/api\/v1\/avatars\/([a-z0-9_]{1,15})$/.exec(path);
  if (method === 'GET' && avatarMatch) return avatar(state, req, res, avatarMatch[1] ?? '');
  const accountMatch = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
  if (method === 'GET' && accountMatch) {
    const handle = decodeURIComponent(accountMatch[1] ?? '');
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) return error(res, 400, 'bad_handle', 'The handle is not valid.');
    const acc = state.accounts.get(handle);
    // 13.8: an account that is not flagged or confirmed shows none of its numbers.
    if (!acc || (acc.status !== 'flagged' && acc.status !== 'confirmed')) {
      return json(res, 200, { handle, status: 'none', tier: 0, score: 0, seed: acc?.seed ?? false, votes: { slop: 0, notSlop: 0 }, sightings: 0, signals: null, evidence: [], appealOpen: acc?.appealOpen ?? false });
    }
    const { handle: h, status, tier, score, seed, votes, sightings, signals, evidence, appealOpen } = acc;
    return json(res, 200, { handle: h, status, tier, score, seed, votes, sightings, signals, evidence, appealOpen });
  }
  if (method === 'GET' && path === '/api/v1/challenge') {
    const purpose = url.searchParams.get('purpose') ?? 'install';
    if (purpose !== 'install' && purpose !== 'appeal') return error(res, 400, 'bad_purpose', 'Unknown purpose.');
    return json(res, 200, { challenge: issueChallenge(purpose), difficulty: s.powBits });
  }
  if (method === 'POST' && path === '/api/v1/appeals') {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b.handle !== 'string' || !/^[a-z0-9_]{1,15}$/.test(b.handle)) return error(res, 400, 'bad_handle', 'The handle is not valid.');
    const allowed = new Set(['handle', 'email', 'message', 'challenge', 'nonce']);
    if (Object.keys(b).some((k) => !allowed.has(k))) return error(res, 400, 'unknown_field', 'The body has an unknown field.');
    if (typeof b.message !== 'string' || b.message.length < 20 || b.message.length > 2000) return error(res, 400, 'bad_message', 'The message needs 20 to 2000 characters.');
    if (b.email !== null && typeof b.email !== 'string') return error(res, 400, 'bad_email', 'The email is not valid.');
    if (!verifyPow(state, b.challenge, b.nonce, 'appeal')) return error(res, 400, 'bad_proof', 'The proof of work is not valid.');
    // One open appeal per handle and network, with no total per handle: an appeal from another network does not block this one.
    if (state.appeals.some((a) => a.handle === b.handle && a.status === 'open' && a.network === 'here')) return error(res, 409, 'appeal_open', 'You already have an open appeal for this account.');
    const appeal: Appeal = { id: randomUUID(), network: 'here', handle: b.handle, email: (b.email as string | null) ?? null, message: b.message, code: `xslop-${randomBytes(3).toString('hex').toUpperCase()}`, status: 'open', createdAt: new Date().toISOString(), decidedAt: null, note: null, marks: { networks: 0, strikes: 0 }, penalty: null };
    state.appeals.push(appeal);
    return json(res, 201, { appealId: appeal.id, code: appeal.code, status: 'open' });
  }
  const appealMatch = /^\/api\/v1\/appeals\/([0-9a-f-]{36})$/.exec(path);
  if (method === 'GET' && appealMatch) {
    const a = state.appeals.find((x) => x.id === appealMatch[1]);
    if (!a) return error(res, 404, 'not_found', 'Unknown appeal.');
    return json(res, 200, { appealId: a.id, handle: a.handle, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt });
  }

  if (path.startsWith('/api/admin/')) {
    if (method === 'POST' && path === '/api/admin/login') {
      const b = bodyOf(body, ['username', 'password', 'code']);
      if (!b || typeof b.username !== 'string' || typeof b.password !== 'string') return error(res, 400, 'bad_request', 'Bad login body.');
      if (b.code !== undefined && (typeof b.code !== 'string' || !/^[0-9]{6}$/.test(b.code))) return error(res, 400, 'bad_request', 'Bad code.');
      // A wrong, missing or used code answers like a wrong password (13.8).
      const codeOk = s.adminCode === null || (b.code === s.adminCode && !state.usedCodes.has(b.code));
      if (b.username !== s.adminUser || b.password !== s.adminPassword || !codeOk) return error(res, 401, 'invalid_credentials', 'The username or password is wrong.');
      if (typeof b.code === 'string' && s.adminCode !== null) state.usedCodes.add(b.code);
      const token = b64u(randomBytes(32));
      const csrf = b64u(randomBytes(24));
      state.sessions.set(token, csrf);
      return json(res, 200, { csrf }, { 'set-cookie': `xs_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
    }
    const token = cookie(req, 'xs_admin');
    const csrf = token ? state.sessions.get(token) : undefined;
    if (!token || !csrf) return error(res, 401, 'unauthorized', 'Log in first.');
    if (method !== 'GET' && (req.headers['x-csrf'] !== csrf || req.headers.origin !== origin)) return error(res, 403, 'bad_csrf', 'CSRF check failed.');
    const session = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const logChange = (action: string, target: string, before: unknown) => state.adminLog.unshift({ id: state.adminLog.length + 1, at: new Date().toISOString(), session, action, target, before });
    const params = url.searchParams;
    if (method === 'GET' && path === '/api/admin/session') return json(res, 200, { user: s.adminUser, csrf });
    if (method === 'POST' && path === '/api/admin/logout') {
      state.sessions.delete(token);
      return json(res, 204, null, { 'set-cookie': 'xs_admin=; Path=/; Max-Age=0' });
    }
    if (method === 'GET' && path === '/api/admin/overview') {
      const accs = [...state.accounts.values()];
      const by = (st: MockAccount['status']) => accs.filter((a) => a.status === st).length;
      return json(res, 200, {
        accounts: { confirmed: by('confirmed'), flagged: by('flagged'), pending: by('pending'), cleared: by('cleared'), seed: accs.filter((a) => a.seed).length },
        standingInstalls: state.installs.filter((i) => i.standing).length,
        trustedInstalls: state.installs.filter((i) => i.trusted).length,
        votes: 15230,
        installs: state.installs.length,
        bannedInstalls: state.installs.filter((i) => i.bannedAt).length,
        sightings: 402113,
        appealsOpen: state.appeals.filter((a) => a.status === 'open').length,
        listVersion: 118,
        score: { lastRunAt: new Date(Date.now() - 180_000).toISOString(), lastOkAt: new Date(Date.now() - 180_000).toISOString(), detail: { struckNetworks: 2, votesHeld: 0 } },
        facts: { lastRunAt: new Date(Date.now() - 60_000).toISOString(), lastOkAt: new Date(Date.now() - 60_000).toISOString(), detail: { checked: 40, evidence: 12, verified: 30 }, moved24h: 3 },
      });
    }
    if (method === 'GET' && path === '/api/admin/review') {
      const queue = params.get('queue') ?? '';
      const limit = params.get('limit') ?? '100';
      if ([...params.keys()].some((k) => k !== 'queue' && k !== 'limit') || !['pending', 'disputed', 'auto'].includes(queue) || !LIMIT.test(limit)) return error(res, 400, 'bad_query', 'Bad queue or limit.');
      const items = state.review.filter((r) => r.queue === queue);
      return json(res, 200, { total: items.length, items: items.slice(0, Number(limit)).map(({ queue: _, ...rest }) => rest) });
    }
    if (method === 'GET' && path === '/api/admin/appeals') {
      const st = params.get('status') ?? 'open';
      return json(res, 200, { appeals: state.appeals.filter((a) => a.status === st).map(({ id, network: _, penalty: __, ...rest }) => ({ appealId: id, ...rest })) });
    }
    const decide = /^\/api\/admin\/appeals\/([0-9a-f-]{36})\/decide$/.exec(path);
    if (method === 'POST' && decide) {
      const a = state.appeals.find((x) => x.id === decide[1]);
      const b = bodyOf(body, ['decision', 'note', 'penalty']);
      if (!a || !b || (b.decision !== 'accept' && b.decision !== 'reject')) return error(res, 400, 'bad_decision', 'Bad decision.');
      if (b.penalty !== undefined && (typeof b.penalty !== 'boolean' || b.decision !== 'accept')) return error(res, 400, 'bad_penalty', 'Bad penalty.');
      if (a.status !== 'open') return error(res, 409, 'appeal_closed', 'This appeal is already decided.');
      logChange(b.decision, a.id, { status: a.status });
      a.status = b.decision === 'accept' ? 'accepted' : 'rejected';
      a.decidedAt = new Date().toISOString();
      a.note = typeof b.note === 'string' ? b.note : null;
      a.penalty = b.decision === 'accept' ? b.penalty !== false : null;
      return json(res, 200, { appealId: a.id, handle: a.handle, status: a.status, decidedAt: a.decidedAt });
    }
    if (method === 'GET' && path === '/api/admin/accounts') {
      const handle = params.get('handle');
      const st = params.get('status');
      const list = [...state.accounts.values()]
        .filter((a) => (!handle || a.handle.startsWith(handle)) && (!st || a.status === st))
        .map((a) => ({ handle: a.handle, status: a.status, tier: a.tier, score: a.score, seed: a.seed, override: a.override, protected: a.protected, updatedAt: new Date().toISOString(), parts: { networks: a.networks }, banNetworks: a.banNetworks }));
      return json(res, 200, { accounts: list });
    }
    const banVoters = /^\/api\/admin\/accounts\/([a-z0-9_]{1,15})\/ban-voters$/.exec(path);
    if (method === 'POST' && banVoters) {
      const handle = banVoters[1] ?? '';
      // The account row and its queue item carry the same count; one install per network in this mock.
      const targets = [state.accounts.get(handle), ...state.review.filter((r) => r.handle === handle)].filter((t) => t !== undefined);
      const networks = targets[0]?.banNetworks;
      if (networks === undefined) return error(res, 404, 'not_found', 'No account has this handle.');
      if (!bodyOf(body, [])) return error(res, 400, 'bad_request', 'The body takes no field.');
      if (networks > 10) return error(res, 409, 'crowd_too_large', 'More than 10 networks marked this account. Ban single installs instead.');
      logChange('ban-voters', handle, { networks });
      for (const t of targets) t.banNetworks = 0;
      return json(res, 200, { banned: networks });
    }
    const accountAction = /^\/api\/admin\/accounts\/([a-z0-9_]{1,15})$/.exec(path);
    if (method === 'POST' && accountAction) {
      const handle = accountAction[1] ?? '';
      const b = bodyOf(body, ['action', 'penalty']);
      const action = b?.action;
      if (!b || typeof action !== 'string' || !['confirm', 'clear', 'reset', 'protect', 'unprotect'].includes(action)) return error(res, 400, 'bad_action', 'Bad action.');
      if (b.penalty !== undefined && (typeof b.penalty !== 'boolean' || action !== 'clear')) return error(res, 400, 'bad_penalty', 'Bad penalty.');
      const acc = state.accounts.get(handle);
      const queued = state.review.find((r) => r.handle === handle);
      if (!acc && !queued) return error(res, 404, 'not_found', 'No account has this handle.');
      logChange(action, handle, acc ? { status: acc.status, override: acc.override, protected: acc.protected } : { status: queued?.status });
      if (action === 'confirm' || action === 'clear') state.review = state.review.filter((r) => r.handle !== handle);
      if (queued && (action === 'protect' || action === 'unprotect')) queued.protected = action === 'protect';
      if (acc) {
        if (action === 'confirm') Object.assign(acc, { status: 'confirmed', tier: 2, override: 'confirm' });
        if (action === 'clear') Object.assign(acc, { status: 'cleared', tier: 0, override: 'clear' });
        if (action === 'reset') acc.override = null;
        if (action === 'protect' || action === 'unprotect') acc.protected = action === 'protect';
      }
      return json(res, 200, { account: { handle, status: acc?.status ?? queued?.status } });
    }
    if (method === 'GET' && path === '/api/admin/installs') {
      const sort = params.get('sort') ?? 'reputation';
      if (!['reputation', 'created', 'votes'].includes(sort)) return error(res, 400, 'bad_query', 'Bad sort.');
      return json(res, 200, { installs: state.installs });
    }
    const installAction = /^\/api\/admin\/installs\/([0-9a-f-]{36})\/(trust|untrust|ban|unban)$/.exec(path);
    if (method === 'POST' && installAction) {
      const inst = state.installs.find((i) => i.id === installAction[1]);
      if (!inst) return error(res, 404, 'not_found', 'Unknown install.');
      if (!bodyOf(body, [])) return error(res, 400, 'bad_request', 'The body takes no field.');
      const action = installAction[2] ?? '';
      logChange(action, inst.id, { trusted: inst.trusted, bannedAt: inst.bannedAt });
      if (action === 'trust' || action === 'untrust') inst.trusted = action === 'trust';
      else inst.bannedAt = action === 'ban' ? new Date().toISOString() : null;
      return json(res, 200, { id: inst.id, trusted: inst.trusted, bannedAt: inst.bannedAt });
    }
    if (method === 'GET' && path === '/api/admin/log') {
      const limit = params.get('limit') ?? '100';
      if (!LIMIT.test(limit)) return error(res, 400, 'bad_query', 'Bad limit.');
      return json(res, 200, { entries: state.adminLog.slice(0, Number(limit)) });
    }
  }
  return error(res, 404, 'not_found', 'Unknown route.');
}

export async function startServer(distDir: string, state: MockState = defaultState()): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const root = resolve(distDir);
  let origin = '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/api/') || url.pathname === '/downloads/latest.json') return await api(state, req, res, url, origin);
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      const page = /^\/(admin|sloppers|how-it-works|rules|download|check|privacy|questions)\/?$/.exec(url.pathname);
      if (page) file = `/${page[1]}/index.html`;
      file = normalize(file);
      const full = join(root, file);
      let status = 200;
      let data: Buffer;
      if (!full.startsWith(root)) throw new Error('traversal');
      try {
        data = await readFile(full);
      } catch {
        status = 404;
        file = '/404.html';
        data = await readFile(join(root, file));
      }
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff' };
      // Built assets are public. The header lets the design gate render its private copy of a page with the real CSS and fonts.
      if (!type.startsWith('text/html')) headers['access-control-allow-origin'] = '*';
      if (type.startsWith('text/html')) {
        Object.assign(headers, {
          'content-security-policy': CSP,
          'x-frame-options': 'DENY',
          'cross-origin-opener-policy': 'same-origin',
          'permissions-policy': 'camera=(), microphone=(), geolocation=()',
          'cache-control': 'no-store',
        });
      }
      res.writeHead(status, headers);
      res.end(data);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    state,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// `node test/e2e/server.ts [port]` runs the server by itself for manual previews and the design gate.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = resolve(import.meta.dirname, '../../dist');
  const { url } = await startServer(dist);
  console.log(url);
}
