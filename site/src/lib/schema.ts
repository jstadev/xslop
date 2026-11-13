// Response validation for the public API (SPEC 5.5, 5.7, 12.5). Nothing reaches the page unvalidated.

import { badShape } from './api.ts';
import { isHandle } from './handle.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isShare = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

export interface Stats {
  confirmed: number;
  flagged: number;
  votes: number;
  installs: number;
  sightings: number;
  generatedAt: string;
}

export function parseStats(v: unknown): Stats {
  if (!isObj(v)) throw badShape('stats');
  const { confirmed, flagged, votes, installs, sightings, generatedAt } = v;
  if (!isCount(confirmed) || !isCount(flagged) || !isCount(votes) || !isCount(installs) || !isCount(sightings) || !isIso(generatedAt)) {
    throw badShape('stats');
  }
  return { confirmed, flagged, votes, installs, sightings, generatedAt };
}

export interface Download {
  file: string;
  sha256: string;
  bytes: number;
}

export interface Latest {
  version: string;
  chrome: Download | null;
  firefox: Download | null;
  safari: Download | null;
  chromeStoreUrl: string | null;
  firefoxUrl: string | null;
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
type Target = 'chrome' | 'firefox' | 'safari';
const ZIP: Record<Target, RegExp> = {
  chrome: /^xslop-chrome-v[0-9]+\.[0-9]+\.[0-9]+\.zip$/,
  firefox: /^xslop-firefox-v[0-9]+\.[0-9]+\.[0-9]+\.zip$/,
  safari: /^xslop-safari-v[0-9]+\.[0-9]+\.[0-9]+\.zip$/,
};

function parseDownload(v: unknown, target: Target): Download | null {
  if (!isObj(v)) return null;
  const { file, sha256, bytes } = v;
  if (typeof file !== 'string' || !ZIP[target].test(file)) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (!isCount(bytes) || bytes === 0) return null;
  return { file, sha256, bytes };
}

/** Accepts a store URL only on its exact host, over https. */
function storeUrl(v: unknown, host: string): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function parseLatest(v: unknown): Latest {
  if (!isObj(v) || typeof v.version !== 'string' || !VERSION.test(v.version)) throw badShape('the download list');
  return {
    version: v.version,
    chrome: parseDownload(v.chrome, 'chrome'),
    firefox: parseDownload(v.firefox, 'firefox'),
    safari: parseDownload(v.safari, 'safari'),
    chromeStoreUrl: storeUrl(v.chromeStoreUrl, 'chromewebstore.google.com'),
    firefoxUrl: storeUrl(v.firefoxUrl, 'addons.mozilla.org'),
  };
}

/** 13.8: an account that is not flagged or confirmed answers `none`, with no numbers. */
export type AccountStatus = 'none' | 'flagged' | 'confirmed';

/** One post that people marked as slop. The API never serves the text that a voter sent, and the page never reads it. */
interface Evidence {
  tweetId: string;
  at: string;
}

export interface Account {
  handle: string;
  status: AccountStatus;
  tier: 0 | 1 | 2;
  score: number;
  seed: boolean;
  votes: { slop: number; notSlop: number };
  sightings: number;
  /** Reply timing from the replies that the server checked, or null when it checked none. */
  signals: { fastReplyShare: number; replies: number } | null;
  evidence: Evidence[];
  appealOpen: boolean;
}

const STATUSES: readonly AccountStatus[] = ['none', 'flagged', 'confirmed'];

export function parseAccount(v: unknown): Account {
  if (!isObj(v)) throw badShape('the account');
  const { handle, status, tier, score, seed, votes, sightings, signals, evidence, appealOpen } = v;
  if (!isHandle(handle) || !STATUSES.includes(status as AccountStatus)) throw badShape('the account');
  if (tier !== 0 && tier !== 1 && tier !== 2) throw badShape('the account');
  if (typeof score !== 'number' || score < 0 || score > 100) throw badShape('the account');
  if (typeof seed !== 'boolean' || typeof appealOpen !== 'boolean' || !isCount(sightings)) throw badShape('the account');
  if (!isObj(votes) || !isCount(votes.slop) || !isCount(votes.notSlop)) throw badShape('the account');
  let parsedSignals: Account['signals'] = null;
  if (signals !== null && signals !== undefined) {
    if (!isObj(signals) || !isShare(signals.fastReplyShare) || !isCount(signals.replies)) throw badShape('the account');
    parsedSignals = { fastReplyShare: signals.fastReplyShare, replies: signals.replies };
  }
  const items: Evidence[] = [];
  if (Array.isArray(evidence)) {
    for (const e of evidence.slice(0, 3)) {
      if (isObj(e) && typeof e.tweetId === 'string' && /^[0-9]{1,20}$/.test(e.tweetId) && isIso(e.at)) items.push({ tweetId: e.tweetId, at: e.at });
    }
  }
  return {
    handle,
    status: status as AccountStatus,
    tier,
    score,
    seed,
    votes: { slop: votes.slop, notSlop: votes.notSlop },
    sightings,
    signals: parsedSignals,
    evidence: items,
    appealOpen,
  };
}

interface Challenge {
  challenge: string;
  difficulty: number;
}

const TOKEN = /^[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,100}$/;

export function parseChallenge(v: unknown): Challenge {
  if (!isObj(v) || typeof v.challenge !== 'string' || !TOKEN.test(v.challenge)) throw badShape('the challenge');
  const { difficulty } = v;
  if (typeof difficulty !== 'number' || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 28) {
    throw badShape('the challenge');
  }
  return { challenge: v.challenge, difficulty };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^xslop-[A-Za-z0-9]{6}$/;
type AppealStatus = 'open' | 'accepted' | 'rejected';
const APPEAL_STATUSES: readonly AppealStatus[] = ['open', 'accepted', 'rejected'];

interface AppealCreated {
  appealId: string;
  code: string;
  status: AppealStatus;
}

export function parseAppealCreated(v: unknown): AppealCreated {
  if (!isObj(v) || typeof v.appealId !== 'string' || !UUID.test(v.appealId)) throw badShape('the appeal');
  if (typeof v.code !== 'string' || !CODE.test(v.code) || !APPEAL_STATUSES.includes(v.status as AppealStatus)) {
    throw badShape('the appeal');
  }
  return { appealId: v.appealId, code: v.code, status: v.status as AppealStatus };
}

interface AppealState {
  appealId: string;
  handle: string;
  status: AppealStatus;
  createdAt: string;
  decidedAt: string | null;
}

export function parseAppealState(v: unknown): AppealState {
  if (!isObj(v) || typeof v.appealId !== 'string' || !UUID.test(v.appealId) || !isHandle(v.handle)) throw badShape('the appeal');
  if (!APPEAL_STATUSES.includes(v.status as AppealStatus) || !isIso(v.createdAt)) throw badShape('the appeal');
  if (v.decidedAt !== null && v.decidedAt !== undefined && !isIso(v.decidedAt)) throw badShape('the appeal');
  return {
    appealId: v.appealId,
    handle: v.handle,
    status: v.status as AppealStatus,
    createdAt: v.createdAt,
    decidedAt: typeof v.decidedAt === 'string' ? v.decidedAt : null,
  };
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

export function isAppealCode(v: unknown): v is string {
  return typeof v === 'string' && CODE.test(v);
}

type SlopperStatus = 'flagged' | 'confirmed';

export interface Slopper {
  handle: string;
  name: string | null;
  avatar: string | null;
  followers: number | null;
  status: SlopperStatus;
  tier: 1 | 2;
  score: number;
  seed: boolean;
  votes: { slop: number; notSlop: number };
  networks: number;
  needed: number;
  listedAt: string | null;
  reason: string;
  /** The list that gave a seed account, or null (also for an older server answer). */
  seedSource: string | null;
  /** The crowd test of confirmed passes and a gate holds the account until a check. */
  waits: boolean;
  xUserId: string | null;
}

export interface SloppersPage {
  total: number;
  generatedAt: string;
  next: string | null;
  items: Slopper[];
}

const AVATAR_PATH = /^\/api\/v1\/avatars\/[a-z0-9_]{1,15}(?:\?[A-Za-z0-9=_.~-]{1,64})?$/;
const REASON = /^[a-z0-9_]{1,40}$/;
const SEED_SOURCE = /^(?:x_list:[0-9]{1,20}|site:[a-z0-9.-]{1,253})$/;
const X_ID = /^[0-9]{1,20}$/;
const NAME_MAX = 100;
const MAX_PAGE_ITEMS = 100;
const CURSOR_MAX = 512;
// Controls and bidi overrides can disguise a display name inside the surrounding line.
const NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function parseDisplayName(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  return v.replace(NAME_CONTROLS, '').trim().slice(0, NAME_MAX) || null;
}

function parseStanding(status: unknown, tier: unknown): Pick<Slopper, 'status' | 'tier'> | null {
  if (status === 'flagged' && tier === 1) return { status, tier };
  if (status === 'confirmed' && tier === 2) return { status, tier };
  return null;
}

/** One list row, or null when any field breaks the contract: one bad row must not cost the reader the whole page. */
function parseSlopper(v: unknown): Slopper | null {
  if (!isObj(v)) return null;
  const { handle, avatar, followers, score, seed, votes, networks, needed, listedAt, reason, waits, xUserId } = v;
  const name = parseDisplayName(v.name);
  const standing = parseStanding(v.status, v.tier);
  if (!isHandle(handle) || name === undefined || standing === null) return null;
  if (typeof score !== 'number' || !(score >= 0 && score <= 100) || typeof seed !== 'boolean') return null;
  if (!isObj(votes) || !isCount(votes.slop) || !isCount(votes.notSlop)) return null;
  if (!isCount(networks) || !isCount(needed)) return null;
  if (followers !== null && !isCount(followers)) return null;
  if (avatar !== null && (typeof avatar !== 'string' || !AVATAR_PATH.test(avatar))) return null;
  if (listedAt !== null && !isIso(listedAt)) return null;
  if (typeof reason !== 'string' || !REASON.test(reason)) return null;
  if (typeof waits !== 'boolean' || (xUserId !== null && (typeof xUserId !== 'string' || !X_ID.test(xUserId)))) return null;
  // A missing or odd source only loses the origin sentence; it never drops the row.
  const seedSource = typeof v.seedSource === 'string' && SEED_SOURCE.test(v.seedSource) ? v.seedSource : null;
  return { handle, name, avatar, followers, ...standing, score, seed, votes: { slop: votes.slop, notSlop: votes.notSlop }, networks, needed, listedAt, reason, seedSource, waits, xUserId };
}

export function parseSloppersPage(v: unknown): SloppersPage {
  if (!isObj(v) || !isCount(v.total) || !isIso(v.generatedAt)) throw badShape('the list');
  const { next, items } = v;
  if (next !== null && (typeof next !== 'string' || next.length === 0 || next.length > CURSOR_MAX)) throw badShape('the list');
  if (!Array.isArray(items) || items.length > MAX_PAGE_ITEMS) throw badShape('the list');
  return {
    total: v.total,
    generatedAt: v.generatedAt,
    next,
    items: items.flatMap((item) => parseSlopper(item) ?? []),
  };
}

export interface CriteriaTier {
  status: SlopperStatus;
  title: string;
  summary: string;
  rules: string[];
}

export interface Criteria {
  version: number;
  tiers: CriteriaTier[];
  weights: string[];
  protections: string[];
  appeal: string;
}

const CRITERIA_TEXT_MAX = 600;
const CRITERIA_LIST_MAX = 16;

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= CRITERIA_TEXT_MAX;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= CRITERIA_LIST_MAX && v.every(isText);

function parseCriteriaTier(v: unknown): CriteriaTier {
  if (!isObj(v) || (v.status !== 'flagged' && v.status !== 'confirmed')) throw badShape('the criteria');
  if (!isText(v.title) || !isText(v.summary) || !isTextList(v.rules)) throw badShape('the criteria');
  return { status: v.status, title: v.title, summary: v.summary, rules: v.rules };
}

export function parseCriteria(v: unknown): Criteria {
  if (!isObj(v) || !isCount(v.version) || !Array.isArray(v.tiers) || v.tiers.length === 0 || v.tiers.length > 4) throw badShape('the criteria');
  if (!isTextList(v.weights) || !isTextList(v.protections) || !isText(v.appeal)) throw badShape('the criteria');
  return { version: v.version, tiers: v.tiers.map(parseCriteriaTier), weights: v.weights, protections: v.protections, appeal: v.appeal };
}
