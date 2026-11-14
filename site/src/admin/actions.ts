// The writes of SPEC 5.6, 13.8 and 13.12, shared by the review queues, the account list, the account page, the install
// list and the install page. Each one asks once (two clicks) and sends x-csrf.

import { h } from '../lib/dom.ts';
import { formatCount } from '../lib/format.ts';
import { HANDLE_RE, UUID_RE } from './route.ts';
import { api } from './session.ts';
import { guarded, say } from './ui.ts';

type AccountAction = 'confirm' | 'clear' | 'reset' | 'protect' | 'unprotect';

function decided(handle: string, action: AccountAction, penalty: boolean | undefined): string {
  switch (action) {
    case 'confirm':
      return `@${handle} is confirmed. The shared list follows at once.`;
    case 'clear':
      return `@${handle} is cleared ${penalty ? 'with a penalty for its slop voters' : 'without a penalty'}. The shared list follows at once.`;
    case 'reset':
      return `@${handle}: the admin decision is removed. The next score run decides the status.`;
    case 'protect':
      return `@${handle} is protected. Only an admin decision changes its public state.`;
    case 'unprotect':
      return `@${handle} is no longer protected.`;
  }
}

/** ban-voters answers 409 above this many networks (STRIKE_MAX_CROWD of the server), so the button is off there. */
const BAN_MAX_NETWORKS = 10;

export interface AccountTarget {
  handle: string;
  override: 'confirm' | 'clear' | null;
  seed: boolean;
  protected: boolean;
  status: string;
  /** The exact number of networks that ban-voters checks and bans (13.12), or null when the answer has none. */
  banNetworks: number | null;
}

/** `after` runs after a write that succeeded: it reloads the view and the menu counts. */
export function accountActions(a: AccountTarget, after: () => Promise<void>, opts: { review: boolean; explain: boolean }): HTMLElement | string {
  const { handle } = a;
  if (!HANDLE_RE.test(handle)) return '';
  const run = (action: AccountAction, penalty?: boolean) => async () => {
    await api(`/api/admin/accounts/${handle}`, { method: 'POST', body: penalty === undefined ? { action } : { action, penalty } });
    say(decided(handle, action, penalty));
    await after();
  };
  const items: [HTMLButtonElement, string][] = [];
  if (a.override !== 'confirm') items.push([guarded('Confirm', 'btn-primary', run('confirm')), 'Lists it as confirmed for every user now, and gives good marks to its first slop voters.']);
  // A starter account was public from the first day, so its clear never gives a penalty (13.8).
  if (a.override !== 'clear' && !a.seed) items.push([guarded('Clear with penalty', 'btn-danger', run('clear', true)), 'Takes it off the list now. Each slop vote becomes a penalty for its install, and its networks can get strikes.']);
  if (a.override !== 'clear') items.push([guarded('Clear without penalty', 'btn-quiet', run('clear', false)), 'Takes it off the list now. Its voters lose nothing.']);
  if (a.override) items.push([guarded('Reset', 'btn-quiet', run('reset')), 'Removes your decision. The next score run decides by the votes; a cleared account comes back only through review.']);
  items.push(
    a.protected
      ? [guarded('Unprotect', 'btn-quiet', run('unprotect')), 'Lets the votes change its public state again.']
      : [guarded('Protect', 'btn-quiet', run('protect')), 'Only an admin decision changes its public state from now on.'],
  );
  const banNetworks = a.banNetworks;
  if ((opts.review || a.status === 'cleared' || opts.explain) && banNetworks !== null && banNetworks > 0) {
    items.push([banVoters(handle, banNetworks, after), `Bans every install with a slop vote on it, when at most ${formatCount(BAN_MAX_NETWORKS)} networks marked it: for a ring, not for a real crowd.`]);
  }
  if (!opts.explain) return h('div', { class: 'decide' }, ...items.map(([button]) => button));
  return h('ul', { class: 'decide-list' }, ...items.map(([button, text]) => h('li', null, button, h('span', { class: 'decide-what' }, text))));
}

function banVoters(handle: string, networks: number, after: () => Promise<void>): HTMLButtonElement {
  const counted = `${formatCount(networks)} ${networks === 1 ? 'network' : 'networks'}`;
  if (networks > BAN_MAX_NETWORKS) {
    return h('button', { type: 'button', class: 'btn btn-small btn-danger', disabled: true }, `Ban the installs that marked it (${counted}, limit ${BAN_MAX_NETWORKS})`);
  }
  return guarded(
    `Ban the installs that marked it (${counted})`,
    'btn-danger',
    async () => {
      const body = (await api(`/api/admin/accounts/${handle}/ban-voters`, { method: 'POST', body: {} })) as { banned?: unknown } | null;
      const banned = typeof body?.banned === 'number' ? body.banned : 0;
      say(`@${handle}: ${formatCount(banned)} ${banned === 1 ? 'install is' : 'installs are'} banned.`);
      await after();
    },
    `Yes, ban the installs of ${counted}`,
  );
}

export function installActions(id: string, trusted: boolean, banned: boolean, after: () => Promise<void>, explain = false): HTMLElement | string {
  if (!UUID_RE.test(id)) return '';
  const short = id.slice(0, 8);
  const run = (action: 'trust' | 'untrust' | 'ban' | 'unban', done: string) => async () => {
    await api(`/api/admin/installs/${id}/${action}`, { method: 'POST', body: {} });
    say(`Install ${short} ${done}`);
    await after();
  };
  const items: [HTMLButtonElement, string][] = [
    trusted
      ? [guarded('Untrust', 'btn-quiet', run('untrust', 'is no longer trusted. Its standing follows the rules from the next score run.')), 'Its standing then follows the age, good marks and reputation rules.']
      : [guarded('Trust', 'btn-quiet', run('trust', 'is trusted. From the next score run it has standing, unless it is banned.')), 'Gives it standing from the next score run, whatever its age and marks.'],
    banned
      ? [guarded('Unban', 'btn-quiet', run('unban', 'is unbanned. Its votes count again from the next score run.')), 'Its votes count again from the next score run.']
      : [guarded('Ban', 'btn-danger', run('ban', 'is banned. Its votes no longer count from the next score run.')), 'Its votes count nowhere from the next score run, and it loses standing.'],
  ];
  if (!explain) return h('div', { class: 'decide' }, ...items.map(([b]) => b));
  return h('ul', { class: 'decide-list' }, ...items.map(([button, text]) => h('li', null, button, h('span', { class: 'decide-what' }, text))));
}
