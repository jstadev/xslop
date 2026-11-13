// The plain words of a list entry, built from the fields of the API. Neutral wording: it describes a record, not a person.

import { formatCount } from '../lib/format.ts';
import type { Slopper } from '../lib/schema.ts';

const NBSP = ' ';

const plural = (n: number, one: string, many: string): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "12 votes", with a space that never breaks the number from its word at the end of a line. */
const counted = (n: number, word: string): string => `${formatCount(n)}${NBSP}${word}${n === 1 ? '' : 's'}`;

const differentNetworks = (n: number): string => (n === 1 ? '1 network' : `${formatCount(n)} different networks`);

type Origin = 'seed' | 'admin' | 'votes';

function originOf(s: Slopper): Origin {
  if (s.reason === 'seed') return 'seed';
  if (s.reason.startsWith('override')) return 'admin';
  return 'votes';
}

const SOURCE: Record<Origin, string> = { seed: 'Seed list', admin: 'Admin decision', votes: 'Votes' };

/** Where the listing came from, in two or three words. */
export function sourceName(s: Slopper): string {
  return SOURCE[originOf(s)];
}

/**
 * The facts after the status and the score on the closed line. A fact with no information gives no text:
 * a count of zero is left out. The source is not on the line; the open record names it.
 * An account that the votes would confirm, held back by a check of 13.3, says so last.
 * No fact breaks inside, so a long line breaks only between two facts.
 */
export function lineFacts(s: Slopper): string[] {
  const facts: string[] = [];
  if (s.votes.slop > 0) facts.push(s.networks > 0 ? `${counted(s.votes.slop, 'vote')} from ${counted(s.networks, 'network')}` : counted(s.votes.slop, 'vote'));
  if (s.waits) facts.push('Waits for a check');
  return facts.map((fact) => fact.replaceAll(' ', NBSP));
}

const X_LIST_SOURCE = 'x_list:2116659176894071283';
const SEED_APPEAL = 'Seed accounts start as confirmed and can appeal like any other.';
const SEED_STORY: Record<string, string> = {
  [X_LIST_SOURCE]: `This account was on the public X list “ai slop posters” when xslop started. ${SEED_APPEAL}`,
  'site:clankwall.vogel.dev': `This account was on Clankwall (clankwall.vogel.dev), a public list of accounts whose replies its checker flagged as spam or AI text. At the import on 13 November 2026, Clankwall had flagged 2 or more of its replies. ${SEED_APPEAL}`,
};
const SEED_STORY_OTHER = `This account was on a public list of slop accounts at the time of its import. ${SEED_APPEAL}`;

/** The sentence under the source in the open record. */
export function originStory(s: Slopper): string {
  switch (originOf(s)) {
    case 'seed':
      return SEED_STORY[s.seedSource ?? X_LIST_SOURCE] ?? SEED_STORY_OTHER;
    case 'admin':
      return 'An admin confirmed this account by hand.';
    case 'votes':
      return 'People who use the xslop extension marked its replies as slop, and the votes met the rule for this status.';
  }
}

export function votesText(s: Slopper): string {
  const { slop, notSlop } = s.votes;
  if (slop === 0 && notSlop === 0) return 'No votes yet.';
  return `${plural(slop, 'vote says', 'votes say')} slop. ${plural(notSlop, 'vote says', 'votes say')} not slop.`;
}

/** The networks behind the marks, or null when no network has marked the account. */
export function networksText(s: Slopper): string | null {
  return s.networks === 0 ? null : `The marks came from ${differentNetworks(s.networks)}.`;
}

/** What a flagged account still lacks, or null when the count is not the open question. More networks are not always enough (13.3). */
export function neededText(s: Slopper): string | null {
  if (s.status !== 'flagged' || s.needed === 0) return null;
  return `It needs marks from at least ${plural(s.needed, 'more network', 'more networks')} to be confirmed.`;
}
