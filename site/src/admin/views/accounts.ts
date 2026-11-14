// #accounts (SPEC 5.6, 14.2): the account list with its filter. Each row opens its account page.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { normalizeHandle } from '../../lib/handle.ts';
import { accountActions } from '../actions.ts';
import { plural, shortReason } from '../explain.ts';
import { readAccount, STATUSES } from '../model.ts';
import { listFrom, num, str, type Row } from '../rows.ts';
import { api } from '../session.ts';
import { accountLink, note, pill, say, table, time } from '../ui.ts';
import { head, limitOf, limitSelect, type Ctx } from '../view.ts';

const filter = { handle: '', status: '', limit: '100' };

export async function accounts(_route: unknown, ctx: Ctx): Promise<Node[]> {
  const params = new URLSearchParams();
  if (filter.handle) params.set('handle', filter.handle);
  if (filter.status) params.set('status', filter.status);
  params.set('limit', filter.limit);
  const items = listFrom(await api(`/api/admin/accounts?${params}`, { signal: ctx.signal }), 'accounts');

  const handleInput = h('input', { id: 'accounts-handle', name: 'handle', type: 'search', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 16, placeholder: 'start of a handle…', value: filter.handle, 'data-filter': '' });
  const statusSelect = h(
    'select',
    { id: 'accounts-status', name: 'status' },
    h('option', { value: '' }, 'Any'),
    ...STATUSES.map((s) => h('option', { value: s, selected: s === filter.status }, s === 'none' ? 'not listed' : s)),
  );
  const form = h(
    'form',
    { class: 'filters', id: 'accounts-filter', role: 'search' },
    h('label', { for: 'accounts-handle' }, 'Handle'),
    handleInput,
    h('label', { for: 'accounts-status' }, 'Status'),
    statusSelect,
    ...limitSelect('accounts-limit', filter.limit),
    h('button', { type: 'submit', class: 'btn btn-quiet btn-small' }, 'Show'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = handleInput.value;
    const handle = raw.trim() ? normalizeHandle(raw) : '';
    if (handle === null) {
      say('Type a handle of 1 to 15 letters, digits or underscores.', 'error');
      handleInput.setAttribute('aria-invalid', 'true');
      return;
    }
    filter.handle = handle;
    filter.status = (STATUSES as readonly string[]).includes(statusSelect.value) ? statusSelect.value : '';
    filter.limit = limitOf(form, 'accounts-limit');
    ctx.reload();
  });

  const what = filter.handle || filter.status ? `Accounts${filter.handle ? ` whose handle starts with "${filter.handle}"` : ''}${filter.status ? ` with status ${filter.status === 'none' ? 'not listed' : filter.status}` : ''}, highest score first.` : 'Every account that the server knows, highest score first.';
  return [
    head('Accounts', 'Every account with votes or a decision. Open one to see why it is where it is.', form),
    note(`${what} The table shows ${plural(items.length, 'account')}.`),
    table(
      'Accounts',
      [
        { label: 'Account', cell: (r: Row) => h('div', { class: 'who' }, accountLink(str(r, 'handle')), str(r, 'name') ? h('bdi', { class: 'who-name' }, str(r, 'name').slice(0, 100)) : null) },
        { label: 'Status', cell: (r) => pill(str(r, 'status')) },
        { label: 'Why', term: 'gate', className: 'wrap', cell: (r) => shortReason(readAccount(r)) },
        { label: 'Score', term: 'score', className: 'num', cell: (r) => formatCount(num(r, 'score') ?? 0) },
        { label: 'Networks', term: 'network', className: 'num', cell: (r) => formatCount(readAccount(r).parts.networks) },
        { label: 'Followers', className: 'num', cell: (r) => (num(r, 'followers') === null ? 'not known' : formatCount(num(r, 'followers') ?? 0)) },
        { label: 'Listed', cell: (r) => time(str(r, 'listedAt'), 'not listed') },
        { label: 'Updated', cell: (r) => time(str(r, 'updatedAt')) },
        {
          label: 'Actions',
          className: 'acts',
          cell: (r) => {
            const a = readAccount(r);
            return accountActions({ handle: a.handle, override: a.override, seed: a.seed, protected: a.protected, status: a.status, banNetworks: num(r, 'banNetworks') }, ctx.afterWrite, { review: false, explain: false });
          },
        },
      ],
      items,
      filter.handle || filter.status ? 'No account matches this filter.' : 'No accounts yet. An account appears with its first vote.',
      'accounts-table',
    ),
  ];
}
