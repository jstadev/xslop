// Reputation, good marks and standing (SPEC.md 13.5, 13.9 item 11).
import { describe, expect, test } from 'vitest';
import {
  EVIDENCE_CONFIRM, EVIDENCE_FLAG, GOOD_MARKS_PER_ACCOUNT, NETWORK_DAILY_VOTES, REPUTATION_MIN, STANDING_MIN_AGE_DAYS, STANDING_MIN_GOOD_MARKS, computeScores,
  type InstallScore, type ScoringInput,
} from '../../src/scoring/index.js';
import { DAY, HOUR, account, ago, allOf, anchor, anchors, cleared, fresh, input, install, many, scoreOf, vote } from './helpers.js';

const installsOf = (o: Partial<ScoringInput>): Map<string, InstallScore> => new Map(computeScores(input(o)).installs.map((i) => [i.id, i]));
const confirmedByAdmin = (h: string, at = ago(DAY)) => account(h, { override: 'confirm', overrideAt: at, listedAt: at, status: 'confirmed' });

describe('13.9.11 trust moves outward from trusted decisions only', () => {
  test('a ring that confirms accounts with no trusted decision earns no reputation and no good mark', () => {
    const ringNets = many('ring', 12, { ageDays: 30 });
    const handles = ['ra', 'rb', 'rc', 'rd'];
    const out = installsOf({ installs: ringNets, votes: handles.flatMap((h) => allOf(ringNets, h)), accounts: handles.map((h) => account(h, { evidence: 12 })) });
    for (const u of ringNets) expect(out.get(u.id)).toEqual({ id: u.id, reputation: 0.5, goodMarks: 0, standing: false });
  });

  test(`marks that an admin approves give standing after ${STANDING_MIN_AGE_DAYS} days and ${STANDING_MIN_GOOD_MARKS} good marks`, () => {
    const handles = ['ga', 'gb', 'gc'];
    const run = (ageDays: number, marks: number) => installsOf({
      installs: [install('voter', { ageDays, reputation: 0.5 })],
      votes: handles.slice(0, marks).map((h) => vote('voter', h, 1, ago(2 * DAY))),
      accounts: handles.map((h) => confirmedByAdmin(h)),
    }).get('voter')!;
    expect(run(STANDING_MIN_AGE_DAYS, 3)).toMatchObject({ reputation: 0.8, goodMarks: 3, standing: true });
    expect(run(STANDING_MIN_AGE_DAYS - 0.5, 3)).toMatchObject({ goodMarks: 3, standing: false });
    expect(run(STANDING_MIN_AGE_DAYS, 2)).toMatchObject({ reputation: 0.75, goodMarks: 2, standing: false });
  });

  test('a not-slop voter loses reputation when the admin confirms, also when the account was already public', () => {
    const out = installsOf({
      installs: [install('denier', { reputation: 0.5 }), install('late', { reputation: 0.5 })],
      votes: [vote('denier', 'adm', 0, ago(3 * HOUR)), vote('late', 'adm', 1, ago(HOUR))],
      accounts: [account('adm', { override: 'confirm', overrideAt: ago(2 * HOUR), listedAt: ago(10 * DAY), status: 'confirmed' })],
    });
    expect(out.get('denier')).toMatchObject({ reputation: 1 / 3, goodMarks: 0 });
    expect(out.get('late')).toMatchObject({ reputation: 0.5, goodMarks: 0 }); // agreed with a public answer
  });

  test('13.10.1 an anchored confirm scores nothing: 2 anchors that confirm the accounts of their ring raise no ring install', () => {
    const ring = [...anchors('s', 2), ...many('r', 10, { reputation: 0.5 })];
    const handles = ['ra', 'rb', 'rc'];
    const result = computeScores(input({
      installs: ring, votes: handles.flatMap((h) => allOf(ring, h, 1, ago(2 * DAY))), accounts: handles.map((h) => account(h, { evidence: EVIDENCE_CONFIRM })),
    }));
    for (const h of handles) expect(scoreOf(result, h).parts.reason).toBe('votes_confirmed');
    const out = new Map(result.installs.map((i) => [i.id, i]));
    for (const u of ring.slice(2)) expect(out.get(u.id)).toEqual({ id: u.id, reputation: 0.5, goodMarks: 0, standing: false });
  });

  test(`13.10.2 one admin confirm gives at most ${GOOD_MARKS_PER_ACCOUNT} good marks: the first networks by the time of their vote, the earliest install of each`, () => {
    const voters = many('v', 8, { reputation: 0.5 });
    const twin = install('a-twin', { ipHash: voters[0]!.ipHash, reputation: 0.5 }); // first in id order, votes after v0 on its network
    const out = installsOf({
      installs: [...voters, twin],
      votes: [...voters.map((u, i) => vote(u.id, 'adm', 1, ago((20 - i) * HOUR))), vote('a-twin', 'adm', 1, ago(19.5 * HOUR))],
      accounts: [confirmedByAdmin('adm', ago(2 * HOUR))],
    });
    expect(voters.map((u) => out.get(u.id)!.goodMarks)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(out.get('a-twin')).toMatchObject({ goodMarks: 0, reputation: 0.5 });
    expect(out.get('v5')).toMatchObject({ goodMarks: 0, reputation: 0.5 });
  });

  test('votes after the listing, "not slop" on an anchored confirm and votes on a starter account score nothing', () => {
    const crowd = anchors('s', 5);
    const out = installsOf({
      installs: [...crowd, install('after'), install('nay'), install('seeder')],
      votes: [...allOf(crowd, 'anch', 1, ago(3 * DAY)), vote('after', 'anch', 1, ago(HOUR)), vote('nay', 'anch', 0, ago(3 * DAY)), vote('seeder', 'starter', 1, ago(3 * DAY))],
      accounts: [account('anch', { evidence: EVIDENCE_CONFIRM, listedAt: ago(2 * DAY), status: 'confirmed' }), account('starter', { seed: true, status: 'confirmed', listedAt: ago(9 * DAY) })],
    });
    for (const id of ['after', 'nay', 'seeder', 's0']) expect(out.get(id)).toMatchObject({ reputation: 0.5, goodMarks: 0 });
  });

  test('an admin clear with the penalty scores the stored rows only: slop disagrees, "not slop" agrees', () => {
    const marker = install('marker', { reputation: 0.5 });
    const defender = install('defender', { reputation: 0.5 });
    const at = ago(DAY);
    const accounts = [account('clr', { override: 'clear', overrideAt: at, status: 'cleared' })];
    const out = installsOf({
      installs: [marker, defender], accounts,
      votes: [vote('marker', 'clr', 0, ago(HOUR)), vote('defender', 'clr', 1, ago(HOUR))], // flipped live votes change nothing
      clearedVotes: [cleared(marker, 'clr', 1, at), cleared(defender, 'clr', 0, at)],
    });
    expect(out.get('marker')).toMatchObject({ reputation: 1 / 3 });
    expect(out.get('defender')).toMatchObject({ reputation: 2 / 3 });
    const noPenalty = installsOf({ installs: [marker, defender], accounts, votes: [vote('marker', 'clr', 1, ago(2 * DAY))] });
    expect(noPenalty.get('marker')).toMatchObject({ reputation: 0.5 });
  });

  test('a vote past the budget of its network scores nothing', () => {
    const voter = install('busy', { reputation: 0.5 });
    const junk = Array.from({ length: NETWORK_DAILY_VOTES }, (_, j) => vote('busy', `j${j}`, 1, ago(5 * HOUR - j)));
    const out = installsOf({ installs: [voter], votes: [...junk, vote('busy', 'adm', 1, ago(4 * HOUR))], accounts: [confirmedByAdmin('adm', ago(2 * HOUR))] });
    expect(out.get('busy')).toMatchObject({ reputation: 0.5, goodMarks: 0 });
  });

  test('standing needs reputation; a ban or an admin trust decide at once', () => {
    const bad = installsOf({
      installs: [install('bad', { reputation: 0.5 })],
      // Clears older than the strike window: the network still counts, the reputation still falls.
      clearedVotes: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((h) => cleared(install('bad'), h, 1, ago(40 * DAY))),
      votes: ['a1', 'a2', 'a3'].map((h) => vote('bad', h, 1, ago(3 * DAY))),
      accounts: [...['a1', 'a2', 'a3'].map((h) => confirmedByAdmin(h)), ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((h) => account(h, { override: 'clear', overrideAt: ago(40 * DAY) }))],
    }).get('bad')!;
    expect(bad).toMatchObject({ goodMarks: 3, reputation: 4 / 11, standing: false });
    const out = installsOf({ installs: [anchor('banned', { banned: true }), install('trusted', { trusted: true, ageDays: 0.1 })] });
    expect(out.get('banned')!.standing).toBe(false);
    expect(out.get('trusted')!.standing).toBe(true);
  });

  test(`reputation stays in [${REPUTATION_MIN}, 1]`, () => {
    const rows = Array.from({ length: 60 }, (_, i) => cleared(install('x'), `c${i}`, 1, ago(DAY)));
    const out = installsOf({ installs: [install('x')], clearedVotes: rows, accounts: rows.map((r) => account(r.handle, { override: 'clear', overrideAt: ago(DAY) })) });
    expect(out.get('x')!.reputation).toBe(REPUTATION_MIN);
  });
});

// SPEC.md 13.10 item 3. The install earned 3 good marks on admin confirms 10 days ago.
describe('13.10.3 a wrong vote takes the standing away', () => {
  const earned = ['g1', 'g2', 'g3'];
  const base = (o: { trusted?: boolean } = {}) => ({
    installs: [install('p', { reputation: 0.8, standing: true, trusted: o.trusted ?? false }), ...fresh('n', 1)],
    votes: earned.map((h) => vote('p', h, 1, ago(12 * DAY))),
    accounts: earned.map((h) => confirmedByAdmin(h, ago(10 * DAY))),
  });
  const run = (o: Partial<ScoringInput>) => computeScores(input(o));
  const withClear = (o: ReturnType<typeof base>) => ({
    ...o, accounts: [...o.accounts, account('bad', { override: 'clear', overrideAt: ago(5 * DAY), status: 'cleared' })],
    clearedVotes: [cleared(o.installs[0]!, 'bad', 1, ago(5 * DAY))],
  });

  test('3 good marks and no penalty: standing', () => {
    expect(run(base()).installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 3, reputation: 0.8, standing: true });
  });

  test('a slop row of a clear with the penalty: only good marks of later admin confirms count', () => {
    const o = withClear(base());
    expect(run(o).installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, reputation: 4 / 6, standing: false });
    const later = ['k1', 'k2', 'k3'];
    const back = { ...o, votes: [...o.votes, ...later.map((h) => vote('p', h, 1, ago(3 * DAY)))], accounts: [...o.accounts, ...later.map((h) => confirmedByAdmin(h, ago(2 * DAY)))] };
    expect(run(back).installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 3, reputation: 7 / 9, standing: true });
  });

  test('round 2 H3: marks set before the penalty give no good mark after it, also when the admin confirms later', () => {
    const o = withClear(base());
    const early = ['e1', 'e2', 'e3'];
    const out = run({
      ...o, votes: [...o.votes, ...early.map((h) => vote('p', h, 1, ago(6 * DAY))), vote('p', 'target', 1), vote('n0', 'target', 1)],
      accounts: [...o.accounts, ...early.map((h) => confirmedByAdmin(h, ago(2 * DAY))), account('target', { evidence: EVIDENCE_FLAG })],
    });
    expect(out.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, standing: false });
    expect(scoreOf(out, 'target')).toMatchObject({ status: 'pending', parts: { anchors: 0 } }); // also in the run that first sees the penalty
  });

  test('a "not slop" vote set before an admin confirm is a penalty', () => {
    const o = base();
    const out = run({ ...o, votes: [...o.votes, vote('p', 'adm2', 0, ago(3 * DAY))], accounts: [...o.accounts, confirmedByAdmin('adm2', ago(2 * DAY))] });
    expect(out.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, reputation: 4 / 6, standing: false });
  });

  test('round 2 H1: a "not slop" vote deleted or flipped after the admin confirm keeps its penalty through the row that the confirm stored', () => {
    const o = base();
    const accounts = [...o.accounts, confirmedByAdmin('adm2', ago(2 * DAY))];
    const row = { ...cleared(o.installs[0]!, 'adm2', 0, ago(2 * DAY)), at: ago(3 * DAY) };
    const deleted = run({ ...o, accounts, clearedVotes: [row] });
    expect(deleted.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, standing: false });
    const flipped = run({ ...o, accounts, votes: [...o.votes, vote('p', 'adm2', 1, ago(HOUR))], clearedVotes: [row] });
    expect(flipped.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, standing: false });
    expect(run({ ...o, accounts }).installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 3, standing: true }); // no row: the escape
  });

  test('the penalty takes the stored standing away in the run that first sees it', () => {
    const o = withClear(base());
    const target = [vote('p', 'target', 1), vote('n0', 'target', 1)];
    const out = run({ ...o, votes: [...o.votes, ...target], accounts: [...o.accounts, account('target', { evidence: EVIDENCE_FLAG })] });
    expect(scoreOf(out, 'target')).toMatchObject({ status: 'pending', parts: { anchors: 0, gate: 'standing' } });
    const clean = run({ ...base(), votes: [...base().votes, ...target], accounts: [...base().accounts, account('target', { evidence: EVIDENCE_FLAG })] });
    expect(scoreOf(clean, 'target')).toMatchObject({ status: 'flagged', parts: { anchors: 1 } });
  });

  test('a trusted install keeps its standing', () => {
    expect(run(withClear(base({ trusted: true }))).installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, standing: true });
  });
});
