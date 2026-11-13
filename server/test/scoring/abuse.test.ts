// Attacks on the list flow that the engine must stop (SPEC.md 13.9). Each test asserts the exact outcome
// through computeScores.
import { describe, expect, test } from 'vitest';
import {
  ANCHORS_CONFIRM, ANCHORS_FLAG, EVIDENCE_CONFIRM, EVIDENCE_FLAG, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, NETWORK_DAILY_VOTES, STANDING_DAILY, computeScores,
  type AccountInput, type AccountScore, type ClearedVoteInput, type InstallInput, type ScoringInput, type ScoringOutput, type VoteInput,
} from '../../src/scoring/index.js';
import {
  DAY, HOUR, NOW, account, ago, allOf, anchor, anchors, byHandle, camps, cleared, fresh, input, install, many, rng, scoreOf, vote, zipfHandle, zipfPopulation,
} from './helpers.js';

const target = (o: Partial<ScoringInput>, handle = 'target'): AccountScore => scoreOf(computeScores(input(o)), handle);
const checked = (handle: string, o: Partial<Omit<AccountInput, 'handle'>> = {}): AccountInput => account(handle, { evidence: EVIDENCE_CONFIRM, ...o });

describe('13.9.1 a crowd of new installs lists nothing', () => {
  test.each([[2, 'flagged'], [7, 'confirmed'], [1000, 'confirmed']] as const)('%i brand-new networks: pending, gate standing', (n, want) => {
    const crowd = fresh('new', n);
    const a = target({ installs: crowd, votes: allOf(crowd, 'target'), accounts: [checked('target', { evidence: n })] });
    expect(a).toMatchObject({ status: 'pending', tier: 0 });
    expect(a.parts).toMatchObject({ gate: 'standing', want, networks: n, anchors: 0, reason: 'pending' });
  });
});

describe('13.9.2 anchors and server facts', () => {
  const crowd = [...anchors('s', 2), ...fresh('n', 2)];
  const run = (o: Partial<Omit<AccountInput, 'handle'>>) => target({ installs: crowd, votes: allOf(crowd, 'target'), accounts: [account('target', o)] });

  test('4 networks, 2 with standing, identity ok, evidence 2: confirmed', () => {
    const a = run({ evidence: 2 });
    expect(a).toMatchObject({ status: 'confirmed', tier: 2 });
    expect(a.parts).toMatchObject({ reason: 'votes_confirmed', want: null, gate: null, networks: 4, anchors: ANCHORS_CONFIRM, evidence: 2, needed: 0 });
  });

  test('evidence 1: flagged with want confirmed, gate evidence', () => {
    const a = run({ evidence: 1 });
    expect(a).toMatchObject({ status: 'flagged', tier: 1 });
    expect(a.parts).toMatchObject({ reason: 'votes_flagged', want: 'confirmed', gate: 'evidence' });
  });

  test('identity unknown: pending, gate identity', () => {
    expect(run({ evidence: 2, identity: 'unknown' }).parts).toMatchObject({ reason: 'pending', want: 'confirmed', gate: 'identity' });
    expect(run({ evidence: 2, identity: 'unknown' })).toMatchObject({ status: 'pending', tier: 0 });
  });

  test('one anchor flags, none leaves it pending: the standing gates of both tiers', () => {
    const one = [anchor('s0'), ...fresh('n', 1)];
    expect(target({ installs: one, votes: allOf(one, 'target'), accounts: [checked('target')] })).toMatchObject({ status: 'flagged', parts: { anchors: ANCHORS_FLAG, want: null, gate: null } });
    const three = [anchor('s0'), ...fresh('n', 6)];
    expect(target({ installs: three, votes: allOf(three, 'target'), accounts: [checked('target')] }).parts).toMatchObject({ want: 'confirmed', gate: 'standing' });
  });
});

describe('13.9.3 "not slop" without standing changes nothing', () => {
  test('1000 not-slop votes of installs without standing change no status; dissent is 1000', () => {
    const honest = [...anchors('s', 2), ...fresh('n', 2)];
    const flag = [anchor('f0'), ...fresh('g', 1)];
    const deniers = [...fresh('d', 500), ...many('w', 500, { ageDays: 8, reputation: 1 })];
    const accounts = [checked('confirmed1'), checked('flagged1'), checked('pending1')];
    const base: VoteInput[] = [...allOf(honest, 'confirmed1'), ...allOf(flag, 'flagged1'), ...allOf(fresh('p', 3), 'pending1')];
    const installs = [...honest, ...flag, ...fresh('p', 3)];
    const before = computeScores(input({ installs, votes: base, accounts }));
    const after = computeScores(input({
      installs: [...installs, ...deniers],
      votes: [...base, ...['confirmed1', 'flagged1', 'pending1'].flatMap((h) => allOf(deniers, h, 0))],
      accounts,
    }));
    for (const h of ['confirmed1', 'flagged1', 'pending1']) {
      const [b, a] = [scoreOf(before, h), scoreOf(after, h)];
      expect({ status: a.status, score: a.score, gate: a.parts.gate, notSlop: a.parts.notSlop }).toEqual({ status: b.status, score: b.score, gate: b.parts.gate, notSlop: 0 });
      expect(a.parts.dissent).toBe(1000);
    }
    expect(scoreOf(after, 'confirmed1').status).toBe('confirmed');
    expect(scoreOf(after, 'flagged1').status).toBe('flagged');
    expect(scoreOf(after, 'pending1').status).toBe('pending');
  });
});

describe('13.9.4 one "not slop" voice with standing', () => {
  const run = (nAnchors: number, nNew: number) => {
    const slop = [...anchors('s', nAnchors), ...fresh('n', nNew)];
    const denier = anchor('denier');
    return target({ installs: [...slop, denier], votes: [...allOf(slop, 'target'), vote('denier', 'target', 0)], accounts: [checked('target', { evidence: 6 })] });
  };

  test('against 2 anchors and 2 new networks: pending, gate dispute', () => {
    const a = run(2, 2);
    expect(a).toMatchObject({ status: 'pending', tier: 0 });
    expect(a.parts).toMatchObject({ want: 'confirmed', gate: 'dispute', anchors: 2, notSlop: 1, dissent: 0 });
  });

  test('against 6 anchors: confirmed', () => {
    expect(run(6, 0)).toMatchObject({ status: 'confirmed', parts: { reason: 'votes_confirmed', notSlop: 1 } });
  });
});

// The probes of 2026-11-12 (/tmp/xslop-probe): a launch population of 200 users that earned standing,
// on a list that earlier runs settled (stored as confirmed, so the daily brake is not in the way).
describe('13.9.5 the three probes touch only what they touch', () => {
  const population = () => zipfPopulation(200, { install: { ageDays: 8, reputation: 0.8, standing: true } });
  const base = population();
  const handles = [...new Set(base.votes.map((v) => v.handle))];
  const accounts = handles.map((h) => checked(h, { status: 'confirmed' }));
  const before = computeScores(input({ installs: base.installs, votes: base.votes, accounts }));
  const status = new Map(before.accounts.map((a) => [a.handle, a.status]));
  const listed = before.accounts.filter((a) => a.tier >= 1).sort((x, y) => y.parts.networks - x.parts.networks || (x.handle < y.handle ? -1 : 1)).map((a) => a.handle);
  const changedOutside = (out: ScoringOutput, touched: Set<string>): string[] =>
    out.accounts.filter((a) => !touched.has(a.handle) && a.status !== status.get(a.handle)).map((a) => a.handle);

  test('the baseline lists accounts', () => {
    expect(before.accounts.filter((a) => a.status === 'confirmed').length).toBeGreaterThan(50);
  });

  test('one install made 15 minutes ago with 50 "not slop" votes changes nothing at all', () => {
    const atk = install('atk', { ageDays: 15 / 1440, reputation: 0.5 });
    const out = computeScores(input({ installs: [...base.installs, atk], votes: [...base.votes, ...listed.slice(0, 50).map((h, i) => vote('atk', h, 0, ago(300_000 + i)))], accounts }));
    expect(changedOutside(out, new Set())).toEqual([]);
  });

  test('10 week-old installs with 50 "not slop" votes each change nothing at all', () => {
    const atk = many('wk', 10, { ageDays: 8, reputation: 0.5 });
    const votes = atk.flatMap((u, j) => listed.slice(j * 50, j * 50 + 50).map((h) => vote(u.id, h, 0, ago(300_000))));
    const out = computeScores(input({ installs: [...base.installs, ...atk], votes: [...base.votes, ...votes], accounts }));
    expect(changedOutside(out, new Set())).toEqual([]);
  });

  test.each([5, 10, 20])('%i honest "not slop" clicks with standing change no account that they did not touch', (m) => {
    const w = population();
    const touched = new Set<string>();
    for (let j = 0; j < m; j++) {
      const id = w.installs[199 - j]!.id;
      const h = listed[j]!;
      touched.add(h);
      const k = w.votes.findIndex((v) => v.install === id && v.handle === h);
      if (k >= 0) w.votes[k] = vote(id, h, 0, ago(HOUR));
      else w.votes.push(vote(id, h, 0, ago(HOUR)));
    }
    const out = computeScores(input({ installs: w.installs, votes: w.votes, accounts }));
    expect(changedOutside(out, touched)).toEqual([]);
  });
});

describe('13.9.6 two real camps', () => {
  const { L, R, votes } = camps(8, 8);
  const out = computeScores(input({
    installs: [...L, ...R],
    votes: [...votes, ...allOf(L, 'onecamp'), ...allOf(L, 'bothcamps'), ...allOf(R, 'bothcamps')],
    accounts: [checked('onecamp'), checked('bothcamps')],
  }));

  test('an account that one camp marks gets gate dispute', () => {
    expect(scoreOf(out, 'onecamp')).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'dispute', anchors: 8 } });
    expect(Math.abs(scoreOf(out, 'onecamp').parts.factor)).toBeGreaterThanOrEqual(0.5);
  });

  test('an account that both camps mark is confirmed', () => {
    expect(scoreOf(out, 'bothcamps')).toMatchObject({ status: 'confirmed', parts: { reason: 'votes_confirmed', anchors: 16 } });
    expect(Math.abs(scoreOf(out, 'bothcamps').parts.factor)).toBeLessThan(0.5);
  });
});

describe('13.9.7 a protected account waits for a person', () => {
  test.each([[anchors('s', 10)], [fresh('n', 2)], [[...anchors('s', 3), ...fresh('n', 500)]]])('crowd %#: pending, gate protected', (crowd) => {
    const a = target({ installs: crowd, votes: allOf(crowd, 'target'), accounts: [checked('target', { protected: true, evidence: 10 })] });
    expect(a).toMatchObject({ status: 'pending', tier: 0, parts: { gate: 'protected' } });
  });
});

describe('13.9.8 the daily brake', () => {
  const crowd = anchors('s', 4);
  const run = (autoConfirmsToday: number, accounts: AccountInput[]) =>
    computeScores(input({ installs: crowd, votes: accounts.flatMap((a) => allOf(crowd, a.handle)), accounts, autoConfirmsToday }));

  test(`with ${MAX_AUTO_CONFIRMS_PER_DAY} automatic confirms in the day, the next one is flagged with gate brake; a confirmed account stays`, () => {
    const out = run(MAX_AUTO_CONFIRMS_PER_DAY, [checked('nextone'), checked('already', { status: 'confirmed' })]);
    expect(scoreOf(out, 'nextone')).toMatchObject({ status: 'flagged', tier: 1, parts: { want: 'confirmed', gate: 'brake' } });
    expect(scoreOf(out, 'already')).toMatchObject({ status: 'confirmed', parts: { gate: null } });
  });

  test('round 2 H2: networks without standing do not move an account up the brake order', () => {
    const handles = Array.from({ length: MAX_AUTO_CONFIRMS_PER_DAY + 1 }, (_, i) => `brake${String(i).padStart(3, '0')}`);
    const crowds = handles.map((_, i) => [...anchors(`s${i}x`, 2), ...fresh(`n${i}x`, 2)]); // each account its own 2 anchors and 2 networks
    const flood = fresh('z', 10);
    const run = (extra: typeof flood) => computeScores(input({
      installs: [...crowds.flat(), ...extra],
      votes: [...handles.flatMap((h, i) => allOf(crowds[i]!, h, 1, ago(2 * DAY))), ...allOf(extra, handles.at(-1)!)],
      accounts: handles.map((h) => checked(h)),
    }));
    const held = (out: ScoringOutput) => out.accounts.filter((a) => a.parts.gate === 'brake').map((a) => a.handle);
    expect(held(run([]))).toEqual([handles.at(-1)]);
    expect(held(run(flood))).toEqual([handles.at(-1)]);
  });

  test('the places left go to the most anchors first, then the handle', () => {
    const fewer = [...crowd.slice(0, 3), ...fresh('x', 1)];
    const out = computeScores(input({
      installs: [...crowd, ...fresh('x', 1)],
      votes: [...allOf(crowd, 'bbb'), ...allOf(crowd, 'ccc'), ...allOf(fewer, 'aaa')],
      accounts: [checked('aaa'), checked('bbb'), checked('ccc')],
      autoConfirmsToday: MAX_AUTO_CONFIRMS_PER_DAY - 1,
    }));
    expect([scoreOf(out, 'aaa').parts.gate, scoreOf(out, 'bbb').parts.gate, scoreOf(out, 'ccc').parts.gate]).toEqual(['brake', null, 'brake']);
    expect(scoreOf(out, 'bbb').status).toBe('confirmed');
  });

  test('13.12 brake order: with equal anchors the higher bound of the voices with standing goes first, before the handle', () => {
    const six = anchors('s', 6);
    const out = computeScores(input({
      installs: [...six, anchor('denier')],
      votes: [...allOf(six, 'aaa_dissent'), vote('denier', 'aaa_dissent', 0), ...allOf(six, 'bbb_clean')],
      accounts: [checked('aaa_dissent'), checked('bbb_clean')],
      autoConfirmsToday: MAX_AUTO_CONFIRMS_PER_DAY - 1,
    }));
    // 6 anchors against 1 "not slop" voice with standing pass the confirm test (bound 0.622), but 6 anchors alone rank higher.
    expect(scoreOf(out, 'bbb_clean')).toMatchObject({ status: 'confirmed', parts: { anchors: 6, notSlop: 0, gate: null } });
    expect(scoreOf(out, 'aaa_dissent')).toMatchObject({ status: 'flagged', parts: { anchors: 6, notSlop: 1, want: 'confirmed', gate: 'brake' } });
  });
});

describe('13.9.9 a shared address', () => {
  const others = [anchor('s1'), ...fresh('n', 2)];
  const owner = anchor('owner', { ipHash: 'shared' });
  const intruders = (n: number, ageDays = 8) => many('in', n, { ipHash: 'shared', ageDays, reputation: 1 });

  test.each([1, 2, 3, 20])('%i installs without standing on the address do not turn the voice of the install with standing there', (n) => {
    const evil = intruders(n);
    const a = target({ installs: [owner, ...others, ...evil], votes: [...allOf([owner, ...others], 'target'), ...allOf(evil, 'target', 0)], accounts: [checked('target')] });
    expect(a).toMatchObject({ status: 'confirmed', parts: { networks: 4, anchors: 2, notSlop: 0 } });
  });

  test('installs without standing on the address cannot turn its "not slop" voice with standing into a slop anchor', () => {
    const slopOnAddress = intruders(3);
    const crowd = [...anchors('s', 2), ...fresh('n', 2)];
    const a = target({
      installs: [owner, ...slopOnAddress, ...crowd], votes: [vote('owner', 'target', 0), ...allOf(slopOnAddress, 'target'), ...allOf(crowd, 'target')], accounts: [checked('target')],
    });
    expect(a).toMatchObject({ status: 'pending', parts: { gate: 'dispute', want: 'confirmed', networks: 4, anchors: 2, notSlop: 1 } });
  });

  test(`${NETWORK_DAILY_VOTES} junk votes on the address earlier that day do not take the budget of the install with standing`, () => {
    const evil = intruders(1);
    const junk = Array.from({ length: NETWORK_DAILY_VOTES }, (_, j) => vote(evil[0]!.id, `junk${j}`, 1, ago(12 * HOUR - j)));
    const a = target({ installs: [owner, ...others, ...evil], votes: [...junk, ...allOf([owner, ...others], 'target', 1, ago(HOUR))], accounts: [checked('target')] });
    expect(a).toMatchObject({ status: 'confirmed', parts: { networks: 4 } });
  });

  test('without standing, the same junk does take the budget: the rule is what protects the voice', () => {
    const plain = install('plain', { ipHash: 'shared' });
    const evil = intruders(1);
    const junk = Array.from({ length: NETWORK_DAILY_VOTES }, (_, j) => vote(evil[0]!.id, `junk${j}`, 1, ago(12 * HOUR - j)));
    const a = target({ installs: [plain, ...others, ...evil], votes: [...junk, ...allOf([plain, ...others], 'target', 1, ago(HOUR))], accounts: [checked('target')] });
    expect(a.parts.networks).toBe(3);
  });
});

// SPEC.md 13.12 "Standing budget" (replaces 13.10 item 4): one identity with standing cannot flag or dispute many
// accounts in a day, and a vote past the budget never carries standing, so there is no waiting list.
describe('13.12 the standing budget', () => {
  const owner = anchor('owner');
  const handles = Array.from({ length: 20 }, (_, i) => `burst${String(i).padStart(2, '0')}`);
  const partner = fresh('n', 1);

  test(`an install with standing that marks 20 accounts in an hour anchors ${STANDING_DAILY}; the others never carry standing`, () => {
    const run = (now: Date) => computeScores(input({
      now, installs: [owner, ...partner], votes: handles.flatMap((h, i) => [vote('owner', h, 1, ago(HOUR - i * 1000)), vote('n0', h, 1, ago(HOUR))]),
      accounts: handles.map((h) => checked(h, { evidence: EVIDENCE_FLAG })),
    }));
    for (const out of [run(NOW), run(ago(-DAY)), run(ago(-7 * DAY))]) {
      expect(out.accounts.filter((a) => a.status === 'flagged').map((a) => a.handle)).toEqual(handles.slice(0, STANDING_DAILY));
      expect(out.accounts.filter((a) => a.status === 'pending' && a.parts.gate === 'standing').length).toBe(20 - STANDING_DAILY);
    }
  });

  test('20 marks a day for 7 days, then a new mark carries standing the next day', () => {
    // Day d marks 20 accounts, one every 30 minutes from 08:00 to 17:30, 7 - d days before NOW (12:00).
    const days = Array.from({ length: 7 }, (_, d) => Array.from({ length: 20 }, (_, i) => `heavy${d}x${String(i).padStart(2, '0')}`));
    const marks = days.flatMap((day, d) => day.map((h, i) => vote('owner', h, 1, ago((7 - d) * DAY + 4 * HOUR - i * (HOUR / 2)))));
    const out = computeScores(input({
      installs: [owner, ...partner], votes: [...marks, vote('owner', 'newmark', 1, ago(HOUR)), vote('n0', 'newmark', 1, ago(HOUR))],
      accounts: [checked('newmark', { evidence: EVIDENCE_FLAG })],
    }));
    // The first 5 marks of each day carried standing, and no later mark took a place of an earlier day.
    expect(out.accounts.filter((a) => a.handle.startsWith('heavy') && a.parts.anchors === 1).map((a) => a.handle)).toEqual(days.flatMap((day) => day.slice(0, STANDING_DAILY)));
    expect(scoreOf(out, 'newmark')).toMatchObject({ status: 'flagged', tier: 1, parts: { anchors: 1, gate: null } });
  });

  test('installs with standing on one network share its standing budget', () => {
    const pair = [anchor('pa', { ipHash: 'home' }), anchor('pb', { ipHash: 'home' })];
    const out = computeScores(input({
      installs: [...pair, ...partner],
      votes: handles.flatMap((h, i) => [vote(pair[i % 2]!.id, h, 1, ago(HOUR - i * 1000)), vote('n0', h, 1, ago(HOUR))]),
      accounts: handles.map((h) => checked(h, { evidence: EVIDENCE_FLAG })),
    }));
    expect(out.accounts.filter((a) => a.status === 'flagged').length).toBe(STANDING_DAILY);
  });

  test(`"not slop" with standing disputes ${STANDING_DAILY} accounts in a day; the others count as dissent`, () => {
    const crowd = anchors('s', 2);
    const out = computeScores(input({
      installs: [owner, ...crowd, ...fresh('n', 2)],
      // The crowd marks one account every 5 hours: inside the standing budget of its networks.
      votes: handles.flatMap((h, i) => [vote('owner', h, 0, ago(HOUR - i * 1000)), ...allOf([...crowd, ...fresh('n', 2)], h, 1, ago(2 * DAY + i * 5 * HOUR))]),
      accounts: handles.map((h) => checked(h)),
    }));
    expect(out.accounts.filter((a) => a.parts.gate === 'dispute').map((a) => a.handle)).toEqual(handles.slice(0, STANDING_DAILY));
    expect(out.accounts.filter((a) => a.status === 'confirmed' && a.parts.dissent === 1).length).toBe(20 - STANDING_DAILY);
  });
});

// SPEC.md 13.10 item 6: a flag needs checked evidence, and the flag brake.
describe('13.10.6 flag evidence and the flag brake', () => {
  test('an anchor and a second network without checked evidence: pending, gate evidence; evidence 1: flagged', () => {
    const crowd = [anchor('s0'), ...fresh('n', 1)];
    const run = (evidence: number) => target({ installs: crowd, votes: allOf(crowd, 'target'), accounts: [checked('target', { evidence })] });
    expect(run(0)).toMatchObject({ status: 'pending', tier: 0, parts: { want: 'flagged', gate: 'evidence' } });
    expect(run(EVIDENCE_FLAG)).toMatchObject({ status: 'flagged', tier: 1, parts: { gate: null } });
  });

  test(`after ${MAX_AUTO_FLAGS_PER_DAY} automatic flags in the day the next one waits with gate brake; a listed account stays`, () => {
    const n = MAX_AUTO_FLAGS_PER_DAY + 1;
    const owners = anchors('f', n);
    const partners = fresh('p', n);
    const handles = owners.map((_, i) => `flag${String(i).padStart(3, '0')}`);
    const run = (autoFlagsToday: number) => computeScores(input({
      installs: [...owners, ...partners], votes: handles.flatMap((h, i) => [vote(owners[i]!.id, h, 1), vote(partners[i]!.id, h, 1)]),
      accounts: handles.map((h, i) => checked(h, { evidence: EVIDENCE_FLAG, status: i === n - 1 ? 'flagged' : 'none' })), autoFlagsToday,
    }));
    const out = run(0);
    expect(out.accounts.filter((a) => a.status === 'flagged').length).toBe(n);
    const full = run(MAX_AUTO_FLAGS_PER_DAY);
    expect(full.accounts.filter((a) => a.status === 'pending' && a.parts.gate === 'brake').length).toBe(n - 1);
    expect(scoreOf(full, handles[n - 1]!)).toMatchObject({ status: 'flagged', parts: { gate: null } });
    const one = run(MAX_AUTO_FLAGS_PER_DAY - 1);
    expect(one.accounts.filter((a) => a.status === 'flagged').map((a) => a.handle)).toEqual([handles[0], handles[n - 1]]);
  });

  test('a confirm that the confirm brake holds takes a flag place', () => {
    const crowd = anchors('s', 4);
    const out = computeScores(input({ installs: crowd, votes: allOf(crowd, 'held'), accounts: [checked('held')], autoConfirmsToday: MAX_AUTO_CONFIRMS_PER_DAY, autoFlagsToday: MAX_AUTO_FLAGS_PER_DAY }));
    expect(scoreOf(out, 'held')).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'brake' } });
  });
});

describe('13.9.14 a cleared account returns only through a person', () => {
  const run = (n: number) => {
    const crowd = many('c', n, { ageDays: 3, reputation: 0.5 });
    return target({ installs: crowd, votes: allOf(crowd, 'target'), accounts: [checked('target', { clearedAt: ago(2 * DAY), status: 'cleared' })] });
  };
  test('6 new networks after the reset: pending, gate review', () => {
    expect(run(6)).toMatchObject({ status: 'pending', tier: 0, parts: { want: 'confirmed', gate: 'review', networks: 6 } });
  });
  test('5 networks: cleared', () => {
    expect(run(5)).toMatchObject({ status: 'cleared', score: 0, parts: { reason: 'cleared' } });
  });
});

// Random mixes of honest networks with standing and attacker networks without standing. Invariants:
// nothing is listed by votes without the anchors and the server facts of its tier; a "not slop" vote
// without standing changes no status; the row order changes nothing; every number is finite.
describe('randomized attacker search', () => {
  function world(seed: number): ScoringInput & { attackNotSlop: VoteInput[] } {
    const next = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]!;
    const handles = Array.from({ length: 12 }, (_, i) => `acct${seed}x${i}`);
    const honest = Array.from({ length: 2 + Math.floor(next() * 6) }, (_, i) => anchor(`h${seed}x${i}`, { ageDays: 8 + next() * 30, reputation: 0.6 + next() * 0.4 }));
    const sharedWith = honest.map((h) => h.ipHash);
    const attackers = Array.from({ length: 5 + Math.floor(next() * 60) }, (_, i) => install(`a${seed}x${i}`, {
      ageDays: next() * 40, reputation: next(), ipHash: next() < 0.3 ? pick(sharedWith) : `atk${seed}x${Math.floor(next() * 20)}`, banned: next() < 0.05,
    }));
    const votes: VoteInput[] = [];
    const attackNotSlop: VoteInput[] = [];
    const seen = new Set<string>();
    const add = (u: InstallInput, h: string, value: 0 | 1, list: VoteInput[]) => {
      if (seen.has(`${u.id}/${h}`)) return;
      seen.add(`${u.id}/${h}`);
      list.push(vote(u.id, h, value, ago(next() * 20 * DAY)));
    };
    for (const u of honest) for (const h of handles) if (next() < 0.35) add(u, h, next() < 0.85 ? 1 : 0, votes);
    for (const u of attackers) {
      for (const h of handles) {
        const r = next();
        if (r < 0.3) add(u, h, 1, votes);
        else if (r < 0.6) add(u, h, 0, attackNotSlop);
      }
    }
    // Deleted votes: rows that an admin clear stored, whose live votes are gone.
    const clearedVotes: ClearedVoteInput[] = attackers.filter(() => next() < 0.3).map((u) => cleared(u, handles[0]!, 1, ago(3 * DAY)));
    const accounts = handles.map((h, i) => account(h, {
      identity: pick(['ok', 'ok', 'ok', 'unknown', 'gone', 'moved'] as const), evidence: Math.floor(next() * 4),
      protected: next() < 0.1, seed: i === 1, override: i === 0 ? 'clear' : null, overrideAt: i === 0 ? ago(3 * DAY) : null,
      status: pick(['none', 'pending', 'flagged', 'confirmed'] as const),
    }));
    return { ...input({ installs: [...honest, ...attackers], votes: [...votes, ...attackNotSlop], accounts, clearedVotes, autoConfirmsToday: Math.floor(next() * 31) }), attackNotSlop };
  }

  const shuffled = <T>(xs: T[], next: () => number): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
    return out;
  };
  const finite = (x: unknown): boolean => typeof x === 'number' ? Number.isFinite(x) : typeof x === 'object' && x !== null ? Object.values(x).every(finite) : true;

  test.each(Array.from({ length: 40 }, (_, i) => 1000 + i))('seed %i', (seed) => {
    const w = world(seed);
    const { attackNotSlop, ...rest } = w;
    const out = computeScores(rest);
    for (const a of out.accounts) {
      if (a.parts.reason === 'votes_flagged') {
        expect(a.parts.anchors).toBeGreaterThanOrEqual(ANCHORS_FLAG);
        expect(a.parts.evidence).toBeGreaterThanOrEqual(EVIDENCE_FLAG);
      }
      if (a.parts.reason === 'votes_confirmed') {
        expect(a.parts.anchors).toBeGreaterThanOrEqual(ANCHORS_CONFIRM);
        expect(a.parts.evidence).toBeGreaterThanOrEqual(EVIDENCE_CONFIRM);
      }
      const acc = rest.accounts.find((x) => x.handle === a.handle)!;
      if (acc.identity === 'moved') expect(a).toMatchObject({ status: 'none', tier: 0, score: 0 });
      // A gone or unknown account keeps a tier that it held in the stored state, and gets no new one.
      if (acc.identity !== 'ok' && a.parts.reason.startsWith('votes_')) expect(a.status === 'confirmed' ? ['confirmed'] : ['flagged', 'confirmed']).toContain(acc.status);
      if (acc.protected && a.parts.reason.startsWith('votes_')) throw new Error(`protected ${a.handle} listed by votes`);
    }
    const withoutNotSlop = computeScores({ ...rest, votes: rest.votes.filter((v) => !attackNotSlop.includes(v)) });
    expect(withoutNotSlop.accounts.map((a) => [a.handle, a.status, a.tier, a.score])).toEqual(out.accounts.map((a) => [a.handle, a.status, a.tier, a.score]));
    const next = rng(seed * 7);
    const again = computeScores({
      ...rest, installs: shuffled(rest.installs, next), votes: shuffled(rest.votes, next), accounts: shuffled(rest.accounts, next), clearedVotes: shuffled(rest.clearedVotes, next),
    });
    expect(again).toEqual(out);
    expect(finite(out)).toBe(true);
    expect(byHandle(out.accounts).size).toBe(out.accounts.length);
  });
});
