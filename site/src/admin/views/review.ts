// #review/pending|disputed|auto (SPEC 13.8, 14.3): each queue with its note, the reason of each account in words, and the
// decisions of before.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { accountActions } from '../actions.ts';
import { plural, statusSentence, timingText } from '../explain.ts';
import type { TermKey } from '../glossary.ts';
import { readAccount } from '../model.ts';
import type { Queue } from '../route.ts';
import { isRow, listFrom, num, obj, rows, str, type Row } from '../rows.ts';
import { api, overview, session } from '../session.ts';
import { accountLink, note, pill, postLink, sentence, table, termLink, time } from '../ui.ts';
import { head, limitOf, limitSelect, tabs, type Ctx } from '../view.ts';

const QUEUE_NOTE: Record<Queue, string> = {
  pending: 'Accounts that pass the crowd test of the votes while a gate holds them back. Confirm lists one now; clear takes it off for good. Either way your decision wins over the votes until you reset it.',
  disputed: 'Starter accounts that networks with standing call not slop, and listed accounts with much dissent. Keep each one, or clear it.',
  auto: 'Accounts that the votes confirmed in the last 7 days, without a person. Your confirm makes each one a trusted decision and gives good marks to its first voters.',
};

const QUEUE_NAME: Record<Queue, string> = { pending: 'Pending', disputed: 'Disputed', auto: 'Automatic' };

let rowLimit = '100';

/** Handle (to the account page), name, followers, and the status with the tier that the votes support. */
function who(r: Row): Node {
  const name = str(r, 'name');
  const followers = num(r, 'followers');
  const want = str(r, 'want');
  return h(
    'div',
    { class: 'who' },
    accountLink(str(r, 'handle')),
    name ? h('bdi', { class: 'who-name' }, name.slice(0, 100)) : null,
    h('span', { class: 'who-sub' }, followers === null ? 'followers not known' : plural(followers, 'follower')),
    h('div', { class: 'who-status' }, pill(str(r, 'status')), want ? h('p', { class: 'who-sub' }, 'votes support ', termLink('want', want)) : null),
  );
}

/** The vote numbers of a queue item, each label with its definition. */
function votes(r: Row): Node {
  const posts = rows(r.evidence).map((e, i) => postLink(str(e, 'tweetId'), `post ${i + 1}`)).filter((l): l is HTMLAnchorElement => typeof l !== 'string');
  const line = (key: TermKey, label: string, value: Node | string) => h('div', { 'data-key': key }, h('dt', null, termLink(key, label)), h('dd', null, value));
  const n = (k: string) => formatCount(num(r, k) ?? 0);
  return h(
    'dl',
    { class: 'mini' },
    line('network', 'Slop networks', n('networks')),
    line('anchor', 'Anchors', n('anchors')),
    line('not-slop', 'Not slop, standing', n('notSlop')),
    line('dissent', 'Dissent', n('dissent')),
    line('evidence', 'Checked posts', posts.length ? h('span', { class: 'links' }, ...posts) : 'none yet'),
  );
}

export async function review(route: { queue: Queue }, ctx: Ctx): Promise<Node[]> {
  const { queue } = route;
  const [ov, body] = await Promise.all([overview(ctx.signal), api(`/api/admin/review?queue=${queue}&limit=${rowLimit}`, { signal: ctx.signal })]);
  const items = listFrom(body, 'items');
  const total = isRow(body) ? num(body, 'total') : null;
  const queues = obj(ov.queues);
  const rules = session.rules;

  const form = h('form', { class: 'filters', id: 'review-filter' }, ...limitSelect('review-limit', rowLimit), h('button', { type: 'submit', class: 'btn btn-quiet btn-small' }, 'Show'));
  form.querySelector('select')?.setAttribute('data-filter', '');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    rowLimit = limitOf(form, 'review-limit');
    ctx.reload();
  });

  const shown = total === null ? '' : ` The table shows ${formatCount(items.length)} of ${plural(total, 'account')} in this queue.`;
  return [
    head('Review', 'Accounts that wait for a person. Each row says why it waits.', form),
    tabs(
      'Review queues',
      (['pending', 'disputed', 'auto'] as const).map((q) => ({ href: `#review/${q}`, text: QUEUE_NAME[q], count: num(queues, q), current: q === queue })),
    ),
    note(h('span', { id: 'review-note' }, `${QUEUE_NOTE[queue]}${shown}`)),
    table(
      `${QUEUE_NAME[queue]} queue`,
      [
        { label: 'Account', cell: who },
        { label: 'Why', term: 'gate', className: 'wide', cell: (r) => sentence(statusSentence(readAccount(r), rules)) },
        { label: 'Votes', term: 'network', cell: votes },
        {
          label: 'Timing',
          term: 'behaviour',
          className: 'wrap',
          cell: (r) =>
            h('div', { class: 'stack' }, h('span', null, timingText(num(r, 'sightings') ?? 0, num(r, 'fastReplyShare') ?? 0)), h('p', { class: 'who-sub' }, 'first vote ', time(str(r, 'firstVoteAt'), 'none')), h('p', { class: 'who-sub' }, 'last vote ', time(str(r, 'lastVoteAt'), 'none'))),
        },
        {
          label: 'Decision',
          className: 'acts',
          cell: (r) => {
            const a = readAccount(r);
            return accountActions({ handle: a.handle, override: a.override, seed: a.seed, protected: a.protected, status: a.status, banNetworks: num(r, 'banNetworks') }, ctx.afterWrite, { review: true, explain: false });
          },
        },
      ],
      items,
      queue === 'pending' ? 'No accounts in the pending queue. Every account that the votes pass also meets its gates, or none passes yet.' : queue === 'disputed' ? 'No accounts in the disputed queue. No voice with standing disputes a listed account.' : 'No accounts in the automatic queue. The votes confirmed no account by themselves in the last 7 days.',
      'review-table',
    ),
    h('p', { class: 'more' }, termLink('gate', 'How the gates work')),
  ];
}
