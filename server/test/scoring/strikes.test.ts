// Strikes come from the rows of cleared_votes (SPEC.md 13.5), never from the live votes (13.9 item 10).
import { describe, expect, test } from 'vitest';
import { EVIDENCE_CONFIRM, STRIKE_LIMIT, STRIKE_MAX_CROWD, STRIKE_WINDOW_DAYS, computeScores, type AccountInput, type ClearedVoteInput, type InstallInput, type VoteInput } from '../../src/scoring/index.js';
import { DAY, account, ago, allOf, anchor, anchors, cleared, input, many, scoreOf, vote } from './helpers.js';

// A ring network with standing marked two accounts that an admin then cleared with the penalty.
const ring = anchor('ring');
const honest = anchors('h', 3);
const clears = (at: [number, number] = [5, 10]): ClearedVoteInput[] => [cleared(ring, 'gone1', 1, ago(at[0] * DAY)), cleared(ring, 'gone2', 1, ago(at[1] * DAY))];
const clearedAccounts = (o: Partial<AccountInput> = {}): AccountInput[] => ['gone1', 'gone2'].map((h, i) =>
  account(h, { override: 'clear', overrideAt: ago((i + 1) * 5 * DAY), status: 'cleared', ...o }));

// The ring's vote on a fresh target decides whether the network still counts.
function run(rows: ClearedVoteInput[], o: { accounts?: AccountInput[]; installs?: InstallInput[]; live?: VoteInput[] } = {}) {
  const installs = o.installs ?? [ring, ...honest];
  const out = computeScores(input({
    installs,
    votes: [...allOf(installs, 'target'), ...(o.live ?? [])],
    accounts: [account('target', { evidence: EVIDENCE_CONFIRM }), ...(o.accounts ?? clearedAccounts())],
    clearedVotes: rows,
  }));
  return { out, target: scoreOf(out, 'target') };
}

describe('13.9.10 strikes', () => {
  test(`${STRIKE_LIMIT} strikes inside ${STRIKE_WINDOW_DAYS} days silence the network on every account`, () => {
    const { out, target } = run(clears());
    expect(out.struckNetworks).toBe(1);
    expect(target.parts).toMatchObject({ networks: 3, anchors: 3, raters: 3 });
  });

  test('strikes hold after the voters delete their votes or flip them to "not slop"', () => {
    expect(run(clears()).out.struckNetworks).toBe(1); // no live votes on the cleared accounts: deleted
    const flipped = [vote('ring', 'gone1', 0), vote('ring', 'gone2', 0)];
    expect(run(clears(), { live: flipped }).out.struckNetworks).toBe(1);
  });

  test('an admin confirm removes them: rows of a confirmed account give no strike', () => {
    const accounts = clearedAccounts();
    accounts[0] = account('gone1', { override: 'confirm', overrideAt: ago(DAY), status: 'confirmed' });
    expect(run(clears(), { accounts }).out.struckNetworks).toBe(0);
    expect(run(clears(), { accounts }).target.parts.networks).toBe(4);
  });

  test('one strike, strikes too far apart, or an old newest strike: no silence', () => {
    expect(run(clears().slice(0, 1)).out.struckNetworks).toBe(0);
    expect(run(clears([5, 5 + STRIKE_WINDOW_DAYS])).out.struckNetworks).toBe(0);
    expect(run(clears([STRIKE_WINDOW_DAYS + 1, STRIKE_WINDOW_DAYS + 2])).out.struckNetworks).toBe(0);
  });

  test(`13.10.5 more than ${STRIKE_MAX_CROWD} slop networks with standing give them no strike; networks without standing get it at any crowd size`, () => {
    const crowd = anchors('c', STRIKE_MAX_CROWD); // with the ring: 11 networks with standing on gone1
    const flood = many('f', 30); // 30 networks without standing on both accounts
    const rows = (n: number) => [
      ...clears(), ...crowd.slice(0, n).map((u) => cleared(u, 'gone1', 1, ago(5 * DAY))),
      ...flood.flatMap((u) => [cleared(u, 'gone1', 1, ago(5 * DAY)), cleared(u, 'gone2', 1, ago(10 * DAY))]),
    ];
    const installs = [ring, ...honest, ...crowd, ...flood];
    expect(run(rows(STRIKE_MAX_CROWD), { installs }).out.struckNetworks).toBe(30); // the flood only; the ring has 1 strike
    expect(run(rows(STRIKE_MAX_CROWD - 1), { installs }).out.struckNetworks).toBe(31); // 10 with standing: the ring too
  });

  test('installs without standing on a shared address cannot silence the install with standing there', () => {
    const owner = anchor('owner', { ipHash: 'shared' });
    const intruder = many('in', 1, { ipHash: 'shared' })[0]!;
    const rows = [cleared(intruder, 'gone1', 1, ago(5 * DAY)), cleared(intruder, 'gone2', 1, ago(10 * DAY))];
    const { out, target } = run(rows, { installs: [owner, intruder, ...honest] });
    expect(out.struckNetworks).toBe(1);
    expect(target.parts).toMatchObject({ networks: 4, anchors: 4 });
  });

  test('a starter account and a clear in the future give no strike', () => {
    const seedAccounts = clearedAccounts();
    seedAccounts[0] = account('gone1', { seed: true, override: 'clear', overrideAt: ago(5 * DAY), status: 'cleared' });
    expect(run(clears(), { accounts: seedAccounts }).out.struckNetworks).toBe(0);
    expect(run([clears()[0]!, cleared(ring, 'gone2', 1, new Date(Date.parse('2026-11-13T12:00:00Z')))]).out.struckNetworks).toBe(0);
  });

  test('a ban does not lift a strike: the rows of a banned install count, loaded or not', () => {
    const bannedTwin = anchor('twin', { ipHash: ring.ipHash, banned: true });
    const rows = [cleared(bannedTwin, 'gone1', 1, ago(5 * DAY)), cleared(bannedTwin, 'gone2', 1, ago(10 * DAY))];
    const loaded = run(rows, { installs: [ring, bannedTwin, ...honest] });
    const notLoaded = run(rows);
    expect(loaded.out.struckNetworks).toBe(1);
    expect(notLoaded.out.struckNetworks).toBe(1);
    expect(loaded.target.parts.networks).toBe(honest.length);
  });

  test('the rows of a network count by majority: a network that said "not slop" there gets no strike', () => {
    const twin = anchor('twin2', { ipHash: ring.ipHash });
    const rows = [...clears(), cleared(twin, 'gone1', 0, ago(5 * DAY))];
    expect(run(rows, { installs: [ring, twin, ...honest] }).out.struckNetworks).toBe(0);
  });
});
