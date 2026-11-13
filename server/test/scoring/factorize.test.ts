// The factor model as far as the one-camp veto needs it (SPEC.md 13.4).
import { describe, expect, test } from 'vitest';
import { EVIDENCE_CONFIRM, computeScores } from '../../src/scoring/index.js';
import {
  FITTED_MIN_VOICES, MAX_EPOCHS, TWO_SIDED_MIN_VOICES, VETO_FACTOR, factorize, slopSideFit, twoSidedNetworks, twoSidedSlopVoices, type FactorVote,
} from '../../src/scoring/factorize.js';
import { account, allOf, anchor, anchors, camps, input, scoreOf, vote } from './helpers.js';

// Voices: network u on account a. Accounts 0..2 are contested by networks 0 (slop) and 1 (not slop).
const contested: FactorVote[] = [0, 1, 2].flatMap((a) => [{ a, u: 0, value: 1 as const, w: 1 }, { a, u: 1, value: 0 as const, w: 1 }]);

describe('two-sided networks and fitted accounts', () => {
  test(`a network is two-sided with ${TWO_SIDED_MIN_VOICES} voices on contested accounts, slop and not slop among them`, () => {
    const mixed: FactorVote[] = [...contested, { a: 0, u: 2, value: 1, w: 1 }, { a: 1, u: 2, value: 0, w: 1 }, { a: 2, u: 2, value: 1, w: 1 }];
    expect([...twoSidedNetworks(mixed, 3, 3)]).toEqual([0, 0, 1]);
    expect([...twoSidedNetworks(mixed.slice(0, -1), 3, 3)]).toEqual([0, 0, 0]); // two voices are not enough
  });

  test(`an account is fitted with ${FITTED_MIN_VOICES} slop voices from two-sided networks`, () => {
    const votes: FactorVote[] = [0, 1, 2, 3, 4].map((u) => ({ a: 0, u, value: 1, w: 1 }));
    expect([...twoSidedSlopVoices(votes, Uint8Array.from([1, 1, 1, 1, 0]), 1)]).toEqual([4]);
    expect([...twoSidedSlopVoices(votes, Uint8Array.from([1, 1, 1, 0, 0]), 1)]).toEqual([3]);
  });

  test('the side fit gives a network that is not two-sided no factor and reads only slop voices', () => {
    const { L, R, votes } = camps(6, 6);
    const out = computeScores(input({ installs: [...L, ...R], votes }));
    expect(out.model.epochs).toBeGreaterThan(0);
    expect(out.model.epochs).toBeLessThan(MAX_EPOCHS);
    const voices: FactorVote[] = [...contested, ...[3, 4, 5, 6].map((u) => ({ a: 3, u, value: 1 as const, w: 0.5 }))];
    const fit = factorize(voices, 4, ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    const side = slopSideFit(fit, voices, Uint8Array.from([1, 1, 0, 1, 1, 0, 0]));
    expect([...side.fu]).toEqual([fit.fu[0], fit.fu[1], 0, fit.fu[3], fit.fu[4], 0, 0]);
    const slopOnly = slopSideFit(fit, voices.filter((v) => v.value === 1), Uint8Array.from([1, 1, 0, 1, 1, 0, 0]));
    expect([...slopOnly.fa]).toEqual([...side.fa]);
  });

  test('the fit is deterministic', () => {
    const { L, R, votes } = camps(5, 7);
    const run = () => computeScores(input({ installs: [...L, ...R], votes: [...votes, ...allOf(L, 'x')] }));
    expect(run()).toEqual(run());
  });
});

describe('the level test is gone (measured 2026-11-12)', () => {
  test('a crowd that only clicks slop is never vetoed, also with "not slop" with standing on it', () => {
    const crowd = anchors('h', 166);
    const denier = anchor('denier');
    const handles = ['t0', 't1', 't2', 't3', 't4'];
    const out = computeScores(input({
      installs: [...crowd, denier],
      votes: [...handles.flatMap((h) => allOf(crowd, h)), ...handles.map((h) => vote('denier', h, 0))],
      accounts: handles.map((h) => account(h, { evidence: EVIDENCE_CONFIRM })),
    }));
    for (const h of handles) expect(scoreOf(out, h)).toMatchObject({ status: 'confirmed', parts: { factor: 0, notSlop: 1, networks: 166 } });
    expect(out.model.epochs).toBe(0); // no network is two-sided: the model does not run
  });

  test(`the veto needs |f_a| of at least ${VETO_FACTOR} in the fit of the slop voices`, () => {
    const { L, R, votes } = camps(8, 8);
    const out = computeScores(input({
      installs: [...L, ...R], votes: [...votes, ...allOf(L, 'onecamp'), ...allOf([...L, ...R], 'both')], accounts: [account('onecamp', { evidence: 2 }), account('both', { evidence: 2 })],
    }));
    expect(Math.abs(scoreOf(out, 'onecamp').parts.factor)).toBeGreaterThanOrEqual(VETO_FACTOR);
    expect(scoreOf(out, 'onecamp').parts.gate).toBe('dispute');
    expect(Math.abs(scoreOf(out, 'both').parts.factor)).toBeLessThan(VETO_FACTOR);
    expect(scoreOf(out, 'both').status).toBe('confirmed');
  });
});
