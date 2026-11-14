// #installs (SPEC 13.8, 14.2): every install with its standing, trust, reputation and votes. Each row opens its page.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { installActions } from '../actions.ts';
import { plural } from '../explain.ts';
import { listFrom, num, str, type Row } from '../rows.ts';
import { api } from '../session.ts';
import { installLink, note, table, time } from '../ui.ts';
import { head, limitOf, limitSelect, type Ctx } from '../view.ts';

const SORTS = { reputation: 'Lowest reputation', created: 'Newest', votes: 'Most votes' } as const;
type Sort = keyof typeof SORTS;
const filter: { sort: Sort; limit: string } = { sort: 'reputation', limit: '100' };

export async function installs(_route: unknown, ctx: Ctx): Promise<Node[]> {
  const items = listFrom(await api(`/api/admin/installs?sort=${filter.sort}&limit=${filter.limit}`, { signal: ctx.signal }), 'installs');
  const sortSelect = h('select', { id: 'installs-sort', name: 'sort', 'data-filter': '' }, ...Object.entries(SORTS).map(([v, label]) => h('option', { value: v, selected: v === filter.sort }, label)));
  const form = h('form', { class: 'filters', id: 'installs-filter' }, h('label', { for: 'installs-sort' }, 'Sort'), sortSelect, ...limitSelect('installs-limit', filter.limit), h('button', { type: 'submit', class: 'btn btn-quiet btn-small' }, 'Show'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    filter.sort = sortSelect.value in SORTS ? (sortSelect.value as Sort) : 'reputation';
    filter.limit = limitOf(form, 'installs-limit');
    ctx.reload();
  });
  const yes = (r: Row, k: string): string => (r[k] === true ? 'yes' : 'no');
  return [
    head('Installs', 'Every copy of the extension that voted or registered. Open one to see its standing and votes.', form),
    note(`${SORTS[filter.sort]} first. The table shows ${plural(items.length, 'install')}. Installs on one network share one voice.`),
    table(
      'Installs',
      [
        { label: 'Install', term: 'install', className: 'nowrap', cell: (r: Row) => installLink(str(r, 'id')) },
        { label: 'Network', term: 'network', className: 'nowrap', cell: (r) => h('code', null, str(r, 'network') || 'not known') },
        { label: 'Created', cell: (r) => time(str(r, 'createdAt')) },
        { label: 'Last seen', cell: (r) => time(str(r, 'lastSeenAt')) },
        { label: 'Standing', term: 'standing', cell: (r) => yes(r, 'standing') },
        { label: 'Trusted', term: 'trusted', cell: (r) => yes(r, 'trusted') },
        { label: 'Reputation', term: 'reputation', className: 'num', cell: (r) => (num(r, 'reputation') ?? 0).toFixed(2) },
        { label: 'Good marks', term: 'good-mark', className: 'num', cell: (r) => formatCount(num(r, 'goodMarks') ?? 0) },
        { label: 'Slop votes', className: 'num', cell: (r) => formatCount(num(r, 'slopVotes') ?? 0) },
        { label: 'Not slop votes', className: 'num', cell: (r) => formatCount(num(r, 'notSlopVotes') ?? 0) },
        { label: 'Version', cell: (r) => str(r, 'extVersion') || 'not known' },
        { label: 'Banned', term: 'ban', cell: (r) => time(str(r, 'bannedAt'), 'no') },
        { label: 'Actions', className: 'acts', cell: (r) => installActions(str(r, 'id'), r.trusted === true, Boolean(str(r, 'bannedAt')), ctx.afterWrite) },
      ],
      items,
      'No installs yet. An install appears when an extension registers.',
      'installs-table',
    ),
  ];
}
