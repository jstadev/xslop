// Popup (SPEC 12.7): the state at a glance, your accounts with one-tap undo, the settings in plain words.
import { muteOf } from '../shared/config';
import { ext } from '../shared/ext';
import { cleanMute, earliest, nextOp, rollDay } from '../shared/muteplan';
import { ALL_KEYS, readStored, type StoredKey } from '../shared/storage';
import { STORED_DEFAULTS, type MuteState, type Stored, type Vote } from '../shared/types';
import { localDay } from '../shared/util';
import { $, bindSwitch, hostAccess, sendPage, setSettings } from './pages';

const SHOW_MAX = 100;
const TOAST_MS = 6000;
const STRICT_HINTS: Record<Stored['settings']['strictness'], string> = {
  off: 'Hides only the accounts that you marked.',
  balanced: 'Hides confirmed slop accounts and the accounts that you marked.',
  strict: 'Also hides accounts that the crowd flagged but did not confirm yet.',
};
const DISPLAY_HINTS: Record<Stored['settings']['display'], string> = {
  collapse: 'A hidden post stays as one line that you can open.',
  remove: 'A hidden post leaves nothing on the page.',
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

/** Whether your marks count for the shared list (SPEC 13.2). Nothing until the server said it, and nothing for a banned install. */
function standingText(): string {
  const { standing, banned } = s.status;
  if (banned || standing === null) return '';
  if (standing) return 'Your marks count for the shared list.';
  return `Your marks ${s.settings.muteOnMark ? 'hide and mute' : 'hide'} for you now. ` +
    'They count for the shared list after a check, or once your install is old enough and has enough approved marks.';
}

function notices(): string[] {
  const out: string[] = [];
  if (s.status.banned) out.push('This install can no longer vote. Your own list still works on this device.');
  if (s.mute.waiting === 'login') out.push('You are not logged in to x.com in this browser. xslop still hides and votes. It can mute on X after you log in.');
  if (s.status.updateNeeded) out.push('A newer version of xslop is available. Update it to get the latest fixes for X.');
  if (!s.identity && s.status.installError) out.push('xslop could not register yet. Your votes wait on this device and send later.');
  const pending = s.outbox.ops.length;
  if (pending && s.outbox.lastError) out.push(`${plural(pending, 'vote waits', 'votes wait')} to send. xslop tries again soon.`);
  if (!s.list) out.push('The shared list loads soon.');
  return out;
}

function muteStatus(st: MuteState): string {
  const cfg = muteOf(s.config);
  const now = Date.now();
  if (!cfg.enabled) return 'Muting on X is off for everyone at the moment.';
  if (st.pausedUntil > now) return `${st.reason ?? 'Muting on X pauses.'} It starts again at ${time(st.pausedUntil)}.`;
  if (st.waiting === 'tab') return 'Open x.com in a tab so that xslop can finish the change on X.';
  const mine = st.muted.length ? `${plural(st.muted.length, 'account', 'accounts')} muted by xslop.` : '';
  const plan = nextOp(st, s.settings, s.votes, s.list, now);
  if (!plan) return [st.reason, mine].filter(Boolean).join(' ');
  const at = earliest(st, cfg, now, plan.op);
  const next = `Next ${plan.op === 'destroy' ? 'unmute' : 'mute'} ${at <= now ? 'now' : `at ${time(at)}`}.`;
  return [st.reason, mine, st.undoAll ? 'xslop removes its mutes one by one.' : '', `${plural(Math.max(0, cfg.maxPerDay - st.count), 'mute', 'mutes')} left today.`, next].filter(Boolean).join(' ');
}

function muteText(): string {
  const st = rollDay(cleanMute(s.mute), Date.now());
  const lost = st.lost
    ? `xslop could not undo ${plural(st.lost, 'mute', 'mutes')} because it has no X user id for ${st.lost === 1 ? 'it' : 'them'}. Check your muted accounts in the X settings.`
    : '';
  return [muteStatus(st), lost].filter(Boolean).join(' ');
}

function showToast(msg: string): void {
  $('toast-msg').textContent = msg;
  $('toast').hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast(): void {
  const hadFocus = document.activeElement === $('toast-undo');
  $('toast').hidden = true;
  removed = null;
  if (hadFocus) $('search').focus();
}

/** The mute state of one marked account, for its tag. */
function muteTag(st: MuteState, h: string): string {
  if (st.muted.some((e) => e[0] === h)) return 'Muted on X';
  if (st.retry.some((e) => e[0] === h)) return 'Mute waits';
  return st.skipped.find((e) => e[0] === h)?.[1] === 'own' ? 'You muted it' : 'Hidden';
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
  tag.className = v.v === 1 ? 'tag slop' : 'tag ok';
  tag.textContent = v.v === 1 ? muteTag(st, v.h) : 'Not slop';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'link';
  undo.textContent = 'Undo';
  undo.setAttribute('aria-label', `Undo your mark on @${v.h}`);
  undo.onclick = () => {
    removed = v;
    void sendPage({ t: 'unvote', handle: v.h });
    showToast(`Removed @${v.h}.`);
    $('toast-undo').focus();
  };
  li.append(a, tag, undo);
  return li;
}

function renderList(): void {
  const q = $<HTMLInputElement>('search').value.trim().replace(/^@/, '').toLowerCase();
  const all = s.votes.slice().sort((a, b) => b.at - a.at);
  const match = q ? all.filter((v) => v.h.includes(q)) : all;
  const shown = match.slice(0, SHOW_MAX);
  $('count').textContent = all.length ? `(${count(all.length)})` : '';
  const st = cleanMute(s.mute);
  const key = shown.map((v) => v.h).join();
  const ul = $('votes');
  if (key === shownKey) {
    for (const li of ul.children) {
      const v = shown.find((x) => x.h === (li as HTMLLIElement).dataset.handle);
      const tag = li.querySelector('.tag');
      if (v && tag) tag.textContent = v.v === 1 ? muteTag(st, v.h) : 'Not slop';
    }
  } else {
    shownKey = key;
    ul.replaceChildren(...shown.map((v) => row(v, st)));
  }
  const more = $('more');
  more.hidden = match.length <= SHOW_MAX;
  more.textContent = `Shows ${SHOW_MAX} of ${count(match.length)}. Search to find the rest.`;
  const empty = $('empty');
  empty.hidden = match.length > 0;
  empty.textContent = q ? 'No account on your list matches.' : 'Your list is empty. Click the xslop button on a post to add its author.';
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
  const standing = standingText();
  $('standing').textContent = standing;
  $('standing').hidden = !standing;
  renderNotices();
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="strictness"]')) el.checked = el.value === s.settings.strictness;
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="display"]')) el.checked = el.value === s.settings.display;
  $('strict-hint').textContent = STRICT_HINTS[s.settings.strictness];
  $('display-hint').textContent = DISPLAY_HINTS[s.settings.display];
  $<HTMLInputElement>('share').checked = s.settings.share;
  $<HTMLInputElement>('mute').checked = s.settings.mute;
  $<HTMLInputElement>('mute-mark').checked = s.settings.muteOnMark;
  const cfg = muteOf(s.config);
  $('mute-hint').textContent = `Mutes confirmed accounts on your X account, one by one, at most ${cfg.maxPerDay} a day. It needs an open x.com tab.`;
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
