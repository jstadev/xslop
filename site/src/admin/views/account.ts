// #account/<handle> (SPEC 14.2, 14.3): who the account is, its status in one sentence, the gate checklist with has and
// needs, the list, the decisions, the networks that voted, checked posts, reply timing, votes kept at a clear, appeals, timeline.

import { ApiError } from '../../lib/api.ts';
import { h } from '../../lib/dom.ts';
import { formatCount, formatPercent } from '../../lib/format.ts';
import { accountActions } from '../actions.ts';
import { checklist, checklistNote, nextStep, plural, statusSentence, timingText, shortReason } from '../explain.ts';
import { feed } from '../feed.ts';
import { readAccount, readActivity } from '../model.ts';
import { isRow, num, obj, rows, str, strOrNull, type Row } from '../rows.ts';
import { api, overview, session } from '../session.ts';
import { block, facts, installLink, mark, note, pill, postLink, sentence, table, termLink, time, xProfile } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

function identityText(identity: string): string {
  switch (identity) {
    case 'ok':
      return 'ok: the handle and its X id match';
    case 'gone':
      return 'gone: not found in the last checks';
    case 'moved':
      return 'moved: the handle has another X id now';
    default:
      return 'unknown: not checked yet';
  }
}

function checks(a: ReturnType<typeof readAccount>): Node[] {
  const rules = session.rules;
  if (!rules) return [note('The server sent no rule numbers, so the console cannot show what each check needs.')];
  const rowsOut = checklist(a, rules);
  const why = checklistNote(a);
  const next = nextStep(a, rules);
  return [
    why ? note(why) : null,
    table(
      'Checks of the votes',
      [
        { label: 'Check', cell: (r) => h('span', { class: 'check-name' }, h('a', { class: 'term', href: `#help/${r.term}`, 'data-term': r.term }, r.label), r.holds ? h('span', { class: 'holds' }, 'holds it now') : null) },
        { label: 'This account has', cell: (r) => r.has },
        { label: 'Flagged needs', cell: (r) => mark(r.flagged.mark, r.flagged.need) },
        { label: 'Confirmed needs', cell: (r) => mark(r.confirmed.mark, r.confirmed.need) },
      ],
      rowsOut,
      'No checks.',
      'checks-table',
    ),
    next ? h('p', { class: 'next-step' }, next) : null,
    note('✓ met, ✗ not met, ? not tested yet: the score job tests the daily limit and the dispute only when the other checks pass.', 'small'),
  ].filter((n): n is HTMLElement => n !== null);
}

function networks(votes: Row): Node[] {
  const list = rows(votes.networks);
  const out: Node[] = [];
  const truncated = votes.truncated === true;
  out.push(
    note(
      `${plural(num(votes, 'slop') ?? 0, 'slop vote')} and ${plural(num(votes, 'notSlop') ?? 0, 'not slop vote')} from ${plural(list.length, 'network')}.${truncated ? ' The server read the first 500 votes only.' : ''}`,
    ),
  );
  const VOICE: Record<string, string> = { slop: 'slop', not_slop: 'not slop', split: 'split' };
  out.push(
    table(
      'Networks that voted',
      [
        { label: 'Network', term: 'network', className: 'nowrap', cell: (n: Row) => h('code', null, str(n, 'network')) },
        { label: 'Voice', term: 'voice', cell: (n) => h('span', { class: 'voice', 'data-voice': str(n, 'voice') }, VOICE[str(n, 'voice')] ?? str(n, 'voice')) },
        { label: 'With standing', term: 'standing', cell: (n) => (n.standing === true ? 'yes' : 'no') },
        {
          label: 'Installs',
          term: 'install',
          className: 'wide',
          cell: (n) =>
            h(
              'ul',
              { class: 'installs' },
              ...rows(n.installs).map((i) => {
                const tags = [i.standing === true ? 'standing' : null, i.trusted === true ? 'trusted' : null, i.banned === true ? 'banned' : null].filter(Boolean).join(', ');
                const changed = str(i, 'changedAt');
                return h(
                  'li',
                  null,
                  installLink(str(i, 'id')),
                  ` ${num(i, 'value') === 1 ? 'slop' : 'not slop'}, `,
                  time(str(i, 'votedAt')),
                  changed && changed !== str(i, 'votedAt') ? h('span', null, ', changed ', time(changed)) : null,
                  `, reputation ${(num(i, 'reputation') ?? 0).toFixed(2)}${tags ? `, ${tags}` : ''}`,
                  str(i, 'tweetId') ? h('span', null, ', ', postLink(str(i, 'tweetId'), 'post')) : null,
                );
              }),
            ),
        },
      ],
      list,
      'No network voted on this account.',
      'networks-table',
    ),
  );
  return out;
}

export async function account(route: { handle: string }, ctx: Ctx): Promise<Node[]> {
  const { handle } = route;
  let body: unknown;
  try {
    [, body] = await Promise.all([overview(ctx.signal), api(`/api/admin/accounts/${handle}`, { signal: ctx.signal })]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return [head(`@${handle}`, 'No account with this handle.'), note('The server has no row for this handle: nobody voted on it, and no decision names it. Rows without votes leave after 30 days.'), h('p', null, h('a', { href: '#accounts' }, 'Back to the accounts'))];
    }
    throw err;
  }
  const d = isRow(body) ? body : {};
  const row = obj(d.account);
  const profile = isRow(d.profile) ? d.profile : null;
  const a = readAccount({ ...row, followers: num(row, 'followers') ?? (profile ? num(profile, 'followers') : null), name: strOrNull(row, 'name') ?? (profile ? strOrNull(profile, 'name') : null) });
  const list = isRow(d.list) ? d.list : null;
  const p = a.parts;

  const avatar = profile?.avatar === true ? h('img', { class: 'avatar', src: `/api/v1/avatars/${handle}`, alt: '', width: 64, height: 64, loading: 'lazy' }) : h('span', { class: 'avatar avatar-none', 'aria-hidden': 'true' }, handle.charAt(0).toUpperCase());
  const xId = str(row, 'xUserId') || (profile ? str(profile, 'xId') : '');
  const identity = h(
    'section',
    { class: 'who-card' },
    avatar,
    h(
      'div',
      { class: 'who-main' },
      a.name ? h('p', { class: 'who-big' }, h('bdi', null, a.name.slice(0, 100))) : null,
      h('p', { class: 'who-line' }, h('span', { class: 'mono' }, `@${handle}`), ' ', xProfile(handle)),
      h('p', { class: 'who-line' }, pill(a.status), h('span', null, `tier ${formatCount(a.tier)}, `, termLink('score', 'score'), ` ${formatCount(a.score)}`)),
    ),
  );

  const listLine = list
    ? h(
        'p',
        { class: 'list-line', 'data-in': list.inList === true ? 'true' : 'false' },
        list.inList === true
          ? `The newest list (version ${formatCount(num(list, 'version') ?? 0)}) holds it at tier ${formatCount(num(list, 'tier') ?? 0)}, score ${formatCount(num(list, 'score') ?? 0)}.`
          : `The newest list (version ${formatCount(num(list, 'version') ?? 0)}) does not hold it, so no extension hides it.`,
      )
    : h('p', { class: 'list-line', 'data-in': 'false' }, 'The server has published no list yet.');

  const ev = rows(d.evidence);
  const sightings = obj(d.sightings);
  const cleared = obj(d.clearedVotes);
  const appealsList = rows(d.appeals);
  const timeline = readActivity(d.timeline);
  const votes = obj(d.votes);
  const clearedRows = num(cleared, 'rows') ?? 0;

  return [
    head(`@${handle}`, shortReason(a), h('a', { href: '#accounts', class: 'btn btn-quiet btn-small' }, 'All accounts')),
    identity,
    h('div', { class: 'verdict', 'data-status': a.status }, sentence(statusSentence(a, session.rules), 'verdict-text'), listLine),
    block('Checks', ...checks(a)),
    block('Decide', accountActions({ handle, override: a.override, seed: a.seed, protected: a.protected, status: a.status, banNetworks: num(row, 'banNetworks') }, ctx.afterWrite, { review: true, explain: true })),
    block(
      'About the account',
      facts([
        [termLink('identity', 'Identity'), identityText(a.identity)],
        ['X id', xId || 'not known'],
        ['Followers', a.followers === null ? 'not known' : formatCount(a.followers)],
        ['First seen', time(str(row, 'firstSeenAt'), 'not known')],
        ['Listed', time(str(row, 'listedAt'), 'not listed')],
        ['Confirmed', time(str(row, 'confirmedAt'), 'not confirmed')],
        ['Identity checked', time(str(row, 'identityAt'), 'never')],
        [termLink('override', 'Admin decision'), a.override ? h('span', null, `${a.override}, `, time(str(row, 'overrideAt'), 'time not known')) : 'none'],
        [termLink('seed', 'Starter account'), a.seed ? `yes${str(row, 'seedSource') ? ` (${str(row, 'seedSource')})` : ''}` : 'no'],
        [termLink('protected', 'Protected'), a.protected ? 'yes, by you' : 'no'],
        [termLink('dissent', 'Dissent'), plural(p.dissent, 'network')],
        ['Moved to', a.movedTo ?? 'not moved'],
      ]),
    ),
    block('Networks that voted', ...networks(votes)),
    block(
      'Checked posts',
      note('Posts that slop votes name. The X facts job checked whether this account wrote them; only matching posts count as evidence.'),
      table(
        'Checked posts',
        [
          { label: 'Post', cell: (e: Row) => postLink(str(e, 'tweetId'), str(e, 'tweetId')) },
          { label: 'Written by this account', term: 'evidence', cell: (e) => mark(e.ok === true && e.matchesId !== false ? 'met' : 'unmet', e.ok === true ? (e.matchesId === false ? 'no, another X id' : 'yes') : 'no') },
          { label: 'Checked', cell: (e) => time(str(e, 'checkedAt')) },
        ],
        ev,
        'The X facts job has checked no post of this account yet.',
      ),
    ),
    block(
      'Reply timing',
      note(
        `${timingText(p.sightings, p.fastReplyShare)}. The server holds ${plural(num(sightings, 'stored') ?? 0, 'reported reply', 'reported replies')}, ${formatCount(num(sightings, 'verified') ?? 0)} of them checked on X. Reply timing never changes a status.`,
      ),
      table(
        'Recent replies',
        [
          { label: 'Reply', cell: (s: Row) => postLink(str(s, 'tweetId'), str(s, 'tweetId')) },
          { label: 'To post', cell: (s) => (str(s, 'parentTweetId') ? postLink(str(s, 'parentTweetId'), str(s, 'parentTweetId')) : 'not known') },
          { label: 'Replied', cell: (s) => time(str(s, 'replyAt')) },
          { label: 'Seconds after the post', className: 'num', cell: (s) => (num(s, 'latencySec') === null ? 'not known' : formatCount(num(s, 'latencySec') ?? 0)) },
          { label: 'Checked on X', cell: (s) => (s.verified === true ? 'yes' : 'not yet') },
        ],
        rows(sightings.recent),
        'No extension reported a reply of this account.',
      ),
      p.behaviour ? note(`Behaviour score ${formatPercent(p.behaviour)}: information for you only.`, 'small') : null,
    ),
    block(
      'Votes kept at your clear',
      clearedRows === 0
        ? note('No votes kept. A clear with penalty keeps a copy of every vote of the account here, so a vote that changes later keeps its penalty.')
        : h(
            'p',
            { class: 'note' },
            `${plural(clearedRows, 'stored vote')} from ${plural(num(cleared, 'networks') ?? 0, 'network')} (${formatCount(num(cleared, 'slopNetworks') ?? 0)} of them slop networks), stored at the clear `,
            time(str(cleared, 'clearedAt'), 'at an unknown time'),
            '. Each slop row is a penalty for its install.',
          ),
    ),
    block(
      'Appeals',
      appealsList.length === 0
        ? note('No appeal for this account.')
        : table(
            'Appeals of this account',
            [
              { label: 'Status', cell: (r: Row) => str(r, 'status') },
              { label: 'Sent', cell: (r) => time(str(r, 'createdAt')) },
              { label: 'Bio code', cell: (r) => h('code', null, str(r, 'code')) },
              { label: 'Message', className: 'wide', cell: (r) => h('bdi', null, str(r, 'message')) },
              { label: 'Email', className: 'wrap', cell: (r) => str(r, 'email') || 'none given' },
              { label: 'Decided', cell: (r) => time(str(r, 'decidedAt'), 'not yet') },
              { label: 'Note', className: 'wrap', cell: (r) => str(r, 'note') || 'no note' },
            ],
            appealsList,
            'No appeal.',
          ),
      appealsList.some((r) => str(r, 'status') === 'open') ? h('p', { class: 'more' }, h('a', { href: '#appeals/open' }, 'Decide in the appeals queue')) : null,
    ),
    block(
      'Timeline',
      feed(timeline, 'Nothing recorded for this account yet: no status change, identity check, decision, appeal or list change.'),
      h('p', { class: 'more' }, h('a', { href: `#activity?subject=${handle}` }, 'All activity of this account')),
    ),
  ];
}
