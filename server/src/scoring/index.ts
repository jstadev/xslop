// xslop scoring engine (SPEC.md 13). Pure and deterministic: no I/O, no clock reads, no randomness.
// The same input in any row order gives the same output.
import { BEHAVIOUR_MIN_SIGHTINGS, accountFeatures, behaviourScore } from './behaviour.js';
import { FITTED_MIN_VOICES, VETO_FACTOR, factorize, slopSideFit, twoSidedNetworks, twoSidedSlopVoices } from './factorize.js';
import { prepareInput } from './input.js';
import { neededNetworks } from './needed.js';
import { carriesStanding, networkIndex, networkNames, struckNetworks, tallyNetworks, withinBudget } from './network.js';
import { couldStand, newestPenalty, reputations } from './reputation.js';
import { MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, decide, isDisputedSeed, scoreOf, standingBound, type Case } from './rules.js';
import type { AccountScore, ScoringInput, ScoringOutput } from './types.js';
import { raterTrust, raterWeights, standingNext, standingNow } from './weight.js';

export type * from './types.js';
export { CRITERIA } from './criteria.js';
export { BEHAVIOUR_FEATURES, BEHAVIOUR_MIN_SIGHTINGS } from './behaviour.js';
export { FITTED_MIN_VOICES, TWO_SIDED_MIN_VOICES, VETO_FACTOR } from './factorize.js';
export { HANDLE_RE, MAX_SIGHTINGS_PER_ACCOUNT, TWEET_ID_RE } from './input.js';
export { NEEDED_MAX } from './needed.js';
export { NETWORK_DAILY_VOTES, STANDING_DAILY, STRIKE_LIMIT, STRIKE_MAX_CROWD, STRIKE_WINDOW_DAYS } from './network.js';
export { GOOD_MARKS_PER_ACCOUNT } from './reputation.js';
export {
  ANCHORS_CONFIRM, ANCHORS_FLAG, CLEARED_RETURN_MIN_NETWORKS, CONFIRM_MIN_NETWORKS, CONFIRM_MIN_TRUST, CONFIRM_SHARE_BOUND, EVIDENCE_CONFIRM,
  EVIDENCE_FLAG, FLAG_MIN_NETWORKS, FLAG_SHARE_BOUND, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, PROTECTED_MIN_FOLLOWERS,
  SEED_DISPUTE_MIN_NETWORKS, SEED_SCORE_MIN, wilsonLowerBound,
} from './rules.js';
export {
  AGE_FACTOR_FIRST_DAY, AGE_FACTOR_FIRST_WEEK, NEW_INSTALL_TRUST, REPUTATION_MAX, REPUTATION_MIN, REPUTATION_PRIOR,
  STANDING_MIN_AGE_DAYS, STANDING_MIN_GOOD_MARKS, STANDING_MIN_REPUTATION,
} from './weight.js';

// The published floats keep 3 decimals, so a tiny change does not rewrite a row. Decisions use raw values.
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function computeScores(input: ScoringInput): ScoringOutput {
  const p = prepareInput(input);
  const nA = p.handles.length;
  const network = networkIndex(p.installs);
  const names = networkNames(p.installs, network);
  const penalty = newestPenalty(p.installs, p.votes, p.accounts, p.clearedVotes);
  const standing = standingNow(p.installs, p.nowMs, couldStand(p.votes, p.accounts, penalty));
  const trust = raterTrust(p.installs, p.nowMs);

  // 1. A struck network counts for nothing (a strike without standing silences its installs without
  //    standing only). Then the votes that count: weight, the standing budget, the vote budget, and for a
  //    cleared account only votes after the clear.
  const struck = struckNetworks(p.clearedVotes, p.accounts, p.installs, network, p.nowMs, names.length);
  network.forEach((n, u) => { if (struck[n] === 2 || (struck[n] === 1 && !standing[u])) trust[u] = 0; });
  const weight = raterWeights(p.installs, trust);
  const withStanding = carriesStanding(p.votes, network, weight, standing, p.nowMs);
  const budget = withinBudget(p.votes, network, weight, withStanding, p.nowMs);
  const afterClear = (k: number): boolean => !(p.votes[k]!.atMs <= p.accounts[p.votes[k]!.a]!.clearedAtMs);
  const counted = Uint8Array.from(p.votes, (_, k) => (budget[k] && afterClear(k) ? 1 : 0));
  // "Not slop" without standing: in no tally and no budget, only in dissent and in the reputation of its install.
  const inert = Uint8Array.from(p.votes, (v, k) => (v.value === 0 && !withStanding[k] && weight[v.u]! > 0 && afterClear(k) ? 1 : 0));
  const raters = new Int32Array(nA);
  const slopRaters = new Int32Array(nA);
  p.votes.forEach((v, k) => { if (counted[k]) { raters[v.a]!++; slopRaters[v.a]! += v.value; } });

  // 2. One voice per network on each account, then the one-camp veto over those voices.
  const tally = tallyNetworks(p.votes, counted, inert, network, trust, weight, withStanding, nA);
  const twoSided = twoSidedNetworks(tally.voices, nA, names.length);
  const fit = twoSided.includes(1) ? factorize(tally.voices, nA, names) : null;
  const side = fit ? slopSideFit(fit, tally.voices, twoSided) : null;
  const twoSidedSlop = twoSidedSlopVoices(tally.voices, twoSided, nA);
  const factor = Float64Array.from(p.handles, (_, a) => (side && twoSidedSlop[a]! >= FITTED_MIN_VOICES ? side.fa[a]! : 0));

  const cases: Case[] = p.accounts.map((acc, a) => ({
    seed: acc.seed,
    override: acc.override,
    cleared: !Number.isNaN(acc.clearedAtMs),
    identity: acc.identity,
    protected: acc.protected,
    evidence: acc.evidence,
    wasConfirmed: acc.status === 'confirmed',
    wasListed: acc.status === 'confirmed' || acc.status === 'flagged',
    slopNetworks: tally.slopNetworks[a]!,
    slopTrust: tally.slopTrust[a]!,
    anchors: tally.anchors[a]!,
    anchorTrust: tally.anchorTrust[a]!,
    notSlop: tally.notSlop[a]!,
    notSlopTrust: tally.notSlopTrust[a]!,
    vetoed: Math.abs(factor[a]!) >= VETO_FACTOR,
  }));

  // 3. Status. The brakes: at most MAX_AUTO_CONFIRMS_PER_DAY − autoConfirmsToday new automatic confirms, then
  //    at most MAX_AUTO_FLAGS_PER_DAY − autoFlagsToday new automatic flags, each most anchors first, then the
  //    highest bound of the voices with standing, then the handle. The others wait (gate brake): a confirm
  //    that waits can still be a flag.
  const confirmOpen = new Uint8Array(nA).fill(1);
  const flagOpen = new Uint8Array(nA).fill(1);
  const decisions = cases.map((c) => decide(c, true, true));
  const bound = (a: number): number => standingBound(cases[a]!);
  const brake = (reason: string, held: (c: Case) => boolean, left: number, open: Uint8Array): void => {
    const fresh = decisions.flatMap((d, a) => (d.reason === reason && !held(cases[a]!) ? [a] : []));
    fresh.sort((x, y) => cases[y]!.anchors - cases[x]!.anchors || bound(y) - bound(x) || x - y);
    for (const a of fresh.slice(left)) {
      open[a] = 0;
      decisions[a] = decide(cases[a]!, confirmOpen[a] === 1, flagOpen[a] === 1);
    }
  };
  brake('votes_confirmed', (c) => c.wasConfirmed, Math.max(0, MAX_AUTO_CONFIRMS_PER_DAY - p.autoConfirmsToday), confirmOpen);
  brake('votes_flagged', (c) => c.wasListed, Math.max(0, MAX_AUTO_FLAGS_PER_DAY - p.autoFlagsToday), flagOpen);

  // 4. Reputation, good marks and standing for the next run.
  const { reputation, goodMarks } = reputations({
    installs: p.installs, votes: p.votes, counted, inert, network, accounts: p.accounts, clearedVotes: p.clearedVotes, penalty,
  });

  const accounts: AccountScore[] = p.handles.map((handle, a) => {
    const c = cases[a]!;
    const d = decisions[a]!;
    const sightings = p.sightings[a]!;
    const x = accountFeatures(sightings);
    return {
      handle,
      status: d.status,
      tier: d.tier,
      score: round3(scoreOf(c, d)),
      parts: {
        reason: d.reason,
        want: d.want,
        gate: d.gate,
        networks: c.slopNetworks,
        anchors: c.anchors,
        notSlop: c.notSlop,
        dissent: tally.dissent[a]!,
        trust: round3(c.slopTrust),
        needed: neededNetworks(c, d),
        disputed: d.reason === 'seed' && isDisputedSeed(c),
        evidence: c.evidence,
        factor: round3(factor[a]!),
        behaviour: sightings.length >= BEHAVIOUR_MIN_SIGHTINGS ? round3(behaviourScore(x)) : 0,
        sightings: sightings.length,
        fastReplyShare: Number.isNaN(x[0]!) ? 0 : round3(x[0]!),
        raters: raters[a]!,
        slopRaters: slopRaters[a]!,
        notSlopRaters: raters[a]! - slopRaters[a]!,
      },
    };
  });

  return {
    accounts,
    installs: p.installs.map((ins, u) => ({
      id: ins.id, reputation: reputation[u]!, goodMarks: goodMarks[u]!, standing: standingNext(ins, p.nowMs, reputation[u]!, goodMarks[u]!),
    })),
    struckNetworks: struck.reduce((sum, s) => sum + (s > 0 ? 1 : 0), 0),
    model: { epochs: fit ? fit.epochs : 0 },
  };
}
