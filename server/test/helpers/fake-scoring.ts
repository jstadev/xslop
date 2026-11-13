import type { ComputeScores } from '../../src/jobs/score-job.js';
import type { AccountScore, AccountStatus } from '../../src/scoring/index.js';

const STATUS_OF: Record<0 | 1 | 2, AccountStatus> = { 0: 'none', 1: 'flagged', 2: 'confirmed' };

/**
 * A stand-in for computeScores: every known handle gets the [score, tier, status] from `table`, else 0/0/none. The status
 * defaults to the one of the tier; reason 'votes_confirmed' marks a confirm by votes. Every install keeps `reputation`.
 */
export function fakeCompute(table: Record<string, [number, 0 | 1 | 2, AccountStatus?, string?]>, reputation = 0.7): ComputeScores {
  return (input) => {
    const handles = new Set<string>([...input.accounts.map((a) => a.handle), ...input.votes.map((v) => v.handle), ...input.sightings.map((s) => s.handle)]);
    const accounts: AccountScore[] = [...handles].sort().map((handle) => {
      const [score, tier, status, reason] = table[handle] ?? [0, 0];
      const sightings = input.sightings.filter((s) => s.handle === handle).length;
      return {
        handle,
        score,
        tier,
        status: status ?? STATUS_OF[tier],
        parts: {
          reason: reason ?? 'test',
          want: null,
          gate: null,
          networks: 0,
          anchors: 0,
          notSlop: 0,
          dissent: 0,
          trust: 0,
          needed: 0,
          disputed: false,
          evidence: input.accounts.find((a) => a.handle === handle)?.evidence ?? 0,
          factor: 0,
          behaviour: 0,
          sightings,
          fastReplyShare: sightings ? 0.5 : 0,
          raters: 0,
          slopRaters: 0,
          notSlopRaters: 0,
        },
      };
    });
    return {
      accounts,
      installs: input.installs.map((i) => ({ id: i.id, reputation, goodMarks: 0, standing: i.trusted })),
      struckNetworks: 0,
      model: { epochs: 0 },
    };
  };
}
