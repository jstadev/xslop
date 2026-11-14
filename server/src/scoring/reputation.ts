// Reputation, good marks and penalties (SPEC.md 13.5 and 13.10 items 1 to 3): Beta(1,1) agreement of an
// install's votes with admin decisions, in [REPUTATION_MIN, REPUTATION_MAX]. Trust starts at the maintainer
// and moves outward: only an admin decision is a trusted decision, and a vote is scored only if it was set
// before that answer was public. A crowd, also a crowd with standing, makes no trusted decision, so a ring
// that confirms its own accounts earns nothing. Agreeing with a public answer, a starter account and a vote
// past the budget teach nothing.
import type { PreparedAccount, PreparedClearedVote, PreparedInstall, PreparedVote } from './input.js';
import { STANDING_MIN_GOOD_MARKS, clampReputation } from './weight.js';

// One admin confirm gives at most this many good marks: standing in the whole system grows by at most this
// for each account that the admin confirmed (SPEC.md 13.10 item 2).
export const GOOD_MARKS_PER_ACCOUNT = 5;

// The time of the admin confirm of an account that scores votes, NaN when it has none. A starter account
// and a moved account (rule 0) score nothing.
const confirmedAt = (acc: PreparedAccount): number =>
  (acc.override === 'confirm' && !acc.seed && acc.identity !== 'moved' ? acc.overrideAtMs : Number.NaN);

// Public since the first listing or the admin confirm, whichever came first. firstPublicAtMs is the
// earliest listing and stays set after the account leaves the list, so a later confirm does not
// make a vote from the earlier public period into a good mark. No admin confirm: NaN, nothing scores.
const publicSince = (acc: PreparedAccount): number => {
  const at = confirmedAt(acc);
  if (Number.isNaN(at)) return Number.NaN;
  let since = at;
  if (!Number.isNaN(acc.listedAtMs)) since = Math.min(since, acc.listedAtMs);
  if (!Number.isNaN(acc.firstPublicAtMs)) since = Math.min(since, acc.firstPublicAtMs);
  return since;
};

// The slop votes that can earn a good mark on one account: the earliest counted slop vote of each
// network set before the account was public, then the first GOOD_MARKS_PER_ACCOUNT networks.
// Votes are sorted by (account, install), so an equal time keeps the earlier install.
function goodMarkIndexes(votes: PreparedVote[], start: number, end: number, since: number, counted: Uint8Array, network: Int32Array): number[] {
  const first = new Map<number, number>();
  for (let k = start; k < end; k++) {
    const v = votes[k]!;
    if (v.value !== 1 || counted[k] !== 1 || !(v.atMs < since)) continue;
    const n = network[v.u]!;
    const best = first.get(n);
    if (best === undefined || v.atMs < votes[best]!.atMs) first.set(n, k);
  }
  return [...first.values()].sort((x, y) => votes[x]!.atMs - votes[y]!.atMs || votes[x]!.u - votes[y]!.u).slice(0, GOOD_MARKS_PER_ACCOUNT);
}

// A row of an admin clear with the penalty answers for its vote: the rows exist only for such a clear. Rows
// of a starter account, of an account that the admin confirms now, and of a vote set after the clear do not.
const scoredRow = (r: PreparedClearedVote, acc: PreparedAccount): boolean => !acc.seed && acc.override !== 'confirm' && r.atMs < r.clearedAtMs;

// Per install: the time of its newest penalty, −Infinity without one (SPEC.md 13.10 item 3): its slop row of an
// admin clear with the penalty, or its "not slop" vote set before an admin confirm, live or in the row that the
// confirm stored (so a vote that is deleted or changed after the confirm keeps its penalty). Only good marks of
// slop votes set after it count toward standing (their admin confirm comes later still): marks that the install
// set before a penalty never pay for its standing after it (round 2 H3).
export function newestPenalty(
  installs: PreparedInstall[], votes: PreparedVote[], accounts: PreparedAccount[], clearedVotes: PreparedClearedVote[],
): Float64Array {
  const out = new Float64Array(installs.length).fill(-Infinity);
  for (const v of votes) {
    const at = confirmedAt(accounts[v.a]!);
    if (v.value === 0 && v.atMs < at) out[v.u] = Math.max(out[v.u]!, at);
  }
  const installIndex = new Map(installs.map((ins, u) => [ins.id, u]));
  for (const r of clearedVotes) {
    const u = installIndex.get(r.install);
    const acc = accounts[r.a]!;
    if (u === undefined) continue;
    if (r.value === 1 && scoredRow(r, acc)) out[u] = Math.max(out[u]!, r.clearedAtMs);
    else if (r.value === 0 && r.atMs < confirmedAt(acc)) out[u] = Math.max(out[u]!, confirmedAt(acc));
  }
  return out;
}

// Per install: 1 when its stored standing can still hold in this run. An install with a penalty needs at least
// STANDING_MIN_GOOD_MARKS counted good marks set after its newest penalty (the same votes reputations counts).
// A vote past the budget, or outside the first networks, does not keep the standing for this run.
export function couldStand(
  votes: PreparedVote[], accounts: PreparedAccount[], penalty: Float64Array, network: Int32Array, counted: Uint8Array,
): Uint8Array {
  const marks = new Int32Array(penalty.length);
  for (let start = 0; start < votes.length; ) {
    const a = votes[start]!.a;
    let end = start;
    while (end < votes.length && votes[end]!.a === a) end++;
    const since = publicSince(accounts[a]!);
    if (!Number.isNaN(since)) {
      for (const k of goodMarkIndexes(votes, start, end, since, counted, network)) {
        const u = votes[k]!.u;
        if (votes[k]!.atMs > penalty[u]!) marks[u]!++;
      }
    }
    start = end;
  }
  return Uint8Array.from(marks, (m, u) => (penalty[u] === -Infinity || m >= STANDING_MIN_GOOD_MARKS ? 1 : 0));
}

export interface ReputationContext {
  installs: PreparedInstall[];
  votes: PreparedVote[]; // sorted by (account, install)
  counted: Uint8Array; // per vote: within the budget, with weight, after the clear
  inert: Uint8Array; // per vote: "not slop" without standing (with weight, after the clear): it still answers for itself
  network: Int32Array; // per install
  accounts: PreparedAccount[];
  clearedVotes: PreparedClearedVote[];
  penalty: Float64Array; // per install: newestPenalty
}

// goodMarks: the good marks of slop votes set after the newest penalty of the install, the count that standing reads.
export function reputations(ctx: ReputationContext): { reputation: Float64Array; goodMarks: Int32Array } {
  const { votes, counted, network } = ctx;
  const n = ctx.installs.length;
  const agree = new Float64Array(n);
  const total = new Float64Array(n);
  const goodMarks = new Int32Array(n);
  for (let start = 0; start < votes.length; ) {
    const a = votes[start]!.a;
    let end = start;
    while (end < votes.length && votes[end]!.a === a) end++;
    const acc = ctx.accounts[a]!;
    const at = confirmedAt(acc);
    if (!Number.isNaN(at)) {
      const since = publicSince(acc);
      for (let k = start; k < end; k++) {
        const v = votes[k]!;
        if (v.value === 0 && (counted[k] || ctx.inert[k]) && v.atMs < at) {
          total[v.u]!++; // "not slop" before the admin upheld the listing disagrees, also when the account was already public
        }
      }
      const marks = goodMarkIndexes(votes, start, end, since, counted, network);
      for (const k of marks) {
        const u = votes[k]!.u;
        agree[u]!++;
        total[u]!++;
        if (votes[k]!.atMs > ctx.penalty[u]!) goodMarks[u]!++;
      }
    }
    start = end;
  }
  // An admin clear with the penalty: the rows stored at the clear, never the live votes.
  const installIndex = new Map(ctx.installs.map((ins, u) => [ins.id, u]));
  for (const r of ctx.clearedVotes) {
    const u = installIndex.get(r.install);
    if (u === undefined || !scoredRow(r, ctx.accounts[r.a]!)) continue;
    total[u]!++;
    if (r.value === 0) agree[u]!++;
  }
  const reputation = new Float64Array(n);
  for (let u = 0; u < n; u++) reputation[u] = clampReputation((agree[u]! + 1) / (total[u]! + 2));
  return { reputation, goodMarks };
}
