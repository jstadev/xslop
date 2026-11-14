// #lists (SPEC 14.2, 14.3): each published list version with its time, count, and the handles that joined or left.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { plural } from '../explain.ts';
import { obj, num, rows, str, type Row } from '../rows.ts';
import { api } from '../session.ts';
import { accountLink, note, termLink, time } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

const TIER = ['not listed', 'flagged', 'confirmed'];

function joined(v: Row): Node {
  const added = Array.isArray(v.added) ? v.added.filter((e): e is unknown[] => Array.isArray(e)) : [];
  const count = num(v, 'addedCount') ?? added.length;
  if (count === 0) return h('span', { class: 'none' }, 'none');
  return h(
    'ul',
    { class: 'chips' },
    ...added.map(([handle, score, tier]) => h('li', null, accountLink(String(handle)), ` ${TIER[Number(tier)] ?? 'tier unknown'}, score ${formatCount(Number(score) || 0)}`)),
    count > added.length ? h('li', { class: 'none' }, `and ${formatCount(count - added.length)} more`) : null,
  );
}

function left(v: Row): Node {
  const removed = Array.isArray(v.removed) ? v.removed.filter((e): e is string => typeof e === 'string') : [];
  const count = num(v, 'removedCount') ?? removed.length;
  if (count === 0) return h('span', { class: 'none' }, 'none');
  return h('ul', { class: 'chips' }, ...removed.map((handle) => h('li', null, accountLink(handle))), count > removed.length ? h('li', { class: 'none' }, `and ${formatCount(count - removed.length)} more`) : null);
}

export async function lists(_route: unknown, ctx: Ctx): Promise<Node[]> {
  const versions = rows(obj(await api('/api/admin/lists?limit=30', { signal: ctx.signal })).versions);
  return [
    head('Lists', h('span', null, 'Each ', termLink('list-version', 'list version'), ' that the server published, newest first.')),
    note(`The newest ${plural(versions.length, 'version')}. "Joined" holds new accounts and accounts whose tier, score or X id changed.`),
    versions.length === 0
      ? h('p', { class: 'empty-state' }, 'The server has published no list version yet.')
      : h(
          'ol',
          { class: 'versions' },
          ...versions.map((v) => {
            const from = num(v, 'from');
            return h(
              'li',
              { class: 'version', id: `version-${formatCount(num(v, 'version') ?? 0)}` },
              h(
                'div',
                { class: 'version-head' },
                h('h2', { class: 'version-title' }, `Version ${formatCount(num(v, 'version') ?? 0)}`),
                h('p', { class: 'version-meta' }, `${plural(num(v, 'count') ?? 0, 'account')}, published `, time(str(v, 'generatedAt')), from === null ? '. The first version.' : `, after version ${formatCount(from)}.`),
              ),
              h('dl', { class: 'facts version-diff' }, h('div', null, h('dt', null, `Joined or changed (${formatCount(num(v, 'addedCount') ?? 0)})`), h('dd', null, joined(v))), h('div', null, h('dt', null, `Left (${formatCount(num(v, 'removedCount') ?? 0)})`), h('dd', null, left(v)))),
            );
          }),
        ),
  ];
}
