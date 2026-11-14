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

type AccountStatus = 'none' | 'pending' | 'flagged' | 'confirmed' | 'cleared';
type GateName = 'protected' | 'identity' | 'standing' | 'evidence' | 'brake' | 'dispute' | 'review';

/** `accounts.parts` of SPEC 13.3, every field set. */
interface Parts {
  reason: string;
  want: 'flagged' | 'confirmed' | null;
  gate: GateName | null;
  networks: number;
  anchors: number;
  notSlop: number;
  dissent: number;
  trust: number;
  needed: number;
  disputed: boolean;
  evidence: number;
  factor: number;
  behaviour: number;
  sightings: number;
  fastReplyShare: number;
  raters: number;
  slopRaters: number;
  notSlopRaters: number;
}

interface MockAccount {
  handle: string;
  status: AccountStatus;
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
  // The admin fields of SPEC 14.2.
  name: string | null;
  followers: number | null;
  avatar: boolean;
  xUserId: string | null;
  identity: 'unknown' | 'ok' | 'gone' | 'moved';
  identityAt: string | null;
  movedTo: string | null;
  firstSeenAt: string;
  listedAt: string | null;
  confirmedAt: string | null;
  overrideAt: string | null;
  clearPenalty: boolean;
  clearedAt: string | null;
  seedSource: string | null;
  updatedAt: string;
  parts: Parts;
  /** Posts of `evidence` that the X facts job found written by another X id. */
  badPosts: string[];
}

interface MockInstall {
  id: string;
  /** The first 8 hex characters of sha256(ip_hash) (14.1). */
  network: string;
  createdAt: string;
  lastSeenAt: string;
  reputation: number;
  extVersion: string;
  bannedAt: string | null;
  trusted: boolean;
  standing: boolean;
  goodMarks: number;
}

interface MockVote {
  install: string;
  handle: string;
  value: 0 | 1;
  votedAt: string;
  changedAt: string;
  tweetId: string | null;
}

interface LogEntry {
  id: number;
  at: string;
  session: string;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
}

/** A row of `events` (14.1): what the score job and the X facts job changed. */
interface MockEvent {
  at: string;
  kind: 'status' | 'identity' | 'standing';
  source: 'score' | 'facts';
  subject: string;
  data: Record<string, unknown>;
}

interface ListVersion {
  version: number;
  generatedAt: string;
  count: number;
  from: number | null;
  added: [string, number, number][];
  removed: string[];
}

interface JobRun {
  id: number;
  job: 'score' | 'profiles';
  startedAt: string;
  endedAt: string;
  ok: boolean;
  detail: Record<string, unknown>;
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
  votes: MockVote[];
  events: MockEvent[];
  lists: ListVersion[];
  jobRuns: JobRun[];
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
  if (!slopper?.avatar && !state.accounts.get(handle)?.avatar) return error(res, 404, 'not_found', 'No avatar.');
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

// Admin fixtures (SPEC 13.8, 14.2). Every account matches the rules of 13.3: its parts give the status that the engine
// would give. Installs, votes, events, list versions and job runs are deterministic, relative to the start of the server.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The constants of SPEC 13.2 as the overview sends them. */
export const RULES = {
  standingMinAgeDays: 7,
  standingMinGoodMarks: 3,
  standingMinReputation: 0.6,
  anchorsFlag: 1,
  anchorsConfirm: 2,
  evidenceFlag: 1,
  evidenceConfirm: 2,
  flagMinNetworks: 2,
  confirmMinNetworks: 4,
  confirmMinTrust: 1,
  flagShareBound: 0.5,
  confirmShareBound: 0.6,
  protectedMinFollowers: 50_000,
  maxAutoConfirmsPerDay: 30,
  maxAutoFlagsPerDay: 60,
  strikeMaxCrowd: 10,
  clearedReturnMinNetworks: 6,
  seedDisputeMinNetworks: 5,
  networkDailyVotes: 50,
};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const uuidOf = (s: string): string => {
  const x = sha(s);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};
const networkOf = (i: number): string => sha(`network:${i}`).slice(0, 8);

const partsOf = (p: Partial<Parts>): Parts => ({
  reason: 'none',
  want: null,
  gate: null,
  networks: 0,
  anchors: 0,
  notSlop: 0,
  dissent: 0,
  trust: 0,
  needed: 0,
  disputed: false,
  evidence: 0,
  factor: 0,
  behaviour: 0,
  sightings: 0,
  fastReplyShare: 0,
  raters: 0,
  slopRaters: 0,
  notSlopRaters: 0,
  ...p,
});

type AccountSeed = Pick<MockAccount, 'handle' | 'status' | 'tier' | 'score'> & Partial<Omit<MockAccount, 'parts'>> & { p: Partial<Parts> };

function adminAccounts(now: number): MockAccount[] {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const seeds: AccountSeed[] = [
    {
      handle: 'growthhacker42', status: 'confirmed', tier: 2, score: 93, seed: true, votes: { slop: 41, notSlop: 2 }, sightings: 57, signals: { fastReplyShare: 0.82, replies: 14 },
      evidence: [
        { text: 'Great insight! This is a game-changer 🚀 <script>alert(1)</script>', tweetId: '1850000000000000001', at: iso(HOUR) },
        { tweetId: '1850000000000000002', at: iso(2 * HOUR) },
      ],
      name: 'Growth Hacker', followers: 48_000, avatar: true, xUserId: '1400000000000000042', identity: 'ok', listedAt: iso(40 * DAY), confirmedAt: iso(40 * DAY), seedSource: 'x_list:1690000000000000000',
      p: { reason: 'seed', networks: 41, anchors: 6, notSlop: 5, dissent: 12, trust: 18.4, disputed: true, evidence: 2, behaviour: 0.71, sightings: 14, fastReplyShare: 0.82 },
    },
    {
      handle: 'pendingperson', status: 'flagged', tier: 1, score: 61, votes: { slop: 4, notSlop: 1 }, sightings: 3, appealOpen: true,
      evidence: [{ tweetId: '1850000000000000010', at: iso(30 * HOUR) }, { tweetId: '1850000000000000011', at: iso(28 * HOUR) }],
      name: 'Pending Person', followers: 3100, avatar: true, xUserId: '1400000000000000007', identity: 'ok', listedAt: iso(2 * DAY),
      p: { reason: 'votes_flagged', want: 'confirmed', gate: 'standing', networks: 4, anchors: 1, dissent: 1, trust: 1.6, evidence: 2, sightings: 3, fastReplyShare: 0.33 },
    },
    {
      handle: 'xs_pending_demo', status: 'pending', tier: 0, score: 71, votes: { slop: 9, notSlop: 1 }, sightings: 12, signals: { fastReplyShare: 0.9, replies: 12 },
      evidence: [{ tweetId: '1850000000000000003', at: iso(9_000_000) }], badPosts: ['1850000000000000003'],
      name: 'Pending Demo <b>Account</b>', followers: 1234, avatar: true, xUserId: '1400000000000000001', identity: 'ok',
      p: { reason: 'pending', want: 'confirmed', gate: 'evidence', networks: 9, anchors: 2, dissent: 4, trust: 2.1, evidence: 0, behaviour: 0.77, sightings: 12, fastReplyShare: 0.9 },
    },
    {
      handle: 'xs_unknown_demo', status: 'pending', tier: 0, score: 52, votes: { slop: 2, notSlop: 0 }, identity: 'unknown',
      evidence: [{ tweetId: '1850000000000000006', at: 'not a date' }],
      p: { reason: 'pending', want: 'flagged', gate: 'identity', networks: 2, anchors: 1, trust: 0.9 },
    },
    {
      handle: 'xs_no_anchor', status: 'pending', tier: 0, score: 74, votes: { slop: 6, notSlop: 0 },
      evidence: [{ tweetId: '1850000000000000020', at: iso(5 * HOUR) }, { tweetId: '1850000000000000021', at: iso(6 * HOUR) }],
      name: 'Standing Gate Demo', followers: 15_200, avatar: true, xUserId: '1400000000000000020', identity: 'ok',
      p: { reason: 'pending', want: 'confirmed', gate: 'standing', networks: 6, anchors: 0, trust: 1.4, evidence: 2, needed: 0 },
    },
    {
      handle: 'xs_brake_demo', status: 'pending', tier: 0, score: 58, votes: { slop: 3, notSlop: 0 },
      evidence: [{ tweetId: '1850000000000000030', at: iso(3 * HOUR) }],
      name: 'Daily Limit Demo', followers: 640, xUserId: '1400000000000000030', identity: 'ok',
      p: { reason: 'pending', want: 'flagged', gate: 'brake', networks: 3, anchors: 1, trust: 1.1, evidence: 1, needed: 1 },
    },
    {
      handle: 'xs_dispute_demo', status: 'pending', tier: 0, score: 40, votes: { slop: 6, notSlop: 1 },
      evidence: [{ tweetId: '1850000000000000040', at: iso(7 * HOUR) }, { tweetId: '1850000000000000041', at: iso(8 * HOUR) }],
      name: 'Dispute Demo', followers: 7300, avatar: true, xUserId: '1400000000000000040', identity: 'ok',
      p: { reason: 'pending', want: 'confirmed', gate: 'dispute', networks: 6, anchors: 2, notSlop: 1, dissent: 1, trust: 2.3, evidence: 2 },
    },
    {
      handle: 'xs_big_account', status: 'pending', tier: 0, score: 77, votes: { slop: 8, notSlop: 0 },
      evidence: [{ tweetId: '1850000000000000050', at: iso(4 * HOUR) }, { tweetId: '1850000000000000051', at: iso(9 * HOUR) }],
      name: 'Big Account Demo', followers: 120_000, avatar: true, xUserId: '1400000000000000050', identity: 'ok',
      p: { reason: 'pending', want: 'confirmed', gate: 'protected', networks: 8, anchors: 3, trust: 4.2, evidence: 2, sightings: 22, fastReplyShare: 0.64, behaviour: 0.58 },
    },
    {
      handle: 'xs_review_back', status: 'pending', tier: 0, score: 72, votes: { slop: 7, notSlop: 0 }, clearedAt: iso(20 * DAY),
      name: 'Back For Review', followers: 2900, xUserId: '1400000000000000060', identity: 'ok',
      p: { reason: 'pending', want: 'confirmed', gate: 'review', networks: 7, anchors: 2, trust: 3.1, evidence: 2 },
    },
    {
      handle: 'xs_auto_confirm', status: 'confirmed', tier: 2, score: 80, votes: { slop: 5, notSlop: 0 }, listedAt: iso(2 * HOUR), confirmedAt: iso(2 * HOUR),
      evidence: [{ tweetId: '1850000000000000004', at: iso(4_000_000) }, { tweetId: '1850000000000000005', at: iso(5_000_000) }],
      name: 'Auto Confirm Demo', followers: 900, avatar: true, xUserId: '1400000000000000004', identity: 'ok',
      p: { reason: 'votes_confirmed', networks: 5, anchors: 3, trust: 3.4, evidence: 2 },
    },
    {
      handle: 'xs_gone_flagged', status: 'flagged', tier: 1, score: 55, votes: { slop: 3, notSlop: 0 }, listedAt: iso(6 * DAY), identity: 'gone',
      evidence: [{ tweetId: '1850000000000000070', at: iso(6 * DAY) }],
      name: 'Gone Flagged', followers: 410, xUserId: '1400000000000000070',
      p: { reason: 'votes_flagged', networks: 3, anchors: 1, trust: 1.3, evidence: 1, needed: 1 },
    },
    {
      handle: 'xs_admin_ok', status: 'confirmed', tier: 2, score: 100, votes: { slop: 3, notSlop: 0 }, override: 'confirm', overrideAt: iso(5 * DAY), listedAt: iso(5 * DAY), confirmedAt: iso(5 * DAY), protected: true,
      evidence: [{ tweetId: '1850000000000000080', at: iso(5 * DAY) }],
      name: 'Admin Confirmed', followers: 2200, avatar: true, xUserId: '1400000000000000080', identity: 'ok',
      p: { reason: 'override_confirm', networks: 3, anchors: 1, trust: 1.5, evidence: 1, needed: 1 },
    },
    {
      handle: 'xs_cleared_demo', status: 'cleared', tier: 0, score: 0, votes: { slop: 3, notSlop: 0 }, override: 'clear', overrideAt: iso(2 * HOUR), clearedAt: iso(2 * HOUR),
      followers: 210, xUserId: '1400000000000000090', identity: 'ok',
      p: { reason: 'override_clear', networks: 4, anchors: 1, trust: 1.2, evidence: 1 },
    },
    {
      handle: 'xs_cleared_many', status: 'cleared', tier: 0, score: 0, votes: { slop: 30, notSlop: 2 }, override: 'clear', overrideAt: iso(3 * DAY), clearedAt: iso(3 * DAY), clearPenalty: false,
      followers: 8800, name: 'Cleared Crowd', xUserId: '1400000000000000091', identity: 'ok',
      p: { reason: 'override_clear', networks: 14, anchors: 4, dissent: 2, trust: 7.7, evidence: 3 },
    },
    {
      handle: 'xs_moved_handle', status: 'none', tier: 0, score: 0, identity: 'moved', movedTo: 'xs_new_handle',
      p: { reason: 'moved' },
    },
    {
      handle: 'xs_new_handle', status: 'confirmed', tier: 2, score: 80, seed: true, listedAt: iso(40 * DAY), confirmedAt: iso(40 * DAY), seedSource: 'x_list:1690000000000000000',
      name: 'Renamed Account', followers: 5400, avatar: true, xUserId: '1400000000000000100', identity: 'ok',
      p: { reason: 'seed' },
    },
    {
      handle: 'xs_quiet_voter', status: 'none', tier: 0, score: 0, votes: { slop: 1, notSlop: 2 },
      p: { reason: 'none', networks: 1, dissent: 2, trust: 0.35, needed: 1 },
    },
  ];
  return seeds.map(({ p, ...a }, i) => {
    const parts = partsOf(p);
    return {
      seed: false,
      votes: { slop: 0, notSlop: 0 },
      sightings: 0,
      signals: null,
      evidence: [],
      appealOpen: false,
      override: null,
      protected: false,
      name: null,
      followers: null,
      avatar: false,
      xUserId: null,
      identity: 'unknown',
      identityAt: a.identity && a.identity !== 'unknown' ? iso((i + 1) * 5 * HOUR) : null,
      movedTo: null,
      firstSeenAt: iso((12 + i) * DAY),
      listedAt: null,
      confirmedAt: null,
      overrideAt: null,
      clearPenalty: true,
      clearedAt: null,
      seedSource: null,
      updatedAt: iso((i + 1) * 7 * 60_000),
      badPosts: [],
      ...a,
      networks: parts.networks,
      parts: { ...parts, raters: parts.networks + parts.notSlop + parts.dissent, slopRaters: parts.networks, notSlopRaters: parts.notSlop + parts.dissent },
    } satisfies MockAccount;
  });
}

/**
 * Installs on 12 networks with standing and 50 without. Each account gets its anchors and its "not slop" voices with
 * standing from the first group, and its other slop and dissent networks from the second, so the networks of the account
 * page add up to the parts of the account.
 */
function adminVoters(now: number, accounts: MockAccount[]): { installs: MockInstall[]; votes: MockVote[] } {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const installs: MockInstall[] = [];
  const standingNets: string[][] = [];
  const plainNets: string[][] = [];
  for (let n = 0; n < 12; n++) {
    const id = uuidOf(`install:s${n}`);
    installs.push({
      id,
      network: networkOf(n),
      createdAt: iso((9 + n * 2) * DAY),
      lastSeenAt: iso((n + 1) * 11 * 60_000),
      // The last one has standing in the stored state, but its reputation fell: the next run takes it away.
      reputation: n === 11 ? 0.55 : Math.round((0.62 + n * 0.03) * 100) / 100,
      extVersion: n % 3 === 0 ? '1.1.4' : '1.2.0',
      bannedAt: null,
      trusted: n < 2,
      standing: true,
      goodMarks: n < 2 ? 1 : 3 + (n % 5),
    });
    const net = [id];
    if (n === 2) {
      // A shared address: one more install without standing on the same network.
      const other = uuidOf('install:s2b');
      installs.push({ id: other, network: networkOf(n), createdAt: iso(2 * DAY), lastSeenAt: iso(HOUR), reputation: 0.5, extVersion: '1.2.0', bannedAt: null, trusted: false, standing: false, goodMarks: 0 });
    }
    standingNets.push(net);
  }
  for (let n = 0; n < 50; n++) {
    const net: string[] = [];
    for (let k = 0; k < (n % 4 === 0 ? 2 : 1); k++) {
      const id = uuidOf(`install:p${n}:${k}`);
      net.push(id);
      installs.push({
        id,
        network: networkOf(100 + n),
        createdAt: n === 49 ? iso(HOUR) : n === 0 ? iso((12 + k) * DAY) : iso(((n * 13 + k * 5) % 40) * DAY + (n % 7) * HOUR + HOUR),
        lastSeenAt: iso(((n * 7) % 30) * HOUR + 60_000),
        // The first one meets every check without standing yet: the next run gives it standing.
        reputation: n === 0 ? 0.65 : n === 49 ? 0.05 : Math.round((0.3 + ((n * 17) % 30) / 100) * 100) / 100,
        extVersion: n % 5 === 0 ? '1.1.4' : '1.2.0',
        bannedAt: n === 3 && k === 0 ? iso(DAY) : null,
        trusted: false,
        standing: false,
        goodMarks: n === 0 ? 3 : n % 6 === 0 ? 1 : 0,
      });
    }
    plainNets.push(net);
  }
  const votes: MockVote[] = [];
  accounts.forEach((a, k) => {
    const p = a.parts;
    if (p.networks + p.notSlop + p.dissent === 0) return;
    let j = 0;
    const cast = (ids: string[], value: 0 | 1) => {
      for (const install of ids) {
        const votedAt = iso((((k * 17 + j * 53) % (6 * 24 * 60)) + 30) * 60_000);
        const changed = j % 7 === 3 ? new Date(Math.min(now - 60_000, Date.parse(votedAt) + 2 * HOUR)).toISOString() : votedAt;
        votes.push({ install, handle: a.handle, value, votedAt, changedAt: changed, tweetId: value === 1 ? `1850000000${String(k).padStart(3, '0')}${String(j).padStart(6, '0')}` : null });
        j++;
      }
    };
    for (let i = 0; i < p.anchors; i++) cast(standingNets[(k * 3 + i) % 12]!, 1);
    for (let i = 0; i < p.networks - p.anchors; i++) cast(plainNets[(k * 7 + i) % 50]!, 1);
    for (let i = 0; i < p.notSlop; i++) cast(standingNets[(k * 3 + p.anchors + i) % 12]!, 0);
    for (let i = 0; i < p.dissent; i++) cast(plainNets[(k * 7 + p.networks - p.anchors + i) % 50]!, 0);
  });
  return { installs, votes };
}

function adminEvents(now: number, installs: MockInstall[]): MockEvent[] {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const to = (status: string, gate: string | null, want: string | null, n: { networks: number; anchors: number; evidence: number; notSlop?: number; score: number; tier?: number }) => ({
    status,
    tier: n.tier ?? 0,
    gate,
    want,
    reason: status === 'pending' ? 'pending' : status === 'flagged' ? 'votes_flagged' : status === 'confirmed' ? 'votes_confirmed' : status,
    score: n.score,
    networks: n.networks,
    anchors: n.anchors,
    notSlop: n.notSlop ?? 0,
    dissent: 0,
    evidence: n.evidence,
  });
  const from = (status: string, gate: string | null = null, want: string | null = null, tier = 0) => ({ status, tier, gate, want });
  const status = (ms: number, subject: string, f: object, t: object): MockEvent => ({ at: iso(ms), kind: 'status', source: 'score', subject, data: { from: f, to: t } });
  const ids = installs.map((i) => i.id);
  const banned = installs.find((i) => i.bannedAt)?.id ?? ids[0]!;
  return [
    status(2 * HOUR, 'xs_auto_confirm', from('flagged', null, 'confirmed', 1), to('confirmed', null, null, { networks: 5, anchors: 3, evidence: 2, score: 80, tier: 2 })),
    status(5 * HOUR, 'xs_pending_demo', from('pending', 'standing', 'confirmed'), to('pending', 'evidence', 'confirmed', { networks: 9, anchors: 2, evidence: 0, score: 71 })),
    status(26 * HOUR, 'xs_pending_demo', from('none'), to('pending', 'standing', 'confirmed', { networks: 7, anchors: 1, evidence: 0, score: 66 })),
    status(2 * DAY, 'pendingperson', from('none'), to('flagged', 'standing', 'confirmed', { networks: 4, anchors: 1, evidence: 2, score: 61, tier: 1 })),
    status(30 * HOUR, 'xs_brake_demo', from('none'), to('pending', 'brake', 'flagged', { networks: 3, anchors: 1, evidence: 1, score: 58 })),
    status(3 * DAY, 'xs_dispute_demo', from('pending', 'standing', 'confirmed'), to('pending', 'dispute', 'confirmed', { networks: 6, anchors: 2, evidence: 2, notSlop: 1, score: 40 })),
    status(4 * DAY + HOUR, 'xs_moved_handle', from('confirmed', null, null, 2), { ...to('none', null, null, { networks: 0, anchors: 0, evidence: 0, score: 0 }), reason: 'moved' }),
    status(6 * DAY, 'xs_gone_flagged', from('none'), to('flagged', null, null, { networks: 3, anchors: 1, evidence: 1, score: 55, tier: 1 })),
    { at: iso(4 * DAY), kind: 'identity', source: 'facts', subject: 'xs_moved_handle', data: { from: 'ok', to: 'moved', xUserId: '1400000000000000100', movedTo: 'xs_new_handle' } },
    { at: iso(4 * DAY), kind: 'identity', source: 'facts', subject: 'xs_new_handle', data: { from: 'unknown', to: 'ok', xUserId: '1400000000000000100', tookFrom: 'xs_moved_handle' } },
    { at: iso(20 * HOUR), kind: 'identity', source: 'facts', subject: 'xs_gone_flagged', data: { from: 'ok', to: 'gone', xUserId: '1400000000000000070', movedTo: null } },
    { at: iso(3 * HOUR), kind: 'identity', source: 'facts', subject: 'xs_no_anchor', data: { from: 'unknown', to: 'ok', xUserId: '1400000000000000020', movedTo: null } },
    { at: iso(3 * DAY + 2 * HOUR), kind: 'identity', source: 'facts', subject: 'xs_pending_demo', data: { from: 'unknown', to: 'ok', xUserId: '1400000000000000001', movedTo: null } },
    { at: iso(7 * HOUR), kind: 'standing', source: 'score', subject: ids[5]!, data: { standing: true, reputation: 0.77, goodMarks: 3, banned: false } },
    { at: iso(DAY), kind: 'standing', source: 'score', subject: banned, data: { standing: false, reputation: 0.41, goodMarks: 0, banned: true } },
    { at: iso(2 * DAY + 3 * HOUR), kind: 'standing', source: 'score', subject: ids[8]!, data: { standing: true, reputation: 0.83, goodMarks: 4, banned: false } },
    { at: iso(5 * DAY), kind: 'standing', source: 'score', subject: ids[3]!, data: { standing: false, reputation: 0.58, goodMarks: 2, banned: false } },
  ];
}

function adminLists(now: number, accounts: MockAccount[]): ListVersion[] {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const entry = (handle: string): [string, number, number] => {
    // A joined entry was listed then: an account that left since keeps a listed tier in the old version.
    const a = accounts.find((x) => x.handle === handle);
    return a && a.tier > 0 ? [handle, a.score, a.tier] : [handle, 58, 1];
  };
  const changes: { ms: number; added: string[]; removed: string[] }[] = [
    { ms: 2 * HOUR, added: ['xs_auto_confirm'], removed: ['xs_cleared_demo'] },
    { ms: 2 * DAY, added: ['pendingperson'], removed: [] },
    { ms: 3 * DAY, added: [], removed: ['xs_cleared_many'] },
    { ms: 4 * DAY, added: ['xs_new_handle'], removed: ['xs_moved_handle'] },
    { ms: 5 * DAY, added: ['xs_admin_ok'], removed: [] },
    { ms: 6 * DAY, added: ['xs_gone_flagged', 'xs_cleared_demo'], removed: [] },
  ];
  let count = 873;
  const versions: ListVersion[] = [];
  changes.forEach((c, i) => {
    const version = 118 - i;
    versions.push({ version, generatedAt: iso(c.ms), count, from: version - 1, added: c.added.map(entry), removed: c.removed });
    count -= c.added.length - c.removed.length;
  });
  // A version with many changes: more joined than the answer lists.
  versions.push({ version: 112, generatedAt: iso(9 * DAY), count, from: null, added: Array.from({ length: 200 }, (_, i) => [`xs_seed_${String(i).padStart(3, '0')}`, 80, 2] as [string, number, number]), removed: [] });
  return versions;
}

function adminRuns(now: number): JobRun[] {
  const runs: JobRun[] = [];
  let id = 1;
  for (let i = 0; i < 120; i++) {
    const end = now - 3 * 60_000 - i * 5 * 60_000;
    const failed = i === 7;
    const ms = 1800 + ((i * 337) % 2400);
    runs.push({
      id: id++,
      job: 'score',
      startedAt: new Date(end - ms).toISOString(),
      endedAt: new Date(end).toISOString(),
      ok: !failed,
      detail: failed
        ? { error: 'canceling statement due to statement timeout' }
        : { accounts: 1180 + (i % 9), listed: 876, version: 118, listChanged: i === 23, ms, accountsChanged: i % 4, installs: 87, votesHeld: i % 11 === 0 ? 3 : 0, struckNetworks: 2, pending: 7, standingInstalls: 12, model: { epochs: 40 + (i % 30) } },
    });
  }
  for (let i = 0; i < 160; i++) {
    const end = now - 60_000 - i * 2 * 60_000;
    const failed = i === 4 || i === 61;
    const ms = 20_000 + ((i * 7919) % 90_000);
    runs.push({
      id: id++,
      job: 'profiles',
      startedAt: new Date(end - ms).toISOString(),
      endedAt: new Date(end).toISOString(),
      ok: !failed,
      detail: failed
        ? { error: i === 4 ? 'fetch failed: api.fxtwitter.com answered 503' : 'The operation was aborted due to timeout' }
        : { picked: 8 + (i % 12), requests: 14 + (i % 20), ok: 12 + (i % 15), avatars: i % 3, missing: i % 4, failed: i % 9 === 0 ? 1 : 0, evidence: i % 5, verified: (i * 3) % 15, deleted: i % 13 === 0 ? 1 : 0, renamed: i === 30 ? 1 : 0, stopped: i === 12 ? 'deadline' : null, ms },
    });
  }
  return runs;
}

function adminLog(now: number, installs: MockInstall[]): LogEntry[] {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const session = '0123456789abcdef';
  const banned = installs.find((i) => i.bannedAt)?.id ?? '';
  const entries: LogEntry[] = [
    { id: 6, at: iso(2 * HOUR), session, action: 'clear', target: 'xs_cleared_demo', before: { account: { status: 'flagged', tier: 1, override: null, clearPenalty: true, protected: false } }, after: { account: { status: 'cleared', tier: 0, override: 'clear', clearPenalty: true, protected: false }, list: { version: 118, changed: true } } },
    { id: 5, at: iso(2 * HOUR + 60_000), session, action: 'login', target: session, before: null, after: null },
    { id: 4, at: iso(DAY), session: 'fedcba9876543210', action: 'ban', target: banned, before: { install: { banned_at: null, trusted: false } }, after: { id: banned, bannedAt: iso(DAY), trusted: false } },
    { id: 3, at: iso(3 * DAY), session: 'fedcba9876543210', action: 'clear', target: 'xs_cleared_many', before: { account: { status: 'confirmed', tier: 2, override: null, clearPenalty: true } }, after: { account: { status: 'cleared', tier: 0, override: 'clear', clearPenalty: false }, list: { version: 116, changed: true } } },
    { id: 2, at: iso(5 * DAY), session: 'aa11bb22cc33dd44', action: 'confirm', target: 'xs_admin_ok', before: { account: { status: 'pending', tier: 0, override: null }, clearedVotes: [] }, after: { account: { status: 'confirmed', tier: 2, override: 'confirm' }, list: { version: 114, changed: true } } },
    { id: 1, at: iso(5 * DAY + HOUR), session: 'aa11bb22cc33dd44', action: 'protect', target: 'xs_admin_ok', before: { account: { protected: false } }, after: { account: { protected: true } } },
  ];
  // A login on most mornings of the last two weeks, each with its logout, so the feed has more than one page.
  for (let d = 1; d <= 14; d++) {
    if (d % 5 === 0) continue;
    const day = sha(`session:${d}`).slice(0, 16);
    entries.push({ id: 0, at: iso(d * DAY + 9 * HOUR), session: day, action: 'login', target: day, before: null, after: null });
    entries.push({ id: 0, at: iso(d * DAY + 8 * HOUR + 20 * 60_000), session: day, action: 'logout', target: day, before: null, after: null });
  }
  entries.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  return entries.map((e, i) => ({ ...e, id: entries.length - i }));
}

// Admin answers of SPEC 14.2, built from the state on each request.

const ACTIVITY_KINDS = ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run', 'vote', 'install'];
const ACTIVITY_DEFAULT = ACTIVITY_KINDS.filter((k) => k !== 'vote' && k !== 'install');
const isSubject = (v: string) => /^[a-z0-9_]{1,15}$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

interface ActivityItem {
  key: string;
  at: string;
  kind: string;
  source: string;
  subject: string | null;
  data: Record<string, unknown>;
}

/** Every activity item, newest first, with a stable key. */
function activityOf(state: MockState, now: number): ActivityItem[] {
  const installs = new Map(state.installs.map((i) => [i.id, i]));
  const items: ActivityItem[] = [
    ...state.adminLog.map((e) => ({ key: `admin:${e.id}`, at: e.at, kind: 'admin', source: 'admin', subject: e.target, data: { action: e.action, session: e.session, before: e.before, after: e.after } })),
    ...state.events.map((e, i) => ({ key: `event:${i}`, at: e.at, kind: e.kind, source: e.source, subject: e.subject, data: e.data })),
    ...state.lists.map((v) => ({
      key: `list:${v.version}`,
      at: v.generatedAt,
      kind: 'list',
      source: 'list',
      subject: String(v.version),
      data: { version: v.version, count: v.count, from: v.from, added: v.added.slice(0, 20), addedCount: v.added.length, removed: v.removed.slice(0, 20), removedCount: v.removed.length },
    })),
    ...state.appeals.map((a) => ({ key: `appeal:${a.id}`, at: a.createdAt, kind: 'appeal', source: 'public', subject: a.handle, data: { appealId: a.id, status: a.status } })),
    ...state.jobRuns.filter((r) => !r.ok).map((r) => ({ key: `run:${r.id}`, at: r.endedAt, kind: 'run', source: r.job, subject: null, data: { job: r.job, ok: false, error: r.detail.error ?? null, ms: Date.parse(r.endedAt) - Date.parse(r.startedAt) } })),
    ...state.votes.map((v) => ({ key: `vote:${v.install}:${v.handle}`, at: v.changedAt, kind: 'vote', source: 'public', subject: v.handle, data: { install: v.install, network: installs.get(v.install)?.network ?? null, value: v.value, first: v.changedAt === v.votedAt } })),
    ...state.installs.map((i) => ({ key: `install:${i.id}`, at: i.createdAt, kind: 'install', source: 'public', subject: i.id, data: { network: i.network, extVersion: i.extVersion } })),
  ];
  return items.filter((i) => Date.parse(i.at) <= now + 60_000).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.key.localeCompare(a.key));
}

/** The networks of the slop voters that are not banned: the exact count that ban-voters checks and bans (13.12). */
function banNetworksOf(state: MockState, handle: string): number {
  const installs = new Map(state.installs.map((i) => [i.id, i]));
  return new Set(state.votes.filter((v) => v.handle === handle && v.value === 1 && !installs.get(v.install)?.bannedAt).map((v) => installs.get(v.install)?.network)).size;
}

function queue(state: MockState, name: 'pending' | 'disputed' | 'auto'): MockAccount[] {
  const all = [...state.accounts.values()];
  if (name === 'pending') return all.filter((a) => a.status === 'pending').sort((a, b) => b.parts.anchors - a.parts.anchors || b.parts.evidence - a.parts.evidence || b.parts.trust - a.parts.trust || a.handle.localeCompare(b.handle));
  if (name === 'disputed') return all.filter((a) => (a.seed && a.parts.disputed) || ((a.status === 'flagged' || a.status === 'confirmed') && a.parts.dissent >= 3)).sort((a, b) => b.parts.dissent - a.parts.dissent);
  const weekAgo = Date.now() - 7 * DAY;
  return all.filter((a) => a.status === 'confirmed' && !a.override && !a.seed && a.confirmedAt !== null && Date.parse(a.confirmedAt) > weekAgo).sort((a, b) => Date.parse(b.confirmedAt ?? '') - Date.parse(a.confirmedAt ?? ''));
}

const okPosts = (a: MockAccount) => a.evidence.filter((e) => !a.badPosts.includes(e.tweetId)).slice(0, 3).map(({ tweetId, at }) => ({ tweetId, at }));

function reviewItem(state: MockState, a: MockAccount) {
  const votes = state.votes.filter((v) => v.handle === a.handle);
  const p = a.parts;
  return {
    handle: a.handle,
    name: a.name,
    followers: a.followers,
    xUserId: a.xUserId,
    identity: a.identity,
    status: a.status,
    want: p.want,
    gate: p.gate,
    networks: p.networks,
    anchors: p.anchors,
    notSlop: p.notSlop,
    dissent: p.dissent,
    trust: p.trust,
    score: a.score,
    seed: a.seed,
    protected: a.protected,
    behaviour: p.behaviour,
    sightings: p.sightings,
    fastReplyShare: p.fastReplyShare,
    evidence: okPosts(a),
    banNetworks: banNetworksOf(state, a.handle),
    firstVoteAt: votes.map((v) => v.votedAt).sort()[0] ?? null,
    lastVoteAt: votes.map((v) => v.changedAt).sort().at(-1) ?? null,
  };
}

function accountRow(state: MockState, a: MockAccount) {
  return {
    handle: a.handle,
    displayHandle: a.handle,
    status: a.status,
    tier: a.tier,
    score: a.score,
    seed: a.seed,
    override: a.override,
    overrideAt: a.overrideAt,
    clearPenalty: a.clearPenalty,
    clearedAt: a.clearedAt,
    protected: a.protected,
    identity: a.identity,
    xUserId: a.xUserId,
    updatedAt: a.updatedAt,
    parts: a.parts,
    banNetworks: banNetworksOf(state, a.handle),
    name: a.name,
    followers: a.followers,
    listedAt: a.listedAt,
  };
}

function clearAccount(a: MockAccount, penalty: boolean, now: number): void {
  const at = new Date(now).toISOString();
  Object.assign(a, { status: 'cleared', tier: 0, score: 0, override: 'clear', overrideAt: at, clearedAt: at, clearPenalty: a.seed ? false : penalty });
  a.parts = { ...a.parts, reason: 'override_clear', gate: null, want: null, disputed: false };
}

/** A confirm or a clear publishes the list in the same request (13.7): a new version with the change. */
function publish(state: MockState, a: MockAccount, now: number): { version: number; changed: boolean } {
  const prev = state.lists[0];
  const listed = a.status === 'confirmed' || a.status === 'flagged';
  const version = (prev?.version ?? 0) + 1;
  const count = (prev?.count ?? 0) + (listed ? 1 : -1);
  state.lists.unshift({ version, generatedAt: new Date(now).toISOString(), count, from: prev?.version ?? null, added: listed ? [[a.handle, a.score, a.tier]] : [], removed: listed ? [] : [a.handle] });
  return { version, changed: true };
}

function accountDetail(state: MockState, a: MockAccount, now: number) {
  const installs = new Map(state.installs.map((i) => [i.id, i]));
  const votes = state.votes.filter((v) => v.handle === a.handle);
  const byNetwork = new Map<string, MockVote[]>();
  for (const v of votes) {
    const net = installs.get(v.install)?.network ?? 'unknown';
    byNetwork.set(net, [...(byNetwork.get(net) ?? []), v]);
  }
  const networks = [...byNetwork.entries()].map(([network, list]) => {
    const withStanding = list.filter((v) => installs.get(v.install)?.standing && !installs.get(v.install)?.bannedAt);
    const voters = withStanding.length ? withStanding : list;
    const slop = voters.filter((v) => v.value === 1).length;
    const voice = slop * 2 > voters.length ? 'slop' : slop * 2 < voters.length ? 'not_slop' : 'split';
    return {
      network,
      voice,
      standing: withStanding.length > 0,
      installs: list.map((v) => {
        const i = installs.get(v.install);
        return { id: v.install, value: v.value, standing: i?.standing ?? false, trusted: i?.trusted ?? false, banned: Boolean(i?.bannedAt), reputation: i?.reputation ?? 0.5, votedAt: v.votedAt, changedAt: v.changedAt, tweetId: v.tweetId };
      }),
    };
  });
  networks.sort((x, y) => (x.voice === y.voice ? Number(y.standing) - Number(x.standing) : x.voice === 'slop' ? -1 : y.voice === 'slop' ? 1 : 0));
  const listed = (a.status === 'flagged' || a.status === 'confirmed') && a.tier >= 1 && a.identity !== 'moved';
  const newest = state.lists[0];
  const sightings = Array.from({ length: Math.min(a.sightings, 20) }, (_, i) => ({
    tweetId: `1860000000${String(i).padStart(9, '0')}`,
    parentTweetId: `1859000000${String(i).padStart(9, '0')}`,
    replyAt: new Date(now - (i * 3 + 1) * HOUR - i * 61_000).toISOString(),
    latencySec: ((i * 37) % 90) + 4,
    verified: i < a.parts.sightings,
  }));
  const penaltyRows = a.clearedAt !== null && a.clearPenalty ? votes : [];
  const timeline = activityOf(state, now).filter((i) => (['admin', 'status', 'identity', 'appeal'].includes(i.kind) && i.subject === a.handle) || (i.kind === 'list' && state.lists.some((v) => String(v.version) === i.subject && (v.added.some(([h]) => h === a.handle) || v.removed.includes(a.handle)))));
  return {
    account: { ...accountRow(state, a), firstSeenAt: a.firstSeenAt, listedAt: a.listedAt, confirmedAt: a.confirmedAt, identityAt: a.identityAt, movedTo: a.movedTo, seedSource: a.seedSource },
    profile: a.followers === null && a.name === null ? null : { xId: a.xUserId, name: a.name, followers: a.followers, gone: a.identity === 'gone', misses: a.identity === 'gone' ? 5 : 0, fetchedAt: a.identityAt ?? a.updatedAt, avatar: a.avatar },
    list: newest ? { version: newest.version, inList: listed, score: listed ? a.score : 0, tier: listed ? a.tier : 0 } : null,
    votes: { slop: votes.filter((v) => v.value === 1).length, notSlop: votes.filter((v) => v.value === 0).length, truncated: false, networks },
    evidence: a.evidence.map((e) => ({ tweetId: e.tweetId, ok: !a.badPosts.includes(e.tweetId), checkedAt: e.at, matchesId: !a.badPosts.includes(e.tweetId) })),
    sightings: { stored: a.sightings, verified: a.parts.sightings, recent: sightings },
    clearedVotes: { rows: penaltyRows.length, networks: new Set(penaltyRows.map((v) => installs.get(v.install)?.network)).size, slopNetworks: new Set(penaltyRows.filter((v) => v.value === 1).map((v) => installs.get(v.install)?.network)).size, clearedAt: penaltyRows.length ? a.clearedAt : null },
    appeals: state.appeals.filter((x) => x.handle === a.handle).map((x) => ({ appealId: x.id, status: x.status, createdAt: x.createdAt, decidedAt: x.decidedAt, note: x.note, message: x.message, email: x.email, code: x.code })),
    timeline: timeline.slice(0, 200),
  };
}

function installRow(state: MockState, i: MockInstall) {
  const votes = state.votes.filter((v) => v.install === i.id);
  const slop = votes.filter((v) => v.value === 1).length;
  return {
    id: i.id,
    createdAt: i.createdAt,
    reputation: i.reputation,
    bannedAt: i.bannedAt,
    lastSeenAt: i.lastSeenAt,
    extVersion: i.extVersion,
    trusted: i.trusted,
    standing: i.standing,
    goodMarks: i.goodMarks,
    votes: votes.length,
    slopVotes: slop,
    notSlopVotes: votes.length - slop,
    sameNetwork: state.installs.filter((j) => j.network === i.network).length,
    network: i.network,
  };
}

function installDetail(state: MockState, i: MockInstall, now: number) {
  const votes = state.votes.filter((v) => v.install === i.id).sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
  const mates = state.installs.filter((j) => j.network === i.network);
  const mateIds = new Set(mates.map((j) => j.id));
  const strikes = [...state.accounts.values()]
    .filter((a) => a.override === 'clear' && a.clearPenalty && state.votes.some((v) => v.handle === a.handle && v.value === 1 && mateIds.has(v.install)))
    .map((a) => ({ handle: a.handle, clearedAt: a.clearedAt, standing: mates.some((j) => j.standing && state.votes.some((v) => v.handle === a.handle && v.install === j.id && v.value === 1)) }));
  return {
    install: installRow(state, i),
    standing: {
      has: i.standing && !i.bannedAt,
      trusted: i.trusted,
      banned: Boolean(i.bannedAt),
      ageDays: Math.round(((now - Date.parse(i.createdAt)) / DAY) * 10) / 10,
      goodMarks: i.goodMarks,
      reputation: i.reputation,
      needs: { ageDays: RULES.standingMinAgeDays, goodMarks: RULES.standingMinGoodMarks, reputation: RULES.standingMinReputation },
    },
    votes: { total: votes.length, items: votes.slice(0, 200).map((v) => ({ handle: v.handle, value: v.value, votedAt: v.votedAt, changedAt: v.changedAt, tweetId: v.tweetId, accountStatus: state.accounts.get(v.handle)?.status ?? 'none' })) },
    network: { network: i.network, installs: mates.length, banned: mates.filter((j) => j.bannedAt).length, strikes },
    timeline: activityOf(state, now).filter((x) => (x.kind === 'admin' || x.kind === 'standing') && x.subject === i.id).slice(0, 200),
  };
}

export function defaultState(overrides: Partial<Scenario> = {}): MockState {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const list = adminAccounts(now);
  const { installs, votes } = adminVoters(now, list);
  return {
    scenario: { stats: 'ok', latest: 'ok', sloppers: 'ok', criteria: 'ok', powBits: 12, adminUser: 'operator', adminPassword: 'correct horse battery staple 42', adminCode: null, ...overrides },
    accounts: new Map(list.map((a) => [a.handle, a])),
    sloppers: mockSloppers(812, 64),
    appeals: [
      { id: randomUUID(), network: 'elsewhere', handle: 'pendingperson', email: 'p@example.com', message: 'I write every reply myself. Please check my timeline.', code: 'xslop-AB12CD', status: 'open', createdAt: iso(5_400_000), decidedAt: null, note: null, marks: { networks: 4, strikes: 3 }, penalty: null },
      { id: uuidOf('appeal:accepted'), network: 'elsewhere', handle: 'xs_cleared_many', email: null, message: 'A tool posted for me for one week. I removed it, and every reply since then is my own.', code: 'xslop-9F3E21', status: 'accepted', createdAt: iso(4 * DAY), decidedAt: iso(3 * DAY), note: 'Bio code found. Replies after the date look human.', marks: { networks: 14, strikes: 0 }, penalty: false },
      { id: uuidOf('appeal:rejected'), network: 'elsewhere', handle: 'xs_admin_ok', email: 'owner@example.com', message: 'These are my own words. I only reply fast because I like the topics.', code: 'xslop-77AA10', status: 'rejected', createdAt: iso(4 * DAY + 3 * HOUR), decidedAt: iso(4 * DAY), note: 'No code in the bio after two days.', marks: { networks: 3, strikes: 0 }, penalty: null },
    ],
    installs,
    votes,
    events: adminEvents(now, installs),
    lists: adminLists(now, list),
    jobRuns: adminRuns(now),
    adminLog: adminLog(now, installs),
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
      const session = createHash('sha256').update(token).digest('hex').slice(0, 16);
      state.adminLog.unshift({ id: (state.adminLog[0]?.id ?? 0) + 1, at: new Date().toISOString(), session, action: 'login', target: session, before: null, after: null });
      return json(res, 200, { csrf }, { 'set-cookie': `xs_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
    }
    const token = cookie(req, 'xs_admin');
    const csrf = token ? state.sessions.get(token) : undefined;
    if (!token || !csrf) return error(res, 401, 'unauthorized', 'Log in first.');
    if (method !== 'GET' && (req.headers['x-csrf'] !== csrf || req.headers.origin !== origin)) return error(res, 403, 'bad_csrf', 'CSRF check failed.');
    const session = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const logChange = (action: string, target: string, before: unknown, after: unknown) =>
      state.adminLog.unshift({ id: (state.adminLog[0]?.id ?? 0) + 1, at: new Date().toISOString(), session, action, target, before, after });
    const params = url.searchParams;
    /** Unknown query keys answer 400, as the real routes with additionalProperties:false do (14.2). */
    const onlyParams = (...keys: string[]) => [...params.keys()].every((k) => keys.includes(k));
    const limitOf = (fallback: number, max: number): number | null => {
      const raw = params.get('limit');
      if (raw === null) return fallback;
      return LIMIT.test(raw) && Number(raw) >= 1 && Number(raw) <= max ? Number(raw) : null;
    };
    const now = Date.now();
    const installs = new Map(state.installs.map((i) => [i.id, i]));
    const accountsAll = [...state.accounts.values()];

    if (method === 'GET' && path === '/api/admin/session') return json(res, 200, { user: s.adminUser, csrf });
    if (method === 'POST' && path === '/api/admin/logout') {
      logChange('logout', session, null, null);
      state.sessions.delete(token);
      return json(res, 204, null, { 'set-cookie': 'xs_admin=; Path=/; Max-Age=0' });
    }
    if (method === 'GET' && path === '/api/admin/overview') {
      if (!onlyParams()) return error(res, 400, 'bad_query', 'Unknown parameter.');
      const by = (st: AccountStatus) => accountsAll.filter((a) => a.status === st).length;
      const in24 = (at: string) => now - Date.parse(at) <= DAY;
      const job = (name: JobRun['job']) => {
        const runs = state.jobRuns.filter((r) => r.job === name).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
        const last = runs[0];
        const ok = runs.find((r) => r.ok);
        return { lastRunAt: last?.endedAt ?? null, lastOkAt: ok?.endedAt ?? null, detail: last?.detail ?? null, runs24h: runs.filter((r) => in24(r.endedAt)).length, failed24h: runs.filter((r) => !r.ok && in24(r.endedAt)).length };
      };
      const items = activityOf(state, now);
      const kindCount = (kind: string) => items.filter((i) => i.kind === kind && in24(i.at)).length;
      const votes24 = state.votes.filter((v) => in24(v.changedAt));
      const list = state.lists[0];
      return json(res, 200, {
        accounts: { confirmed: by('confirmed'), flagged: by('flagged'), pending: by('pending'), cleared: by('cleared'), seed: accountsAll.filter((a) => a.seed).length },
        votes: state.votes.length,
        installs: state.installs.length,
        bannedInstalls: state.installs.filter((i) => i.bannedAt).length,
        standingInstalls: state.installs.filter((i) => i.standing && !i.bannedAt).length,
        trustedInstalls: state.installs.filter((i) => i.trusted).length,
        sightings: 402113,
        appealsOpen: state.appeals.filter((a) => a.status === 'open').length,
        listVersion: list?.version ?? null,
        score: job('score'),
        facts: { ...job('profiles'), moved24h: state.events.filter((e) => e.kind === 'identity' && e.data.to === 'moved' && in24(e.at)).length },
        queues: { pending: queue(state, 'pending').length, disputed: queue(state, 'disputed').length, auto: queue(state, 'auto').length },
        list: list ? { version: list.version, count: list.count, generatedAt: list.generatedAt } : null,
        last24h: {
          votes: votes24.length,
          slopVotes: votes24.filter((v) => v.value === 1).length,
          notSlopVotes: votes24.filter((v) => v.value === 0).length,
          newInstalls: state.installs.filter((i) => in24(i.createdAt)).length,
          statusChanges: kindCount('status'),
          identityChanges: kindCount('identity'),
          standingChanges: kindCount('standing'),
          listVersions: kindCount('list'),
          appeals: kindCount('appeal'),
          adminActions: kindCount('admin'),
        },
        rules: RULES,
      });
    }
    if (method === 'GET' && path === '/api/admin/review') {
      const q = params.get('queue') ?? '';
      const limit = limitOf(100, 500);
      if (!onlyParams('queue', 'limit') || !['pending', 'disputed', 'auto'].includes(q) || limit === null) return error(res, 400, 'bad_query', 'Bad queue or limit.');
      const items = queue(state, q as 'pending' | 'disputed' | 'auto');
      return json(res, 200, { total: items.length, items: items.slice(0, limit).map((a) => reviewItem(state, a)) });
    }
    if (method === 'GET' && path === '/api/admin/appeals') {
      const st = params.get('status') ?? 'open';
      if (!onlyParams('status') || !['open', 'accepted', 'rejected'].includes(st)) return error(res, 400, 'bad_query', 'Bad status.');
      return json(res, 200, {
        appeals: state.appeals
          .filter((a) => a.status === st)
          .map(({ id, network: _, penalty: __, ...rest }) => {
            const acc = state.accounts.get(rest.handle);
            return { appealId: id, ...rest, account: { status: acc?.status ?? 'none', tier: acc?.tier ?? 0, score: acc?.score ?? 0, seed: acc?.seed ?? false } };
          }),
      });
    }
    const decide = /^\/api\/admin\/appeals\/([0-9a-f-]{36})\/decide$/.exec(path);
    if (method === 'POST' && decide) {
      const a = state.appeals.find((x) => x.id === decide[1]);
      const b = bodyOf(body, ['decision', 'note', 'penalty']);
      if (!a || !b || (b.decision !== 'accept' && b.decision !== 'reject')) return error(res, 400, 'bad_decision', 'Bad decision.');
      if (b.penalty !== undefined && (typeof b.penalty !== 'boolean' || b.decision !== 'accept')) return error(res, 400, 'bad_penalty', 'Bad penalty.');
      if (a.status !== 'open') return error(res, 409, 'appeal_closed', 'This appeal is already decided.');
      a.status = b.decision === 'accept' ? 'accepted' : 'rejected';
      a.decidedAt = new Date().toISOString();
      a.note = typeof b.note === 'string' ? b.note : null;
      a.penalty = b.decision === 'accept' ? b.penalty !== false : null;
      const acc = state.accounts.get(a.handle);
      const before: Record<string, unknown> = { appeal: { status: 'open' } };
      const result: Record<string, unknown> = { appealId: a.id, handle: a.handle, status: a.status, decidedAt: a.decidedAt };
      if (a.status === 'accepted' && acc) {
        before.account = accountRow(state, acc);
        clearAccount(acc, b.penalty !== false, now);
        result.list = publish(state, acc, now);
      }
      logChange(b.decision, a.id, before, result);
      return json(res, 200, result);
    }
    if (method === 'GET' && path === '/api/admin/accounts') {
      const handle = params.get('handle');
      const st = params.get('status');
      const limit = limitOf(100, 500);
      if (!onlyParams('handle', 'status', 'limit') || limit === null || (st !== null && !['none', 'pending', 'flagged', 'confirmed', 'cleared'].includes(st)) || (handle !== null && handle !== '' && !/^[a-z0-9_]{1,15}$/.test(handle))) {
        return error(res, 400, 'bad_query', 'Bad filter.');
      }
      const list = accountsAll
        .filter((a) => (!handle || a.handle.startsWith(handle)) && (!st || a.status === st))
        .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
        .slice(0, limit)
        .map((a) => accountRow(state, a));
      return json(res, 200, { accounts: list });
    }
    const accountGet = /^\/api\/admin\/accounts\/([^/]+)$/.exec(path);
    if (method === 'GET' && accountGet) {
      const handle = decodeURIComponent(accountGet[1] ?? '');
      if (!/^[a-z0-9_]{1,15}$/.test(handle)) return error(res, 400, 'bad_handle', 'The handle is not valid.');
      const a = state.accounts.get(handle);
      if (!a) return error(res, 404, 'not_found', 'No account has this handle.');
      return json(res, 200, accountDetail(state, a, now));
    }
    const banVoters = /^\/api\/admin\/accounts\/([a-z0-9_]{1,15})\/ban-voters$/.exec(path);
    if (method === 'POST' && banVoters) {
      const handle = banVoters[1] ?? '';
      const acc = state.accounts.get(handle);
      if (!acc) return error(res, 404, 'not_found', 'No account has this handle.');
      if (!bodyOf(body, [])) return error(res, 400, 'bad_request', 'The body takes no field.');
      if (banNetworksOf(state, handle) > RULES.strikeMaxCrowd) return error(res, 409, 'crowd_too_large', 'More than 10 networks marked this account. Ban single installs instead.');
      const ids = [...new Set(state.votes.filter((v) => v.handle === handle && v.value === 1).map((v) => v.install))].filter((id) => !installs.get(id)?.bannedAt);
      for (const id of ids) installs.get(id)!.bannedAt = new Date(now).toISOString();
      logChange('ban-voters', handle, { unbannedInstalls: ids }, { banned: ids.length });
      return json(res, 200, { banned: ids.length });
    }
    const accountAction = /^\/api\/admin\/accounts\/([a-z0-9_]{1,15})$/.exec(path);
    if (method === 'POST' && accountAction) {
      const handle = accountAction[1] ?? '';
      const b = bodyOf(body, ['action', 'penalty']);
      const action = b?.action;
      if (!b || typeof action !== 'string' || !['confirm', 'clear', 'reset', 'protect', 'unprotect'].includes(action)) return error(res, 400, 'bad_action', 'Bad action.');
      if (b.penalty !== undefined && (typeof b.penalty !== 'boolean' || action !== 'clear')) return error(res, 400, 'bad_penalty', 'Bad penalty.');
      const acc = state.accounts.get(handle);
      if (!acc) return error(res, 404, 'not_found', 'No account has this handle.');
      const before = { account: accountRow(state, acc) };
      const at = new Date(now).toISOString();
      let list: unknown;
      if (action === 'confirm') {
        Object.assign(acc, { status: 'confirmed', tier: 2, score: 100, override: 'confirm', overrideAt: at, listedAt: acc.listedAt ?? at, confirmedAt: acc.confirmedAt ?? at, clearedAt: null });
        acc.parts = { ...acc.parts, reason: 'override_confirm', gate: null, want: null, disputed: false };
        list = publish(state, acc, now);
      }
      if (action === 'clear') {
        clearAccount(acc, b.penalty !== false, now);
        list = publish(state, acc, now);
      }
      if (action === 'reset') Object.assign(acc, { override: null, overrideAt: null });
      if (action === 'protect' || action === 'unprotect') acc.protected = action === 'protect';
      acc.updatedAt = at;
      const after = { account: accountRow(state, acc), ...(list ? { list } : {}) };
      logChange(action, handle, before, after);
      return json(res, 200, after);
    }
    if (method === 'GET' && path === '/api/admin/installs') {
      const sort = params.get('sort') ?? 'reputation';
      const limit = limitOf(100, 500);
      if (!onlyParams('sort', 'limit') || !['reputation', 'created', 'votes'].includes(sort) || limit === null) return error(res, 400, 'bad_query', 'Bad sort or limit.');
      const list = state.installs.map((i) => installRow(state, i));
      list.sort((a, b) => (sort === 'created' ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : sort === 'votes' ? b.votes - a.votes || Date.parse(b.createdAt) - Date.parse(a.createdAt) : a.reputation - b.reputation || Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      return json(res, 200, { installs: list.slice(0, limit) });
    }
    const installGet = /^\/api\/admin\/installs\/([^/]+)$/.exec(path);
    if (method === 'GET' && installGet) {
      const id = decodeURIComponent(installGet[1] ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return error(res, 400, 'bad_request', 'The id is not valid.');
      const inst = installs.get(id);
      if (!inst) return error(res, 404, 'not_found', 'No install has this id.');
      return json(res, 200, installDetail(state, inst, now));
    }
    const installAction = /^\/api\/admin\/installs\/([0-9a-f-]{36})\/(trust|untrust|ban|unban)$/.exec(path);
    if (method === 'POST' && installAction) {
      const inst = installs.get(installAction[1] ?? '');
      if (!inst) return error(res, 404, 'not_found', 'Unknown install.');
      if (!bodyOf(body, [])) return error(res, 400, 'bad_request', 'The body takes no field.');
      const action = installAction[2] ?? '';
      const before = { install: { banned_at: inst.bannedAt, trusted: inst.trusted } };
      if (action === 'trust' || action === 'untrust') inst.trusted = action === 'trust';
      else inst.bannedAt = action === 'ban' ? new Date(now).toISOString() : null;
      const after = { id: inst.id, trusted: inst.trusted, bannedAt: inst.bannedAt };
      logChange(action, inst.id, before, after);
      return json(res, 200, after);
    }
    if (method === 'GET' && path === '/api/admin/log') {
      const limit = limitOf(100, 500);
      if (!onlyParams('limit') || limit === null) return error(res, 400, 'bad_query', 'Bad limit.');
      return json(res, 200, { entries: state.adminLog.slice(0, limit) });
    }
    if (method === 'GET' && path === '/api/admin/activity') {
      const limit = limitOf(100, 200);
      const kindsRaw = params.get('kinds');
      const kinds = kindsRaw === null ? ACTIVITY_DEFAULT : kindsRaw.split(',');
      const subject = params.get('subject');
      const cursor = params.get('cursor');
      if (!onlyParams('kinds', 'subject', 'cursor', 'limit') || limit === null || kinds.some((k) => !ACTIVITY_KINDS.includes(k)) || (subject !== null && !isSubject(subject))) return error(res, 400, 'bad_request', 'Bad filter.');
      if (cursor !== null && !/^o\.[0-9]{1,6}$/.test(cursor)) return error(res, 400, 'bad_request', 'Bad cursor.');
      const start = cursor === null ? 0 : Number(cursor.slice(2));
      const all = activityOf(state, now).filter((i) => kinds.includes(i.kind) && (subject === null || i.subject === subject || (i.kind === 'vote' && i.data.install === subject)));
      const items = all.slice(start, start + limit);
      return json(res, 200, { items, next: start + items.length < all.length ? `o.${start + items.length}` : null });
    }
    if (method === 'GET' && path === '/api/admin/lists') {
      const limit = limitOf(30, 60);
      if (!onlyParams('limit') || limit === null) return error(res, 400, 'bad_query', 'Bad limit.');
      return json(res, 200, { versions: state.lists.slice(0, limit).map((v) => ({ ...v, added: v.added.slice(0, 200), addedCount: v.added.length + (v.version === 112 ? 61 : 0), removed: v.removed.slice(0, 200), removedCount: v.removed.length })) });
    }
    if (method === 'GET' && path === '/api/admin/jobs') {
      const job = params.get('job');
      const limit = limitOf(100, 500);
      if (!onlyParams('job', 'limit') || limit === null || (job !== null && job !== 'score' && job !== 'profiles')) return error(res, 400, 'bad_query', 'Bad job or limit.');
      const runs = state.jobRuns.filter((r) => job === null || r.job === job).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      const last = runs[0];
      return json(res, 200, {
        runs: runs.slice(0, limit).map((r) => ({ ...r, ms: Date.parse(r.endedAt) - Date.parse(r.startedAt) })),
        last: { lastRunAt: last?.endedAt ?? null, lastOkAt: runs.find((r) => r.ok)?.endedAt ?? null, detail: last?.detail ?? null },
      });
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
