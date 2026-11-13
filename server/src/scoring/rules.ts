// Status rules and the published score (SPEC.md 13.3). README.md gives the reason for each number.
//
// Nothing that costs nothing decides anything. A crowd of any size can only make an account pending:
// an automatic flag needs a slop network with standing (an anchor) and one network whose vote names a
// post that the server verified, an automatic confirm needs two anchors and two such networks. "Not
// slop" counts only with standing. Behaviour never changes a status.
import type { AccountStatus, Gate, Identity, Tier, Want } from './types.js';

export const FLAG_MIN_NETWORKS = 2;
export const CONFIRM_MIN_NETWORKS = 4;
export const CONFIRM_MIN_TRUST = 1; // Σ voice trust; a first-day install has 0.15, an older one 0.35 to 1
const WILSON_Z = 1.2816; // one-sided 90%
export const FLAG_SHARE_BOUND = 0.5;
export const CONFIRM_SHARE_BOUND = 0.6;
export const ANCHORS_FLAG = 1;
export const ANCHORS_CONFIRM = 2;
export const EVIDENCE_FLAG = 1;
export const EVIDENCE_CONFIRM = 2;
export const PROTECTED_MIN_FOLLOWERS = 50_000;
export const MAX_AUTO_CONFIRMS_PER_DAY = 30;
export const MAX_AUTO_FLAGS_PER_DAY = 60;
export const SEED_DISPUTE_MIN_NETWORKS = 5;
export const CLEARED_RETURN_MIN_NETWORKS = 6;
export const SEED_SCORE_MIN = 0.8;

// What the rules know about one account.
export interface Case {
  seed: boolean;
  override: 'confirm' | 'clear' | null;
  cleared: boolean; // clearedAt is set: only votes after it count
  identity: Identity;
  protected: boolean;
  evidence: number;
  wasConfirmed: boolean; // the stored status is confirmed: the confirm brake does not apply
  wasListed: boolean; // the stored status is flagged or confirmed: the flag brake does not apply
  slopNetworks: number;
  slopTrust: number;
  anchors: number; // slop networks whose voice has standing
  anchorTrust: number;
  notSlop: number; // not-slop networks whose voice has standing
  notSlopTrust: number;
  vetoed: boolean; // the one-camp veto (factorize.ts)
}

export interface Decision { status: AccountStatus; tier: Tier; reason: string; want: Want; gate: Gate }

const decision = (status: AccountStatus, tier: Tier, reason: string, want: Want = null, gate: Gate = null): Decision => ({ status, tier, reason, want, gate });
const pending = (want: Want, gate: Gate): Decision => decision('pending', 0, 'pending', want, gate);

// Lower bound of the Wilson interval for a share (0..1) of n independent votes.
export function wilsonLowerBound(share: number, n: number): number {
  if (n <= 0) return 0;
  const z2 = WILSON_Z * WILSON_Z;
  const center = share + z2 / (2 * n);
  const margin = WILSON_Z * Math.sqrt((share * (1 - share)) / n + z2 / (4 * n * n));
  return (center - margin) / (1 + z2 / n);
}

// The share bound of the voices with standing alone. The brake orders by it, so votes without standing never
// move an account up the brake order (round 2 H2).
export function standingBound(c: Case): number {
  const total = c.anchorTrust + c.notSlopTrust;
  return wilsonLowerBound(total > 0 ? c.anchorTrust / total : 0, c.anchors + c.notSlop);
}

// The share test: with a not-slop voice with standing, standing voices only on both sides.
export const shareBound = (c: Case): number => (c.notSlop === 0 ? wilsonLowerBound(1, c.slopNetworks) : standingBound(c));

export interface CrowdTier { minNetworks: number; bound: number; minTrust: number }
export const FLAG_TIER: Readonly<CrowdTier> = Object.freeze({ minNetworks: FLAG_MIN_NETWORKS, bound: FLAG_SHARE_BOUND, minTrust: 0 });
export const CONFIRM_TIER: Readonly<CrowdTier> = Object.freeze({ minNetworks: CONFIRM_MIN_NETWORKS, bound: CONFIRM_SHARE_BOUND, minTrust: CONFIRM_MIN_TRUST });

// The crowd test of a tier before any voice disputes it. Trust is a sum of floats: the margin absorbs rounding.
export const crowdPasses = (c: Pick<Case, 'slopNetworks' | 'slopTrust'>, t: CrowdTier): boolean =>
  c.slopNetworks >= t.minNetworks && c.slopTrust >= t.minTrust - 1e-9 && wilsonLowerBound(1, c.slopNetworks) >= t.bound;

// 'dispute': the crowd passes, but the voices with standing that say not slop, or the one-camp veto, stop it.
export function crowdTest(c: Case, t: CrowdTier): 'pass' | 'dispute' | 'fail' {
  if (!crowdPasses(c, t)) return 'fail';
  return c.vetoed || shareBound(c) < t.bound ? 'dispute' : 'pass';
}

// A gone account (the source did not find it, SPEC.md 13.10 item 10) keeps a tier that it holds in the
// stored state, but votes list nothing new on it.
const identityGate = (c: Case, held: boolean): Gate =>
  (c.protected ? 'protected' : c.identity === 'ok' || (c.identity === 'gone' && held) ? null : 'identity');

// The gates of a tier in order; brakeOpen is false when the day has no automatic place left for this account.
function tierGate(c: Case, held: boolean, anchors: number, evidence: number, brakeOpen: boolean): Gate {
  const g = identityGate(c, held);
  if (g) return g;
  if (c.anchors < anchors) return 'standing';
  if (c.evidence < evidence) return 'evidence';
  return !held && !brakeOpen ? 'brake' : null;
}

// The rules 0 to 6 of SPEC.md 13.3 and 13.10; the first that matches wins. confirmOpen and flagOpen are
// false when the day has no automatic confirm or flag left for this account (index.ts orders the candidates).
export function decide(c: Case, confirmOpen: boolean, flagOpen: boolean): Decision {
  if (c.identity === 'moved') return decision('none', 0, 'moved');
  if (c.override === 'confirm') return decision('confirmed', 2, 'override_confirm');
  if (c.override === 'clear') return decision('cleared', 0, 'override_clear');
  if (c.cleared) {
    // An admin reset: a cleared account never returns without a person.
    return c.slopNetworks >= CLEARED_RETURN_MIN_NETWORKS && crowdTest(c, CONFIRM_TIER) === 'pass'
      ? pending('confirmed', 'review') : decision('cleared', 0, 'cleared');
  }
  if (c.seed) return decision('confirmed', 2, 'seed');
  let want: Want = null;
  let gate: Gate = null;
  const confirm = crowdTest(c, CONFIRM_TIER);
  if (confirm !== 'fail') {
    gate = confirm === 'dispute' ? 'dispute' : tierGate(c, c.wasConfirmed, ANCHORS_CONFIRM, EVIDENCE_CONFIRM, confirmOpen);
    if (gate === null) return decision('confirmed', 2, 'votes_confirmed');
    want = 'confirmed';
  }
  // The confirm crowd implies the flag crowd, so a want of rule 4 always reaches a flag decision here.
  const flag = crowdTest(c, FLAG_TIER);
  if (flag === 'fail') return decision('none', 0, 'none');
  const flagHold = flag === 'dispute' ? 'dispute' : tierGate(c, c.wasListed, ANCHORS_FLAG, EVIDENCE_FLAG, flagOpen);
  if (flagHold === null) return decision('flagged', 1, 'votes_flagged', want, gate);
  return pending(want ?? 'flagged', gate ?? flagHold);
}

// A starter account that voices with standing dispute: the not-slop share test of a confirm, standing
// voices only on both sides. Votes never remove a starter account; this only marks it for the admin.
export function isDisputedSeed(c: Case): boolean {
  const total = c.anchorTrust + c.notSlopTrust;
  return c.notSlop >= SEED_DISPUTE_MIN_NETWORKS && c.notSlopTrust >= CONFIRM_MIN_TRUST - 1e-9 && total > 0 &&
    wilsonLowerBound(c.notSlopTrust / total, c.anchors + c.notSlop) >= CONFIRM_SHARE_BOUND;
}

// Score 0..1. Cleared and none: 0. Votes: the Wilson bound of the share test that applied. A starter
// account: at least SEED_SCORE_MIN. An admin confirm: 1.
export function scoreOf(c: Case, d: Decision): number {
  if (d.status === 'cleared' || d.status === 'none') return 0;
  if (d.reason === 'override_confirm') return 1;
  const votes = c.slopNetworks >= FLAG_MIN_NETWORKS ? shareBound(c) : 0;
  return d.reason === 'seed' ? Math.max(votes, SEED_SCORE_MIN) : votes;
}
