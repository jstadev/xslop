// #home (SPEC 14.3): job health, the list, the queues with their next step, the last 24 hours, installs, newest activity.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { plural } from '../explain.ts';
import { feed } from '../feed.ts';
import type { TermKey } from '../glossary.ts';
import { readActivity } from '../model.ts';
import { num, obj, str, type Row } from '../rows.ts';
import { api, overview } from '../session.ts';
import { block, termLink, time } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

const MINUTE = 60_000;

/**
 * One health line: "The score job ran 3 minutes ago and succeeded." Red when the last run failed or the last success is old.
 * `runUnit` names what runs24h counts: an X facts run that picks no account writes no job_runs row (SPEC 14.1).
 */
export function healthLine(name: string, term: TermKey, job: Row, staleMinutes: number, now = Date.now(), runUnit: [string, string] = ['run', 'runs']): HTMLElement {
  const runAt = str(job, 'lastRunAt');
  const okAt = str(job, 'lastOkAt');
  const runs = num(job, 'runs24h');
  const failed = num(job, 'failed24h');
  const line = h('p', { class: 'health' });
  let bad = false;
  const label = termLink(term, name);
  if (!runAt || Number.isNaN(Date.parse(runAt))) {
    bad = true;
    line.append('The ', label, ' has not run yet.');
  } else {
    const lastFailed = !okAt || Date.parse(okAt) < Date.parse(runAt);
    const stale = !okAt || now - Date.parse(okAt) > staleMinutes * MINUTE;
    bad = lastFailed || stale;
    line.append('The ', label, ' ran ', time(runAt), lastFailed ? ' and failed.' : ' and succeeded.');
    if (lastFailed) line.append(' The last success was ', okAt ? time(okAt) : 'never', '.');
    else if (stale) line.append(` That is more than ${staleMinutes} minutes ago.`);
  }
  if (runs !== null) line.append(` ${plural(runs, runUnit[0], runUnit[1])} in 24 hours, ${formatCount(failed ?? 0)} failed.`);
  line.dataset.health = bad ? 'bad' : 'ok';
  return line;
}

interface Tile {
  label: string | Node;
  value: number | null;
  href?: string;
  sub?: string;
}

function tiles(items: Tile[]): HTMLElement {
  return h(
    'ul',
    { class: 'tiles' },
    ...items.map((t) => {
      const shown = t.value === null ? 'not known' : formatCount(t.value);
      const label = h('span', { class: 'tile-label' }, t.label);
      const sub = t.sub ? h('span', { class: 'tile-sub' }, t.sub) : null;
      if (t.href && typeof t.label === 'string') return h('li', { class: 'tile' }, h('a', { href: t.href, class: 'tile-link' }, h('span', { class: 'tile-value' }, shown), label, sub));
      // A label with a glossary link cannot sit inside another link: the number is the link, the label stays a term.
      const value = t.href ? h('a', { href: t.href, class: 'tile-link tile-value', 'aria-label': `${shown} ${label.textContent ?? ''}` }, shown) : h('span', { class: 'tile-value' }, shown);
      return h('li', { class: 'tile' }, h('div', null, value, label, sub));
    }),
  );
}

const QUEUE_CARDS: { key: 'pending' | 'disputed' | 'auto' | 'appeals'; title: string; href: string; next: string; term: TermKey }[] = [
  { key: 'pending', title: 'Pending', href: '#review/pending', term: 'queue-pending', next: 'The votes pass and a gate holds each one. Read the reason, then confirm or clear.' },
  { key: 'disputed', title: 'Disputed', href: '#review/disputed', term: 'queue-disputed', next: 'Voters with standing disagree. Keep each one listed, or clear it.' },
  { key: 'auto', title: 'Automatic', href: '#review/auto', term: 'queue-auto', next: 'The votes listed these without you. Confirm the right ones to make them trusted decisions.' },
  { key: 'appeals', title: 'Open appeals', href: '#appeals/open', term: 'appeal', next: 'Owners ask to leave the list. Check the bio code, then accept or reject.' },
];

export async function home(_route: unknown, ctx: Ctx): Promise<Node[]> {
  const [ov, act] = await Promise.all([overview(ctx.signal), api('/api/admin/activity?limit=15', { signal: ctx.signal })]);
  const score = obj(ov.score);
  const factsJob = obj(ov.facts);
  const list = obj(ov.list);
  const queues = obj(ov.queues);
  const day = obj(ov.last24h);
  const accounts = obj(ov.accounts);
  const listVersion = num(list, 'version') ?? num(ov, 'listVersion');

  const listLine = h('p', { class: 'health', 'data-health': listVersion === null ? 'bad' : 'ok' });
  if (listVersion === null) listLine.append('The server has published no list yet.');
  else {
    const count = num(list, 'count');
    listLine.append('The ', termLink('list-version', 'list'), ' is at ', h('a', { href: '#lists' }, `version ${formatCount(listVersion)}`), count === null ? '' : ` with ${plural(count, 'account')}`);
    const at = str(list, 'generatedAt');
    listLine.append(at ? ', published ' : '', at ? time(at) : '', '.');
  }
  const moved = num(factsJob, 'moved24h');

  const queueCount = (key: string): number | null => (key === 'appeals' ? num(ov, 'appealsOpen') : num(queues, key));
  const cards = h(
    'ul',
    { class: 'queues' },
    ...QUEUE_CARDS.map((q) => {
      const count = queueCount(q.key);
      return h(
        'li',
        { class: 'queue', 'data-empty': count === 0 ? 'true' : null },
        h('a', { href: q.href, class: 'queue-link' }, h('span', { class: 'queue-count' }, count === null ? '?' : formatCount(count)), h('span', { class: 'queue-title' }, q.title)),
        h('p', { class: 'queue-next' }, count === 0 ? 'Nothing waits here.' : q.next),
        termLink(q.term, 'What is this?'),
      );
    }),
  );

  const n = (k: string): number | null => num(day, k);
  const votes = n('votes');
  const items = readActivity(obj(act).items);

  return [
    head('Home', 'The state of the whole system, and what waits for you.'),
    block(
      'Health',
      healthLine('score job', 'score-job', score, 15),
      healthLine('X facts job', 'facts-job', factsJob, 10, Date.now(), ['run with work', 'runs with work']),
      listLine,
      moved === null || moved === 0 ? null : h('p', { class: 'health', 'data-health': 'ok' }, `${plural(moved, 'handle')} moved to another X account in 24 hours, so ${moved === 1 ? 'it' : 'they'} left the list.`),
    ),
    block('Waiting for you', cards),
    block(
      'Last 24 hours',
      tiles([
        { label: 'votes', value: votes, href: '#activity?kinds=vote', sub: votes === null ? '' : `${formatCount(n('slopVotes') ?? 0)} slop, ${formatCount(n('notSlopVotes') ?? 0)} not slop` },
        { label: 'new installs', value: n('newInstalls'), href: '#activity?kinds=install' },
        { label: 'status changes', value: n('statusChanges'), href: '#activity?kinds=status' },
        { label: 'identity changes', value: n('identityChanges'), href: '#activity?kinds=identity' },
        { label: 'standing changes', value: n('standingChanges'), href: '#activity?kinds=standing' },
        { label: 'list versions', value: n('listVersions'), href: '#lists' },
        { label: 'appeals', value: n('appeals'), href: '#activity?kinds=appeal' },
        { label: 'your actions', value: n('adminActions'), href: '#activity?kinds=admin' },
      ]),
    ),
    block(
      'Accounts',
      tiles([
        { label: termLink('confirmed', 'confirmed'), value: num(accounts, 'confirmed'), href: '#accounts' },
        { label: termLink('flagged', 'flagged'), value: num(accounts, 'flagged'), href: '#accounts' },
        { label: termLink('pending', 'pending'), value: num(accounts, 'pending'), href: '#review/pending' },
        { label: termLink('cleared', 'cleared'), value: num(accounts, 'cleared'), href: '#accounts' },
        { label: termLink('seed', 'starter accounts'), value: num(accounts, 'seed') },
      ]),
    ),
    block(
      'Installs',
      tiles([
        { label: termLink('install', 'installs'), value: num(ov, 'installs'), href: '#installs' },
        { label: termLink('standing', 'with standing'), value: num(ov, 'standingInstalls'), href: '#installs' },
        { label: termLink('trusted', 'trusted by you'), value: num(ov, 'trustedInstalls'), href: '#installs' },
        { label: termLink('ban', 'banned'), value: num(ov, 'bannedInstalls'), href: '#installs' },
      ]),
    ),
    block('Newest activity', feed(items, 'Nothing happened yet: no job run, vote, list version or decision is recorded.'), h('p', { class: 'more' }, h('a', { href: '#activity' }, 'All activity'))),
  ];
}
