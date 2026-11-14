// Admin console v3 (SPEC 14.3): cookie session with x-csrf on writes, a side menu with live counts, hash routes, one live
// request per view, keyboard keys, and a console that forgets everything on logout and on a session end.

import { ApiError, request } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { formatCount } from '../lib/format.ts';
import { describeError } from '../lib/messages.ts';
import { num, obj } from './rows.ts';
import { navKey, parseRoute, type Route } from './route.ts';
import { clearSession, latest, loadOverview, onOverview, onSessionEnd, overviewAge, session, staleOverview } from './session.ts';
import { fail, hideTip, installTips, isAbort, note, say } from './ui.ts';
import { head, type Ctx } from './view.ts';
import { account } from './views/account.ts';
import { accounts } from './views/accounts.ts';
import { activity } from './views/activity.ts';
import { appeals } from './views/appeals.ts';
import { help } from './views/help.ts';
import { home } from './views/home.ts';
import { install } from './views/install.ts';
import { installs } from './views/installs.ts';
import { jobs } from './views/jobs.ts';
import { lists } from './views/lists.ts';
import { review } from './views/review.ts';

const loginView = req('#login-view');
const appView = req('#app-view');
const userBox = req('#user-box');
const userName = req('#user-name');
const viewRoot = req('#view');

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

/** Empties every view, the menu counts and the user name, so nothing of the session stays for the next person. */
function wipe(): void {
  clearSession();
  hideTip();
  viewRoot.replaceChildren();
  viewRoot.removeAttribute('aria-busy');
  for (const count of document.querySelectorAll<HTMLElement>('[data-count]')) {
    count.replaceChildren();
    count.closest('a')?.removeAttribute('aria-describedby');
  }
  userName.textContent = '';
  current = '';
}

function showLogin(message = ''): void {
  hint(false);
  wipe();
  appView.hidden = true;
  userBox.hidden = true;
  loginView.hidden = false;
  document.title = 'Log in: xslop admin';
  say(message, message ? 'error' : 'ok');
  loginUser.focus();
}

function showApp(user: string, csrf: string): void {
  session.csrf = csrf;
  session.user = user;
  loginView.hidden = true;
  appView.hidden = false;
  userBox.hidden = false;
  userName.textContent = user;
  void render();
}

onSessionEnd((message) => showLogin(message));

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
    const body = (await request('/api/admin/login', { method: 'POST', body: code ? { username, password, code } : { username, password } })) as { csrf?: unknown };
    if (typeof body.csrf !== 'string' || body.csrf.length < 16) throw new ApiError(200, 'bad_response', 'The server sent no session token.');
    hint(true);
    loginPass.value = '';
    loginCode.value = '';
    say('');
    showApp(username.slice(0, 64), body.csrf);
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
    await request('/api/admin/logout', { method: 'POST', body: {}, headers: { 'x-csrf': session.csrf } });
  } catch (err) {
    // A 401 means the session already ended. Any other failure: the session may still be live, so the console stays.
    if (!(err instanceof ApiError && err.status === 401)) {
      fail(err);
      return;
    }
  }
  showLogin();
  say('You are logged out.');
});

// The menu counts of SPEC 14.3: pending, disputed and open appeals, from the newest overview.

function updateCounts(): void {
  const ov = session.overview;
  if (!ov) return;
  const queues = obj(ov.queues);
  const values: Record<string, number | null> = { pending: num(queues, 'pending') ?? num(obj(ov.accounts), 'pending'), disputed: num(queues, 'disputed'), appeals: num(ov, 'appealsOpen') };
  for (const el of document.querySelectorAll<HTMLElement>('[data-count]')) {
    const v = values[el.dataset.count ?? ''];
    const shown = v !== null && v !== undefined;
    el.textContent = shown ? formatCount(v) : '';
    // The hidden hint describes the number, so a screen reader says "Review 7, waiting for you".
    if (shown) el.closest('a')?.setAttribute('aria-describedby', 'count-hint');
    else el.closest('a')?.removeAttribute('aria-describedby');
    el.dataset.zero = v === 0 ? 'true' : 'false';
  }
}
onOverview(updateCounts);

// Routing: the hash is the only source of the view.

type Views = { [V in Route['view']]: (route: Extract<Route, { view: V }>, ctx: Ctx) => Promise<Node[]> };
const VIEWS: Omit<Views, 'bad'> = { home, review, appeals, accounts, account, installs, install, activity, lists, jobs, help };

const TITLE: Record<Route['view'], string> = {
  home: 'Home',
  review: 'Review',
  appeals: 'Appeals',
  accounts: 'Accounts',
  account: 'Account',
  installs: 'Installs',
  install: 'Install',
  activity: 'Activity',
  lists: 'Lists',
  jobs: 'Jobs',
  help: 'Help',
  bad: 'Not found',
};

let current = '';

function markNav(route: Route): void {
  const key = navKey(route);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-nav]')) {
    if (link.dataset.nav === key) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function titleOf(route: Route): string {
  if (route.view === 'account') return `@${route.handle}`;
  if (route.view === 'install') return `Install ${route.id.slice(0, 8)}`;
  return TITLE[route.view];
}

async function render(reload = false): Promise<void> {
  if (appView.hidden) return;
  const parsed = parseRoute(location.hash);
  if (parsed.redirect) history.replaceState(null, '', parsed.redirect);
  const { route } = parsed;
  const same = reload || location.hash === current;
  current = location.hash;
  markNav(route);
  hideTip();
  const signal = latest('view');
  document.title = `${titleOf(route)}: xslop admin`;
  if (route.view === 'bad') {
    viewRoot.removeAttribute('aria-busy');
    viewRoot.replaceChildren(head('Not found', route.message), note(h('a', { href: '#home' }, 'Go to the home page')));
    return;
  }
  if (!same) viewRoot.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
  viewRoot.setAttribute('aria-busy', 'true');
  if (reload) staleOverview();
  if (overviewAge() > 10_000) void loadOverview(signal).catch(() => undefined);
  const ctx: Ctx = {
    signal,
    reload: () => void render(true),
    afterWrite: async () => {
      staleOverview();
      await render(true);
    },
  };
  try {
    const nodes = await (VIEWS[route.view] as (r: Route, c: Ctx) => Promise<Node[]>)(route, ctx);
    if (signal.aborted) return;
    viewRoot.replaceChildren(...nodes);
    if (!same) {
      window.scrollTo(0, 0);
      viewRoot.querySelector<HTMLElement>('#view-title')?.focus({ preventScroll: true });
    }
  } catch (err) {
    if (isAbort(err) || signal.aborted) return;
    if (!same) viewRoot.replaceChildren(head(titleOf(route), 'This page could not load.'), note(describeError(err), 'error'));
    fail(err);
  } finally {
    if (!signal.aborted) viewRoot.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', () => void render());

viewRoot.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('[data-reload]')) void render(true);
});

// The skip link moves the focus without a hash, because the hash names the view.
req('.skip').addEventListener('click', (e) => {
  e.preventDefault();
  req<HTMLElement>('#main').focus();
});

// Keys: 1 to 9 open the sections of the menu, / jumps to the filter, r reloads.
const KEYS = [...document.querySelectorAll<HTMLAnchorElement>('[data-key]')].sort((a, b) => Number(a.dataset.key) - Number(b.dataset.key));
document.addEventListener('keydown', (event) => {
  if (appView.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const link = KEYS.find((a) => a.dataset.key === event.key);
  if (link) {
    location.hash = link.getAttribute('href') ?? '#home';
    event.preventDefault();
  } else if (event.key === '/') {
    viewRoot.querySelector<HTMLElement>('[data-filter]')?.focus();
    event.preventDefault();
  } else if (event.key === 'r') {
    void render(true);
    event.preventDefault();
  }
});

installTips();

// Start: an existing session goes straight to the console.
(async () => {
  if (!hasHint()) {
    showLogin();
    return;
  }
  try {
    const body = (await request('/api/admin/session')) as { user?: unknown; csrf?: unknown };
    if (typeof body.csrf !== 'string' || typeof body.user !== 'string') throw new ApiError(200, 'bad_response', 'Unexpected session data.');
    showApp(body.user.slice(0, 64), body.csrf);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) showLogin();
    else showLogin(describeError(err));
  }
})();
