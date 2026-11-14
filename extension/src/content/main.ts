// Content script on X (SPEC 7.3, 12.2): one MutationObserver, work batched per animation frame, each
// article processed once. Collapses the content of the cell, never removes X's nodes.
import { DEFAULT_CONFIG, SELECTOR_KEYS, configFits, type Config, type Selectors } from '../shared/config';
import { VERSION, ext, ownSender } from '../shared/ext';
import { hideReason, type HideReason } from '../shared/hidden';
import { applyDelta, toMap } from '../shared/list';
import { HIDDEN_MAX, OBS_MAX, VOTES_MAX, parseBgMsg, type BgMsg, type ContentMsg } from '../shared/messages';
import { readStored } from '../shared/storage';
import { DEFAULT_SETTINGS, type Observation, type Settings, type VoteBody } from '../shared/types';
import { remember } from './bounded';
import { createInstant } from './instant';
import { actionBarOf, newerId, ownHandle, parseTweet, statusIdOf, type Parsed } from './parse';
import { mountToast, showToast } from './toast';
import { makeBar, makeButton, shown, type Bar, type MarkButton } from './ui';
import { xcall } from './xcall';

interface Entry {
  article: HTMLElement;
  p: Parsed;
  button: MarkButton | null;
  bar: Bar | null;
  /** Last rendered state, so a refresh writes the DOM only on change. */
  view: string;
}

const MAX_TRIES = 30;
const TWEETS_MAX = 5000;
const OBS_QUEUE_MAX = 1000;
const entries = new WeakMap<Element, Entry>();
const tries = new WeakMap<Element, number>();

let cfg: Config = DEFAULT_CONFIG;
const sel = (): Selectors => cfg.selectors;
let settings: Settings = DEFAULT_SETTINGS;
const votes = new Map<string, 0 | 1>();
let list = new Map<string, number>();
let listVersion = -1;
let me: string | null = null;

// Page state, reset when the path changes.
let path = '';
let statusId: string | null = null;
let focal: Parsed | null = null;

// Tweet-level state for this tab.
const revealed = new Set<string>();
const justMarked = new Set<string>();
const counted = new Set<string>();
const observed = new Set<string>();
/** Tweet ids hidden since the last report. */
let hiddenNew: string[] = [];
/** The tweet whose bar takes keyboard focus after you mark it. */
let focusAfter: string | null = null;
let obsQueue: Observation[] = [];
let obsTimer: ReturnType<typeof setTimeout> | null = null;

/** False after an update or removal of the extension: this old script can reach nothing any more. */
const alive = (): boolean => ext.runtime?.id !== undefined;
/** One id for this script. A resend of a vote or an unvote carries the same `n` and `s`. */
const ACT_S = crypto.randomUUID();
let actN = 0;
/** Firefox can stop its event page as a message arrives, so one resend after a short wait. The same stamp goes again. */
const RESEND_MS = 300;
function send(msg: ContentMsg): Promise<unknown> {
  if (!alive()) return Promise.resolve(null);
  const stamped = msg.t === 'vote' || msg.t === 'unvote' ? { ...msg, n: ++actN, s: ACT_S } : msg;
  return ext.runtime.sendMessage(stamped).catch(async () => {
    await new Promise((done) => setTimeout(done, RESEND_MS));
    return alive() ? ext.runtime.sendMessage(stamped).catch(() => null) : null;
  });
}

/** A control that still runs after an update would mute on X with no record of it: it says so and stops here. */
function connected(): boolean {
  if (alive()) return true;
  showToast('xslop was updated. Reload this page.');
  return false;
}

const instant = createInstant({
  send,
  config: () => cfg,
  undo: (h) => {
    if (connected()) unmark(h);
  },
  yours,
  toast: showToast,
  articleOf(handle) {
    for (const a of document.querySelectorAll(sel().article)) if (entries.get(a)?.p.handle === handle) return a;
    return null;
  },
});

/** The remote kill switch (`mute.enabled`) also stops instant mutes. */
const instantOn = (): boolean => settings.muteOnMark && cfg.mute.enabled;

// ---- config and state ----

/** Use each remote selector only when the browser can parse it; else the built-in one. */
function checkedSelectors(remote: Selectors): Selectors {
  const out = { ...DEFAULT_CONFIG.selectors };
  const frag = document.createDocumentFragment();
  for (const k of SELECTOR_KEYS) {
    try {
      frag.querySelector(remote[k]);
      out[k] = remote[k];
    } catch {
      // Invalid selector: keep the default.
    }
  }
  return out;
}

function setVote(handle: string, value: 0 | 1): void {
  votes.set(handle, value);
  if (votes.size > VOTES_MAX) votes.delete(votes.keys().next().value as string);
}

async function loadState(): Promise<void> {
  const s = await readStored(['settings', 'votes', 'list', 'config']);
  settings = s.settings;
  votes.clear();
  for (const v of s.votes) setVote(v.h, v.v);
  list = toMap(s.list?.accounts ?? []);
  listVersion = s.list?.version ?? -1;
  const next = s.config && configFits(s.config, VERSION) ? s.config : DEFAULT_CONFIG;
  const selectors = checkedSelectors(next.selectors);
  const changed = JSON.stringify(selectors) !== JSON.stringify(cfg.selectors);
  cfg = { ...next, selectors };
  if (changed) resetDom();
}

/** Remove everything xslop added, so a new selector set can start clean. */
function resetDom(): void {
  for (const el of document.querySelectorAll('.xslop-host, .xslop-bar')) el.remove();
  for (const el of document.querySelectorAll('[data-xslop-cell], [data-xslop-article]')) {
    el.removeAttribute('data-xslop-cell');
    el.removeAttribute('data-xslop-article');
  }
  for (const a of document.querySelectorAll(sel().article)) {
    entries.delete(a);
    tries.delete(a);
  }
  focal = null;
}

// ---- page and classification ----

/** Reads the page URL and your handle. True when either changed. */
function syncPage(): boolean {
  let changed = false;
  if (location.pathname !== path) {
    path = location.pathname;
    statusId = statusIdOf(path);
    focal = null;
    changed = true;
  }
  const who = ownHandle(document, sel());
  if (who !== null && who !== me) {
    me = who;
    changed = true;
  }
  return changed;
}

const isFocal = (p: Parsed): boolean => p.tweetId === statusId;
/** The posts under the focal post are newer than it; its ancestors are older. */
const underFocal = (p: Parsed): boolean => statusId !== null && p.tweetId !== statusId && newerId(p.tweetId, statusId);
const isReply = (p: Parsed): boolean => !isFocal(p) && (p.replyingTo || underFocal(p));
const actionable = (p: Parsed): boolean => !p.promoted && p.handle !== me;

// ---- rendering ----

function clearView(e: Entry): void {
  e.bar?.el.remove();
  e.bar = null;
  e.p.cell?.removeAttribute('data-xslop-cell');
  e.article.removeAttribute('data-xslop-article');
}

/** A click counts only while the bar is visible where xslop put it. */
const barLive = (e: Entry, run: () => void) => (): void => {
  if (e.bar && shown(e.bar.el) && connected()) run();
};

function barFor(e: Entry, r: HideReason): Bar {
  const h = e.p.handle;
  const show = { label: 'Show', run: barLive(e, () => { remember(revealed, e.p.tweetId, TWEETS_MAX); refresh(); }) };
  if (r.kind === 'personal') {
    return makeBar(`Hidden ${isReply(e.p) ? 'reply' : 'post'} from @${h}`, [show, { label: 'Undo', run: barLive(e, () => unmark(h)) }]);
  }
  return makeBar(`Hidden by xslop (score ${r.score})`, [show, { label: 'Not slop', run: barLive(e, () => notSlop(e)) }]);
}

/** A click counts only while the button sits in its own action bar, in its tweet, and is visible. */
function buttonLive(e: Entry): boolean {
  const el = e.button?.el;
  return !!el && !!e.p.actionBar && el.parentElement === e.p.actionBar && e.article.contains(el) && shown(el);
}

const needsButton = (e: Entry): boolean => actionable(e.p) && !e.button?.el.isConnected;

function placeButton(e: Entry): void {
  if (e.button && !e.button.el.isConnected) e.button = null;
  const wanted = actionable(e.p);
  if (wanted && !e.button) {
    if (!e.p.actionBar?.isConnected) e.p.actionBar = actionBarOf(e.article, sel());
    if (!e.p.actionBar) return;
    e.button = makeButton(() => {
      if (buttonLive(e)) toggle(e);
    });
    e.p.actionBar.append(e.button.el);
  } else if (!wanted && e.button) {
    e.button.el.remove();
    e.button = null;
  }
  e.button?.set(e.p.handle, votes.get(e.p.handle) === 1, instantOn());
}

function render(e: Entry): void {
  placeButton(e);
  // The focal post is never hidden: you opened it on purpose.
  const r = actionable(e.p) && !isFocal(e.p) ? hideReason(e.p.handle, votes, list, settings.strictness) : null;
  if (!r) justMarked.delete(e.p.tweetId);
  const mode = !r || revealed.has(e.p.tweetId) ? 'show' : settings.display === 'remove' && !justMarked.has(e.p.tweetId) ? 'remove' : 'bar';
  const view = r && mode !== 'show' ? `${mode}:${r.kind}:${r.kind === 'global' ? r.score : ''}` : 'show';
  if (view === e.view) return;
  e.view = view;
  clearView(e);
  if (!r || mode === 'show') return;
  if (!counted.has(e.p.tweetId)) {
    remember(counted, e.p.tweetId, TWEETS_MAX);
    hiddenNew.push(e.p.tweetId);
  }
  const cell = e.p.cell;
  if (mode === 'remove') {
    if (cell) cell.setAttribute('data-xslop-cell', 'removed');
    else e.article.setAttribute('data-xslop-article', 'removed');
    return;
  }
  const bar = barFor(e, r);
  e.bar = bar;
  if (cell) {
    cell.setAttribute('data-xslop-cell', 'collapsed');
    cell.append(bar.el);
  } else {
    e.article.setAttribute('data-xslop-article', 'collapsed');
    e.article.before(bar.el);
  }
  if (justMarked.has(e.p.tweetId) && focusAfter === e.p.tweetId) {
    focusAfter = null;
    bar.focusLast();
  }
}

/** Re-render every tweet in the page after a state change. */
function refresh(): void {
  for (const a of document.querySelectorAll(sel().article)) {
    const e = entries.get(a);
    if (e) render(e);
  }
  reportHidden();
}

function reportHidden(): void {
  for (let i = 0; i < hiddenNew.length; i += HIDDEN_MAX) void send({ t: 'hidden', ids: hiddenNew.slice(i, i + HIDDEN_MAX) });
  hiddenNew = [];
}

// ---- actions ----

function voteBody(e: Entry, value: VoteBody['value']): VoteBody {
  return {
    handle: e.p.handle, value, tweetId: e.p.tweetId,
    parentTweetId: underFocal(e.p) ? statusId : null,
    postedAt: e.p.time, context: isReply(e.p) ? 'reply' : 'post',
  };
}

/** X can reuse an article for another tweet: xslop must never mark the author that this element showed before. */
function sameTweet(e: Entry): boolean {
  const now = parseTweet(e.article, sel());
  return now !== null && now.tweetId === e.p.tweetId && now.handle === e.p.handle;
}

function forget(e: Entry): void {
  clearView(e);
  e.button?.el.remove();
  entries.delete(e.article);
  schedule();
}

function toggle(e: Entry): void {
  if (!connected()) return;
  if (!sameTweet(e)) return forget(e);
  if (votes.get(e.p.handle) === 1) unmark(e.p.handle);
  else mark(e);
}

/** One task: the tweet collapses, the X call starts, the vote goes to the background. */
function mark(e: Entry): void {
  const h = e.p.handle;
  const height = e.p.cell?.getBoundingClientRect().height ?? 0;
  setVote(h, 1);
  revealed.delete(e.p.tweetId);
  remember(justMarked, e.p.tweetId, TWEETS_MAX);
  focusAfter = e.p.tweetId;
  refresh();
  e.bar?.shrinkFrom(height);
  if (instantOn()) instant.mute(h);
  void send({ t: 'vote', ...voteBody(e, 'slop') });
}

/** The undo reaches the background first, in this task: the X call may fail, or the tab may close during it. */
function unmark(h: string): void {
  votes.delete(h);
  refresh();
  void send({ t: 'unvote', handle: h });
  if (instantOn()) void instant.unmute(h);
}

/** X says that this account is you. Now xslop knows your handle, and it takes the mark back. */
function yours(handle: string): void {
  me = handle;
  votes.delete(handle);
  void send({ t: 'unvote', handle });
  refresh();
  showToast('This is your own account. xslop did not mark it.');
}

function notSlop(e: Entry): void {
  setVote(e.p.handle, 0);
  void send({ t: 'vote', ...voteBody(e, 'not_slop') });
  refresh();
}

// ---- observations (only after consent, only replies under a focal post) ----

function observe(e: Entry): void {
  // No observation while xslop does not know your handle: it could be your own reply. None from or to a protected account.
  if (!settings.share || !cfg.observe.enabled || !me || !focal || !underFocal(e.p) || e.p.promoted || e.p.handle === me) return;
  if (e.p.protected || focal.protected) return;
  const id = e.p.tweetId;
  if (observed.has(id) || obsQueue.length >= OBS_QUEUE_MAX) return;
  remember(observed, id, TWEETS_MAX);
  // Three fields (SPEC 13.8). The server reads both times from the ids and checks the reply on X itself.
  obsQueue.push({ handle: e.p.handle, tweetId: id, parentTweetId: focal.tweetId });
  obsTimer ??= setTimeout(sendObservations, cfg.observe.flushSec * 1000);
}

function sendObservations(): void {
  obsTimer = null;
  if (!obsQueue.length) return;
  const max = Math.min(OBS_MAX, cfg.observe.batchMax);
  const items = obsQueue.slice(0, max);
  obsQueue = obsQueue.slice(max);
  if (settings.share) void send({ t: 'observe', items });
  if (obsQueue.length) obsTimer = setTimeout(sendObservations, cfg.observe.flushSec * 1000);
}

// ---- the batch ----

let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(flush);
}

/** Starts tracking an article, or returns null when it is not a tweet that xslop can read. */
function track(a: HTMLElement): Entry | null {
  const n = tries.get(a) ?? 0;
  if (n >= MAX_TRIES) return null;
  const p = parseTweet(a, sel());
  if (!p) {
    tries.set(a, n + 1);
    return null;
  }
  // A recycled cell may still carry the state of the tweet it showed before.
  p.cell?.querySelectorAll(':scope > .xslop-bar').forEach((b) => b.remove());
  p.cell?.removeAttribute('data-xslop-cell');
  const e: Entry = { article: a, p, button: null, bar: null, view: 'show' };
  entries.set(a, e);
  return e;
}

function flush(): void {
  scheduled = false;
  const changed = syncPage();
  const focalBefore = focal;
  const all: Entry[] = [];
  const fresh: Entry[] = [];
  for (const a of document.querySelectorAll<HTMLElement>(sel().article)) {
    const known = entries.get(a);
    const e = known ?? track(a);
    if (!e) continue;
    all.push(e);
    if (isFocal(e.p)) focal = e.p;
    if (!known) fresh.push(e);
    if (!known || changed || needsButton(e)) render(e);
  }
  // Replies seen before the focal post, or before your handle, get their observation now.
  for (const e of changed || focal !== focalBefore ? all : fresh) observe(e);
  reportHidden();
}

// ---- messages from the background ----

async function onBg(m: BgMsg): Promise<unknown> {
  switch (m.t) {
    case 'settings':
      settings = m.settings;
      if (!settings.share) obsQueue = [];
      refresh();
      return { ok: true };
    case 'votes':
      for (const [h, v] of m.set) setVote(h, v);
      for (const h of m.del) votes.delete(h);
      refresh();
      return { ok: true };
    case 'list':
      if (m.from === listVersion) {
        applyDelta(list, m);
        listVersion = m.version;
      } else await loadState();
      refresh();
      return { ok: true };
    case 'listReload':
    case 'config':
      await loadState();
      schedule();
      refresh();
      return { ok: true };
    case 'xcall':
      return xcall(m);
  }
}

let ready = false;
let dirty = false;

ext.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!ownSender(sender) || sender.tab) return false;
  const m = parseBgMsg(raw);
  if (!m) return false;
  if (!ready && m.t !== 'xcall') {
    dirty = true;
    return false;
  }
  onBg(m).then(sendResponse, () => sendResponse(null));
  return true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && obsQueue.length) {
    if (obsTimer) clearTimeout(obsTimer);
    sendObservations();
  }
});

async function start(): Promise<void> {
  do {
    dirty = false;
    await loadState();
  } while (dirty);
  ready = true;
  mountToast();
  const observer = new MutationObserver((records) => {
    if (!alive()) return observer.disconnect();
    for (const r of records) {
      if (r.addedNodes.length) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedule();
  void send({ t: 'hello' });
}

void start();
