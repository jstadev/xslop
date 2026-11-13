// Validates a ScoringInput and puts it in a canonical order, so that the output
// does not depend on the order of the rows that the loader sends. A bad row
// throws, and the job keeps the previous scores (fail closed).
import type { AccountInput, AccountStatus, ClearedVoteInput, Identity, InstallInput, ScoringInput, SightingInput, VoteInput } from './types.js';

export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
export const TWEET_ID_RE = /^[0-9]{1,20}$/;
export const MAX_SIGHTINGS_PER_ACCOUNT = 50;
const SIGHTING_WINDOW_MS = 30 * 86_400_000;
const SIGHTING_MAX_FUTURE_MS = 10 * 60_000;
const MAX_ID_LENGTH = 64;
const MAX_IP_HASH_LENGTH = 128;
const STATUSES: readonly AccountStatus[] = ['none', 'pending', 'flagged', 'confirmed', 'cleared'];
const IDENTITIES: readonly Identity[] = ['unknown', 'ok', 'gone', 'moved'];

export interface PreparedInstall {
  id: string; createdAtMs: number; ipHash: string; banned: boolean; reputation: number; trusted: boolean; standing: boolean;
}
export interface PreparedAccount {
  seed: boolean;
  override: 'confirm' | 'clear' | null;
  overrideAtMs: number; // NaN = no time
  clearedAtMs: number; // NaN = never cleared
  listedAtMs: number; // NaN = not listed
  status: AccountStatus; // stored by the previous run
  identity: Identity;
  evidence: number;
  protected: boolean;
}
export interface PreparedVote { a: number; u: number; value: 0 | 1; atMs: number }
export interface PreparedClearedVote { a: number; install: string; ipHash: string; value: 0 | 1; atMs: number; clearedAtMs: number; standing: boolean }

export interface Prepared {
  nowMs: number;
  handles: string[]; // sorted, unique: accounts ∪ vote, sighting and cleared vote handles
  accounts: PreparedAccount[]; // parallel to handles
  installs: PreparedInstall[]; // sorted by id
  votes: PreparedVote[]; // votes of known installs, sorted by (account, install)
  sightings: SightingInput[][]; // per account: in the window, newest first, at most 50
  clearedVotes: PreparedClearedVote[]; // sorted by (account, install)
  autoConfirmsToday: number;
  autoFlagsToday: number;
}

const NO_STATE: Readonly<PreparedAccount> = Object.freeze({
  seed: false, override: null, overrideAtMs: Number.NaN, clearedAtMs: Number.NaN, listedAtMs: Number.NaN,
  status: 'none', identity: 'unknown', evidence: 0, protected: false,
});

function fail(path: string, rule: string): never {
  throw new TypeError(`ScoringInput.${path} ${rule}`);
}

function timeOf(value: unknown, path: string): number {
  if (!(value instanceof Date)) fail(path, 'must be a Date');
  const t = value.getTime();
  if (!Number.isFinite(t)) fail(path, 'must be a valid Date');
  return t;
}

const timeOrNull = (value: unknown, path: string): number => (value === null ? Number.NaN : timeOf(value, path));

function rows(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function row<T>(value: unknown, path: string): Partial<T> {
  if (typeof value !== 'object' || value === null) fail(path, 'must be an object');
  return value as Partial<T>;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, 'must be an integer of 0 or more');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) fail(path, `must be one of ${allowed.join(', ')}`);
  return value as T;
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) fail(path, 'must be a string of 1 to 64 chars');
  return value;
}

function ipHash(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > MAX_IP_HASH_LENGTH) fail(path, 'must be a string of at most 128 chars');
  return value;
}

function handleOf(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HANDLE_RE.test(value)) fail(path, 'must match ^[a-z0-9_]{1,15}$');
  return value;
}

function voteValue(value: unknown, path: string): 0 | 1 {
  if (value !== 0 && value !== 1) fail(path, 'must be 0 or 1');
  return value;
}

const byKey = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

export function prepareInput(input: ScoringInput): Prepared {
  const top = row<ScoringInput>(input, 'input');
  const nowMs = timeOf(top.now, 'now');
  const autoConfirmsToday = count(top.autoConfirmsToday, 'autoConfirmsToday');
  const autoFlagsToday = count(top.autoFlagsToday, 'autoFlagsToday');
  const handleSet = new Set<string>();

  const installIds = new Set<string>();
  const installs = rows(top.installs, 'installs').map((value, i): PreparedInstall => {
    const p = `installs[${i}]`;
    const r = row<InstallInput>(value, p);
    const installId = id(r.id, `${p}.id`);
    if (installIds.has(installId)) fail(`${p}.id`, 'is a duplicate');
    installIds.add(installId);
    if (typeof r.reputation !== 'number' || !Number.isFinite(r.reputation)) fail(`${p}.reputation`, 'must be a finite number');
    return {
      id: installId, createdAtMs: timeOf(r.createdAt, `${p}.createdAt`), ipHash: ipHash(r.ipHash, `${p}.ipHash`), banned: bool(r.banned, `${p}.banned`),
      reputation: r.reputation, trusted: bool(r.trusted, `${p}.trusted`), standing: bool(r.standing, `${p}.standing`),
    };
  });
  installs.sort((x, y) => byKey(x.id, y.id));
  const installIndex = new Map<string, number>();
  installs.forEach((ins, i) => installIndex.set(ins.id, i));

  const accountRows = new Map<string, PreparedAccount>();
  rows(top.accounts, 'accounts').forEach((value, i) => {
    const p = `accounts[${i}]`;
    const r = row<AccountInput>(value, p);
    const handle = handleOf(r.handle, `${p}.handle`);
    if (accountRows.has(handle)) fail(`${p}.handle`, 'is a duplicate');
    accountRows.set(handle, {
      seed: bool(r.seed, `${p}.seed`),
      override: r.override === null ? null : oneOf(r.override, ['confirm', 'clear'] as const, `${p}.override`),
      overrideAtMs: timeOrNull(r.overrideAt, `${p}.overrideAt`),
      clearedAtMs: timeOrNull(r.clearedAt, `${p}.clearedAt`),
      listedAtMs: timeOrNull(r.listedAt, `${p}.listedAt`),
      status: oneOf(r.status, STATUSES, `${p}.status`),
      identity: oneOf(r.identity, IDENTITIES, `${p}.identity`),
      evidence: count(r.evidence, `${p}.evidence`),
      protected: bool(r.protected, `${p}.protected`),
    });
    handleSet.add(handle);
  });

  const rawVotes: { handle: string; u: number; value: 0 | 1; atMs: number }[] = [];
  rows(top.votes, 'votes').forEach((value, i) => {
    const p = `votes[${i}]`;
    const r = row<VoteInput>(value, p);
    const install = id(r.install, `${p}.install`);
    const handle = handleOf(r.handle, `${p}.handle`);
    const v = voteValue(r.value, `${p}.value`);
    const atMs = timeOf(r.at, `${p}.at`);
    handleSet.add(handle);
    const u = installIndex.get(install);
    // A vote of an install that the loader did not see carries no weight; its handle still gets an output row.
    if (u !== undefined) rawVotes.push({ handle, u, value: v, atMs });
  });

  const rawCleared = rows(top.clearedVotes, 'clearedVotes').map((value, i) => {
    const p = `clearedVotes[${i}]`;
    const r = row<ClearedVoteInput>(value, p);
    const handle = handleOf(r.handle, `${p}.handle`);
    handleSet.add(handle);
    return {
      handle, install: id(r.install, `${p}.install`), ipHash: ipHash(r.ipHash, `${p}.ipHash`), value: voteValue(r.value, `${p}.value`),
      atMs: timeOf(r.at, `${p}.at`), clearedAtMs: timeOf(r.clearedAt, `${p}.clearedAt`), standing: bool(r.standing, `${p}.standing`),
    };
  });

  const sightingRows = rows(top.sightings, 'sightings');
  const sightingTimes = new Float64Array(sightingRows.length);
  const tweetIds = new Set<string>();
  sightingRows.forEach((value, i) => {
    const p = `sightings[${i}]`;
    const r = row<SightingInput>(value, p);
    handleSet.add(handleOf(r.handle, `${p}.handle`));
    if (typeof r.tweetId !== 'string' || !TWEET_ID_RE.test(r.tweetId)) fail(`${p}.tweetId`, 'must match ^[0-9]{1,20}$');
    if (tweetIds.has(r.tweetId)) fail(`${p}.tweetId`, 'is a duplicate');
    tweetIds.add(r.tweetId);
    if (r.parentTweetId !== null && (typeof r.parentTweetId !== 'string' || !TWEET_ID_RE.test(r.parentTweetId))) {
      fail(`${p}.parentTweetId`, 'must match ^[0-9]{1,20}$ or be null');
    }
    if (r.latencySec !== null && (typeof r.latencySec !== 'number' || !Number.isFinite(r.latencySec))) fail(`${p}.latencySec`, 'must be a finite number or null');
    sightingTimes[i] = timeOf(r.replyAt, `${p}.replyAt`);
  });

  const handles = [...handleSet].sort();
  const handleIndex = new Map<string, number>();
  handles.forEach((h, i) => handleIndex.set(h, i));
  const accounts = handles.map((h) => accountRows.get(h) ?? NO_STATE);

  const votes: PreparedVote[] = rawVotes.map((v) => ({ a: handleIndex.get(v.handle)!, u: v.u, value: v.value, atMs: v.atMs }));
  votes.sort((x, y) => x.a - y.a || x.u - y.u);
  for (let i = 1; i < votes.length; i++) {
    if (votes[i]!.a === votes[i - 1]!.a && votes[i]!.u === votes[i - 1]!.u) fail('votes', 'has two votes of one install on one handle');
  }

  const clearedVotes: PreparedClearedVote[] = rawCleared.map(({ handle, ...r }) => ({ a: handleIndex.get(handle)!, ...r }));
  clearedVotes.sort((x, y) => x.a - y.a || byKey(x.install, y.install));
  for (let i = 1; i < clearedVotes.length; i++) {
    if (clearedVotes[i]!.a === clearedVotes[i - 1]!.a && clearedVotes[i]!.install === clearedVotes[i - 1]!.install) fail('clearedVotes', 'has two rows of one install on one handle');
  }

  const oldest = nowMs - SIGHTING_WINDOW_MS;
  const newest = nowMs + SIGHTING_MAX_FUTURE_MS;
  const grouped: number[][] = handles.map(() => []);
  for (let i = 0; i < sightingRows.length; i++) {
    const t = sightingTimes[i]!;
    if (t < oldest || t > newest) continue;
    grouped[handleIndex.get((sightingRows[i] as SightingInput).handle)!]!.push(i);
  }
  const sightings = grouped.map((idx) => {
    idx.sort((x, y) => sightingTimes[y]! - sightingTimes[x]! || cmpTweetId((sightingRows[y] as SightingInput).tweetId, (sightingRows[x] as SightingInput).tweetId));
    if (idx.length > MAX_SIGHTINGS_PER_ACCOUNT) idx.length = MAX_SIGHTINGS_PER_ACCOUNT;
    return idx.map((i) => sightingRows[i] as SightingInput);
  });

  return { nowMs, handles, accounts, installs, votes, sightings, clearedVotes, autoConfirmsToday, autoFlagsToday };
}

// Numeric order of decimal tweet ids without BigInt.
function cmpTweetId(x: string, y: string): number {
  return x.length - y.length || byKey(x, y);
}
