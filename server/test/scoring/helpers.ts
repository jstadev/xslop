// Builders for synthetic scoring inputs. Deterministic: no Math.random.
import type { AccountInput, AccountScore, ClearedVoteInput, InstallInput, ScoringInput, ScoringOutput, SightingInput, VoteInput } from '../../src/scoring/index.js';

export const NOW = new Date('2026-11-12T12:00:00.000Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A month-old install on its own network, full reputation, no standing.
export function install(id: string, o: Partial<Omit<InstallInput, 'id'>> & { ageDays?: number } = {}): InstallInput {
  return {
    id,
    createdAt: o.createdAt ?? new Date(NOW.getTime() - (o.ageDays ?? 30) * DAY),
    ipHash: o.ipHash ?? `ip-${id}`,
    banned: o.banned ?? false,
    reputation: o.reputation ?? 1,
    trusted: o.trusted ?? false,
    standing: o.standing ?? false,
  };
}

// An install with standing: a month old, full reputation, standing from the previous run.
export const anchor = (id: string, o: Parameters<typeof install>[1] = {}): InstallInput => install(id, { standing: true, ...o });

// Installs on their own networks.
export const many = (prefix: string, n: number, o: Parameters<typeof install>[1] = {}): InstallInput[] =>
  Array.from({ length: n }, (_, i) => install(`${prefix}${i}`, o));
export const anchors = (prefix: string, n: number, o: Parameters<typeof install>[1] = {}): InstallInput[] =>
  many(prefix, n, { standing: true, ...o });
// Brand-new installs (one hour old) at the starting reputation.
export const fresh = (prefix: string, n: number): InstallInput[] => many(prefix, n, { ageDays: 1 / 24, reputation: 0.5 });

export function vote(install: string, handle: string, value: 0 | 1, at: Date = ago(HOUR)): VoteInput {
  return { install, handle, value, at };
}
export const allOf = (who: InstallInput[], handle: string, value: 0 | 1 = 1, at?: Date): VoteInput[] => who.map((u) => vote(u.id, handle, value, at));

// An account that the X facts job checked: identity ok, no evidence yet.
export function account(handle: string, o: Partial<Omit<AccountInput, 'handle'>> = {}): AccountInput {
  return {
    handle,
    seed: o.seed ?? false,
    clearedAt: o.clearedAt ?? null,
    override: o.override ?? null,
    overrideAt: o.overrideAt ?? null,
    listedAt: o.listedAt ?? null,
    status: o.status ?? 'none',
    identity: o.identity ?? 'ok',
    evidence: o.evidence ?? 0,
    protected: o.protected ?? false,
  };
}

// A row of an admin clear with the penalty; standing: the standing of the install at the clear (its stored standing by default).
export function cleared(ins: InstallInput, handle: string, value: 0 | 1, clearedAt: Date, standing = ins.standing): ClearedVoteInput {
  return { install: ins.id, ipHash: ins.ipHash, handle, value, at: new Date(clearedAt.getTime() - HOUR), clearedAt, standing };
}

let tweetCounter = 1_000_000;
export function sighting(handle: string, o: Partial<Omit<SightingInput, 'handle'>> = {}): SightingInput {
  tweetCounter++;
  return {
    handle,
    tweetId: o.tweetId ?? String(tweetCounter),
    parentTweetId: o.parentTweetId === undefined ? String(tweetCounter + 500_000_000) : o.parentTweetId,
    replyAt: o.replyAt ?? ago(2 * HOUR),
    latencySec: o.latencySec === undefined ? 3600 : o.latencySec,
  };
}

// Verified sightings of one account with a bot-like or a human-like reply pattern.
export function sightingsFor(handle: string, n: number, kind: 'bot' | 'human', next: () => number): SightingInput[] {
  return Array.from({ length: n }, (_, i) => sighting(handle, {
    replyAt: ago((kind === 'bot' ? i * 4 * 60_000 : i * 9 * HOUR) + Math.floor(next() * 60_000)),
    latencySec: kind === 'bot' ? Math.floor(5 + next() * 40) : Math.floor(600 + next() * 20_000),
  }));
}

export function input(o: Partial<ScoringInput>): ScoringInput {
  return {
    now: o.now ?? NOW, installs: o.installs ?? [], votes: o.votes ?? [], accounts: o.accounts ?? [], sightings: o.sightings ?? [],
    clearedVotes: o.clearedVotes ?? [], autoConfirmsToday: o.autoConfirmsToday ?? 0, autoFlagsToday: o.autoFlagsToday ?? 0,
  };
}

export function byHandle<T extends { handle: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.handle, r]));
}

export const scoreOf = (out: ScoringOutput, handle: string): AccountScore => byHandle(out.accounts).get(handle)!;

// Two camps with standing that disagree on partisan accounts: camp L says slop on pl<i> and not slop on
// pr<i>, camp R the reverse, one pair of votes a day, inside the standing budget. Every network of both
// camps is two-sided.
export function camps(sizeL: number, sizeR: number, partisan = 6): { L: InstallInput[]; R: InstallInput[]; votes: VoteInput[] } {
  const L = anchors('l', sizeL);
  const R = anchors('r', sizeR);
  const votes: VoteInput[] = [];
  for (let p = 0; p < partisan; p++) {
    const at = ago((p + 2) * DAY);
    votes.push(...allOf(L, `pl${p}`, 1, at), ...allOf(L, `pr${p}`, 0, at), ...allOf(R, `pl${p}`, 0, at), ...allOf(R, `pr${p}`, 1, at));
  }
  return { L, R, votes };
}

// Zipf(1) launch population (the probes of 2026-11-12): users on their own networks, each marks
// `marks` of `pool` accounts, more popular accounts more often.
export function zipfPopulation(users: number, o: { pool?: number; marks?: number; seed?: number; install?: Parameters<typeof install>[1]; prefix?: string } = {}): {
  installs: InstallInput[]; votes: VoteInput[];
} {
  const next = rng(o.seed ?? 777);
  const pool = o.pool ?? 5000;
  const cum: number[] = [];
  let s = 0;
  for (let i = 1; i <= pool; i++) cum.push((s += 1 / i));
  const draw = (): number => {
    const x = next() * s;
    let lo = 0, hi = pool - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m]! < x) lo = m + 1; else hi = m; }
    return lo;
  };
  const installs = many(o.prefix ?? 'u', users, o.install);
  const votes: VoteInput[] = [];
  for (const u of installs) {
    const picked = new Set<number>();
    while (picked.size < (o.marks ?? 15)) picked.add(draw());
    for (const a of picked) votes.push(vote(u.id, zipfHandle(a), 1, ago((1 + next() * 2) * DAY)));
  }
  return { installs, votes };
}
export const zipfHandle = (a: number): string => `acct${String(a).padStart(4, '0')}`;
