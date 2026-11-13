// Launch simulations: named populations that reach computeScores, with the exact outcome each must
// produce (SPEC.md 12.4 and 13.9 item 12).
import { describe, expect, test } from 'vitest';
import { CONFIRM_MIN_NETWORKS, FLAG_MIN_NETWORKS, computeScores, type InstallInput, type VoteInput } from '../../src/scoring/index.js';
import { DAY, account, ago, allOf, anchor, anchors, fresh, input, many, scoreOf, vote } from './helpers.js';
import { launch } from './launch.js';

const run = (installs: InstallInput[], votes: VoteInput[], evidence = 3) => {
  const handles = [...new Set(votes.map((v) => v.handle))];
  return computeScores(input({ installs, votes, accounts: handles.map((h) => account(h, { evidence })) }));
};

describe('13.9.12 launch: 200 new users, an admin who approves the pending queue once a day', () => {
  const days = launch(14);
  const on = (d: number) => days[d - 1]!;

  test('day 1: the crowd fills the review queue, nothing is listed', () => {
    expect(on(1)).toMatchObject({ admin: 0, auto: 0, confirmed: 0, flagged: 0, pending: 81, standing: 0 });
  });

  test('day 8: the admin approved the queue every day, and the users who marked first earned standing', () => {
    expect(on(8)).toMatchObject({ admin: 190, auto: 0, confirmed: 190, flagged: 0, pending: 89, standing: 165 });
  });

  test('day 9 has the first automatic confirm', () => {
    expect(days.findIndex((d) => d.auto > 0) + 1).toBe(9);
    expect(on(9)).toMatchObject({ auto: 12, pending: 2 });
  });

  test('day 14: anchors list new accounts by themselves, inside the daily brake', () => {
    expect(on(14)).toMatchObject({ admin: 210, auto: 59, confirmed: 269, flagged: 27, pending: 0, standing: 173 });
    for (const d of days) expect(d.autoNew).toBeLessThanOrEqual(30);
  });

  test('without the admin nothing is ever listed: standing starts at a person', () => {
    expect(launch(14, { admin: false }).at(-1)).toMatchObject({ confirmed: 0, flagged: 0, pending: 296, standing: 0 });
  });
});

describe('named populations', () => {
  test('a small honest community without standing waits in the review queue', () => {
    const friends = many('friend', 8, { ageDays: 4, reputation: 0.5 });
    const out = run(friends, [...allOf(friends, 'everyone'), ...allOf(friends.slice(0, 2), 'two'), vote('friend0', 'one', 1)]);
    expect(scoreOf(out, 'everyone')).toMatchObject({ status: 'pending', parts: { want: 'confirmed', gate: 'standing', networks: 8 } });
    expect(scoreOf(out, 'two')).toMatchObject({ status: 'pending', parts: { want: 'flagged', gate: 'standing', networks: FLAG_MIN_NETWORKS } });
    expect(scoreOf(out, 'one')).toMatchObject({ status: 'none', parts: { networks: 1, needed: 1 } });
  });

  test('the same community after it earned standing lists by itself', () => {
    const friends = anchors('friend', 8);
    const out = run(friends, [...allOf(friends, 'everyone'), ...allOf(friends.slice(0, CONFIRM_MIN_NETWORKS), 'four'), ...allOf(friends.slice(0, 2), 'two')]);
    expect(scoreOf(out, 'everyone')).toMatchObject({ status: 'confirmed', parts: { reason: 'votes_confirmed', needed: 0 } });
    expect(scoreOf(out, 'four')).toMatchObject({ status: 'confirmed' });
    expect(scoreOf(out, 'two')).toMatchObject({ status: 'flagged', parts: { needed: 2 } });
  });

  test('30 installs with standing on one network list nothing', () => {
    const installs = Array.from({ length: 30 }, (_, i) => anchor(`i${i}`, { ipHash: 'one-network' }));
    expect(scoreOf(run(installs, allOf(installs, 'victim')), 'victim')).toMatchObject({ status: 'none', parts: { raters: 30, networks: 1, anchors: 1 } });
  });

  test('an even split among people with standing lists nothing by itself', () => {
    const yes = anchors('y', 5);
    const no = anchors('n', 5);
    const out = run([...yes, ...no], [...allOf(yes, 'split'), ...allOf(no, 'split', 0)]);
    expect(scoreOf(out, 'split')).toMatchObject({ status: 'pending', parts: { gate: 'dispute', anchors: 5, notSlop: 5 } });
  });

  test('a starter account stays on the list; an admin clear removes it', () => {
    const deniers = anchors('d', 20);
    const out = computeScores(input({
      installs: deniers, votes: [...allOf(deniers, 'starter', 0), ...allOf(deniers, 'gone', 0)],
      accounts: [account('starter', { seed: true }), account('gone', { seed: true, override: 'clear', overrideAt: ago(DAY) })],
    }));
    expect(scoreOf(out, 'starter')).toMatchObject({ status: 'confirmed', parts: { reason: 'seed', disputed: true } });
    expect(scoreOf(out, 'gone')).toMatchObject({ status: 'cleared', score: 0 });
  });

  test('a banned install with standing counts for nothing', () => {
    const crowd = [...anchors('s', 1), ...fresh('n', 2), anchor('banned', { banned: true })];
    expect(scoreOf(run(crowd, allOf(crowd, 'acc')), 'acc')).toMatchObject({ status: 'flagged', parts: { networks: 3, anchors: 1 } });
  });

  test('marks from day-one installs on many networks wait; one anchor then flags, two and evidence confirm', () => {
    const crowd = fresh('c', 20);
    expect(scoreOf(run(crowd, allOf(crowd, 'acc')), 'acc')).toMatchObject({ status: 'pending', parts: { gate: 'standing', want: 'confirmed' } });
    expect(scoreOf(run([...crowd, anchor('a0')], allOf([...crowd, anchor('a0')], 'acc')), 'acc')).toMatchObject({ status: 'flagged', parts: { gate: 'standing' } });
    const two = [...crowd, ...anchors('a', 2)];
    expect(scoreOf(run(two, allOf(two, 'acc')), 'acc')).toMatchObject({ status: 'confirmed' });
    expect(scoreOf(run(two, allOf(two, 'acc'), 1), 'acc')).toMatchObject({ status: 'flagged', parts: { gate: 'evidence' } });
  });
});
