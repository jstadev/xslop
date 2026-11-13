// Background (service worker in Chrome, event page in Firefox). Listeners register synchronously at start.
import { ensureInstall } from './bg/api';
import { MUTE_ALARM, changeMute, muteRecord, recordInstant, refreshOwn, tick as muteTick, undoAll, updateMute } from './bg/mute';
import { OUTBOX_ALARM, enqueueDelete, enqueueObservations, enqueueVote, flush, flushDue, obsConsent } from './bg/outbox';
import { save, state } from './bg/store';
import { CONFIG_ALARM, LIST_ALARM, syncConfig, syncList, syncMe } from './bg/sync';
import { broadcast } from './bg/tabs';
import { DATA_COLLECTION, ext, listen } from './shared/ext';
import { isXUrl } from './shared/hosts';
import { VOTES_MAX, parseContentMsg, parsePageMsg } from './shared/messages';
import { expectInstant, takeBack } from './shared/muteplan';
import type { Observation, Settings, Vote, VoteBody } from './shared/types';
import { cmpVersion, localDay } from './shared/util';

const PERIODS: [string, number][] = [[LIST_ALARM, 10], [CONFIG_ALARM, 360]];
const SEEN_MAX = 5000;
/** The first version where a click mutes on your X account. A user of an older version gets to read that once. */
const MUTES_ON_CLICK_SINCE = '1.1.0';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => undefined);
};

/** Run calls of `fn` one after another (each reads, then writes session storage). */
function serial<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve();
  return (...a) => {
    const p = chain.then(() => fn(...a));
    chain = p.catch(() => undefined);
    return p;
  };
}

async function ensureAlarms(): Promise<void> {
  for (const [name, period] of PERIODS) {
    if (!(await ext.alarms.get(name))) await ext.alarms.create(name, { periodInMinutes: period, delayInMinutes: period });
  }
}

async function register(): Promise<void> {
  try {
    await ensureInstall();
  } catch (e) {
    const s = await state();
    await save('status', { ...s.status, installError: e instanceof Error ? e.message : 'failed' });
  }
}

async function startup(): Promise<void> {
  await ensureAlarms();
  await Promise.allSettled([syncConfig(), syncList().finally(() => muteTick()), register().then(() => flush())]);
}

ext.runtime.onInstalled.addListener((d) => {
  const before = d.previousVersion;
  const upgraded = d.reason === 'update' && before !== undefined && cmpVersion(before, MUTES_ON_CLICK_SINCE) < 0;
  if (d.reason === 'install' || upgraded) quiet(ext.tabs.create({ url: ext.runtime.getURL('onboarding.html') }));
  quiet(startup());
});
ext.runtime.onStartup.addListener(() => quiet(startup()));

ext.alarms.onAlarm.addListener((a) => {
  if (a.name === LIST_ALARM) {
    quiet(syncList().then((changed) => (changed ? muteTick() : undefined)));
    // Also catches what a killed worker left: votes in the outbox, an install that did not register.
    quiet(state().then((s) => (s.identity ? flushDue() : register())));
  } else if (a.name === CONFIG_ALARM) quiet(syncConfig());
  else if (a.name === OUTBOX_ALARM) quiet(flush());
  else if (a.name === MUTE_ALARM) quiet(muteTick());
});

quiet(ensureAlarms());

// Firefox: you can take back the data collection permission in the add-on manager. Sharing stops at once.
ext.permissions?.onRemoved?.addListener((p) => {
  const removed = (p as { data_collection?: string[] }).data_collection ?? [];
  if (DATA_COLLECTION.data_collection.some((d) => removed.includes(d))) quiet(setSettings({ share: false }));
});
// Firefox and Safari: you can grant host access after install. The sync that failed without it runs now.
ext.permissions?.onAdded?.addListener(() => quiet(startup()));

// ---- messages ----

// One vote change is one task: the memory copy of the vote and the mute state and the outbox order are set
// before the next message runs, so a mark and an undo right behind it cannot interleave.

async function putVote(input: VoteBody): Promise<{ ok: true }> {
  const s = await state();
  const at = Date.now();
  const v: Vote = {
    h: input.handle, v: input.value === 'slop' ? 1 : 0, at, tweetId: input.tweetId,
    parentTweetId: input.parentTweetId, postedAt: input.postedAt, context: input.context,
  };
  const votes = s.votes.filter((x) => x.h !== v.h);
  votes.push(v);
  await Promise.all([
    changeMute(s, (st) => (input.value === 'slop' ? expectInstant(st, v.h, at, s.settings.muteOnMark) : takeBack(st, v.h, at, false))),
    save('votes', votes.length > VOTES_MAX ? votes.slice(votes.length - VOTES_MAX) : votes),
    enqueueVote({ handle: v.h, value: input.value, tweetId: v.tweetId, parentTweetId: v.parentTweetId, postedAt: v.postedAt, context: v.context }),
  ]);
  quiet(broadcast({ t: 'votes', set: [[v.h, v.v]], del: [] }));
  quiet(muteTick());
  return { ok: true };
}

async function removeVote(handle: string): Promise<{ ok: true }> {
  const s = await state();
  await Promise.all([
    changeMute(s, (st) => takeBack(st, handle, Date.now(), true)),
    s.votes.some((v) => v.h === handle) ? save('votes', s.votes.filter((v) => v.h !== handle)) : undefined,
    enqueueDelete(handle),
  ]);
  quiet(broadcast({ t: 'votes', set: [], del: [handle] }));
  quiet(muteTick());
  return { ok: true };
}

const observe = serial(async (items: Observation[]): Promise<{ ok: true }> => {
  const s = await state();
  if (!s.settings.share || s.config?.observe.enabled === false) return { ok: true };
  if (!(await obsConsent())) {
    // Firefox without the data collection permission: sharing is off, whatever the setting said.
    await setSettings({ share: false });
    return { ok: true };
  }
  // LRU of sent tweet ids in session storage: survives worker restarts, not browser restarts.
  const seen = ((await ext.storage.session.get('seen')).seen as string[] | undefined) ?? [];
  const known = new Set(seen);
  const fresh = items.filter((i) => !known.has(i.tweetId) && (known.add(i.tweetId), true));
  if (!fresh.length) return { ok: true };
  const next = seen.concat(fresh.map((i) => i.tweetId));
  await ext.storage.session.set({ seen: next.length > SEEN_MAX ? next.slice(next.length - SEEN_MAX) : next });
  await enqueueObservations(fresh);
  return { ok: true };
});

/** Count each hidden reply once per day, across tabs and reloads (ids kept in session storage). */
const countHidden = serial(async (ids: string[]): Promise<{ ok: true }> => {
  const day = localDay(Date.now());
  const got = (await ext.storage.session.get('hidden')).hidden as { day: string; ids: string[] } | undefined;
  const seen = new Set(got?.day === day ? got.ids : []);
  const fresh = ids.filter((id) => !seen.has(id) && (seen.add(id), true));
  if (!fresh.length) return { ok: true };
  const all = [...seen];
  await ext.storage.session.set({ hidden: { day, ids: all.length > SEEN_MAX ? all.slice(all.length - SEEN_MAX) : all } });
  const s = await state();
  await save('stats', { day, hidden: (s.stats.day === day ? s.stats.hidden : 0) + fresh.length });
  return { ok: true };
});

async function setSettings(patch: Partial<Settings>): Promise<{ ok: true }> {
  const s = await state();
  const settings = { ...s.settings, ...patch };
  await save('settings', settings);
  if (!settings.share && s.outbox.obs.length) {
    // You withdrew consent: drop the observations that are not sent yet.
    const cur = await state();
    await save('outbox', { ...cur.outbox, obs: [] });
  }
  if (patch.mute || patch.muteOnMark) {
    // You turn muting on again: forget a stop reason, but keep the reason of a running pause.
    await updateMute((st) => ({ ...st, undoAll: false, reason: st.pausedUntil > Date.now() ? st.reason : null }));
  }
  if (patch.muteOnMark === false) await updateMute((st) => ({ ...st, retry: [] }));
  await broadcast({ t: 'settings', settings });
  quiet(muteTick());
  return { ok: true };
}

let lastSync = 0;
async function syncNow(): Promise<{ ok: true }> {
  if (Date.now() - lastSync > 60_000) {
    lastSync = Date.now();
    await Promise.allSettled([syncList(), syncConfig(), state().then((s) => (s.identity ? flush() : register())), refreshOwn(), syncMe()]);
  }
  return { ok: true };
}

const bad = { error: 'bad_message' };

listen(async (raw, sender) => {
  const url = sender.url ?? '';
  if (url.startsWith(ext.runtime.getURL(''))) {
    const m = parsePageMsg(raw);
    if (!m) return bad;
    switch (m.t) {
      case 'settings': return setSettings(m.patch);
      case 'unvote': return removeVote(m.handle);
      case 'restore': {
        const v = m.vote;
        return putVote({
          handle: v.h, value: v.v === 1 ? 'slop' : 'not_slop', tweetId: v.tweetId, parentTweetId: v.parentTweetId,
          postedAt: v.postedAt, context: v.context,
        });
      }
      case 'muteUndoAll':
        await undoAll();
        return { ok: true };
      case 'syncNow': return syncNow();
    }
    return bad;
  }
  if (!sender.tab || !isXUrl(url)) return bad;
  const m = parseContentMsg(raw);
  if (!m) return bad;
  switch (m.t) {
    case 'vote': return putVote(m);
    case 'unvote': return removeVote(m.handle);
    case 'observe': return observe(m.items);
    case 'hidden': return countHidden(m.ids);
    case 'hello':
      quiet(muteTick());
      quiet(refreshOwn(sender.tab.id));
      return { ok: true };
    case 'muted': return recordInstant(m);
    case 'muteRecord': return muteRecord(m.handle);
  }
  return bad;
});
