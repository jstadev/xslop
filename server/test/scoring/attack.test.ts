// The attack search of round 2 (lane red-engine): every goal against every attacker budget, run after run
// in time, with the invariants of the lane spec asserted on every run. The numbers it prints are the risks
// that stay (README.md section 9).
import { describe, expect, test } from 'vitest';
import {
  ANCHORS_CONFIRM, ANCHORS_FLAG, EVIDENCE_CONFIRM, EVIDENCE_FLAG, GOOD_MARKS_PER_ACCOUNT, NETWORK_DAILY_VOTES, STANDING_MIN_GOOD_MARKS, computeScores,
  type ScoringInput, type ScoringOutput,
} from '../../src/scoring/index.js';
import { campaign, type Goal } from './attack.js';
import { DAY, rng } from './helpers.js';

const publicState = (out: ScoringOutput): string[] => out.accounts.map((a) => `${a.handle}:${a.status}:${a.tier}`);
const finite = (x: unknown): boolean => (typeof x === 'number' ? Number.isFinite(x) : typeof x === 'object' && x !== null ? Object.values(x).every(finite) : true);
const shuffled = <T>(xs: T[], next: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
};

function assertRun(input: ScoringInput, out: ScoringOutput, adminConfirms: number, label: string): void {
  // (a) No public state without the anchors and the server facts of its tier, unless an admin override or a starter account.
  for (const a of out.accounts) {
    if (a.parts.reason === 'votes_flagged') expect([a.parts.anchors >= ANCHORS_FLAG, a.parts.evidence >= EVIDENCE_FLAG], `${label} ${a.handle}`).toEqual([true, true]);
    if (a.parts.reason === 'votes_confirmed') expect([a.parts.anchors >= ANCHORS_CONFIRM, a.parts.evidence >= EVIDENCE_CONFIRM], `${label} ${a.handle}`).toEqual([true, true]);
  }
  // (b) "Not slop" of installs without standing changes no public state.
  const plain = new Set(input.installs.filter((i) => !i.standing && !i.trusted).map((i) => i.id));
  const without = computeScores({ ...input, votes: input.votes.filter((v) => !(v.value === 0 && plain.has(v.install))) });
  expect(publicState(without), `${label} (b)`).toEqual(publicState(out));
  // (c) Standing only through admin decisions: at most GOOD_MARKS_PER_ACCOUNT good marks for each admin confirm.
  expect(out.installs.reduce((s, i) => s + i.goodMarks, 0), `${label} (c)`).toBeLessThanOrEqual(GOOD_MARKS_PER_ACCOUNT * adminConfirms);
  for (const i of out.installs) if (i.standing) expect(i.goodMarks, `${label} (c) ${i.id}`).toBeGreaterThanOrEqual(STANDING_MIN_GOOD_MARKS);
  // (e) Every number is finite.
  expect(finite(out), `${label} (e)`).toBe(true);
}

describe('attack search: every goal, every budget, run after run (SPEC.md 13.10, lane red-engine)', () => {
  const rows: string[] = [];
  const goals: Goal[] = ['smear', 'shield', 'farm'];
  for (const goal of goals) {
    test.each([0, 1, 2, 5, 20])(`${goal} with %i installs with standing`, (standing) => {
      const r = campaign({ seed: 41 + standing, standing, goal });
      for (const run of r.runs) {
        assertRun(run.input, run.out, run.input.accounts.filter((a) => a.override === 'confirm').length, `${goal}/${standing} day ${run.day}`);
        // (d) The votes that one ring network cast in the last 24 hours change at most NETWORK_DAILY_VOTES public states.
        if (run.day >= 10) {
          for (const net of [...new Set(run.input.installs.filter((i) => i.id.startsWith('ring')).map((i) => i.ipHash))].slice(0, 5)) {
            const ids = new Set(run.input.installs.filter((i) => i.ipHash === net).map((i) => i.id));
            const since = run.input.now.getTime() - DAY;
            const out = computeScores({ ...run.input, votes: run.input.votes.filter((v) => !(ids.has(v.install) && v.at.getTime() > since)) });
            const before = publicState(run.out);
            expect(publicState(out).filter((s, k) => s !== before[k]).length, `${goal}/${standing} day ${run.day} (d) ${net}`).toBeLessThanOrEqual(NETWORK_DAILY_VOTES);
          }
        }
      }
      // (e) The same rows in any order give the same output.
      const last = r.runs.at(-1)!;
      const next = rng(standing + 7);
      expect(computeScores({ ...last.input, installs: shuffled(last.input.installs, next), votes: shuffled(last.input.votes, next), clearedVotes: shuffled(last.input.clearedVotes, next) })).toEqual(last.out);
      rows.push(`${goal} standing=${standing}: victims listed ${r.smearListed} (runs ${r.smearListedRuns}), real slop held by a dispute ${r.shieldHeld} runs, attacker installs with standing at the end ${r.attackerStanding}, caught ring installs with standing ${r.penalizedWithStanding}, good marks ${r.goodMarks}, admin confirms ${r.adminConfirms}`);
      if (goal === 'smear' && standing === 0) expect(r.smearListed).toBe(0);
      // (c) A wrong vote that the admin caught takes the standing away; deleting or flipping it afterwards does not give it back.
      expect(r.penalizedWithStanding).toBe(0);
    }, 120_000);
  }
  test('summary', () => { for (const row of rows) console.log(row); expect(rows.length).toBe(15); });
});
