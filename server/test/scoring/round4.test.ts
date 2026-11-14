// Round 4 attacks on standing, evidence and the public-time clock (SPEC 13.5, 13.10, 13.11).
import { describe, expect, test } from 'vitest';
import { EVIDENCE_FLAG, NETWORK_DAILY_VOTES, computeScores } from '../../src/scoring/index.js';
import { DAY, HOUR, account, ago, anchor, cleared, fresh, input, install, many, scoreOf, vote } from './helpers.js';

const confirmed = (h: string, at: Date) => account(h, { override: 'confirm', overrideAt: at, listedAt: at, status: 'confirmed' });

describe('a listing that ends does not reset the public clock', () => {
  test('a vote cast while the account was public earns nothing when an admin confirms it again', () => {
    const early = install('early', { reputation: 0.5 });
    const during = install('during', { reputation: 0.5 });
    const back = account('back', {
      override: 'confirm', overrideAt: ago(HOUR), listedAt: ago(HOUR), firstPublicAt: ago(8 * DAY), status: 'confirmed',
    });
    const out = computeScores(input({
      installs: [early, during],
      votes: [vote(early.id, 'back', 1, ago(10 * DAY)), vote(during.id, 'back', 1, ago(5 * DAY))],
      accounts: [back],
    }));
    expect(out.installs.find((i) => i.id === 'early')).toMatchObject({ goodMarks: 1 });
    expect(out.installs.find((i) => i.id === 'during')).toMatchObject({ goodMarks: 0, reputation: 0.5 });
  });
});

describe('stored standing needs 3 counted good marks after the penalty', () => {
  const p = install('p', { reputation: 0.8, standing: true });
  const penaltyAt = ago(5 * DAY);
  const earned = ['g1', 'g2', 'g3'].map((h) => vote('p', h, 1, ago(12 * DAY)));
  const baseAccounts = [
    ...['g1', 'g2', 'g3'].map((h) => confirmed(h, ago(10 * DAY))),
    account('bad', { override: 'clear', overrideAt: penaltyAt, status: 'cleared' }),
  ];
  const clearedVotes = [cleared(p, 'bad', 1, penaltyAt)];

  test('votes past the network budget do not keep standing for this run', () => {
    const fillers = Array.from({ length: NETWORK_DAILY_VOTES - 1 }, (_, i) => vote('p', `j${i}`, 1, ago(2 * HOUR)));
    const later = ['k1', 'k2', 'k3'];
    const n0 = fresh('n', 1)[0]!;
    const out = computeScores(input({
      installs: [p, n0],
      votes: [
        ...earned, vote('p', 'target', 1, ago(3 * HOUR)), ...fillers,
        ...later.map((h) => vote('p', h, 1, ago(90 * 60_000))),
        vote(n0.id, 'target', 1),
      ],
      accounts: [
        ...baseAccounts,
        ...later.map((h) => confirmed(h, ago(HOUR))),
        account('target', { evidence: EVIDENCE_FLAG }),
      ],
      clearedVotes,
    }));
    expect(out.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, reputation: 4 / 6, standing: false });
    expect(scoreOf(out, 'target')).toMatchObject({ status: 'pending', parts: { anchors: 0, gate: 'standing' } });
  });

  test('slop votes outside the first 5 networks do not keep standing for this run', () => {
    const decoys = many('e', 5);
    const later = ['k1', 'k2', 'k3'];
    const n0 = fresh('n', 1)[0]!;
    const out = computeScores(input({
      installs: [p, ...decoys, n0],
      votes: [
        ...earned,
        ...later.flatMap((h) => [...decoys.map((u) => vote(u.id, h, 1, ago(4 * DAY))), vote('p', h, 1, ago(3 * DAY))]),
        vote('p', 'target', 1), vote(n0.id, 'target', 1),
      ],
      accounts: [...baseAccounts, ...later.map((h) => confirmed(h, ago(2 * DAY))), account('target', { evidence: EVIDENCE_FLAG })],
      clearedVotes,
    }));
    expect(out.installs.find((i) => i.id === 'p')).toMatchObject({ goodMarks: 0, standing: false });
    expect(scoreOf(out, 'target')).toMatchObject({ status: 'pending', parts: { anchors: 0, gate: 'standing' } });
  });
});

describe('a standing slot survives a delete and a value change', () => {
  test('five deleted slots block the next five votes of that network', () => {
    const ring = anchor('ring');
    const out = computeScores(input({
      installs: [ring],
      votes: Array.from({ length: 5 }, (_, i) => vote(ring.id, `n${i}`, 1, ago(HOUR))),
      accounts: Array.from({ length: 5 }, (_, i) => account(`n${i}`)),
      standingSpent: Array.from({ length: 5 }, (_, i) => ({ ipHash: ring.ipHash, at: ago((i + 2) * HOUR) })),
    }));
    for (let i = 0; i < 5; i++) expect(scoreOf(out, `n${i}`).parts.anchors).toBe(0);
  });

  test('a recorded time stays the slot when the vote time moves forward', () => {
    const ring = anchor('ring');
    const moved = Array.from({ length: 5 }, (_, i) => {
      const v = vote(ring.id, `a${i}`, 1, ago(30 * 60_000));
      v.standingAt = ago((i + 3) * HOUR);
      return v;
    });
    const out = computeScores(input({
      installs: [ring],
      votes: [...moved, ...Array.from({ length: 5 }, (_, i) => vote(ring.id, `b${i}`, 1, ago(HOUR)))],
      accounts: [...Array.from({ length: 5 }, (_, i) => account(`a${i}`)), ...Array.from({ length: 5 }, (_, i) => account(`b${i}`))],
    }));
    expect(scoreOf(out, 'a0').parts.anchors).toBe(1);
    expect(scoreOf(out, 'b0').parts.anchors).toBe(0);
  });
});

describe('evidence is the counted slop votes', () => {
  test('a slop vote that does not count gives no evidence', () => {
    const ring = anchor('ring');
    const honest = anchor('honest');
    const plain = fresh('f', 1)[0]!;
    const out = computeScores(input({
      installs: [ring, honest, plain],
      votes: [vote('ring', 'target', 1, ago(HOUR), true), vote('honest', 'target', 1), vote(plain.id, 'target', 1)],
      accounts: [
        account('target', { evidence: 1 }),
        account('gone1', { override: 'clear', overrideAt: ago(5 * DAY), status: 'cleared' }),
        account('gone2', { override: 'clear', overrideAt: ago(10 * DAY), status: 'cleared' }),
      ],
      clearedVotes: [cleared(ring, 'gone1', 1, ago(5 * DAY)), cleared(ring, 'gone2', 1, ago(10 * DAY))],
    }));
    expect(out.struckNetworks).toBe(1);
    expect(scoreOf(out, 'target')).toMatchObject({ status: 'pending', parts: { gate: 'evidence', evidence: 0, anchors: 1, networks: 2 } });
  });
});
