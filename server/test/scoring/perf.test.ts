// SPEC.md 13.9 item 15: speed, and the same rows in any order give the same output.
import { expect, test } from 'vitest';
import { computeScores, type ClearedVoteInput, type ScoringInput, type SightingInput, type VoteInput } from '../../src/scoring/index.js';
import { DAY, NOW, account, install, rng } from './helpers.js';

const N_ACCOUNTS = 20_000;
const N_INSTALLS = 5_000;
const N_VOTES = 50_000;
const N_SIGHTINGS = 500_000;

function bigInput(): ScoringInput {
  const next = rng(2026);
  const now = NOW.getTime();
  const installs = Array.from({ length: N_INSTALLS }, (_, i) => install(`i${String(i).padStart(5, '0')}`, {
    ageDays: next() * 60, ipHash: `net${i % 3500}`, reputation: 0.05 + next() * 0.95, banned: next() < 0.01, standing: next() < 0.3, trusted: next() < 0.01,
  }));
  const handles = Array.from({ length: N_ACCOUNTS }, (_, i) => `a${i}`);
  const accounts = handles.map((h, i) => account(h, {
    seed: i < 793,
    override: i % 997 === 0 ? 'confirm' : i % 991 === 0 ? 'clear' : null,
    overrideAt: i % 997 === 0 || i % 991 === 0 ? new Date(now - 5 * DAY) : null,
    clearedAt: i >= 793 && i % 150 === 0 ? new Date(now - 10 * DAY) : null,
    listedAt: next() < 0.2 ? new Date(now - Math.floor(next() * 20 * DAY)) : null,
    status: next() < 0.1 ? 'confirmed' : 'none',
    identity: next() < 0.9 ? 'ok' : 'unknown',
    evidence: Math.floor(next() * 4),
    protected: next() < 0.01,
  }));
  const votes: VoteInput[] = [];
  const pairs = new Set<string>();
  while (votes.length < N_VOTES) {
    const u = Math.floor(next() * N_INSTALLS);
    const a = Math.floor(N_ACCOUNTS * next() ** 2); // skewed: popular accounts get more votes
    const key = `${u}:${a}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    votes.push({ install: installs[u]!.id, handle: handles[a]!, value: next() < 0.85 ? 1 : 0, at: new Date(now - Math.floor(next() * 30 * DAY)) });
  }
  const clearedVotes: ClearedVoteInput[] = votes.filter((v) => Number(v.handle.slice(1)) % 991 === 0).map((v) => {
    const ins = installs.find((x) => x.id === v.install)!;
    return { install: v.install, ipHash: ins.ipHash, handle: v.handle, value: v.value, at: v.at, clearedAt: new Date(now - 5 * DAY), standing: ins.standing };
  });
  const sightings: SightingInput[] = [];
  for (let k = 0; k < N_SIGHTINGS; k++) {
    sightings.push({
      handle: handles[k % N_ACCOUNTS]!,
      tweetId: String(1_900_000_000_000_000_000n + BigInt(k)),
      parentTweetId: String(1_800_000_000_000_000_000n + BigInt(Math.floor(next() * 60_000))),
      replyAt: new Date(now - Math.floor(next() * 29 * DAY)),
      latencySec: next() < 0.1 ? null : Math.floor(next() ** 3 * 86_400),
    });
  }
  return { now: NOW, installs, votes, accounts, sightings, clearedVotes, autoConfirmsToday: 3, autoFlagsToday: 7 };
}

const reversed = (x: ScoringInput): ScoringInput => ({
  ...x, installs: [...x.installs].reverse(), votes: [...x.votes].reverse(), accounts: [...x.accounts].reverse(),
  sightings: [...x.sightings].reverse(), clearedVotes: [...x.clearedVotes].reverse(),
});

test('50k votes, 20k accounts, 500k sightings in under 10 CPU seconds, the same output in any row order', () => {
  const inp = bigInput();
  // CPU time, because wall time on a busy host measures the other processes.
  const before = process.cpuUsage();
  const out = computeScores(inp);
  const used = process.cpuUsage(before);
  const ms = (used.user + used.system) / 1000;
  const count = (s: string) => out.accounts.filter((a) => a.status === s).length;
  console.log(`computeScores: ${ms.toFixed(0)} ms, epochs ${out.model.epochs}, confirmed ${count('confirmed')}, flagged ${count('flagged')}, pending ${count('pending')}, struck ${out.struckNetworks}`);
  expect(out.accounts).toHaveLength(N_ACCOUNTS);
  expect(out.installs).toHaveLength(N_INSTALLS);
  expect(out.model.epochs).toBeGreaterThan(0); // two-sided networks exist: the factor model ran inside the measured time
  expect(ms).toBeLessThan(10_000);
  expect(computeScores(reversed(inp))).toEqual(out);
}, 300_000);
