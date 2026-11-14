// Popup (SPEC 12.7): the state at a glance, your list with one-tap undo, the settings in short words.
import { muteOf } from '../shared/config';
import { ext } from '../shared/ext';
import { cleanMute, earliest, nextOp, rollDay } from '../shared/muteplan';
import { ALL_KEYS, readStored, type StoredKey } from '../shared/storage';
import { STORED_DEFAULTS, type MuteState, type Stored, type Vote } from '../shared/types';
import { localDay } from '../shared/util';
import { $, bindSwitch, hostAccess, sendPage, setSettings } from './pages';

const SHOW_MAX = 100;
/** The search field shows from this many marks, or while it holds text. */
const SEARCH_FROM = 7;
const TOAST_MS = 6000;
const STRICT_HINTS: Record<Stored['settings']['strictness'], string> = {
  off: 'Only your marks.',
  balanced: 'Your marks and confirmed slop.',
  strict: 'Also accounts the crowd flagged.',
};

let s: Stored = STORED_DEFAULTS;
let removed: Vote | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** The handles that the list shows now. The rows are rebuilt only when these change, so focus stays put. */
let shownKey = '';

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const count = (n: number): string => n.toLocaleString();
const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

function headline(): { tone: 'ok' | 'warn' | 'off'; text: string } {
  if (s.status.banned) return { tone: 'warn', text: 'Votes stopped' };
  if (s.mute.waiting === 'login') return { tone: 'warn', text: 'X login missing' };
  if (s.status.updateNeeded) return { tone: 'warn', text: 'Update needed' };
  if (s.settings.strictness === 'off') return { tone: 'off', text: 'Your marks only' };
  return { tone: 'ok', text: 'Hiding' };
}

function notices(): string[] {
  const out: string[] = [];
  if (s.status.banned) out.push('This install can no longer vote. Your own list still works.');
  if (s.mute.waiting === 'login') out.push('Log in to x.com to mute on X. Hiding still works.');
  if (s.status.updateNeeded) out.push('Update xslop to keep up with changes on X.');
  if (!s.identity && s.status.installError) out.push('xslop could not register yet. Your votes wait on this device.');
  const pending = s.outbox.ops.length;
  if (pending && s.outbox.lastError) out.push(`${plural(pending, 'vote waits', 'votes wait')} to send.`);
  if (!s.list) out.push('The shared list loads soon.');
  return out;
}

function muteStatus(st: MuteState): string {
  const cfg = muteOf(s.config);
  const now = Date.now();
  if (!cfg.enabled) return 'Muting on X is off for everyone right now.';
  if (st.pausedUntil > now) return [st.reason, `Mute sync resumes at ${time(st.pausedUntil)}.`].filter(Boolean).join(' ');
  if (st.waiting === 'tab') return 'Open an x.com tab to finish the changes on X.';
  const mine = st.muted.length ? `${plural(st.muted.length, 'account', 'accounts')} muted by xslop.` : '';
  const plan = nextOp(st, s.settings, s.votes, s.list, now);
  if (!plan) return [st.reason, mine].filter(Boolean).join(' ');
  const at = earliest(st, cfg, now, plan.op);
  const next = `Next ${plan.op === 'destroy' ? 'unmute' : 'mute'} ${at <= now ? 'now' : `at ${time(at)}`}.`;
  return [st.reason, mine, st.undoAll ? 'xslop removes its mutes one by one.' : '', `${plural(Math.max(0, cfg.maxPerDay - st.count), 'mute', 'mutes')} left today.`, next].filter(Boolean).join(' ');
}

function muteText(): string {
  const st = rollDay(cleanMute(s.mute), Date.now());
  const lost = st.lost ? `xslop could not undo ${plural(st.lost, 'mute', 'mutes')}. Check your muted accounts on X.` : '';
  return [muteStatus(st), lost].filter(Boolean).join(' ');
}

function showToast(msg: string): void {
  $('toast-msg').textContent = msg;
  $('toast').hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

/** Closes the toast. If it held the focus, the focus goes back to the list: the search field, else its heading. */
function hideToast(): void {
  const hadFocus = $('toast').contains(document.activeElement);
  $('toast').hidden = true;
  removed = null;
  if (hadFocus) ($('search').hidden ? $('h-list') : $('search')).focus();
}

/** The state of one marked account, for its tag. */
function tagText(st: MuteState, v: Vote): string {
  if (v.v !== 1) return 'Not slop';
  if (st.muted.some((e) => e[0] === v.h)) return 'Muted';
  if (st.retry.some((e) => e[0] === v.h)) return 'Mute waits';
  return st.skipped.find((e) => e[0] === v.h)?.[1] === 'own' ? 'Muted by you' : 'Hidden';
}

function paintTag(tag: Element, st: MuteState, v: Vote): void {
  tag.className = v.v === 1 ? 'tag slop' : 'tag ok';
  tag.textContent = tagText(st, v);
}

/** Removes your mark on `h`. The toast can put back the vote as it is now, not as it was when the row was drawn. */
function undoMark(h: string): void {
  const v = s.votes.find((x) => x.h === h);
  if (!v) return;
  removed = v;
  void sendPage({ t: 'unvote', handle: h });
  showToast(`Removed @${h}.`);
  $('toast-undo').focus();
}

function row(v: Vote, st: MuteState): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.handle = v.h;
  const a = document.createElement('a');
  a.href = `https://x.com/${v.h}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `@${v.h}`;
  const tag = document.createElement('span');
  paintTag(tag, st, v);
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'link';
  undo.textContent = 'Undo';
  undo.setAttribute('aria-label', `Undo your mark on @${v.h}`);
  undo.onclick = () => undoMark(v.h);
  li.append(a, tag, undo);
  return li;
}

function renderList(): void {
  const search = $<HTMLInputElement>('search');
  const q = search.value.trim().replace(/^@/, '').toLowerCase();
  const all = s.votes.slice().sort((a, b) => b.at - a.at);
  search.hidden = all.length < SEARCH_FROM && !search.value;
  const match = q ? all.filter((v) => v.h.includes(q)) : all;
  const shown = match.slice(0, SHOW_MAX);
  $('count').textContent = all.length ? count(all.length) : '';
  const st = cleanMute(s.mute);
  const key = shown.map((v) => v.h).join();
  const ul = $('votes');
  if (key === shownKey) {
    const byHandle = new Map(shown.map((v) => [v.h, v]));
    for (const li of ul.querySelectorAll('li')) {
      const v = byHandle.get(li.dataset.handle ?? '');
      const tag = li.querySelector('.tag');
      if (v && tag) paintTag(tag, st, v);
    }
  } else {
    shownKey = key;
    ul.replaceChildren(...shown.map((v) => row(v, st)));
  }
  const more = $('more');
  more.hidden = match.length <= SHOW_MAX;
  more.textContent = `Showing ${SHOW_MAX} of ${count(match.length)}. Search to find more.`;
  const empty = $('empty');
  empty.hidden = match.length > 0;
  empty.textContent = q ? 'No match.' : 'No marks yet. Click the xslop button on a post.';
}

function renderNotices(): void {
  const items = notices().map((text) => {
    const li = document.createElement('li');
    li.className = 'notice';
    li.textContent = text;
    return li;
  });
  $('notices').replaceChildren(...items);
}

function render(): void {
  const { tone, text } = headline();
  $('headline').dataset.tone = tone;
  $('headline').textContent = text;
  const hidden = s.stats.day === localDay(Date.now()) ? s.stats.hidden : 0;
  $('stat-hidden').textContent = count(hidden);
  $('stat-list').textContent = count(s.list?.accounts.length ?? 0);
  $('stat-mine').textContent = count(s.votes.filter((v) => v.v === 1).length);
  // SPEC 13.8: the tag shows only once the server said that your marks count, and never for a banned install.
  $('standing').hidden = s.status.standing !== true || s.status.banned;
  renderNotices();
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="strictness"]')) el.checked = el.value === s.settings.strictness;
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="display"]')) el.checked = el.value === s.settings.display;
  $('strict-hint').textContent = STRICT_HINTS[s.settings.strictness];
  $<HTMLInputElement>('share').checked = s.settings.share;
  $<HTMLInputElement>('mute').checked = s.settings.mute;
  $<HTMLInputElement>('mute-mark').checked = s.settings.muteOnMark;
  $('mute-max').textContent = String(muteOf(s.config).maxPerDay);
  $('mute-state').textContent = muteText();
  $('undo-mutes').hidden = !s.mute.muted.length || s.mute.undoAll;
  renderList();
}

async function reload(keys: readonly StoredKey[]): Promise<void> {
  // Read first: a spread of `s` before the await would undo a reload that lands during the wait.
  const fresh = await readStored(keys);
  s = { ...s, ...fresh };
  render();
}

for (const el of document.querySelectorAll<HTMLInputElement>('input[name="strictness"], input[name="display"]')) {
  el.addEventListener('change', () => {
    if (el.checked) void setSettings(el.name === 'strictness' ? { strictness: el.value as Stored['settings']['strictness'] } : { display: el.value as Stored['settings']['display'] });
  });
}
bindSwitch($<HTMLInputElement>('share'), 'share');
bindSwitch($<HTMLInputElement>('mute'), 'mute');
bindSwitch($<HTMLInputElement>('mute-mark'), 'muteOnMark');
$('undo-mutes').onclick = () => void sendPage({ t: 'muteUndoAll' });
$('search').addEventListener('input', renderList);
$('toast-undo').onclick = () => {
  if (removed) void sendPage({ t: 'restore', vote: removed });
  hideToast();
};

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter((k): k is StoredKey => (ALL_KEYS as string[]).includes(k));
  if (keys.length) void reload(keys);
});

void reload(ALL_KEYS);
void hostAccess($('access'), $<HTMLButtonElement>('access-grant'), $('access-help'));
void sendPage({ t: 'syncNow' });
