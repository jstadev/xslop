// #install/<id> (SPEC 14.2, 14.3): network, age, version, standing as a checklist, trust and ban, its votes, its network
// and its timeline.

import { ApiError } from '../../lib/api.ts';
import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { installActions } from '../actions.ts';
import { plural, standingChecks, standingSentence } from '../explain.ts';
import { feed } from '../feed.ts';
import { readActivity, readStanding } from '../model.ts';
import { isRow, num, obj, rows, str, type Row } from '../rows.ts';
import { api } from '../session.ts';
import { accountLink, block, facts, mark, note, pill, postLink, sentence, table, termLink, time } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

export async function install(route: { id: string }, ctx: Ctx): Promise<Node[]> {
  const { id } = route;
  const short = id.slice(0, 8);
  let body: unknown;
  try {
    body = await api(`/api/admin/installs/${id}`, { signal: ctx.signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return [head(`Install ${short}`, 'No install with this id.'), note('The server has no install with this id. Installs without votes and activity leave after 90 days.'), h('p', null, h('a', { href: '#installs' }, 'Back to the installs'))];
    }
    throw err;
  }
  const d = isRow(body) ? body : {};
  const row = obj(d.install);
  const standing = readStanding(d.standing);
  const votes = obj(d.votes);
  const net = isRow(d.network) ? d.network : {};
  const network = str(row, 'network') || str(net, 'network');
  const strikes = rows(net.strikes);
  const banned = Boolean(str(row, 'bannedAt')) || standing.banned;

  return [
    head(`Install ${short}`, h('span', { class: 'mono' }, id), h('a', { href: '#installs', class: 'btn btn-quiet btn-small' }, 'All installs')),
    h('div', { class: 'verdict', 'data-status': standing.has ? 'confirmed' : 'none' }, sentence(standingSentence(standing), 'verdict-text')),
    block(
      'Standing',
      table(
        'Standing checks',
        [
          { label: 'Check', cell: (c) => h('span', { class: 'check-name' }, h('a', { class: 'term', href: `#help/${c.term}`, 'data-term': c.term }, c.label)) },
          { label: 'This install has', cell: (c) => c.has },
          { label: 'Standing needs', cell: (c) => mark(c.mark, c.need) },
        ],
        standingChecks(standing),
        'No checks.',
        'standing-table',
      ),
      note('A trusted install has standing while it is not banned. Otherwise it needs every line below the first two. A penalty sets its good marks back.', 'small'),
    ),
    block('Decide', installActions(id, standing.trusted || row.trusted === true, banned, ctx.afterWrite, true)),
    block(
      'About the install',
      facts([
        [termLink('network', 'Network'), h('code', null, network || 'not known')],
        ['Created', time(str(row, 'createdAt'))],
        ['Age', plural(Math.floor(standing.ageDays), 'day')],
        ['Last seen', time(str(row, 'lastSeenAt'))],
        ['Extension version', str(row, 'extVersion') || 'not known'],
        [termLink('reputation', 'Reputation'), (num(row, 'reputation') ?? standing.reputation).toFixed(2)],
        [termLink('good-mark', 'Good marks'), formatCount(num(row, 'goodMarks') ?? standing.goodMarks)],
        [termLink('ban', 'Banned'), str(row, 'bannedAt') ? time(str(row, 'bannedAt')) : 'no'],
      ]),
    ),
    block(
      'Votes',
      note(`${plural(num(votes, 'total') ?? 0, 'vote')} in total. The table shows the newest ${formatCount(rows(votes.items).length)}.`),
      table(
        'Votes of this install',
        [
          { label: 'Account', cell: (v: Row) => accountLink(str(v, 'handle')) },
          { label: 'Vote', cell: (v) => (num(v, 'value') === 1 ? 'slop' : 'not slop') },
          { label: 'Voted', cell: (v) => time(str(v, 'votedAt')) },
          { label: 'Changed', cell: (v) => (str(v, 'changedAt') && str(v, 'changedAt') !== str(v, 'votedAt') ? time(str(v, 'changedAt')) : 'never') },
          { label: 'Post', cell: (v) => (str(v, 'tweetId') ? postLink(str(v, 'tweetId'), 'Open post') : 'none') },
          { label: 'Account now', cell: (v) => pill(str(v, 'accountStatus') || 'none') },
        ],
        rows(votes.items),
        'This install has not voted.',
      ),
    ),
    block(
      'Its network',
      note(`Network ${network || 'not known'} has ${plural(num(net, 'installs') ?? 0, 'install')}, ${formatCount(num(net, 'banned') ?? 0)} of them banned. Installs on one network are one voice.`),
      table(
        'Strikes of this network',
        [
          { label: 'Account', cell: (s: Row) => accountLink(str(s, 'handle')) },
          { label: 'Cleared', cell: (s) => time(str(s, 'clearedAt')) },
          { label: 'With standing', term: 'strike', cell: (s) => (s.standing === true ? 'yes' : 'no') },
        ],
        strikes,
        'No strikes. No account that this network marked was cleared with penalty.',
      ),
    ),
    block('Timeline', feed(readActivity(d.timeline), 'Nothing recorded for this install yet: no standing change and no decision of yours.'), h('p', { class: 'more' }, h('a', { href: `#activity?kinds=admin,standing,vote&subject=${id}` }, 'All activity of this install'))),
  ];
}
