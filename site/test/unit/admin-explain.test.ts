// The sentence builder of the admin console (SPEC 14.3): every status and every gate gives its sentence with the right
// numbers, the checklists mark the right checks, and every activity kind reads as one sentence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activityDetail,
  activitySentence,
  changedFields,
  showValue,
  checklist,
  checklistNote,
  marksSentence,
  nextStep,
  plain,
  shortReason,
  standingChecks,
  standingSentence,
  statusSentence,
  timingText,
  type Seg,
} from '../../src/admin/explain.ts';
import { readAccount, readActivity, readRules, readStanding, type AccountFacts, type Rules } from '../../src/admin/model.ts';
import { rawState } from '../../src/admin/feed.ts';
import { str, strOrNull } from '../../src/admin/rows.ts';

const RULES: Rules = {
  standingMinAgeDays: 7,
  standingMinGoodMarks: 3,
  standingMinReputation: 0.6,
  anchorsFlag: 1,
  anchorsConfirm: 2,
  evidenceFlag: 1,
  evidenceConfirm: 2,
  flagMinNetworks: 2,
  confirmMinNetworks: 4,
  confirmMinTrust: 1,
  flagShareBound: 0.5,
  confirmShareBound: 0.6,
  protectedMinFollowers: 50_000,
  maxAutoConfirmsPerDay: 30,
  maxAutoFlagsPerDay: 60,
  strikeMaxCrowd: 10,
  clearedReturnMinNetworks: 6,
  seedDisputeMinNetworks: 5,
  networkDailyVotes: 50,
};

/** An account row of /api/admin/accounts, read the way the console reads it. */
function account(row: Record<string, unknown>, parts: Record<string, unknown> = {}): AccountFacts {
  return readAccount({ handle: 'someone', status: 'none', tier: 0, score: 0, seed: false, override: null, protected: false, identity: 'ok', followers: 900, ...row, parts: { reason: 'none', ...parts } });
}

const say = (a: AccountFacts, rules: Rules | null = RULES): string => plain(statusSentence(a, rules));
const terms = (segs: Seg[]): string[] => segs.flatMap((s) => (typeof s !== 'string' && s.t === 'term' ? [s.term] : []));

describe('status sentence: every status', () => {
  test('none without counted votes', () => {
    const a = account({});
    assert.equal(say(a), 'Not listed. No slop vote counts for it.');
    assert.equal(shortReason(a), 'No counted slop votes');
  });

  test('none below the crowd test, with dissent', () => {
    const a = account({}, { networks: 1, needed: 1, dissent: 2 });
    assert.equal(say(a), 'Not listed. 1 slop network marked it, and the test for flagged needs 1 more. 2 networks without standing said not slop; that counts in no test (dissent).');
    assert.equal(shortReason(a), 'Needs 1 more network');
    assert.deepEqual(terms(statusSentence(a, RULES)), ['dissent']);
  });

  test('flagged by votes, with the networks that confirmed needs', () => {
    const a = account({ status: 'flagged', tier: 1, score: 55 }, { reason: 'votes_flagged', networks: 3, anchors: 1, evidence: 1, needed: 1 });
    assert.equal(say(a), 'Flagged by votes. 3 slop networks marked it, 1 of them with standing (anchor), and the server checked posts of 1 network. Confirmed needs 1 more slop network.');
    assert.equal(shortReason(a), 'Flagged by votes');
  });

  test('flagged by votes while a gate holds confirmed', () => {
    const a = account({ status: 'flagged', tier: 1 }, { reason: 'votes_flagged', want: 'confirmed', gate: 'standing', networks: 4, anchors: 1, evidence: 2 });
    assert.equal(
      say(a),
      'Flagged by votes. 4 slop networks marked it, 1 of them with standing (anchor), and the server checked posts of 2 networks. The votes also pass the test for confirmed, but the standing gate holds it: 1 network with standing marked it, and confirmed needs 2.',
    );
    assert.equal(shortReason(a), 'Flagged by votes; standing gate holds confirmed');
  });

  test('confirmed by votes', () => {
    const a = account({ status: 'confirmed', tier: 2, score: 80 }, { reason: 'votes_confirmed', networks: 5, anchors: 3, evidence: 2 });
    assert.equal(say(a), 'Confirmed by votes. 5 slop networks marked it, 3 of them with standing (anchors), and the server checked posts of 2 networks.');
    assert.equal(shortReason(a), 'Confirmed by votes');
  });

  test('cleared after a reset: only votes after the clear count', () => {
    const a = account({ status: 'cleared' }, { reason: 'cleared', networks: 2 });
    assert.equal(say(a), 'Cleared. You cleared it and then reset the decision, so only votes after the clear count. It goes back to review when at least 6 slop networks pass the test for confirmed. It has 2.');
    assert.equal(say(a, null), 'Cleared. You cleared it and then reset the decision, so only votes after the clear count. It goes back to review only when many networks mark it again. It has 2 slop networks.');
    assert.equal(shortReason(a), 'Cleared before, then reset');
  });

  test('your decisions win over every vote', () => {
    assert.equal(say(account({ status: 'confirmed', override: 'confirm' }, { reason: 'override_confirm' })), 'Confirmed by your decision. Only an admin decision changes it.');
    const withPenalty = account({ status: 'cleared', override: 'clear', clearPenalty: true }, { reason: 'override_clear' });
    assert.equal(say(withPenalty), 'Cleared by your decision, with a penalty for its slop voters. It stays off the list until you reset the decision.');
    assert.equal(shortReason(withPenalty), 'You cleared it, with penalty');
    const without = account({ status: 'cleared', override: 'clear', clearPenalty: false }, { reason: 'override_clear' });
    assert.equal(say(without), 'Cleared by your decision, without a penalty. It stays off the list until you reset the decision.');
    assert.equal(shortReason(without), 'You cleared it, without penalty');
    assert.deepEqual(terms(statusSentence(withPenalty, RULES)), ['override', 'penalty']);
  });

  test('a starter account, plain and disputed', () => {
    const seed = account({ status: 'confirmed', tier: 2, seed: true }, { reason: 'seed' });
    assert.equal(say(seed), 'Confirmed as a starter account: it is on the public X list "ai slop posters", so it is listed from the first day. Votes never remove it; only an accepted appeal or your clear does.');
    assert.equal(shortReason(seed), 'Starter account');
    const disputed = account({ status: 'confirmed', tier: 2, seed: true }, { reason: 'seed', disputed: true, notSlop: 5 });
    assert.match(say(disputed), / 5 networks with standing say it is not slop, so it waits in the Disputed queue\.$/);
    assert.equal(shortReason(disputed), 'Starter account, disputed');
  });

  test('a moved handle, with and without the new handle', () => {
    const moved = account({ identity: 'moved', movedTo: 'new_handle' }, { reason: 'moved' });
    assert.equal(say(moved), 'Not listed. The handle now belongs to another X account, so xslop never hides it. Its state moved to @new_handle.');
    assert.equal(shortReason(moved), 'Handle moved to another X account');
    assert.equal(say(account({ identity: 'moved' }, { reason: 'moved' })), 'Not listed. The handle now belongs to another X account, so xslop never hides it. Its state stays on this row until the server finds the new handle of the account.');
    // A bad handle from the server never becomes a link.
    assert.equal(account({ identity: 'moved', movedTo: '../admin' }).movedTo, null);
  });
});

describe('status sentence: every gate of a pending account', () => {
  const pending = (parts: Record<string, unknown>, row: Record<string, unknown> = {}) => account({ status: 'pending', ...row }, { reason: 'pending', ...parts });

  test('protected by followers, and protected by you', () => {
    const big = pending({ want: 'confirmed', gate: 'protected', networks: 8, anchors: 3, evidence: 2 }, { followers: 120_000 });
    assert.equal(say(big), 'Pending. The votes pass the test for confirmed, but the protected gate holds it: it has 120,000 followers, and from 50,000 followers only an admin decision changes its public state.');
    assert.equal(say(big, null), 'Pending. The votes pass the test for confirmed, but the protected gate holds it: it is a large account, so only an admin decision changes its public state.');
    const mine = pending({ want: 'flagged', gate: 'protected', networks: 2, anchors: 1 }, { protected: true });
    assert.equal(say(mine), 'Pending. The votes pass the test for flagged, but the protected gate holds it: you protected it, and only an admin decision changes the public state of a protected account.');
    assert.equal(shortReason(mine), 'Protected gate holds it');
  });

  test('identity: not matched yet, and gone', () => {
    assert.equal(say(pending({ want: 'flagged', gate: 'identity', networks: 2 }, { identity: 'unknown' })), 'Pending. The votes pass the test for flagged, but the identity gate holds it: the X facts job has not matched the handle to an X account yet.');
    assert.equal(say(pending({ want: 'flagged', gate: 'identity', networks: 2 }, { identity: 'gone' })), 'Pending. The votes pass the test for flagged, but the identity gate holds it: the X facts job did not find the handle on X in its last checks, so votes list nothing new on it.');
  });

  test('standing names the anchors that it has and needs', () => {
    const a = pending({ want: 'confirmed', gate: 'standing', networks: 6, anchors: 0, evidence: 2 });
    assert.equal(say(a), 'Pending. The votes pass the test for confirmed, but the standing gate holds it: 0 networks with standing marked it, and confirmed needs 2.');
    assert.equal(say(pending({ want: 'flagged', gate: 'standing', networks: 2, anchors: 0 })), 'Pending. The votes pass the test for flagged, but the standing gate holds it: 0 networks with standing marked it, and flagged needs 1.');
    // Without the rule numbers the sentence names no number that the server did not send.
    assert.equal(say(a, null), 'Pending. The votes pass the test for confirmed, but the standing gate holds it: 0 networks with standing marked it.');
  });

  test('evidence names the checked posts that it has and needs', () => {
    assert.equal(say(pending({ want: 'confirmed', gate: 'evidence', networks: 9, anchors: 2, evidence: 0 })), 'Pending. The votes pass the test for confirmed, but the evidence gate holds it: the server checked posts of 0 networks, and confirmed needs 2.');
    assert.equal(say(pending({ want: 'flagged', gate: 'evidence', networks: 2, anchors: 1, evidence: 0 })), 'Pending. The votes pass the test for flagged, but the evidence gate holds it: the server checked posts of 0 networks, and flagged needs 1.');
  });

  test('the daily limit names its number for each tier', () => {
    const flags = pending({ want: 'flagged', gate: 'brake', networks: 3, anchors: 1, evidence: 1 });
    assert.equal(say(flags), 'Pending. The votes pass the test for flagged, but the daily limit holds it: the daily limit of automatic flags (60 in 24 hours) is used up. It goes on at a score run with a free place, or when you decide.');
    assert.equal(shortReason(flags), 'Daily limit holds it');
    assert.match(say(pending({ want: 'confirmed', gate: 'brake', networks: 5, anchors: 2, evidence: 2 })), /automatic confirms \(30 in 24 hours\) is used up/);
  });

  test('dispute: voices with standing, and the one-camp check', () => {
    assert.equal(
      say(pending({ want: 'confirmed', gate: 'dispute', networks: 6, anchors: 2, notSlop: 1, evidence: 2 })),
      'Pending. The votes pass the test for confirmed, but the dispute gate holds it: 1 network with standing says it is not slop, so the share test counts only voices with standing on both sides, and it fails.',
    );
    assert.equal(say(pending({ want: 'flagged', gate: 'dispute', networks: 3, anchors: 1 })), 'Pending. The votes pass the test for flagged, but the dispute gate holds it: the one-camp check stopped it: only one camp of voters, who disagree on other accounts, marks it.');
  });

  test('review after a clear', () => {
    const a = pending({ want: 'confirmed', gate: 'review', networks: 7, anchors: 2, evidence: 2 });
    assert.equal(say(a), 'Pending. The review gate holds it: you cleared it before, and 7 slop networks marked it again since (review starts at 6). A person decides.');
    assert.equal(shortReason(a), 'Cleared before, marked again');
  });

  test('every gate links its glossary entry', () => {
    for (const [gate, key] of [['protected', 'gate-protected'], ['identity', 'gate-identity'], ['standing', 'gate-standing'], ['evidence', 'gate-evidence'], ['brake', 'gate-brake'], ['dispute', 'gate-dispute'], ['review', 'gate-review']] as const) {
      assert.ok(terms(statusSentence(pending({ want: 'confirmed', gate, networks: 6 }), RULES)).includes(key), gate);
    }
  });
});

describe('gate checklist', () => {
  const row = (a: AccountFacts, key: string) => {
    const r = checklist(a, RULES).find((x) => x.key === key);
    assert.ok(r, key);
    return r;
  };

  test('flagged, held from confirmed by standing: the anchors row holds it', () => {
    const a = account({ status: 'flagged', tier: 1, followers: 3100 }, { reason: 'votes_flagged', want: 'confirmed', gate: 'standing', networks: 4, anchors: 1, trust: 1.6, evidence: 2 });
    const anchors = row(a, 'anchors');
    assert.deepEqual([anchors.has, anchors.flagged, anchors.confirmed, anchors.holds], ['1', { need: '1', mark: 'met' }, { need: '2', mark: 'unmet' }, true]);
    assert.deepEqual([row(a, 'networks').flagged.mark, row(a, 'networks').confirmed.mark], ['met', 'met']);
    assert.deepEqual([row(a, 'trust').has, row(a, 'trust').confirmed], ['1.60', { need: '1', mark: 'met' }]);
    assert.equal(row(a, 'trust').flagged.mark, 'none');
    assert.deepEqual([row(a, 'protected').has, row(a, 'protected').confirmed.mark], ['3,100 followers', 'met']);
    assert.equal(checklist(a, RULES).filter((r) => r.holds).length, 1);
    assert.equal(checklistNote(a), null);
    assert.equal(nextStep(a, RULES), 'For confirmed by votes it needs 1 more anchor.');
  });

  test('pending on evidence: the evidence row holds it, and the next step names the posts', () => {
    const a = account({ status: 'pending' }, { reason: 'pending', want: 'confirmed', gate: 'evidence', networks: 9, anchors: 2, trust: 2.1, evidence: 0 });
    assert.deepEqual(row(a, 'evidence').confirmed, { need: '2', mark: 'unmet' });
    assert.equal(row(a, 'evidence').holds, true);
    assert.equal(row(a, 'brake').confirmed.mark, 'open');
    assert.equal(nextStep(a, RULES), 'For confirmed by votes it needs a checked post from 2 more networks.');
  });

  test('a large account fails the protected row for both tiers, and only you can list it', () => {
    const a = account({ status: 'pending', followers: 120_000 }, { reason: 'pending', want: 'confirmed', gate: 'protected', networks: 8, anchors: 3, trust: 4.2, evidence: 2 });
    assert.deepEqual([row(a, 'protected').flagged.mark, row(a, 'protected').confirmed.mark, row(a, 'protected').holds], ['unmet', 'unmet', true]);
    assert.equal(nextStep(a, RULES), 'Only your decision can list it, because it is protected.');
  });

  test('an unknown identity fails the identity row', () => {
    const a = account({ status: 'pending', identity: 'unknown', followers: null }, { reason: 'pending', want: 'flagged', gate: 'identity', networks: 2, anchors: 1, trust: 0.9 });
    assert.deepEqual([row(a, 'identity').has, row(a, 'identity').flagged.mark], ['unknown', 'unmet']);
    assert.equal(row(a, 'protected').has, 'followers not known');
    assert.equal(nextStep(a, RULES), 'For flagged by votes it needs an identity check by the X facts job and a checked post from 1 more network.');
  });

  test('a not listed account names the networks that it lacks', () => {
    const a = account({}, { networks: 1, needed: 1, trust: 0.35 });
    assert.deepEqual(row(a, 'networks').flagged, { need: '2', mark: 'unmet' });
    assert.equal(nextStep(a, RULES), 'For flagged by votes it needs 1 more slop network, 1 more anchor and a checked post from 1 more network.');
  });

  test('decisions, seeds, moves and clears explain why the checks do not decide', () => {
    assert.match(checklistNote(account({ status: 'confirmed', override: 'confirm' })) ?? '', /^Your decision decides this account/);
    assert.match(checklistNote(account({ status: 'confirmed', seed: true })) ?? '', /^A starter account is confirmed/);
    assert.match(checklistNote(account({ identity: 'moved' })) ?? '', /^The handle belongs to another X account/);
    assert.match(checklistNote(account({ status: 'cleared' })) ?? '', /^A cleared account never returns/);
    assert.equal(nextStep(account({ status: 'confirmed', seed: true }), RULES), null);
    assert.equal(nextStep(account({ status: 'confirmed' }, { reason: 'votes_confirmed', networks: 5, anchors: 3, trust: 3, evidence: 2 }), RULES), null);
  });

  test('a review item reads like an account row', () => {
    const item = readAccount({ handle: 'xs_auto', status: 'confirmed', seed: false, gate: null, want: null, networks: 5, anchors: 3, evidence: [{ tweetId: '1', at: 'x' }], trust: 3.4, followers: 900, identity: 'ok' });
    assert.equal(item.parts.reason, 'votes_confirmed');
    assert.equal(item.parts.networks, 5);
    // `evidence` of a review item is the list of posts, not the count: the count stays 0, and no sentence names it.
    assert.equal(item.parts.evidence, 0);
    assert.equal(item.partial, true);
    assert.equal(say(item), 'Confirmed by votes. 5 slop networks marked it, 3 of them with standing (anchors).');
    const held = readAccount({ handle: 'xs_p', status: 'pending', want: 'confirmed', gate: 'evidence', networks: 9, anchors: 2, dissent: 4, evidence: [], identity: 'ok' });
    assert.equal(say(held), 'Pending. The votes pass the test for confirmed, but the evidence gate holds it: the server checked posts of too few networks, and confirmed needs 2.');
    const listed = readAccount({ handle: 'xs_l', status: 'flagged', networks: 3, anchors: 1, dissent: 3, evidence: [] });
    assert.equal(say(listed), 'Flagged by votes. 3 slop networks marked it, 1 of them with standing (anchor). 3 networks without standing said not slop; that counts in no test (dissent).');
    const seed = readAccount({ handle: 'xs_s', status: 'confirmed', seed: true, networks: 41, notSlop: 5, evidence: [] });
    assert.match(say(seed), /only an accepted appeal or your clear does\. 5 networks with standing say it is not slop\.$/);
    assert.equal(account({ status: 'flagged' }).partial, false);
  });
});

describe('install standing', () => {
  const needs = { ageDays: 7, goodMarks: 3, reputation: 0.6 };
  const standing = (s: Record<string, unknown>) => readStanding({ has: false, trusted: false, banned: false, ageDays: 10, goodMarks: 4, reputation: 0.7, needs, ...s });
  const text = (s: Record<string, unknown>) => plain(standingSentence(standing(s)));

  test('every state gives its sentence', () => {
    assert.equal(text({ has: true }), 'Has standing: it is 10 days old, has 4 good marks and a reputation of 0.70.');
    assert.equal(text({ has: true, reputation: 0.55 }), 'Has standing now, but the next score run takes it away. It needs a reputation of at least 0.60 (it has 0.55).');
    assert.equal(text({}), 'No standing yet. Every check passes (it is 10 days old, has 4 good marks and a reputation of 0.70), so the next score run gives it standing.');
    assert.equal(text({ ageDays: 0.04, goodMarks: 0, reputation: 0.05 }), 'No standing. It needs 7 more days, 3 more good marks and a reputation of at least 0.60 (it has 0.05).');
    assert.equal(text({ ageDays: 2.2, goodMarks: 1 }), 'No standing. It needs 5 more days and 2 more good marks.');
    assert.equal(text({ banned: true, has: true }), 'No standing: you banned it, so its votes count nowhere.');
    assert.equal(text({ trusted: true, has: true }), 'Has standing, because you trusted it.');
    assert.equal(text({ trusted: true, ageDays: 1 }), 'You trusted it, so the next score run gives it standing.');
    assert.equal(plain(standingSentence(readStanding({ has: true }))), 'Has standing.');
  });

  test('the checklist marks every check against the needs of the answer', () => {
    const marks = standingChecks(standing({ ageDays: 2.6, goodMarks: 3, reputation: 0.59 })).map((c) => [c.key, c.has, c.need, c.mark]);
    assert.deepEqual(marks, [
      ['banned', 'not banned', 'not banned', 'met'],
      ['trusted', 'no', 'gives standing alone', 'none'],
      ['age', '2 days', '7 days', 'unmet'],
      ['goodMarks', '3', '3', 'met'],
      ['reputation', '0.59', '0.60', 'unmet'],
    ]);
    // Without needs from the server the checklist shows no number that it would have to invent.
    assert.deepEqual(standingChecks(readStanding({ has: true, banned: true })).map((c) => c.key), ['banned', 'trusted']);
  });
});

describe('activity sentences', () => {
  const one = (item: Record<string, unknown>) => {
    const [a] = readActivity([{ key: 'k', at: '2026-11-10T10:00:00Z', source: 'x', subject: null, data: {}, ...item }]);
    assert.ok(a);
    return plain(activitySentence(a));
  };
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  test('every admin action reads as what you did', () => {
    const admin = (action: string, subject: string | null, after: unknown = null, session = 'abcd') => one({ kind: 'admin', subject, data: { action, session, before: null, after } });
    assert.equal(admin('login', 'abcd'), 'You logged in (session abcd).');
    assert.equal(admin('logout', 'abcd'), 'You logged out (session abcd).');
    assert.equal(admin('confirm', 'xs_b', { list: { version: 119 } }), 'You confirmed @xs_b. The list went to version 119.');
    assert.equal(admin('clear', 'xs_c', { account: { clearPenalty: false }, list: { version: 120 } }), 'You cleared @xs_c without a penalty. The list went to version 120.');
    assert.equal(admin('clear', 'xs_c', { account: { clearPenalty: true } }), 'You cleared @xs_c with a penalty.');
    assert.equal(admin('reset', 'xs_d'), 'You removed your decision on @xs_d. The next score run decides it.');
    assert.equal(admin('protect', 'xs_e'), 'You protected @xs_e.');
    assert.equal(admin('unprotect', 'xs_e'), 'You removed the protection of @xs_e.');
    assert.equal(admin('ban-voters', 'xs_f', { banned: 4 }), 'You banned 4 installs that marked @xs_f.');
    assert.equal(admin('trust', ID), 'You trusted install 0f8fad5b.');
    assert.equal(admin('untrust', ID), 'You removed the trust of install 0f8fad5b.');
    assert.equal(admin('ban', ID), 'You banned install 0f8fad5b.');
    assert.equal(admin('unban', ID), 'You unbanned install 0f8fad5b.');
    assert.equal(admin('accept', ID, { handle: 'xs_g', list: { version: 121 } }), 'You accepted the appeal for @xs_g. The list went to version 121.');
    assert.equal(admin('reject', ID, { handle: 'xs_g' }), 'You rejected the appeal for @xs_g.');
  });

  test('status, identity, standing, list, appeal, run, vote and install items', () => {
    const moved = { kind: 'status', subject: 'xs_a', data: { from: { status: 'pending', gate: 'evidence' }, to: { status: 'flagged', gate: null, networks: 4, anchors: 1, evidence: 1, notSlop: 0, score: 61 } } };
    assert.equal(one(moved), 'The score job moved @xs_a from pending (evidence gate) to flagged.');
    const [item] = readActivity([{ key: 'k', at: '2026-11-10T10:00:00Z', ...moved }]);
    assert.ok(item);
    assert.equal(activityDetail(item), '4 slop networks, 1 anchor, evidence of 1 network, 0 not slop with standing, score 61.');
    assert.equal(one({ kind: 'status', subject: 'xs_a', data: { from: { status: 'pending', gate: 'standing' }, to: { status: 'pending', gate: 'evidence' } } }), 'The score job kept @xs_a at pending (evidence gate); before, the standing gate held it.');
    assert.equal(one({ kind: 'status', subject: 'xs_a', data: { from: { status: 'none' }, to: { status: 'pending', gate: 'brake' } } }), 'The score job moved @xs_a from not listed to pending (daily limit).');
    assert.equal(one({ kind: 'identity', subject: 'xs_a', data: { from: 'unknown', to: 'ok', xUserId: '14' } }), 'The X facts job matched @xs_a to X id 14.');
    assert.equal(one({ kind: 'identity', subject: 'xs_a', data: { from: 'ok', to: 'gone' } }), 'The X facts job did not find @xs_a on X in its last checks.');
    assert.equal(one({ kind: 'identity', subject: 'xs_a', data: { from: 'ok', to: 'moved', movedTo: 'xs_b' } }), 'The X facts job found that @xs_a belongs to another X account now; its state moved to @xs_b.');
    assert.equal(one({ kind: 'identity', subject: 'xs_b', data: { from: 'unknown', to: 'ok', tookFrom: 'xs_a' } }), 'The X facts job found a rename: @xs_b took the state of @xs_a.');
    assert.equal(one({ kind: 'standing', subject: ID, data: { standing: true } }), 'Install 0f8fad5b gained standing.');
    assert.equal(one({ kind: 'standing', subject: ID, data: { standing: false, banned: true } }), 'Install 0f8fad5b lost standing, because it is banned.');
    assert.equal(one({ kind: 'list', subject: '118', data: { version: 118, count: 873, addedCount: 1, removedCount: 1 } }), 'The list went to version 118: 1 joined or changed, 1 left, 873 accounts in total.');
    assert.equal(one({ kind: 'appeal', subject: 'xs_a', data: {} }), 'An appeal for @xs_a arrived.');
    assert.equal(one({ kind: 'run', data: { job: 'profiles', ms: 21_500, error: 'fetch failed' } }), 'The X facts job failed after 21.5 s: fetch failed.');
    assert.equal(one({ kind: 'run', data: { job: 'profiles', ms: 1000, error: 'fail\u202e.exe' } }), 'The X facts job failed after 1.0 s: fail.exe.');
    assert.equal(one({ kind: 'run', data: { job: 'score', ms: 800 } }), 'The score job failed after 800 ms: no error text.');
    assert.equal(one({ kind: 'vote', subject: 'xs_a', data: { install: ID, value: 1, first: true } }), 'Install 0f8fad5b marked @xs_a as slop.');
    assert.equal(one({ kind: 'vote', subject: 'xs_a', data: { install: ID, value: 0, first: true } }), 'Install 0f8fad5b said not slop on @xs_a.');
    assert.equal(one({ kind: 'vote', subject: 'xs_a', data: { install: ID, value: 0, first: false } }), 'Install 0f8fad5b changed its vote to not slop on @xs_a.');
    assert.equal(one({ kind: 'install', subject: ID, data: { network: 'a1b2c3d4', extVersion: '1.2.0' } }), 'A new install 0f8fad5b joined from network a1b2c3d4, version 1.2.0.');
  });

  test('a subject that is neither a handle nor an id stays plain text, and bad items are dropped', () => {
    assert.equal(one({ kind: 'appeal', subject: '<b>x</b>' }), 'An appeal for <b>x</b> arrived.');
    assert.equal(readActivity([{ kind: 'nope', at: '2026-11-10T10:00:00Z' }, { kind: 'admin', at: 'not a date' }, null, 'x']).length, 0);
  });
});

describe('admin changes and small texts', () => {
  test('changedFields lists only the fields that changed, in words', () => {
    const before = { account: { status: 'flagged', tier: 1, override: null, clearPenalty: true, updatedAt: 'a' } };
    const after = { account: { status: 'cleared', tier: 0, override: 'clear', clearPenalty: true, updatedAt: 'b' }, list: { version: 118, changed: true } };
    assert.deepEqual(changedFields(before, after), [
      { field: 'Account status', before: 'flagged', after: 'cleared' },
      { field: 'Account tier', before: '1', after: '0' },
      { field: 'Account override', before: 'none', after: 'clear' },
      { field: 'List version', before: 'none', after: '118' },
      { field: 'List changed', before: 'none', after: 'yes' },
    ]);
    assert.deepEqual(changedFields({ install: { banned_at: null } }, { install: { banned_at: null } }), []);
    assert.deepEqual(changedFields(null, null), []);
    assert.deepEqual(changedFields({ note: 'pay\u202e.exe' }, { note: 'ok' }), [{ field: 'Note', before: 'pay.exe', after: 'ok' }]);
    assert.equal(showValue('keep\nthis\tand\u0000drop'), 'keep\nthis\tanddrop');
    assert.equal(str({ message: 'a\u202eb\nc' }, 'message'), 'ab\nc');
    assert.equal(strOrNull({ message: '\u202e' }, 'message'), null);
    assert.equal(rawState({ name: 'a\u202eb' }, null).includes('\u202e'), false);
    assert.match(rawState({ name: 'a\u202eb' }, null), /ab/);
  });

  test('marks, timing and rules', () => {
    assert.equal(marksSentence({ networks: 4, strikes: 3 }), '4 networks marked it. An accept with penalty strikes 3.');
    assert.equal(timingText(12, 0.9), '90% within a minute, of 12 checked replies');
    assert.equal(timingText(1, 0), '0% within a minute, of 1 checked reply');
    assert.equal(timingText(0, 0.5), 'No checked replies');
    assert.deepEqual(readRules(RULES), RULES);
    const { networkDailyVotes: _, ...missing } = RULES;
    assert.equal(readRules(missing), null);
    assert.equal(readRules(null), null);
  });
});
