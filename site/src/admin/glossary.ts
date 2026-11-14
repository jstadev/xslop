// The words of the console (SPEC 14.3), in the plain words of docs/list-flow-explained.md. A number in a definition comes
// from `overview.rules`; without the rules the definition names no number.

import { formatCount, formatPercent } from '../lib/format.ts';
import type { Rules } from './model.ts';

export interface Term {
  word: string;
  group: 'Statuses' | 'Gates' | 'Votes and voters' | 'Accounts' | 'System';
  def: (r: Rules | null) => string;
}

const n = (r: Rules | null, k: keyof Rules, unit = ''): string => (r ? `${formatCount(r[k])}${unit}` : '');
const pct = (r: Rules | null, k: keyof Rules): string => (r ? formatPercent(r[k]) : '');
/** "Flagged needs 1, confirmed needs 2." or nothing without rules. */
const needs = (r: Rules | null, flag: keyof Rules, confirm: keyof Rules): string => (r ? ` Flagged needs ${n(r, flag)}, confirmed needs ${n(r, confirm)}.` : '');

export const GLOSSARY = {
  none: {
    word: 'Not listed',
    group: 'Statuses',
    def: () => 'Status none. The account is not on the list, and every public page shows it as not listed. Votes may exist, but they pass no test yet.',
  },
  pending: {
    word: 'Pending',
    group: 'Statuses',
    def: () => 'The votes pass the crowd test, but a gate holds the account. It waits for you in the review queue. It is not on the list, and public pages show it as not listed.',
  },
  flagged: {
    word: 'Flagged',
    group: 'Statuses',
    def: () => 'Tier 1. The extension hides the account only for users who chose Strict mode.',
  },
  confirmed: {
    word: 'Confirmed',
    group: 'Statuses',
    def: () => 'Tier 2. The extension hides the account for every user who keeps the list on, and mute sync mutes it.',
  },
  cleared: {
    word: 'Cleared',
    group: 'Statuses',
    def: () => 'An admin took the account off the list, by a clear or an accepted appeal. It never returns without a person.',
  },
  tier: {
    word: 'Tier',
    group: 'Statuses',
    def: () => '0: not listed. 1: flagged, hidden for users in Strict mode. 2: confirmed, hidden for every user who keeps the list on.',
  },
  score: {
    word: 'Score',
    group: 'Statuses',
    def: () => '0 to 100. For an account that votes list or hold: the cautious share of its votes. A starter account keeps a high minimum. Your confirm gives 100. Not listed and cleared accounts have 0.',
  },
  want: {
    word: 'Votes support',
    group: 'Statuses',
    def: () => 'The status that the votes alone would give, when a gate holds the account below it.',
  },
  gate: {
    word: 'Gate',
    group: 'Gates',
    def: () => 'A check that the votes must pass besides the crowd test, in this order: protected, identity, standing, evidence, daily limit. The first check that fails holds the account and names the gate.',
  },
  'gate-protected': {
    word: 'Protected gate',
    group: 'Gates',
    def: (r) => `The account is protected${r ? `, or has ${n(r, 'protectedMinFollowers')} followers or more` : ''}. Only an admin decision changes its public state.`,
  },
  'gate-identity': {
    word: 'Identity gate',
    group: 'Gates',
    def: () => 'The X facts job has not matched the handle to its X account, or did not find it. Votes list nothing new on such an account.',
  },
  'gate-standing': {
    word: 'Standing gate',
    group: 'Gates',
    def: (r) => `Too few networks with standing marked the account.${needs(r, 'anchorsFlag', 'anchorsConfirm')}`,
  },
  'gate-evidence': {
    word: 'Evidence gate',
    group: 'Gates',
    def: (r) => `The server checked too few posts that the slop votes name, counted in networks.${needs(r, 'evidenceFlag', 'evidenceConfirm')}`,
  },
  'gate-brake': {
    word: 'Daily limit',
    group: 'Gates',
    def: (r) =>
      `${r ? `At most ${n(r, 'maxAutoConfirmsPerDay')} automatic confirms and ${n(r, 'maxAutoFlagsPerDay')} automatic flags in 24 hours.` : 'Automatic confirms and flags have a daily limit.'} The accounts with the most anchors go first. The rest wait for a free place or for you.`,
  },
  'gate-dispute': {
    word: 'Dispute gate',
    group: 'Gates',
    def: () => 'Voices with standing say not slop, so the share test counts only voices with standing on both sides and fails. Or the one-camp check found that only one camp of voters marks the account.',
  },
  'gate-review': {
    word: 'Review gate',
    group: 'Gates',
    def: (r) => `You cleared the account before and then reset the decision.${r ? ` When at least ${n(r, 'clearedReturnMinNetworks')} slop networks mark it again, it waits for you.` : ' When enough networks mark it again, it waits for you.'} It never returns without a person.`,
  },
  network: {
    word: 'Network',
    group: 'Votes and voters',
    def: () => 'One internet connection, for example a home, an office or a phone carrier. The server records it when an extension installs. Many installs on one connection are one voice. The console names a network by 8 characters of a hash, never by its address.',
  },
  install: {
    word: 'Install',
    group: 'Votes and voters',
    def: () => 'One copy of the extension in one browser, with a random id and the network where it installed. Its network never changes.',
  },
  voice: {
    word: 'Voice',
    group: 'Votes and voters',
    def: () => 'What one network says about one account: slop, not slop, or split. When an install with standing on that network voted, only the installs with standing make the voice.',
  },
  trust: {
    word: 'Trust',
    group: 'Votes and voters',
    def: (r) => `How much one network counts: the reputation of the install times an age factor. A new install counts little; after one week it counts in full.${r ? ` Confirmed needs a total trust of ${n(r, 'confirmMinTrust')} from its slop networks.` : ''}`,
  },
  share: {
    word: 'Cautious share',
    group: 'Votes and voters',
    def: (r) => `The share of slop votes, lowered when few networks voted (a Wilson lower bound).${r ? ` Flagged needs ${pct(r, 'flagShareBound')}, confirmed needs ${pct(r, 'confirmShareBound')}.` : ''}`,
  },
  standing: {
    word: 'Standing',
    group: 'Votes and voters',
    def: (r) =>
      `An install has standing when it is not banned and you trusted it${r ? `, or it is at least ${n(r, 'standingMinAgeDays')} days old, has at least ${n(r, 'standingMinGoodMarks')} good marks and a reputation of at least ${r.standingMinReputation}` : ', or it is old enough and earned enough good marks and reputation'}. Only votes with standing can list an account without you.`,
  },
  trusted: {
    word: 'Trusted',
    group: 'Votes and voters',
    def: () => 'You marked the install as trusted. It has standing while it is not banned. Only an admin sets or removes this.',
  },
  anchor: {
    word: 'Anchors',
    group: 'Votes and voters',
    def: (r) => `The slop networks whose voice has standing.${needs(r, 'anchorsFlag', 'anchorsConfirm')}`,
  },
  'not-slop': {
    word: 'Not slop with standing',
    group: 'Votes and voters',
    def: () => 'Networks with standing that say the account is not slop. They lower the cautious share and can send an account to review.',
  },
  dissent: {
    word: 'Dissent',
    group: 'Votes and voters',
    def: () => 'Networks without standing that say not slop. They count in no test. The number is information for you.',
  },
  'good-mark': {
    word: 'Good mark',
    group: 'Votes and voters',
    def: () => 'A slop vote cast before the account was public, on an account that you then confirmed. One confirm gives good marks only to the first few networks that marked it. A confirm by votes gives none, so standing always starts at a person.',
  },
  reputation: {
    word: 'Reputation',
    group: 'Votes and voters',
    def: () => 'How often the earlier votes of an install agreed with your decisions. It rises with each agreement and falls with each wrong vote.',
  },
  penalty: {
    word: 'Penalty',
    group: 'Votes and voters',
    def: () => 'A wrong vote: a slop mark on an account that you clear with penalty, or a not slop vote set before you confirm the account. A penalty ends the standing of its install at the next score run. After it, only new good marks count.',
  },
  strike: {
    word: 'Strike',
    group: 'Votes and voters',
    def: (r) =>
      `When you clear an account with penalty, each slop network without standing gets a strike. The slop networks with standing get one only when ${r ? `at most ${n(r, 'strikeMaxCrowd')}` : 'few'} of them marked it. Too many strikes in a short time silence a network for a while.`,
  },
  ban: {
    word: 'Ban',
    group: 'Votes and voters',
    def: () => 'The votes of a banned install count nowhere, from the next score run. Unban gives them back.',
  },
  identity: {
    word: 'Identity',
    group: 'Accounts',
    def: () => 'ok: the server found the handle and its X id. unknown: not checked yet. gone: the handle was not found in several checks in a row; the account keeps its state, but votes list nothing new on it. moved: the handle now has another X id, so it is never listed.',
  },
  evidence: {
    word: 'Evidence',
    group: 'Accounts',
    def: (r) => `Posts that a slop vote names and that the server found written by the account, counted in networks.${needs(r, 'evidenceFlag', 'evidenceConfirm')}`,
  },
  override: {
    word: 'Admin decision',
    group: 'Accounts',
    def: () => 'Your confirm or clear of an account. It wins over the votes until you reset it. Each one publishes the list at once.',
  },
  seed: {
    word: 'Starter account',
    group: 'Accounts',
    def: (r) => `An account of the public X list "ai slop posters". It is confirmed from the first day. Votes never remove it; only an accepted appeal or your clear does, and its clear has no penalty.${r ? ` At ${n(r, 'seedDisputeMinNetworks')} not slop networks with standing it shows as disputed.` : ''}`,
  },
  protected: {
    word: 'Protected',
    group: 'Accounts',
    def: (r) => `An account that you protected${r ? `, or one with ${n(r, 'protectedMinFollowers')} followers or more` : ', or a large account'}. Only an admin decision changes its public state.`,
  },
  behaviour: {
    word: 'Reply timing',
    group: 'Accounts',
    def: () => 'How fast the account replies, from replies that the server checked on X. It is information for you and never changes a status.',
  },
  appeal: {
    word: 'Appeal',
    group: 'Accounts',
    def: () => 'The owner of a listed account asks to leave the list on the check page and puts a code in the X bio. Accept clears the account; reject keeps it.',
  },
  'queue-pending': {
    word: 'Pending queue',
    group: 'System',
    def: () => 'Accounts that the votes pass and a gate holds. Confirm lists one at once; clear takes it off for good.',
  },
  'queue-disputed': {
    word: 'Disputed queue',
    group: 'System',
    def: () => 'Starter accounts that networks with standing call not slop, and listed accounts with much dissent.',
  },
  'queue-auto': {
    word: 'Automatic queue',
    group: 'System',
    def: () => 'Accounts that the votes confirmed in the last 7 days without a person. Your confirm makes the decision trusted and gives good marks to the first voters.',
  },
  'list-version': {
    word: 'List version',
    group: 'System',
    def: () => 'The server publishes a new list version when the list changes. Extensions fetch it at their next sync and hide the new accounts.',
  },
  'score-job': {
    word: 'Score job',
    group: 'System',
    def: () => 'Counts the votes, decides the status of each account and the standing of each install, and publishes the list. It runs every few minutes.',
  },
  'facts-job': {
    word: 'X facts job',
    group: 'System',
    def: () => 'Checks accounts on X with two public sources: the handle and its X id, the posts that votes name, and reply timing.',
  },
  session: {
    word: 'Session',
    group: 'System',
    def: () => 'One login. The activity feed names it by 16 characters of a hash. It ends after 30 minutes without a request, or after 12 hours.',
  },
} satisfies Record<string, Term>;

export type TermKey = keyof typeof GLOSSARY;

export const isTerm = (v: string): v is TermKey => Object.hasOwn(GLOSSARY, v);

export const gateTerm = (gate: string): TermKey => (isTerm(`gate-${gate}`) ? (`gate-${gate}` as TermKey) : 'gate');
