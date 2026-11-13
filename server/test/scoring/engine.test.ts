// The engine contract (SPEC.md 13.3, 13.7): rule order, parts, score, needed, behaviour, validation, order.
import { describe, expect, test } from 'vitest';
import {
  CONFIRM_MIN_NETWORKS, EVIDENCE_CONFIRM, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, NEEDED_MAX, SEED_DISPUTE_MIN_NETWORKS, SEED_SCORE_MIN, computeScores, wilsonLowerBound,
  type AccountInput, type ScoringInput,
} from '../../src/scoring/index.js';
import { DAY, account, ago, allOf, anchor, anchors, fresh, input, install, many, rng, scoreOf, sighting, sightingsFor, vote } from './helpers.js';

const crowd = [...anchors('s', 3), ...fresh('n', 3)];
const one = (o: Partial<Omit<AccountInput, 'handle'>>, who = crowd) =>
  scoreOf(computeScores(input({ installs: who, votes: allOf(who, 'acc'), accounts: [account('acc', { evidence: EVIDENCE_CONFIRM, ...o })] })), 'acc');

describe('rule order', () => {
  test('13.9.13 identity moved is never listed: votes, a starter account and an admin confirm', () => {
    for (const o of [{}, { seed: true }, { override: 'confirm' as const, overrideAt: ago(DAY), listedAt: ago(DAY) }]) {
      expect(one({ identity: 'moved', ...o })).toMatchObject({ status: 'none', tier: 0, score: 0, parts: { reason: 'moved', want: null, gate: null } });
    }
  });

  test('13.10.10 gone keeps its state, and votes list nothing new on it', () => {
    expect(one({ identity: 'gone', seed: true })).toMatchObject({ status: 'confirmed', parts: { reason: 'seed' } });
    expect(one({ identity: 'gone', override: 'confirm', overrideAt: ago(DAY), listedAt: ago(DAY) })).toMatchObject({ status: 'confirmed', parts: { reason: 'override_confirm' } });
    expect(one({ identity: 'gone', status: 'confirmed', listedAt: ago(DAY) })).toMatchObject({ status: 'confirmed', parts: { reason: 'votes_confirmed', gate: null } });
    expect(one({ identity: 'gone', status: 'flagged', listedAt: ago(DAY) })).toMatchObject({ status: 'flagged', parts: { want: 'confirmed', gate: 'identity' } });
    expect(one({ identity: 'gone' })).toMatchObject({ status: 'pending', tier: 0, parts: { want: 'confirmed', gate: 'identity' } });
  });

  test('the gates of rule 4 and rule 5 hold in their order: protected, identity, standing, evidence, brake', () => {
    const plain = many('o', 6);
    expect(one({ protected: true, identity: 'unknown', evidence: 0 }, plain).parts).toMatchObject({ want: 'confirmed', gate: 'protected' });
    expect(one({ identity: 'unknown', evidence: 0 }, plain).parts).toMatchObject({ want: 'confirmed', gate: 'identity' });
    expect(one({ evidence: 0 }, plain).parts).toMatchObject({ want: 'confirmed', gate: 'standing' });
    expect(one({ evidence: 0 }, [anchor('s0'), ...plain]).parts).toMatchObject({ want: 'confirmed', gate: 'standing' });
    expect(one({ evidence: 0 }, [...anchors('s', 2), ...plain])).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'evidence' } });
    // The brake comes last: on a day with no automatic place left, an account that misses evidence names evidence.
    const who = [...anchors('s', 2), ...plain];
    const full = (evidence: number) => scoreOf(computeScores(input({
      installs: who, votes: allOf(who, 'acc'), accounts: [account('acc', { evidence })], autoConfirmsToday: MAX_AUTO_CONFIRMS_PER_DAY, autoFlagsToday: MAX_AUTO_FLAGS_PER_DAY,
    })), 'acc');
    expect(full(0)).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'evidence' } });
    expect(full(EVIDENCE_CONFIRM)).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'brake' } });
  });

  test('an admin confirm and an admin clear win over the votes', () => {
    expect(one({ override: 'confirm', overrideAt: ago(DAY) }, [])).toMatchObject({ status: 'confirmed', tier: 2, score: 1, parts: { reason: 'override_confirm' } });
    expect(one({ override: 'clear', overrideAt: ago(DAY) })).toMatchObject({ status: 'cleared', tier: 0, score: 0, parts: { reason: 'override_clear', needed: 0 } });
  });

  test('a starter account is confirmed with a score of at least the seed score, also without votes or identity', () => {
    expect(one({ seed: true, identity: 'unknown' }, [])).toMatchObject({ status: 'confirmed', tier: 2, score: SEED_SCORE_MIN, parts: { reason: 'seed', disputed: false } });
    expect(one({ seed: true, protected: true })).toMatchObject({ status: 'confirmed', parts: { reason: 'seed' } });
  });

  test(`${SEED_DISPUTE_MIN_NETWORKS} not-slop networks with standing dispute a starter account; votes never remove it`, () => {
    const deniers = anchors('d', SEED_DISPUTE_MIN_NETWORKS);
    const run = (who: typeof deniers) => scoreOf(computeScores(input({ installs: who, votes: allOf(who, 'acc', 0), accounts: [account('acc', { seed: true })] })), 'acc');
    expect(run(deniers)).toMatchObject({ status: 'confirmed', parts: { disputed: true, notSlop: SEED_DISPUTE_MIN_NETWORKS } });
    expect(run(deniers.slice(1))).toMatchObject({ status: 'confirmed', parts: { disputed: false } });
    expect(run(fresh('x', 50))).toMatchObject({ status: 'confirmed', parts: { disputed: false, dissent: 50 } });
  });

  test('stored standing is checked again: a loader fault does not give a new or low install standing', () => {
    const faulty = [install('young', { standing: true, ageDays: 2 }), install('low', { standing: true, reputation: 0.4 }), ...fresh('n', 2)];
    expect(one({}, faulty)).toMatchObject({ status: 'pending', parts: { anchors: 0, gate: 'standing' } });
    const run = computeScores(input({ installs: faulty }));
    expect(run.installs.map((i) => i.standing)).toEqual([false, false, false, false]);
  });

  test('a cleared account counts only the votes after the clear', () => {
    const early = allOf(crowd, 'acc', 1, ago(5 * DAY));
    const out = computeScores(input({ installs: crowd, votes: early, accounts: [account('acc', { clearedAt: ago(DAY), evidence: 9 })] }));
    expect(scoreOf(out, 'acc')).toMatchObject({ status: 'cleared', parts: { reason: 'cleared', networks: 0, raters: 0 } });
  });
});

describe('parts and score', () => {
  test('every part is set, and the score of a votes decision is the Wilson bound of the share test', () => {
    const a = one({});
    expect(Object.keys(a.parts).sort()).toEqual([
      'anchors', 'behaviour', 'disputed', 'dissent', 'evidence', 'factor', 'fastReplyShare', 'gate', 'needed', 'networks', 'notSlop', 'notSlopRaters',
      'raters', 'reason', 'sightings', 'slopRaters', 'trust', 'want',
    ]);
    expect(a).toMatchObject({ status: 'confirmed', score: Math.round(wilsonLowerBound(1, 6) * 1000) / 1000 });
    expect(a.parts).toMatchObject({ networks: 6, anchors: 3, notSlop: 0, dissent: 0, trust: 3.45, raters: 6, slopRaters: 6, notSlopRaters: 0, evidence: EVIDENCE_CONFIRM });
  });

  test('a pending account has a score for the review queue; one network alone is none with score 0', () => {
    const newOnly = fresh('n', 3);
    const p = one({}, newOnly);
    expect(p).toMatchObject({ status: 'pending', score: Math.round(wilsonLowerBound(1, 3) * 1000) / 1000, parts: { want: 'flagged', gate: 'standing' } });
    expect(one({}, newOnly.slice(0, 1))).toMatchObject({ status: 'none', score: 0, parts: { reason: 'none', want: null, gate: null } });
  });

  test('needed counts the networks of new installs until the crowd test of the next tier passes', () => {
    expect(one({}, fresh('n', 1)).parts.needed).toBe(1);
    expect(one({}, fresh('n', 2)).parts.needed).toBe(5); // trust 0.3: 5 more new networks reach 1
    expect(one({}, [anchor('s0'), ...fresh('n', 1)]).parts.needed).toBe(2); // 4 networks, trust 1.45
    expect(one({}, many('o', 3)).parts.needed).toBe(1);
    expect(one({}, many('o', CONFIRM_MIN_NETWORKS)).parts.needed).toBe(0); // the crowd passes; standing holds it
    expect(one({}).parts.needed).toBe(0);
    expect(NEEDED_MAX).toBe(20);
  });

  test('banned installs and votes of unknown installs count for nothing; their handles still get a row', () => {
    const out = computeScores(input({
      installs: anchors('b', 6, { banned: true }),
      votes: [...allOf(anchors('b', 6), 'acc'), vote('ghost', 'other', 1)],
      accounts: [account('acc', { evidence: 5 })],
    }));
    expect(scoreOf(out, 'acc')).toMatchObject({ status: 'none', parts: { networks: 0, raters: 0 } });
    expect(scoreOf(out, 'other')).toMatchObject({ status: 'none', parts: { networks: 0, raters: 0 } });
  });
});

describe('behaviour is information only', () => {
  test('a bot-like reply pattern scores high, a human one low, and neither changes a status', () => {
    const next = rng(5);
    const sightings = [...sightingsFor('bot', 30, 'bot', next), ...sightingsFor('human', 30, 'human', next)];
    const out = computeScores(input({ sightings, accounts: [account('bot', { evidence: 5 }), account('human')] }));
    const bot = scoreOf(out, 'bot');
    const human = scoreOf(out, 'human');
    expect(bot.parts.behaviour).toBeGreaterThan(0.9);
    expect(bot.parts.fastReplyShare).toBe(1);
    expect(human.parts.behaviour).toBeLessThan(0.1);
    expect([bot.status, human.status]).toEqual(['none', 'none']);
    const marked = fresh('n', 2);
    const withVotes = computeScores(input({ installs: marked, votes: allOf(marked, 'bot'), sightings, accounts: [account('bot', { evidence: 5 })] }));
    expect(scoreOf(withVotes, 'bot')).toMatchObject({ status: 'pending', parts: { gate: 'standing', sightings: 30 } });
  });

  test('fewer than 10 sightings: behaviour 0', () => {
    const out = computeScores(input({ sightings: sightingsFor('few', 9, 'bot', rng(1)) }));
    expect(scoreOf(out, 'few').parts).toMatchObject({ behaviour: 0, sightings: 9 });
  });
});

describe('input validation fails closed', () => {
  const good = (): ScoringInput => input({ installs: [install('i1')], votes: [vote('i1', 'acc', 1)], accounts: [account('acc')], sightings: [sighting('acc')] });
  test.each<[string, (x: ScoringInput) => void]>([
    ['a bad handle', (x) => { x.votes[0]!.handle = 'Bad-Handle'; }],
    ['a bad vote value', (x) => { (x.votes[0] as { value: number }).value = 2; }],
    ['a duplicate vote', (x) => { x.votes.push({ ...x.votes[0]! }); }],
    ['a missing standing', (x) => { delete (x.installs[0] as Partial<typeof x.installs[0]>).standing; }],
    ['a bad identity', (x) => { (x.accounts[0] as { identity: string }).identity = 'maybe'; }],
    ['a bad status', (x) => { (x.accounts[0] as { status: string }).status = 'listed'; }],
    ['negative evidence', (x) => { x.accounts[0]!.evidence = -1; }],
    ['a fractional autoConfirmsToday', (x) => { x.autoConfirmsToday = 1.5; }],
    ['an invalid date', (x) => { x.accounts[0]!.overrideAt = new Date(Number.NaN); }],
    ['a bad latency', (x) => { (x.sightings[0] as { latencySec: unknown }).latencySec = 'fast'; }],
    ['a cleared vote without ipHash', (x) => { x.clearedVotes.push({ install: 'i1', handle: 'acc', value: 1, at: ago(DAY), clearedAt: ago(DAY) } as never); }],
    ['two cleared rows of one install', (x) => { const r = { install: 'i1', ipHash: 'n', handle: 'acc', value: 1 as const, at: ago(DAY), clearedAt: ago(DAY), standing: false }; x.clearedVotes.push(r, { ...r }); }],
    ['a cleared vote without standing', (x) => { x.clearedVotes.push({ install: 'i1', ipHash: 'n', handle: 'acc', value: 1, at: ago(DAY), clearedAt: ago(DAY) } as never); }],
    ['a missing autoFlagsToday', (x) => { delete (x as Partial<ScoringInput>).autoFlagsToday; }],
  ])('%s throws', (_, spoil) => {
    const x = good();
    expect(() => computeScores(x)).not.toThrow();
    spoil(x);
    expect(() => computeScores(x)).toThrow(TypeError);
  });
});
