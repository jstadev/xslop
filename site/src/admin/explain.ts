// The sentence builder of SPEC 14.3: one plain sentence for each state, with the reason and the "has / needs" numbers from
// `parts` and `overview.rules`. Pure functions without DOM, so the unit tests read every sentence.

import { formatCount, formatPercent } from '../lib/format.ts';
import { gateTerm, type TermKey } from './glossary.ts';
import type { AccountFacts, Activity, Gate, Rules, StandingInfo, Want } from './model.ts';
import { isRow, num, obj, str, type Row } from './rows.ts';

/** A piece of a sentence: text, a glossary term, or a link to an account, an install or a list version. */
export type Seg = string | { t: 'term'; term: TermKey; text: string } | { t: 'handle'; handle: string } | { t: 'install'; id: string } | { t: 'version'; version: number };

export const term = (key: TermKey, text: string): Seg => ({ t: 'term', term: key, text });
const handle = (h: string): Seg => ({ t: 'handle', handle: h });
const install = (id: string): Seg => ({ t: 'install', id });

/** The plain text of a sentence: what a reader without links reads. */
export function plain(segs: Seg[]): string {
  return segs.map((s) => (typeof s === 'string' ? s : s.t === 'term' ? s.text : s.t === 'handle' ? `@${s.handle}` : s.t === 'install' ? s.id.slice(0, 8) : `version ${formatCount(s.version)}`)).join('');
}

/** "1 network", "3 networks". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "1 network says", "2 networks say". */
const says = (n: number): string => `${plural(n, 'network')} with standing ${n === 1 ? 'says' : 'say'}`;

const TIER_WORD: Record<Want, string> = { flagged: 'flagged', confirmed: 'confirmed' };

/** The tier that the named gate holds back: the `want` of the engine, else the tier above the status. */
export function gateTier(a: AccountFacts): Want | null {
  const { gate, want } = a.parts;
  if (!gate) return null;
  if (gate === 'review') return 'confirmed';
  return want ?? (a.status === 'flagged' ? 'confirmed' : 'flagged');
}

/** The reason of one gate, as the end of a sentence: "1 network with standing marked it, and confirmed needs 2." */
export function gateReason(gate: Gate, a: AccountFacts, rules: Rules | null): Seg[] {
  const tier: Want = gateTier(a) ?? 'flagged';
  const word = TIER_WORD[tier];
  const p = a.parts;
  const need = (flag: keyof Rules, confirm: keyof Rules): string => (rules ? `, and ${word} needs ${formatCount(rules[tier === 'confirmed' ? confirm : flag])}` : '');
  switch (gate) {
    case 'protected':
      if (a.protected) return ['you protected it, and only an admin decision changes the public state of a protected account.'];
      if (rules && a.followers !== null && a.followers >= rules.protectedMinFollowers) {
        return [`it has ${plural(a.followers, 'follower')}, and from ${formatCount(rules.protectedMinFollowers)} followers only an admin decision changes its public state.`];
      }
      return ['it is a large account, so only an admin decision changes its public state.'];
    case 'identity':
      if (a.identity === 'gone') return ['the X facts job did not find the handle on X in its last checks, so votes list nothing new on it.'];
      if (a.identity === 'moved') return ['the handle now belongs to another X account.'];
      return ['the X facts job has not matched the handle to an X account yet.'];
    case 'standing':
      return [`${plural(p.anchors, 'network')} with `, term('standing', 'standing'), ` marked it${need('anchorsFlag', 'anchorsConfirm')}.`];
    case 'evidence':
      if (a.partial) return [`the server checked posts of too few networks${need('evidenceFlag', 'evidenceConfirm')}.`];
      return [`the server checked posts of ${plural(p.evidence, 'network')}${need('evidenceFlag', 'evidenceConfirm')}.`];
    case 'brake': {
      const limit = rules ? ` (${formatCount(tier === 'confirmed' ? rules.maxAutoConfirmsPerDay : rules.maxAutoFlagsPerDay)} in 24 hours)` : '';
      return [`the daily limit of automatic ${tier === 'confirmed' ? 'confirms' : 'flags'}${limit} is used up. It goes on at a score run with a free place, or when you decide.`];
    }
    case 'dispute':
      if (p.notSlop > 0) {
        return [`${says(p.notSlop)} it is `, term('not-slop', 'not slop'), ', so the share test counts only voices with standing on both sides, and it fails.'];
      }
      return ['the one-camp check stopped it: only one camp of voters, who disagree on other accounts, marks it.'];
    case 'review':
      return [`you cleared it before, and ${plural(p.networks, 'slop network')} marked it again since${rules ? ` (review starts at ${formatCount(rules.clearedReturnMinNetworks)})` : ''}. A person decides.`];
  }
}

const gateName = (gate: Gate): Seg => term(gateTerm(gate), gate === 'brake' ? 'daily limit' : `${gate} gate`);

/** Dissent of installs without standing: shown, and said to count in no test. */
function dissentNote(dissent: number): Seg[] {
  return dissent > 0 ? [` ${plural(dissent, 'network')} without standing said not slop; that counts in no test (`, term('dissent', 'dissent'), ').'] : [];
}

/** The counts behind a listing by votes: "4 slop networks marked it, 2 of them with standing, and the server checked posts of 2 networks." */
function voteCounts(a: AccountFacts): Seg[] {
  const p = a.parts;
  return [
    `${plural(p.networks, 'slop network')} marked it, ${formatCount(p.anchors)} of them with standing (`,
    term('anchor', p.anchors === 1 ? 'anchor' : 'anchors'),
    a.partial ? ').' : `), and the server checked posts of ${plural(p.evidence, 'network')}.`,
    ...dissentNote(p.dissent),
  ];
}

/** The status sentence of SPEC 14.3. The first case that matches wins, in the order of the rules 0 to 6 of 13.3. */
export function statusSentence(a: AccountFacts, rules: Rules | null): Seg[] {
  const p = a.parts;
  if (a.identity === 'moved' || p.reason === 'moved') {
    return [
      'Not listed. The handle now belongs to another X account, so xslop never hides it. ',
      ...(a.movedTo ? ['Its state moved to ', handle(a.movedTo), '.'] : ['Its state stays on this row until the server finds the new handle of the account.']),
    ];
  }
  if (a.override === 'confirm') return ['Confirmed by ', term('override', 'your decision'), '. Only an admin decision changes it.'];
  if (a.override === 'clear') {
    return ['Cleared by ', term('override', 'your decision'), a.clearPenalty ? ', with a ' : ', without a ', term('penalty', 'penalty'), a.clearPenalty ? ' for its slop voters.' : '.', ' It stays off the list until you reset the decision.'];
  }
  if (p.gate === 'review') return ['Pending. The ', gateName('review'), ' holds it: ', ...gateReason('review', a, rules)];
  if (p.reason === 'cleared' || a.status === 'cleared') {
    return [
      'Cleared. You cleared it and then reset the decision, so only votes after the clear count. ',
      rules
        ? `It goes back to review when at least ${formatCount(rules.clearedReturnMinNetworks)} slop networks pass the test for confirmed. It has ${formatCount(p.networks)}.`
        : `It goes back to review only when many networks mark it again. It has ${plural(p.networks, 'slop network')}.`,
    ];
  }
  if (a.seed || p.reason === 'seed') {
    const out: Seg[] = ['Confirmed as a ', term('seed', 'starter account'), ': it is on the public X list "ai slop posters", so it is listed from the first day. Votes never remove it; only an accepted appeal or your clear does.'];
    if (p.disputed) out.push(` ${says(p.notSlop)} it is not slop, so it waits in the `, term('queue-disputed', 'Disputed queue'), '.');
    else if (a.partial && p.notSlop > 0) out.push(` ${says(p.notSlop)} it is not slop.`);
    return out;
  }
  const gate = p.gate;
  if (a.status === 'pending') {
    const want = p.want ?? gateTier(a) ?? 'flagged';
    return ['Pending. The votes pass the test for ', term(want, TIER_WORD[want]), ', but the ', ...(gate ? [gateName(gate), ' holds it: ', ...gateReason(gate, a, rules)] : ['a check holds it.'])];
  }
  if (a.status === 'confirmed') return ['Confirmed by votes. ', ...voteCounts(a)];
  if (a.status === 'flagged') {
    const out: Seg[] = ['Flagged by votes. ', ...voteCounts(a)];
    if (p.want === 'confirmed' && gate) out.push(' The votes also pass the test for confirmed, but the ', gateName(gate), ' holds it: ', ...gateReason(gate, a, rules));
    else if (p.needed > 0 && !a.partial) out.push(` Confirmed needs ${plural(p.needed, 'more slop network')}.`);
    return out;
  }
  // Rule 6: none.
  const out: Seg[] = [];
  if (p.networks === 0) out.push('Not listed. No slop vote counts for it.');
  else out.push(`Not listed. ${plural(p.networks, 'slop network')} marked it${p.needed > 0 ? `, and the test for flagged needs ${formatCount(p.needed)} more` : ''}.`);
  out.push(...dissentNote(p.dissent));
  return out;
}

/** A short reason for a table cell: "Standing gate holds it". */
export function shortReason(a: AccountFacts): string {
  const p = a.parts;
  if (a.identity === 'moved' || p.reason === 'moved') return 'Handle moved to another X account';
  if (a.override === 'confirm') return 'You confirmed it';
  if (a.override === 'clear') return a.clearPenalty ? 'You cleared it, with penalty' : 'You cleared it, without penalty';
  if (p.gate === 'review') return 'Cleared before, marked again';
  if (p.reason === 'cleared' || a.status === 'cleared') return 'Cleared before, then reset';
  if (a.seed || p.reason === 'seed') return p.disputed ? 'Starter account, disputed' : 'Starter account';
  const gate = p.gate ? `${p.gate === 'brake' ? 'Daily limit' : `${p.gate.charAt(0).toUpperCase()}${p.gate.slice(1)} gate`}` : '';
  if (a.status === 'pending') return gate ? `${gate} holds it` : 'A check holds it';
  if (a.status === 'confirmed') return 'Confirmed by votes';
  if (a.status === 'flagged') return gate ? `Flagged by votes; ${gate.toLowerCase()} holds confirmed` : 'Flagged by votes';
  if (p.networks === 0) return 'No counted slop votes';
  return p.needed > 0 ? `Needs ${plural(p.needed, 'more network')}` : 'Below the crowd test';
}

/** Whether an account holds its tier by votes, so the checks of that tier passed in the last score run. */
function reachedByVotes(a: AccountFacts, tier: Want): boolean {
  if (a.override || a.seed || a.identity === 'moved') return false;
  return a.status === 'confirmed' || (tier === 'flagged' && a.status === 'flagged');
}

export type Mark = 'met' | 'unmet' | 'open' | 'none';
export interface Need {
  need: string;
  mark: Mark;
}
export interface CheckRow {
  key: 'networks' | 'trust' | 'dispute' | 'protected' | 'identity' | 'anchors' | 'evidence' | 'brake';
  term: TermKey;
  label: string;
  has: string;
  flagged: Need;
  confirmed: Need;
  /** The row of `parts.gate`: the check that holds the account now. */
  holds: boolean;
}

const atLeast = (has: number, need: number): Mark => (has >= need - 1e-9 ? 'met' : 'unmet');

/** The gate checklist of the account page: each check with what the account has and what flagged and confirmed need. */
export function checklist(a: AccountFacts, rules: Rules): CheckRow[] {
  const p = a.parts;
  const held = gateTier(a);
  const byGate = (gate: Gate, tier: Want): Mark => (p.gate === gate && held === tier ? 'unmet' : reachedByVotes(a, tier) ? 'met' : 'open');
  const isProtected = a.protected || (a.followers !== null && a.followers >= rules.protectedMinFollowers);
  const identity = (tier: Want): Mark => (a.identity === 'ok' || (a.identity === 'gone' && reachedByVotes(a, tier)) ? 'met' : 'unmet');
  const both = (need: string, mark: (tier: Want) => Mark): Pick<CheckRow, 'flagged' | 'confirmed'> => ({ flagged: { need, mark: mark('flagged') }, confirmed: { need, mark: mark('confirmed') } });
  const rowsOut: CheckRow[] = [
    {
      key: 'networks',
      term: 'network',
      label: 'Slop networks',
      has: formatCount(p.networks),
      flagged: { need: formatCount(rules.flagMinNetworks), mark: atLeast(p.networks, rules.flagMinNetworks) },
      confirmed: { need: formatCount(rules.confirmMinNetworks), mark: atLeast(p.networks, rules.confirmMinNetworks) },
      holds: false,
    },
    {
      key: 'trust',
      term: 'trust',
      label: 'Trust of the slop networks',
      has: p.trust.toFixed(2),
      flagged: { need: 'no minimum', mark: 'none' },
      confirmed: { need: formatCount(rules.confirmMinTrust), mark: atLeast(p.trust, rules.confirmMinTrust) },
      holds: false,
    },
    {
      key: 'dispute',
      term: 'gate-dispute',
      label: 'No dispute',
      has: `${says(p.notSlop)} not slop`,
      ...both('no dispute', (tier) => byGate('dispute', tier)),
      holds: p.gate === 'dispute',
    },
    {
      key: 'protected',
      term: 'protected',
      label: 'Not protected',
      has: a.protected ? 'protected by you' : a.followers === null ? 'followers not known' : plural(a.followers, 'follower'),
      ...both(`under ${formatCount(rules.protectedMinFollowers)} followers`, () => (isProtected ? 'unmet' : 'met')),
      holds: p.gate === 'protected',
    },
    {
      key: 'identity',
      term: 'identity',
      label: 'Identity checked',
      has: a.identity,
      ...both('ok', identity),
      holds: p.gate === 'identity',
    },
    {
      key: 'anchors',
      term: 'anchor',
      label: 'Anchors (slop networks with standing)',
      has: formatCount(p.anchors),
      flagged: { need: formatCount(rules.anchorsFlag), mark: atLeast(p.anchors, rules.anchorsFlag) },
      confirmed: { need: formatCount(rules.anchorsConfirm), mark: atLeast(p.anchors, rules.anchorsConfirm) },
      holds: p.gate === 'standing',
    },
    {
      key: 'evidence',
      term: 'evidence',
      label: 'Networks with a checked post',
      has: formatCount(p.evidence),
      flagged: { need: formatCount(rules.evidenceFlag), mark: atLeast(p.evidence, rules.evidenceFlag) },
      confirmed: { need: formatCount(rules.evidenceConfirm), mark: atLeast(p.evidence, rules.evidenceConfirm) },
      holds: p.gate === 'evidence',
    },
    {
      key: 'brake',
      term: 'gate-brake',
      label: 'Daily limit not used up',
      has: p.gate === 'brake' ? 'used up' : 'no hold',
      flagged: { need: `${formatCount(rules.maxAutoFlagsPerDay)} flags a day`, mark: byGate('brake', 'flagged') },
      confirmed: { need: `${formatCount(rules.maxAutoConfirmsPerDay)} confirms a day`, mark: byGate('brake', 'confirmed') },
      holds: p.gate === 'brake',
    },
  ];
  return rowsOut;
}

/** Why the checklist does not decide this account now, or null when the votes decide it. */
export function checklistNote(a: AccountFacts): string | null {
  if (a.identity === 'moved') return 'The handle belongs to another X account now, so no check lists it. The table shows what the votes on this row have.';
  if (a.override) return 'Your decision decides this account, so these checks do not change it. They show what the votes alone have.';
  if (a.seed) return 'A starter account is confirmed whatever the votes say. The checks show what the votes alone have.';
  if (a.status === 'cleared' || a.parts.gate === 'review') return 'A cleared account never returns by these checks alone; at most it goes back to review.';
  return null;
}

/** What the account lacks for the next tier by votes, from the checklist: "2 more slop networks and 1 more anchor". */
export function nextStep(a: AccountFacts, rules: Rules): string | null {
  if (checklistNote(a) || a.status === 'confirmed') return null;
  const target: Want = a.status === 'flagged' ? 'confirmed' : (a.parts.want ?? 'flagged');
  const missing: string[] = [];
  for (const row of checklist(a, rules)) {
    const need = row[target];
    if (need.mark !== 'unmet') continue;
    const p = a.parts;
    if (row.key === 'networks') missing.push(plural((target === 'confirmed' ? rules.confirmMinNetworks : rules.flagMinNetworks) - p.networks, 'more slop network'));
    else if (row.key === 'trust') missing.push(`a total trust of ${formatCount(rules.confirmMinTrust)} (it has ${p.trust.toFixed(2)})`);
    else if (row.key === 'anchors') missing.push(plural((target === 'confirmed' ? rules.anchorsConfirm : rules.anchorsFlag) - p.anchors, 'more anchor'));
    else if (row.key === 'evidence') missing.push(`a checked post from ${plural((target === 'confirmed' ? rules.evidenceConfirm : rules.evidenceFlag) - p.evidence, 'more network')}`);
    else if (row.key === 'identity') missing.push(a.identity === 'gone' ? 'a new match of the handle on X' : 'an identity check by the X facts job');
    else if (row.key === 'protected') return `Only your decision can list it, because it is protected.`;
    else if (row.key === 'dispute') return 'It waits for you, because voices with standing disagree or one camp alone marks it.';
    else if (row.key === 'brake') return 'It waits only for a free place in the daily limit, or for your decision.';
  }
  return missing.length ? `For ${target} by votes it needs ${joinAnd(missing)}.` : null;
}

export interface StandingCheck {
  key: 'banned' | 'trusted' | 'age' | 'goodMarks' | 'reputation';
  term: TermKey;
  label: string;
  has: string;
  need: string;
  mark: Mark;
}

/** The standing checklist of the install page (14.3), against `standing.needs` of the answer. */
export function standingChecks(s: StandingInfo): StandingCheck[] {
  const out: StandingCheck[] = [
    { key: 'banned', term: 'ban', label: 'Not banned', has: s.banned ? 'banned' : 'not banned', need: 'not banned', mark: s.banned ? 'unmet' : 'met' },
    { key: 'trusted', term: 'trusted', label: 'Trusted by you', has: s.trusted ? 'yes' : 'no', need: 'gives standing alone', mark: s.trusted ? 'met' : 'none' },
  ];
  if (s.needs) {
    out.push(
      { key: 'age', term: 'standing', label: 'Age', has: plural(Math.floor(s.ageDays), 'day'), need: `${plural(s.needs.ageDays, 'day')}`, mark: atLeast(s.ageDays, s.needs.ageDays) },
      { key: 'goodMarks', term: 'good-mark', label: 'Good marks', has: formatCount(s.goodMarks), need: formatCount(s.needs.goodMarks), mark: atLeast(s.goodMarks, s.needs.goodMarks) },
      { key: 'reputation', term: 'reputation', label: 'Reputation', has: s.reputation.toFixed(2), need: s.needs.reputation.toFixed(2), mark: atLeast(s.reputation, s.needs.reputation) },
    );
  }
  return out;
}

/** The standing sentence of the install page. */
export function standingSentence(s: StandingInfo): Seg[] {
  if (s.banned) return ['No standing: you banned it, so its votes count nowhere.'];
  if (s.trusted) return s.has ? ['Has ', term('standing', 'standing'), ', because you trusted it.'] : ['You trusted it, so the next score run gives it ', term('standing', 'standing'), '.'];
  if (!s.needs) return s.has ? ['Has ', term('standing', 'standing'), '.'] : ['No ', term('standing', 'standing'), '.'];
  const n = s.needs;
  const missing: string[] = [];
  if (s.ageDays < n.ageDays) missing.push(plural(Math.ceil(n.ageDays - s.ageDays), 'more day'));
  if (s.goodMarks < n.goodMarks) missing.push(plural(n.goodMarks - s.goodMarks, 'more good mark'));
  if (s.reputation < n.reputation - 1e-9) missing.push(`a reputation of at least ${n.reputation.toFixed(2)} (it has ${s.reputation.toFixed(2)})`);
  const facts = `it is ${plural(Math.floor(s.ageDays), 'day')} old, has ${plural(s.goodMarks, 'good mark')} and a reputation of ${s.reputation.toFixed(2)}`;
  if (s.has && missing.length === 0) return ['Has ', term('standing', 'standing'), `: ${facts}.`];
  if (s.has) return ['Has ', term('standing', 'standing'), ` now, but the next score run takes it away. It needs ${joinAnd(missing)}.`];
  if (missing.length === 0) return ['No ', term('standing', 'standing'), ` yet. Every check passes (${facts}), so the next score run gives it standing.`];
  return ['No ', term('standing', 'standing'), `. It needs ${joinAnd(missing)}.`];
}

// Activity (14.2, 14.3): one plain sentence for each item.

const JOB_NAME: Record<string, string> = { score: 'The score job', profiles: 'The X facts job' };

function statusWord(v: Row): string {
  const status = str(v, 'status') || 'none';
  const gate = str(v, 'gate');
  return gate && status === 'pending' ? `pending (${gate === 'brake' ? 'daily limit' : `${gate} gate`})` : status === 'none' ? 'not listed' : status;
}

const short = (id: string): string => id.slice(0, 8);
const isUuidLike = (v: string | null): v is string => v !== null && /^[0-9a-f-]{36}$/i.test(v);
const isHandleLike = (v: string | null): v is string => v !== null && /^[a-z0-9_]{1,15}$/.test(v);

function subjectSeg(subject: string | null): Seg {
  if (isHandleLike(subject)) return handle(subject);
  if (isUuidLike(subject)) return install(subject);
  return subject ?? 'an unknown target';
}

/** The sentence of an admin item, from the action and the answer of the change (`after`). */
function adminSentence(item: Activity): Seg[] {
  const d = item.data;
  const action = str(d, 'action');
  const after = obj(d.after);
  const target = subjectSeg(item.subject);
  const version = num(obj(after.list), 'version');
  const listed: Seg[] = version === null ? [] : [' The list went to ', { t: 'version', version }, '.'];
  switch (action) {
    case 'login':
      return [`You logged in (session ${str(d, 'session') || 'unknown'}).`];
    case 'logout':
      return [`You logged out (session ${str(d, 'session') || 'unknown'}).`];
    case 'confirm':
      return ['You confirmed ', target, '.', ...listed];
    case 'clear': {
      const penalty = obj(after.account).clearPenalty;
      return ['You cleared ', target, penalty === false ? ' without a penalty.' : penalty === true ? ' with a penalty.' : '.', ...listed];
    }
    case 'reset':
      return ['You removed your decision on ', target, '. The next score run decides it.'];
    case 'protect':
      return ['You protected ', target, '.'];
    case 'unprotect':
      return ['You removed the protection of ', target, '.'];
    case 'ban-voters': {
      const banned = num(after, 'banned');
      return [`You banned ${banned === null ? 'the installs' : plural(banned, 'install')} that marked `, target, '.'];
    }
    case 'trust':
      return ['You trusted install ', target, '.'];
    case 'untrust':
      return ['You removed the trust of install ', target, '.'];
    case 'ban':
      return ['You banned install ', target, '.'];
    case 'unban':
      return ['You unbanned install ', target, '.'];
    case 'accept':
    case 'reject': {
      const h = str(after, 'handle');
      const who: Seg[] = isHandleLike(h) ? [' for ', handle(h)] : [];
      return [`You ${action === 'accept' ? 'accepted' : 'rejected'} the appeal`, ...who, '.', ...listed];
    }
    default:
      return [`You ran ${action || 'an action'} on `, target, '.'];
  }
}

/** One sentence for an activity item, with links for its subject. */
export function activitySentence(item: Activity): Seg[] {
  const d = item.data;
  const subject = subjectSeg(item.subject);
  switch (item.kind) {
    case 'admin':
      return adminSentence(item);
    case 'status': {
      const from = obj(d.from);
      const to = obj(d.to);
      if ((str(from, 'status') || 'none') === (str(to, 'status') || 'none')) {
        return ['The score job kept ', subject, ` at ${statusWord(to)}${str(from, 'gate') ? `; before, the ${str(from, 'gate')} gate held it` : ''}.`];
      }
      return ['The score job moved ', subject, ` from ${statusWord(from)} to ${statusWord(to)}.`];
    }
    case 'identity': {
      const to = str(d, 'to');
      const tookFrom = str(d, 'tookFrom');
      if (isHandleLike(tookFrom)) return ['The X facts job found a rename: ', subject, ' took the state of ', handle(tookFrom), '.'];
      if (to === 'ok') return ['The X facts job matched ', subject, ` to X id ${str(d, 'xUserId') || 'unknown'}.`];
      if (to === 'gone') return ['The X facts job did not find ', subject, ' on X in its last checks.'];
      if (to === 'moved') {
        const movedTo = str(d, 'movedTo');
        return ['The X facts job found that ', subject, ' belongs to another X account now', ...(isHandleLike(movedTo) ? ['; its state moved to ', handle(movedTo)] : []), '.'];
      }
      return ['The identity of ', subject, ` changed from ${str(d, 'from') || 'unknown'} to ${to || 'unknown'}.`];
    }
    case 'standing':
      if (d.standing === true) return ['Install ', subject, ' gained standing.'];
      return ['Install ', subject, d.banned === true ? ' lost standing, because it is banned.' : ' lost standing.'];
    case 'list': {
      const version = num(d, 'version') ?? Number(item.subject);
      const added = num(d, 'addedCount') ?? 0;
      const removed = num(d, 'removedCount') ?? 0;
      const total = num(d, 'count');
      const v: Seg = Number.isFinite(version) ? { t: 'version', version } : 'a new version';
      return ['The list went to ', v, `: ${formatCount(added)} joined or changed, ${formatCount(removed)} left${total === null ? '' : `, ${plural(total, 'account')} in total`}.`];
    }
    case 'appeal':
      return ['An appeal for ', subject, ' arrived.'];
    case 'run': {
      const job = JOB_NAME[str(d, 'job')] ?? 'A job';
      const ms = num(d, 'ms');
      return [`${job} failed${ms === null ? '' : ` after ${seconds(ms)}`}: ${str(d, 'error') || 'no error text'}.`];
    }
    case 'vote': {
      const who = isUuidLike(str(d, 'install')) ? install(str(d, 'install')) : 'An install';
      const value = num(d, 'value');
      const first = d.first !== false;
      const what = value === 1 ? (first ? ' marked ' : ' changed its vote to slop on ') : first ? ' said not slop on ' : ' changed its vote to not slop on ';
      return [...(typeof who === 'string' ? [who] : ['Install ', who]), what, subject, value === 1 && first ? ' as slop.' : '.'];
    }
    case 'install': {
      const version = str(d, 'extVersion');
      return ['A new install ', subject, ` joined from network ${str(d, 'network') || 'unknown'}${version ? `, version ${version}` : ''}.`];
    }
  }
}

/** A second line with the numbers of a status item: what the score job saw. */
export function activityDetail(item: Activity): string | null {
  if (item.kind !== 'status') return null;
  const to = obj(item.data.to);
  const n = (k: string): number => num(to, k) ?? 0;
  return `${plural(n('networks'), 'slop network')}, ${plural(n('anchors'), 'anchor')}, evidence of ${plural(n('evidence'), 'network')}, ${formatCount(n('notSlop'))} not slop with standing, score ${formatCount(n('score'))}.`;
}

export function seconds(ms: number): string {
  return ms < 1000 ? `${formatCount(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Admin changes: the state before and after as a list of changed fields (14.3), never raw JSON by default.

export interface Change {
  field: string;
  before: string;
  after: string;
}

const NOISE = new Set(['updatedAt', 'decidedAt']);

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isRow(value)) {
    for (const [k, v] of Object.entries(value)) if (!NOISE.has(k)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, value);
  }
}

/** "account.clearPenalty" → "Account clear penalty". */
export function humanize(path: string): string {
  const words = path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function showValue(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return formatCount(v);
  if (Array.isArray(v)) return plural(v.length, 'item');
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  return 'object';
}

/** The fields whose value differs between the state before and after an admin change. */
export function changedFields(before: unknown, after: unknown): Change[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(before, '', a);
  flatten(after, '', b);
  const out: Change[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = showValue(a.get(key));
    const y = showValue(b.get(key));
    if (x !== y) out.push({ field: humanize(key), before: x, after: y });
  }
  return out;
}

/** "4 networks marked it. An accept with penalty strikes 3." */
export function marksSentence(marks: Row): string {
  const networks = num(marks, 'networks') ?? 0;
  const strikes = num(marks, 'strikes') ?? 0;
  return `${plural(networks, 'network')} marked it. An accept with penalty strikes ${formatCount(strikes)}.`;
}

/** "90% within a minute, of 12 checked replies" or a plain "No checked replies". */
export function timingText(sightings: number, fastReplyShare: number): string {
  return sightings === 0 ? 'No checked replies' : `${formatPercent(fastReplyShare)} within a minute, of ${plural(sightings, 'checked reply', 'checked replies')}`;
}

