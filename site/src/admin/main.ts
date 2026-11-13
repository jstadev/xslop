// Admin console for SPEC 5.6 and 13.8: cookie session, x-csrf header on every write, review queues, dense tables, keyboard shortcuts.

import { ApiError, request, type RequestOptions } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { formatCount, formatDate, formatPercent, formatRelative } from '../lib/format.ts';
import { normalizeHandle, postUrl, profileUrl } from '../lib/handle.ts';
import { describeError } from '../lib/messages.ts';
import { isUuid } from '../lib/schema.ts';
import { field, isRow, listFrom, num, str, type Row } from './rows.ts';

const VIEWS = ['overview', 'review', 'appeals', 'accounts', 'installs', 'log'] as const;
type View = (typeof VIEWS)[number];
const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);

const status = req('#status');
const loginView = req('#login-view');
const appView = req('#app-view');
const userBox = req('#user-box');
const userName = req('#user-name');
let csrf = '';
let view: View = 'overview';

// A hint (no secret) that this browser has logged in, so a first visit does not probe the session and log a 401.
const HINT = 'xslop.admin.session';
function hint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    // Storage can be off; the session probe then runs on every visit.
  }
}
function hasHint(): boolean {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return true;
  }
}

function say(text: string, kind: 'ok' | 'error' = 'ok'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

class SessionEnded extends Error {}

/** Admin request: adds x-csrf to writes and turns a 401 (logout, 30 idle minutes, 12 hours) into a return to the login form. */
async function api(path: string, opts: RequestOptions = {}): Promise<unknown> {
  const write = opts.method !== undefined && opts.method !== 'GET';
  try {
    return await request(path, write ? { ...opts, headers: { ...opts.headers, 'x-csrf': csrf } } : opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.endsWith('/login')) {
      showLogin('Your session ended. Log in again.');
      throw new SessionEnded();
    }
    throw err;
  }
}

function fail(err: unknown): void {
  if (err instanceof SessionEnded || (err instanceof ApiError && err.code === 'aborted')) return;
  if (err instanceof ApiError && err.status === 403) {
    say('The server refused the action (403). Reload the page and try again.', 'error');
    return;
  }
  say(describeError(err), 'error');
}

function showLogin(message = ''): void {
  csrf = '';
  hint(false);
  for (const controller of inFlight.values()) controller.abort();
  // Appeal messages and emails must not stay in the page for the next person at this screen.
  for (const data of document.querySelectorAll('#overview-data, .grid, .view-note')) data.replaceChildren();
  userName.textContent = '';
  appView.hidden = true;
  userBox.hidden = true;
  loginView.hidden = false;
  say(message, message ? 'error' : 'ok');
  loginUser.focus();
}

function showApp(user: string): void {
  loginView.hidden = true;
  appView.hidden = false;
  userBox.hidden = false;
  userName.textContent = user;
  route();
}

// Login and logout

const loginForm = req<HTMLFormElement>('#login-form');
const loginUser = req<HTMLInputElement>('#login-user');
const loginPass = req<HTMLInputElement>('#login-pass');
const loginCode = req<HTMLInputElement>('#login-code');
const loginError = req('#login-error');
const loginSubmit = req<HTMLButtonElement>('#login-submit');
const CODE = /^[0-9]{6}$/;

function markInvalid(...fields: HTMLInputElement[]): void {
  for (const input of [loginUser, loginPass, loginCode]) {
    if (fields.includes(input)) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = loginUser.value.trim();
  const password = loginPass.value;
  const code = loginCode.value.trim();
  if (!username || !password) {
    loginError.textContent = 'Type the username and the password.';
    markInvalid(...(username ? [] : [loginUser]), ...(password ? [] : [loginPass]));
    return;
  }
  if (code && !CODE.test(code)) {
    loginError.textContent = 'Type the 6 digits of the code, or leave the field empty.';
    markInvalid(loginCode);
    return;
  }
  loginError.textContent = '';
  markInvalid();
  loginSubmit.disabled = true;
  loginSubmit.setAttribute('aria-busy', 'true');
  try {
    const body = (await api('/api/admin/login', { method: 'POST', body: code ? { username, password, code } : { username, password } })) as { csrf?: unknown };
    if (typeof body.csrf !== 'string' || body.csrf.length < 16) throw new ApiError(200, 'bad_response', 'The server sent no session token.');
    csrf = body.csrf;
    hint(true);
    loginPass.value = '';
    loginCode.value = '';
    say('');
    showApp(username);
  } catch (err) {
    const rejected = err instanceof ApiError && err.status === 401;
    loginError.textContent = rejected ? 'Wrong username, password or code.' : describeError(err);
    if (rejected) markInvalid(loginUser, loginPass, loginCode);
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.removeAttribute('aria-busy');
  }
});

req<HTMLButtonElement>('#logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: {} });
  } catch (err) {
    // The session may still be live on the server, so the console must not claim otherwise.
    fail(err);
    return;
  }
  showLogin();
  say('You are logged out.');
});

// Tables

interface Column {
  label: string;
  cell: (row: Row) => Node | string;
  className?: string;
}

function renderTable(table: HTMLTableElement, rows: Row[], columns: Column[], empty: string): void {
  const head = h('thead', null, h('tr', null, ...columns.map((c) => h('th', { scope: 'col' }, c.label))));
  const body = h('tbody');
  if (rows.length === 0) {
    body.append(h('tr', null, h('td', { colspan: columns.length, class: 'empty' }, empty)));
  }
  for (const row of rows) {
    body.append(h('tr', null, ...columns.map((c) => h('td', { class: c.className, 'data-label': c.label }, c.cell(row)))));
  }
  table.replaceChildren(head, body);
}

function when(row: Row, ...names: string[]): Node | string {
  const v = str(row, ...names);
  if (!v || Number.isNaN(Date.parse(v))) return '';
  return h('time', { datetime: v, title: formatDate(v) }, formatRelative(v));
}

function handleLink(handle: string): Node | string {
  return normalizeHandle(handle) === handle ? h('a', { href: profileUrl(handle), rel: 'noopener noreferrer' }, `@${handle}`) : handle;
}

const count = (row: Row, ...names: string[]): string => {
  const v = num(row, ...names);
  return v === null ? '' : formatCount(v);
};

const yesNo = (row: Row, name: string): string => (field(row, name) === true ? 'yes' : 'no');

const statusPill = (row: Row): Node => h('span', { class: 'pill', 'data-status': str(row, 'status') }, str(row, 'status'));

function limitOf(selector: string): string {
  const v = req<HTMLSelectElement>(selector).value;
  return ['50', '100', '200', '500'].includes(v) ? v : '100';
}

/** Every write asks once: the first click arms the button for 4 s and names what the second click sends. */
function guarded(label: string, className: string, action: () => Promise<void>, armedLabel = `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`): HTMLButtonElement {
  const button = h('button', { type: 'button', class: `btn btn-small ${className}` }, label);
  let armed = false;
  let timer = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = armedLabel;
      timer = window.setTimeout(() => {
        armed = false;
        button.textContent = label;
      }, 4000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await action();
    } catch (err) {
      fail(err);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  });
  return button;
}

// One live request per view, so a slower, older answer cannot overwrite a newer filter.

const inFlight = new Map<View, AbortController>();

function latestSignal(v: View): AbortSignal {
  inFlight.get(v)?.abort();
  const controller = new AbortController();
  inFlight.set(v, controller);
  return controller.signal;
}

// Overview

function flatten(value: unknown, prefix = '', out: [string, unknown][] = []): [string, unknown][] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix} ${k}` : k, out);
  } else {
    out.push([prefix, value]);
  }
  return out;
}

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayValue(v: unknown): Node | string {
  if (typeof v === 'number') return formatCount(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) {
    return h('time', { datetime: v, title: formatDate(v) }, `${formatRelative(v)} (${formatDate(v)})`);
  }
  if (Array.isArray(v)) return `${v.length} items`;
  return String(v).slice(0, 300);
}

// The numbers of 13.8 lead the overview; every other field follows in the order of the answer.
const OVERVIEW_FIRST = ['accounts pending', 'standingInstalls', 'trustedInstalls', 'score detail struckNetworks', 'facts lastRunAt', 'facts lastOkAt', 'facts moved24h'];
const OVERVIEW_LABEL: Record<string, string> = {
  'accounts pending': 'Pending accounts',
  standingInstalls: 'Installs with standing',
  'score detail struckNetworks': 'Struck networks',
  'facts lastRunAt': 'X facts job, last run',
  'facts lastOkAt': 'X facts job, last success',
  'facts moved24h': 'Accounts that changed owner in 24 hours',
};
const overviewRank = (key: string): number => {
  const i = OVERVIEW_FIRST.indexOf(key);
  return i < 0 ? OVERVIEW_FIRST.length : i;
};

async function loadOverview(): Promise<void> {
  const body = await api('/api/admin/overview', { signal: latestSignal('overview') });
  const entries = flatten(body).sort(([a], [b]) => overviewRank(a) - overviewRank(b));
  req('#overview-data').replaceChildren(...entries.map(([k, v]) => h('div', null, h('dt', null, OVERVIEW_LABEL[k] ?? humanize(k)), h('dd', null, displayValue(v)))));
}

// Account decisions, shared by the review queues and the account list (13.8: both publish the list in the same request).

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

/** `networks` is banNetworks of the row: the exact number of networks that ban-voters checks and bans (13.12). */
function banVoters(handle: string, networks: number, reload: () => Promise<void>): HTMLButtonElement {
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
      await reload();
    },
    `Yes, ban the installs of ${counted}`,
  );
}

/**
 * The decisions for one account row: an item of a review queue or a row of the account list. A review item offers the
 * ban before the decision, because a confirm or a clear takes it out of its queue; an account row offers it once cleared.
 */
function accountButtons(r: Row, reload: () => Promise<void>, review: boolean): Node | string {
  const handle = str(r, 'handle');
  if (normalizeHandle(handle) !== handle) return '';
  const override = str(r, 'override');
  const seed = field(r, 'seed') === true;
  const isProtected = field(r, 'protected') === true;
  const run = (action: AccountAction, penalty?: boolean) => async () => {
    await api(`/api/admin/accounts/${handle}`, { method: 'POST', body: penalty === undefined ? { action } : { action, penalty } });
    say(decided(handle, action, penalty));
    await reload();
  };
  const banNetworks = num(r, 'banNetworks');
  return h(
    'div',
    { class: 'decide' },
    override === 'confirm' ? null : guarded('Confirm', 'btn-primary', run('confirm')),
    // A starter account was public from the first day, so its clear never gives a penalty (13.8).
    override === 'clear' || seed ? null : guarded('Clear with penalty', 'btn-danger', run('clear', true)),
    override === 'clear' ? null : guarded('Clear without penalty', 'btn-quiet', run('clear', false)),
    override ? guarded('Reset', 'btn-quiet', run('reset')) : null,
    isProtected ? guarded('Unprotect', 'btn-quiet', run('unprotect')) : guarded('Protect', 'btn-quiet', run('protect')),
    (review || str(r, 'status') === 'cleared') && banNetworks !== null && banNetworks > 0 ? banVoters(handle, banNetworks, reload) : null,
  );
}

// Review

const QUEUES = ['pending', 'disputed', 'auto'] as const;
type Queue = (typeof QUEUES)[number];

const QUEUE_NOTE: Record<Queue, string> = {
  pending: 'The votes pass a crowd test, and a gate holds the account back. Your decision publishes it or clears it.',
  disputed: 'Starter accounts that many networks call not slop, and listed accounts that voters dispute.',
  auto: 'Accounts that the votes confirmed recently, without a person. Confirm one to make it a trusted decision.',
};

const WANT: Record<string, string> = { confirmed: 'Confirm', flagged: 'Flag' };

const GATE: Record<string, string> = {
  protected: 'Protected account. Only an admin decision changes it.',
  identity: 'The server has not matched the handle to its X account.',
  standing: 'Too few voters with standing.',
  evidence: 'Too few marked posts that the server checked.',
  brake: 'The daily limit of automatic confirms or flags is used up.',
  dispute: 'Voters with standing disagree, or one camp alone marks it.',
  review: 'An admin cleared it before, so new marks need a person.',
};

function gateText(r: Row): string {
  const gate = str(r, 'gate');
  if (!gate) return 'None';
  const text = GATE[gate] ?? gate;
  return gate === 'identity' ? `${text} State: ${str(r, 'identity') || 'unknown'}.` : text;
}

function timing(r: Row): string {
  const replies = num(r, 'sightings') ?? 0;
  if (replies === 0) return 'No checked replies';
  const behaviour = num(r, 'behaviour');
  return `${formatPercent(num(r, 'fastReplyShare') ?? 0)} within a minute, of ${formatCount(replies)} checked ${replies === 1 ? 'reply' : 'replies'}${behaviour === null ? '' : `. Behaviour ${behaviour.toFixed(2)}`}`;
}

function evidenceLinks(r: Row): Node | string {
  const items = Array.isArray(r.evidence) ? r.evidence.filter((e): e is Row => typeof e === 'object' && e !== null) : [];
  const links = items.flatMap((e, i) => {
    const url = postUrl(str(e, 'tweetId'));
    const at = str(e, 'at');
    return url ? [h('a', { href: url, rel: 'noopener noreferrer', target: '_blank', title: Number.isNaN(Date.parse(at)) ? null : formatDate(at), 'aria-label': `Checked post ${i + 1} of @${str(r, 'handle')}` }, `Post ${i + 1}`)] : [];
  });
  return links.length === 0 ? 'None' : h('span', { class: 'links' }, ...links);
}

function who(r: Row): Node {
  const name = str(r, 'name');
  return h('span', { class: 'who' }, name ? h('bdi', null, name.slice(0, 100)) : null, name ? ' ' : null, handleLink(str(r, 'handle')));
}

async function loadReview(): Promise<void> {
  const raw = req<HTMLSelectElement>('#review-queue').value;
  const queue: Queue = (QUEUES as readonly string[]).includes(raw) ? (raw as Queue) : 'pending';
  const body = await api(`/api/admin/review?queue=${queue}&limit=${limitOf('#review-limit')}`, { signal: latestSignal('review') });
  const rows = listFrom(body, 'items');
  // total counts the whole queue, also past the row limit (13.12).
  const total = isRow(body) ? num(body, 'total') : null;
  req('#review-note').textContent =
    total === null ? QUEUE_NOTE[queue] : `${QUEUE_NOTE[queue]} The table shows ${formatCount(rows.length)} of ${formatCount(total)} ${total === 1 ? 'account' : 'accounts'} in this queue.`;
  renderTable(
    req<HTMLTableElement>('#review-table'),
    rows,
    [
      { label: 'Account', cell: who },
      { label: 'Followers', cell: (r) => count(r, 'followers'), className: 'num' },
      { label: 'Status', cell: statusPill },
      { label: 'Votes support', cell: (r) => WANT[str(r, 'want')] ?? 'Nothing' },
      { label: 'Gate', cell: gateText, className: 'wrap' },
      { label: 'Networks', cell: (r) => count(r, 'networks'), className: 'num' },
      { label: 'Anchors', cell: (r) => count(r, 'anchors'), className: 'num' },
      { label: 'Not slop, standing', cell: (r) => count(r, 'notSlop'), className: 'num' },
      { label: 'Dissent', cell: (r) => count(r, 'dissent'), className: 'num' },
      { label: 'Reply timing', cell: timing, className: 'wrap' },
      { label: 'Checked posts', cell: evidenceLinks },
      { label: 'Decision', cell: (r) => accountButtons(r, loadReview, true) },
    ],
    `No accounts in the ${queue === 'auto' ? 'automatic' : queue} queue.`,
  );
}

// Appeals

function marksText(r: Row): string {
  const marks = field(r, 'marks');
  if (!marks || typeof marks !== 'object') return '';
  const networks = num(marks as Row, 'networks') ?? 0;
  const strikes = num(marks as Row, 'strikes') ?? 0;
  return `${formatCount(networks)} ${networks === 1 ? 'network' : 'networks'} marked it. An accept with penalty strikes ${formatCount(strikes)}.`;
}

async function loadAppeals(): Promise<void> {
  const select = req<HTMLSelectElement>('#appeals-status');
  const statusValue = ['open', 'accepted', 'rejected'].includes(select.value) ? select.value : 'open';
  const rows = listFrom(await api(`/api/admin/appeals?status=${statusValue}`, { signal: latestSignal('appeals') }), 'appeals');
  const columns: Column[] = [
    { label: 'Handle', cell: (r) => handleLink(str(r, 'handle')) },
    { label: 'Bio code', cell: (r) => h('code', null, str(r, 'code')) },
    { label: 'Message', cell: (r) => str(r, 'message'), className: 'wide' },
    { label: 'Email', cell: (r) => str(r, 'email') },
    { label: 'Sent', cell: (r) => when(r, 'createdAt', 'created_at') },
  ];
  if (statusValue === 'open') {
    columns.push({ label: 'Marks', cell: marksText, className: 'wide' });
    columns.push({
      label: 'Decision',
      cell: (r) => {
        const id = str(r, 'id', 'appealId');
        if (!isUuid(id)) return 'Bad id';
        const handle = str(r, 'handle');
        const note = h('input', { type: 'text', maxlength: 500, 'aria-label': `Note for @${handle}`, placeholder: 'note (optional)…' });
        const decide = (decision: 'accept' | 'reject', penalty?: boolean) => async () => {
          const body = { decision, note: note.value.trim(), ...(penalty === undefined ? {} : { penalty }) };
          await api(`/api/admin/appeals/${id}/decide`, { method: 'POST', body });
          say(decision === 'accept' ? `Appeal for @${handle} accepted ${penalty ? 'with' : 'without'} a penalty. The account is cleared.` : `Appeal for @${handle} rejected.`);
          await loadAppeals();
        };
        return h(
          'div',
          { class: 'decide' },
          note,
          guarded('Accept with penalty', 'btn-primary', decide('accept', true)),
          guarded('Accept without penalty', 'btn-quiet', decide('accept', false)),
          guarded('Reject', 'btn-danger', decide('reject')),
        );
      },
    });
  } else {
    columns.push({ label: 'Decided', cell: (r) => when(r, 'decidedAt', 'decided_at') });
    columns.push({ label: 'Note', cell: (r) => str(r, 'note'), className: 'wide' });
  }
  renderTable(req<HTMLTableElement>('#appeals-table'), rows, columns, `No ${statusValue} appeals.`);
}

// Accounts

async function loadAccounts(): Promise<void> {
  const params = new URLSearchParams();
  const raw = req<HTMLInputElement>('#accounts-handle').value;
  if (raw.trim()) {
    const handle = normalizeHandle(raw);
    if (!handle) {
      say('Type a handle of 1 to 15 letters, digits or underscores.', 'error');
      return;
    }
    params.set('handle', handle);
  }
  const statusValue = req<HTMLSelectElement>('#accounts-status').value;
  if (['none', 'pending', 'flagged', 'confirmed', 'cleared'].includes(statusValue)) params.set('status', statusValue);
  params.set('limit', limitOf('#accounts-limit'));
  const rows = listFrom(await api(`/api/admin/accounts?${params}`, { signal: latestSignal('accounts') }), 'accounts');
  renderTable(
    req<HTMLTableElement>('#accounts-table'),
    rows,
    [
      { label: 'Handle', cell: (r) => handleLink(str(r, 'handle')) },
      { label: 'Status', cell: statusPill },
      { label: 'Tier', cell: (r) => String(num(r, 'tier') ?? ''), className: 'num' },
      { label: 'Score', cell: (r) => String(num(r, 'score') ?? ''), className: 'num' },
      { label: 'Seed', cell: (r) => yesNo(r, 'seed') },
      { label: 'Protected', cell: (r) => yesNo(r, 'protected') },
      { label: 'Override', cell: (r) => str(r, 'override') || 'none' },
      { label: 'Updated', cell: (r) => when(r, 'updatedAt', 'updated_at') },
      { label: 'Actions', cell: (r) => accountButtons(r, loadAccounts, false) },
    ],
    'No accounts match.',
  );
}

// Installs

async function loadInstalls(): Promise<void> {
  const raw = req<HTMLSelectElement>('#installs-sort').value;
  const sort = raw === 'created' || raw === 'votes' ? raw : 'reputation';
  const rows = listFrom(await api(`/api/admin/installs?sort=${sort}&limit=${limitOf('#installs-limit')}`, { signal: latestSignal('installs') }), 'installs');
  renderTable(
    req<HTMLTableElement>('#installs-table'),
    rows,
    [
      { label: 'Install', cell: (r) => h('code', { title: str(r, 'id', 'installId') }, str(r, 'id', 'installId').slice(0, 8)) },
      { label: 'Created', cell: (r) => when(r, 'createdAt', 'created_at') },
      { label: 'Last seen', cell: (r) => when(r, 'lastSeenAt', 'last_seen_at') },
      { label: 'Reputation', cell: (r) => (num(r, 'reputation') ?? 0).toFixed(2), className: 'num' },
      { label: 'Standing', cell: (r) => yesNo(r, 'standing') },
      { label: 'Trusted', cell: (r) => yesNo(r, 'trusted') },
      { label: 'Good marks', cell: (r) => count(r, 'goodMarks'), className: 'num' },
      { label: 'Slop votes', cell: (r) => count(r, 'slopVotes'), className: 'num' },
      { label: 'Not slop votes', cell: (r) => count(r, 'notSlopVotes'), className: 'num' },
      { label: 'Version', cell: (r) => str(r, 'extVersion', 'ext_version') },
      { label: 'Banned', cell: (r) => when(r, 'bannedAt', 'banned_at') || 'no' },
      {
        label: 'Actions',
        cell: (r) => {
          const id = str(r, 'id', 'installId');
          if (!isUuid(id)) return '';
          const short = id.slice(0, 8);
          const run = (action: 'trust' | 'untrust' | 'ban' | 'unban', done: string) => async () => {
            await api(`/api/admin/installs/${id}/${action}`, { method: 'POST', body: {} });
            say(`Install ${short} ${done}`);
            await loadInstalls();
          };
          const trusted = field(r, 'trusted') === true;
          const banned = Boolean(str(r, 'bannedAt', 'banned_at'));
          return h(
            'div',
            { class: 'decide' },
            trusted
              ? guarded('Untrust', 'btn-quiet', run('untrust', 'is no longer trusted. Its standing follows the rules from the next score run.'))
              : guarded('Trust', 'btn-quiet', run('trust', 'is trusted. From the next score run it has standing, unless it is banned.')),
            banned
              ? guarded('Unban', 'btn-quiet', run('unban', 'is unbanned. Its votes count again from the next score run.'))
              : guarded('Ban', 'btn-danger', run('ban', 'is banned. Its votes no longer count from the next score run.')),
          );
        },
      },
    ],
    'No installs yet.',
  );
}

// Log

function before(r: Row): Node | string {
  const v = field(r, 'before');
  if (v === null || v === undefined) return 'none';
  const text = JSON.stringify(v);
  return h('code', { class: 'before' }, text.length > 400 ? `${text.slice(0, 400)} …` : text);
}

async function loadLog(): Promise<void> {
  const rows = listFrom(await api(`/api/admin/log?limit=${limitOf('#log-limit')}`, { signal: latestSignal('log') }), 'entries');
  renderTable(
    req<HTMLTableElement>('#log-table'),
    rows,
    [
      { label: 'When', cell: (r) => when(r, 'at') },
      { label: 'Session', cell: (r) => h('code', null, str(r, 'session')) },
      { label: 'Action', cell: (r) => str(r, 'action') },
      { label: 'Target', cell: (r) => str(r, 'target') },
      { label: 'State before', cell: before, className: 'wide' },
    ],
    'No admin changes yet.',
  );
}

// Routing: the hash is the single source of the current view.

const loaders: Record<View, () => Promise<void>> = {
  overview: loadOverview,
  review: loadReview,
  appeals: loadAppeals,
  accounts: loadAccounts,
  installs: loadInstalls,
  log: loadLog,
};

async function load(v: View): Promise<void> {
  const section = req(`#view-${v}`);
  section.setAttribute('aria-busy', 'true');
  try {
    await loaders[v]();
  } catch (err) {
    fail(err);
  } finally {
    section.removeAttribute('aria-busy');
  }
}

function route(): void {
  if (appView.hidden) return;
  const hash = location.hash.slice(1);
  view = isView(hash) ? hash : 'overview';
  for (const section of document.querySelectorAll<HTMLElement>('[data-view]')) section.hidden = section.dataset.view !== view;
  for (const tab of document.querySelectorAll<HTMLAnchorElement>('[data-tab]')) {
    if (tab.dataset.tab === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  document.title = `${view.charAt(0).toUpperCase()}${view.slice(1)}: xslop admin`;
  void load(view);
}

window.addEventListener('hashchange', route);

for (const v of ['review', 'appeals', 'accounts', 'installs', 'log'] as const) {
  req<HTMLFormElement>(`#${v}-filter`).addEventListener('submit', (event) => {
    event.preventDefault();
    void load(view);
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reload]')) {
  button.addEventListener('click', () => void load(view));
}

document.addEventListener('keydown', (event) => {
  if (appView.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const index = ['1', '2', '3', '4', '5', '6'].indexOf(event.key);
  if (index >= 0) {
    location.hash = VIEWS[index] ?? 'overview';
    event.preventDefault();
  } else if (event.key === '/') {
    req(`#view-${view}`).querySelector<HTMLElement>('[data-filter]')?.focus();
    event.preventDefault();
  } else if (event.key === 'r') {
    void load(view);
    event.preventDefault();
  }
});

// Start: an existing session goes straight to the console.
(async () => {
  if (!hasHint()) {
    showLogin();
    return;
  }
  try {
    const body = (await request('/api/admin/session')) as { user?: unknown; csrf?: unknown };
    if (typeof body.csrf !== 'string' || typeof body.user !== 'string') throw new ApiError(200, 'bad_response', 'Unexpected session data.');
    csrf = body.csrf;
    showApp(body.user.slice(0, 64));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) showLogin();
    else showLogin(describeError(err));
  }
})();
