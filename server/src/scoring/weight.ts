// Rater trust, weight and standing (SPEC.md 6 item 2 and 13.2).
// trust = reputation × age factor. weight = trust ÷ √(installs that share the network). Banned: 0.
import type { PreparedInstall } from './input.js';

export const AGE_FACTOR_FIRST_DAY = 0.3;
export const AGE_FACTOR_FIRST_WEEK = 0.7;
export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
export const REPUTATION_MIN = 0.05;
export const REPUTATION_MAX = 1;
export const REPUTATION_PRIOR = 0.5; // the Beta(1,1) mean: what an install with no track record has

// Trust of a brand-new install with no track record: the weakest ordinary voter.
export const NEW_INSTALL_TRUST = REPUTATION_PRIOR * AGE_FACTOR_FIRST_DAY;

// Standing (SPEC.md 13.2): an admin trusts the install, or it earned standing with age, good marks and reputation.
export const STANDING_MIN_AGE_DAYS = 7;
export const STANDING_MIN_GOOD_MARKS = 3;
export const STANDING_MIN_REPUTATION = 0.6;

export function clampReputation(r: number): number {
  return r < REPUTATION_MIN ? REPUTATION_MIN : r > REPUTATION_MAX ? REPUTATION_MAX : r;
}

// An install with a creation time in the future counts as new.
export function ageFactor(ageMs: number): number {
  if (ageMs < DAY_MS) return AGE_FACTOR_FIRST_DAY;
  if (ageMs < WEEK_MS) return AGE_FACTOR_FIRST_WEEK;
  return 1;
}

// Trust of each install, banned installs have none.
export function raterTrust(installs: PreparedInstall[], nowMs: number): Float64Array {
  const trust = new Float64Array(installs.length);
  installs.forEach((ins, i) => {
    if (!ins.banned) trust[i] = clampReputation(ins.reputation) * ageFactor(nowMs - ins.createdAtMs);
  });
  return trust;
}

// Only installs that are not banned count for the shared network damping.
export function raterWeights(installs: PreparedInstall[], trust: Float64Array): Float64Array {
  const shared = new Map<string, number>();
  for (const ins of installs) if (!ins.banned) shared.set(ins.ipHash, (shared.get(ins.ipHash) ?? 0) + 1);
  return trust.map((t, i) => (t > 0 ? t / Math.sqrt(shared.get(installs[i]!.ipHash)!) : 0));
}

const oldEnough = (ins: PreparedInstall, nowMs: number): boolean => nowMs - ins.createdAtMs >= STANDING_MIN_AGE_DAYS * DAY_MS;

// The standing that counts in this run: the stored standing of the previous run, checked again against
// the age, the reputation and the good marks that this input can still give after the newest penalty
// (couldStand, reputation.ts). So a loader fault never gives standing to a new install, and a penalty takes
// it away in the first run that sees the penalty. Admin trust wins.
export function standingNow(installs: PreparedInstall[], nowMs: number, couldStand: Uint8Array): Uint8Array {
  return Uint8Array.from(installs, (ins, u) => !ins.banned && (ins.trusted ||
    (ins.standing && couldStand[u] === 1 && oldEnough(ins, nowMs) && clampReputation(ins.reputation) >= STANDING_MIN_REPUTATION)) ? 1 : 0);
}

// The standing for the next run, from the reputation and the good marks of this run.
export function standingNext(ins: PreparedInstall, nowMs: number, reputation: number, goodMarks: number): boolean {
  return !ins.banned && (ins.trusted || (oldEnough(ins, nowMs) && goodMarks >= STANDING_MIN_GOOD_MARKS && reputation >= STANDING_MIN_REPUTATION));
}
