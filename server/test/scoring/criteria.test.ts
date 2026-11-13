import { describe, expect, test } from 'vitest';
import { CRITERIA, type CriteriaTier } from '../../src/scoring/criteria.js';
import {
  ANCHORS_CONFIRM, ANCHORS_FLAG, CLEARED_RETURN_MIN_NETWORKS, CONFIRM_MIN_NETWORKS, CONFIRM_MIN_TRUST, EVIDENCE_CONFIRM, EVIDENCE_FLAG, FLAG_MIN_NETWORKS,
  GOOD_MARKS_PER_ACCOUNT, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, NETWORK_DAILY_VOTES, NEW_INSTALL_TRUST, PROTECTED_MIN_FOLLOWERS, STANDING_DAILY,
  STANDING_MIN_AGE_DAYS, STANDING_MIN_GOOD_MARKS, STANDING_MIN_REPUTATION, STRIKE_LIMIT, STRIKE_MAX_CROWD, STRIKE_WINDOW_DAYS,
} from '../../src/scoring/index.js';

const allStrings = (c: typeof CRITERIA): string[] => [
  ...c.tiers.flatMap((t: CriteriaTier) => [t.title, t.summary, ...t.rules]),
  ...c.weights, ...c.protections, c.appeal,
];

describe('CRITERIA', () => {
  test('has the contract shape, version 2, one tier per listed status', () => {
    expect(CRITERIA.version).toBe(2);
    expect(CRITERIA.tiers.map((t) => t.status)).toEqual(['flagged', 'confirmed']);
    for (const t of CRITERIA.tiers) expect(t.rules.length).toBeGreaterThan(0);
    expect(CRITERIA.weights.length).toBeGreaterThan(0);
    expect(CRITERIA.protections.length).toBeGreaterThan(0);
    expect(typeof CRITERIA.appeal).toBe('string');
    expect(JSON.parse(JSON.stringify(CRITERIA))).toEqual(CRITERIA);
  });

  // The limits of parseCriteria in site/src/lib/schema.ts: one text or list past them and /rules drops the whole answer.
  test('every text is 1 to 600 characters and every list holds at most 16 items, the limits of the site parser', () => {
    expect(allStrings(CRITERIA).filter((s) => s.length < 1 || s.length > 600)).toEqual([]);
    expect([...CRITERIA.tiers.map((t) => t.rules), CRITERIA.weights, CRITERIA.protections].filter((list) => list.length > 16)).toEqual([]);
  });

  test('every string is finished customer copy: no first person, no em-dash, no empty text', () => {
    for (const s of allStrings(CRITERIA)) {
      expect(s).not.toBe('');
      expect(s).not.toMatch(/—/);
      expect(s).not.toMatch(/\b(we|our|ours|us)\b/i);
      expect(s).not.toMatch(/\bTODO\b|undefined|NaN/);
    }
  });

  test('the numbers are the engine constants, and every rule of v2 is stated in plain words', () => {
    const [flagged, confirmed] = CRITERIA.tiers;
    const flag = [flagged!.summary, ...flagged!.rules].join(' ');
    const confirm = [confirmed!.summary, ...confirmed!.rules].join(' ');
    const weights = CRITERIA.weights.join(' ');
    const protections = CRITERIA.protections.join(' ');
    expect(flag).toContain(`At least ${FLAG_MIN_NETWORKS} different networks`);
    expect(flag).toContain(`at least ${ANCHORS_FLAG} of them with standing`);
    expect(confirm).toContain(`At least ${CONFIRM_MIN_NETWORKS} different networks`);
    expect(confirm).toContain(`at least ${ANCHORS_CONFIRM} of them with standing`);
    expect(confirm).toContain(`at least ${Math.ceil(CONFIRM_MIN_TRUST / NEW_INSTALL_TRUST)} different networks`);
    expect(confirm).toContain(`Evidence check: the marks of at least ${EVIDENCE_CONFIRM} networks name a post`);
    expect(flag).toContain(`Evidence check: the marks of at least ${EVIDENCE_FLAG} network name a post`);
    expect(flag).toContain(`At most ${MAX_AUTO_FLAGS_PER_DAY} accounts become flagged automatically in 24 hours`);
    expect(confirm).toContain(`At most ${MAX_AUTO_CONFIRMS_PER_DAY} accounts become confirmed automatically in 24 hours`);
    expect(confirm).toContain('Votes do not remove a starter account');
    expect(confirm).toContain('An admin can confirm or clear');
    // Who has standing and how to earn it; new installs wait for a person; "not slop" needs standing.
    expect(weights).toContain(`at least ${STANDING_MIN_AGE_DAYS} days old, has at least ${STANDING_MIN_GOOD_MARKS} good marks and has a reputation of at least ${Math.round(STANDING_MIN_REPUTATION * 100)}%`);
    expect(weights).toContain('A good mark:');
    expect(weights).toContain(`Only an admin decision gives good marks, and one admin confirm gives them to the first ${GOOD_MARKS_PER_ACCOUNT} networks`);
    expect(weights).toContain('A wrong vote takes your standing away');
    expect(weights).toContain(`only the marks that you set after that admin decision can become good marks, so you need ${STANDING_MIN_GOOD_MARKS} new good marks`);
    expect(weights).toContain(`At most ${STANDING_DAILY} votes from your network carry standing in 24 hours`);
    expect(weights).toContain(`A vote past that never carries standing, also not later: it counts as a vote without standing. So if you mark many accounts, your first ${STANDING_DAILY} marks of each day carry standing.`);
    expect(weights).toContain('they wait for a person');
    expect(weights).toContain('"Not slop" votes count only from installs with standing');
    expect(protections).toContain('Review: a person checks every account');
    expect(protections).toContain(`Protected accounts: an account with ${PROTECTED_MIN_FOLLOWERS.toLocaleString('en-US')} followers or more`);
    expect(protections).toContain(`Daily brake: at most ${MAX_AUTO_CONFIRMS_PER_DAY} automatic confirms`);
    expect(protections).toContain(`at most ${NETWORK_DAILY_VOTES} votes in 24 hours`);
    expect(protections).toContain(`A network with standing gets none when more than ${STRIKE_MAX_CROWD} networks with standing marked the account`);
    expect(protections).toContain(`${MAX_AUTO_FLAGS_PER_DAY} automatic flags in 24 hours`);
    expect(protections).toContain(`With ${STRIKE_LIMIT} strikes inside ${STRIKE_WINDOW_DAYS} days`);
    expect(protections).toContain(`until ${STRIKE_WINDOW_DAYS} days after the newest strike`);
    expect(protections).toContain(`When at least ${CLEARED_RETURN_MIN_NETWORKS} networks mark it again, it goes to the review queue`);
    expect(CRITERIA.appeal).toContain('the appeal form at https://x-slop.com/check');
  });
});
