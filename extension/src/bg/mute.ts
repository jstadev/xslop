// Mutes on your X account (SPEC 7.7, 12.3). The paced sync plans one X call at a time and an open x.com
// tab's content script makes it in your own session. Instant mutes run in the content script; it reports
// the result here. The rules live in shared/muteplan.ts.
import { muteOf, type MuteConfig } from '../shared/config';
import { ext } from '../shared/ext';
import { X_MATCHES } from '../shared/hosts';
import type { MuteRecordReply, MuteResult, XCall, XResult } from '../shared/messages';
import {
  OWN_SNAPSHOT_MS, applyInstant, applyOwnFailure, applyOwnSnapshot, applyReadFailure, applyResult, capStop, cleanMute, dropNoId,
  earliest, followRenames, loginGone, muteStays, nextDue, nextOp, noteWrongId, parseXResult, recordedId, rollDay, sameMute, takeBack,
  wrongIdOf, type Plan,
} from '../shared/muteplan';
import type { MuteState, Stored } from '../shared/types';
import { save, state } from './store';
import { broadcast } from './tabs';

export const MUTE_ALARM = 'mute';
/** 20 pages of 5000 ids: you mute at most 100,000 accounts. Above that, mute sync stops. */
const MAX_ID_PAGES = 20;
/** The longest wait for a tab: a frozen tab never answers. A little above the content script's own limit for an X call. */
const TAB_WAIT_MS = 20_000;

/** Change the mute state as it is now. No await lies between the read and the write, so no update is lost. */
export async function updateMute(fn: (st: MuteState) => MuteState): Promise<MuteState> {
  const s = await state();
  const st = fn(cleanMute(s.mute));
  await save('mute', st);
  return st;
}

/** Change the mute state of `s` in memory in this task, and write it. For a caller that changes other state in the same task. */
export const changeMute = (s: Stored, fn: (st: MuteState) => MuteState): Promise<void> => save('mute', fn(cleanMute(s.mute)));

/** One call to one tab. Null when no content script answered in time. */
function ask(tab: number, msg: XCall): Promise<XResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TAB_WAIT_MS);
  });
  return Promise.race([ext.tabs.sendMessage(tab, msg).then(parseXResult), late]).catch(() => null).finally(() => clearTimeout(timer));
}

/**
 * One call through the X tabs, in turn, until one makes it from a logged-in session. `tabs` is the list of
 * this run: a tab that could not make the call leaves it, so the next call does not wait for that tab again.
 */
async function xcall(tabs: number[], msg: Omit<XCall, 't' | 'bearer'>, cfg: MuteConfig): Promise<XResult | null> {
  let last: XResult | null = null;
  while (tabs.length) {
    const r = await ask(tabs[0]!, { t: 'xcall', ...msg, bearer: cfg.webBearer });
    if (r && !loginGone(r.status, r.code)) return r;
    last = r ?? last;
    tabs.shift();
  }
  return last;
}

const planCall = (p: Plan): Omit<XCall, 't' | 'bearer'> =>
  ({ op: p.op, handle: p.op === 'create' ? p.handle : null, userId: p.id, cursor: null });

/** "Undo all" ends when no record is left. */
const settle = (st: MuteState): MuteState => ({ ...st, undoAll: st.undoAll && st.muted.length > 0 });

async function xTabs(): Promise<number[]> {
  const tabs = await ext.tabs.query({ url: X_MATCHES });
  tabs.sort((a, b) => Number(b.active) - Number(a.active));
  return tabs.flatMap((t) => (t.id === undefined || t.discarded ? [] : [t.id]));
}

/** Read the accounts you muted yourself, now. Returns the ids, 'cap' when there are too many pages, or the failed result. */
async function readOwnMutes(tabs: number[], cfg: MuteConfig): Promise<Set<string> | 'cap' | XResult | null> {
  const ids = new Set<string>();
  let cursor = '-1';
  for (let i = 0; i < MAX_ID_PAGES; i++) {
    const r = await xcall(tabs, { op: 'ids', handle: null, userId: null, cursor }, cfg);
    if (!r || r.status !== 200 || !r.ids) return r;
    for (const id of r.ids) ids.add(id);
    if (!r.next || r.next === '0') return ids;
    cursor = r.next;
  }
  return 'cap';
}

const arm = (at: number | null): Promise<unknown> =>
  at === null ? ext.alarms.clear(MUTE_ALARM) : ext.alarms.create(MUTE_ALARM, { when: at });

let running: Promise<void> | null = null;
let rerun = false;

/** Run the next due call, then schedule the alarm for the one after. Single flight. */
export function tick(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      await runOnce();
    } while (rerun);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function runOnce(): Promise<void> {
  const s = await state();
  const cfg = muteOf(s.config);
  const now = Date.now();
  const stored = cleanMute(s.mute);
  let st = followRenames(rollDay(stored, now), s.settings, s.votes, s.list);
  let plan = cfg.enabled ? nextOp(st, s.settings, s.votes, s.list, now) : null;
  while (plan?.op === 'destroy' && !plan.id) {
    st = dropNoId(st, plan.handle);
    plan = nextOp(st, s.settings, s.votes, s.list, now);
  }
  const settled = !plan && st.undoAll && !st.muted.length ? { ...st, undoAll: false } : st;
  // A login problem stays until X answers again; only the wait for a tab ends when no call is planned.
  const next = !plan && settled.waiting === 'tab' ? { ...settled, waiting: null } : settled;
  if (!sameMute(next, stored)) await save('mute', next);
  if (!plan) {
    await arm(nextDue(next, now));
    return;
  }
  const at = earliest(next, cfg, now, plan.op);
  if (at > now) {
    await arm(at);
    return;
  }
  const tabs = await xTabs();
  if (!tabs.length) {
    await updateMute((x) => ({ ...x, waiting: 'tab' }));
    await arm(null);
    return;
  }
  await callX(plan, tabs, cfg, now);
}

/** Make the planned call. Every state change after an await goes through updateMute, so results that came in meanwhile stay. */
async function callX(plan: Plan, tabs: number[], cfg: MuteConfig, now: number): Promise<void> {
  const rand = Math.random();
  let own: ReadonlySet<string> = new Set();
  if (plan.op === 'create') {
    // Read your own mutes right before each create, so a mute that you made a minute ago counts as yours.
    const pre = await readOwnMutes(tabs, cfg);
    if (pre === 'cap') {
      const cur = await state();
      await save('settings', { ...cur.settings, mute: false });
      await updateMute(capStop);
      await arm(null);
      return;
    }
    if (!(pre instanceof Set)) {
      const failed = await updateMute((x) => applyReadFailure(x, pre, cfg, now, rand));
      if (!failed.waiting) await arm(earliest(failed, cfg, now, plan.op));
      return;
    }
    own = pre;
    await updateMute((x) => {
      // An instant mute whose report was lost is in this read already: only the earlier read shows that you did not make it.
      if (x.retry.some((e) => e[0] === plan.handle)) own = new Set(x.own);
      return applyOwnSnapshot(x, pre, Date.now());
    });
  }
  const r = await xcall(tabs, planCall(plan), cfg);
  const wrong = wrongIdOf(plan, r, (await state()).votes, own);
  let after = await updateMute((x) => {
    const applied = applyResult(x, plan, r, cfg, Date.now(), rand, own);
    return settle(wrong ? noteWrongId(applied, wrong) : applied);
  });
  if (wrong) {
    // X muted an account on your allow list (SPEC 13.10 item 9): undo it at once, by the id that X returned.
    const u = await xcall(tabs, planCall(wrong.undo), cfg);
    after = await updateMute((x) => settle(applyResult(x, wrong.undo, u, cfg, Date.now(), rand)));
  }
  const s = await state();
  const nextPlan = nextOp(after, s.settings, s.votes, s.list, Date.now());
  if (!nextPlan) await arm(nextDue(after, Date.now()));
  else if (!after.waiting) await arm(earliest(after, cfg, Date.now(), nextPlan.op));
}

/** Record what X answered to an instant mute or unmute. Never counts against the paced limits. */
export async function recordInstant(m: MuteResult): Promise<{ ok: true }> {
  const { votes } = await state();
  const marked = votes.some((v) => v.h === m.handle && v.v === 1);
  await updateMute((st) => {
    const now = Date.now();
    const next = applyInstant(st, m, now);
    // You took the mark back while X answered: the instant undo, or else the paced sync, removes this mute.
    return m.op === 'create' && !marked ? takeBack(next, m.handle, now, true) : next;
  });
  void tick().catch(() => undefined);
  return { ok: true };
}

/** The user id for an instant unmute, and whether the mute stays on X when there is none. */
export async function muteRecord(handle: string): Promise<MuteRecordReply> {
  const st = cleanMute((await state()).mute);
  const id = recordedId(st, handle);
  return { id, stays: !id && muteStays(st, handle) };
}

let reading: Promise<void> | null = null;

/** Read your own mutes through an x.com tab, at most every 6 hours. A click never waits for this. */
export function refreshOwn(tabId?: number): Promise<void> {
  reading ??= (async () => {
    const s = await state();
    const cfg = muteOf(s.config);
    const st = cleanMute(s.mute);
    const fresh = Date.now() - st.ownAt < OWN_SNAPSHOT_MS && st.waiting !== 'login';
    if (!s.settings.muteOnMark || !cfg.enabled || fresh) return;
    const found = await xTabs();
    const tabs = tabId === undefined ? found : [tabId, ...found.filter((t) => t !== tabId)];
    if (!tabs.length) return;
    const r = await readOwnMutes(tabs, cfg);
    if (r === null) return;
    await updateMute((x) => {
      if (r instanceof Set) return applyOwnSnapshot(x, r, Date.now());
      return r === 'cap' ? { ...x, ownAt: Date.now() } : applyOwnFailure(x, r.status, r.code, Date.now());
    });
  })().finally(() => {
    reading = null;
  });
  return reading;
}

/** "Undo all xslop mutes": stop muting on X and remove every mute in xslop's own record. */
export async function undoAll(): Promise<void> {
  const s = await state();
  const settings = { ...s.settings, mute: false, muteOnMark: false };
  await save('settings', settings);
  await broadcast({ t: 'settings', settings });
  await updateMute((st) => ({ ...st, undoAll: true, retry: [] }));
  await tick();
}
