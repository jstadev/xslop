// Public contract of the scoring engine (SPEC.md 13.7). The job loads the input and stores the output.

export interface InstallInput {
  id: string;
  createdAt: Date;
  ipHash: string; // the network of registration
  banned: boolean;
  reputation: number; // stored by the previous run
  trusted: boolean; // only an admin sets it
  standing: boolean; // stored by the previous run; the engine computes it again
}

export interface VoteInput {
  install: string;
  handle: string;
  value: 0 | 1;
  at: Date;
  postOk?: boolean;
  standingAt?: Date | null; // time this vote already carried standing; a later value change does not move it
}

/** A standing slot whose vote was deleted. The engine counts it in the 24 hour window. */
export interface StandingSpentInput { ipHash: string; at: Date }

export type AccountStatus = 'none' | 'pending' | 'flagged' | 'confirmed' | 'cleared';
export type Identity = 'unknown' | 'ok' | 'gone' | 'moved';

export interface AccountInput {
  handle: string;
  seed: boolean;
  clearedAt: Date | null;
  override: 'confirm' | 'clear' | null;
  overrideAt: Date | null;
  listedAt: Date | null; // start of the current listing; null when the account is not listed
  firstPublicAt?: Date | null; // earliest time the account was on the list; kept after it leaves
  status: AccountStatus; // the stored state of the previous run: the brake reads it
  identity: Identity;
  evidence: number; // networks with a counted slop vote that names a post the server verified
  protected: boolean; // accounts.protected or followers >= PROTECTED_MIN_FOLLOWERS
}

// Verified sightings only, newest 50 per account.
export interface SightingInput { handle: string; tweetId: string; parentTweetId: string | null; replyAt: Date; latencySec: number | null }

// The votes of an account at the time of an admin clear with the penalty (table cleared_votes). standing: the
// standing of the install at the time of the clear (SPEC.md 13.10 item 5).
export interface ClearedVoteInput { install: string; ipHash: string; handle: string; value: 0 | 1; at: Date; clearedAt: Date; standing: boolean }

export interface ScoringInput {
  now: Date;
  installs: InstallInput[];
  votes: VoteInput[];
  accounts: AccountInput[];
  sightings: SightingInput[];
  clearedVotes: ClearedVoteInput[];
  autoConfirmsToday: number; // accounts confirmed by votes in the last 24 hours
  autoFlagsToday: number; // accounts listed at tier 1 by votes in the last 24 hours (SPEC.md 13.10 item 6)
  standingSpent?: StandingSpentInput[]; // deleted votes that already carried standing
}

export type Tier = 0 | 1 | 2;
export type Want = 'flagged' | 'confirmed' | null;
export type Gate = 'protected' | 'identity' | 'standing' | 'evidence' | 'brake' | 'dispute' | 'review' | null;

export interface ScoreParts {
  reason: string;
  want: Want; // the tier that the crowd test gives, when a gate holds the account below it
  gate: Gate; // the first gate that is not met
  networks: number; // slop networks
  anchors: number; // slop networks whose voice has standing
  notSlop: number; // not-slop networks with standing
  dissent: number; // not-slop networks without standing: in no test
  trust: number; // Σ trust of the slop voices
  needed: number; // more slop networks until the crowd test of the next tier passes; 0 when it passes or at the top
  disputed: boolean; // a starter account that not-slop voices with standing dispute
  evidence: number; // networks whose slop vote names a verified post
  factor: number; // f_a of the side fit, 0 when not fitted
  behaviour: number; // reply timing score, information only
  sightings: number; // verified sightings
  fastReplyShare: number;
  raters: number; // counted votes
  slopRaters: number;
  notSlopRaters: number;
}

export interface AccountScore { handle: string; status: AccountStatus; tier: Tier; score: number; parts: ScoreParts }

export interface InstallScore { id: string; reputation: number; goodMarks: number; standing: boolean }

export interface ScoringOutput {
  accounts: AccountScore[];
  installs: InstallScore[];
  struckNetworks: number; // networks that count for nothing in this run
  model: { epochs: number };
  standingVotes?: { install: string; handle: string }[]; // votes that carry standing in this run
}
