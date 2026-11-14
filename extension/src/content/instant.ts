// One click mutes the account on your X account at once (SPEC 12.3): the content script calls X itself,
// with no hop through the background and no pacing. The per-minute limit and the stop live here.
import type { Config } from '../shared/config';
import { NOT_CALLED, NOT_LOGGED_IN, type ContentMsg, type MuteRecordReply, type MuteResult, type XCall, type XResult } from '../shared/messages';
import { X_SELF_CODE, isAccountAnswer, isOk } from '../shared/muteplan';
import { isObj } from '../shared/util';
import { remember } from './bounded';
import { runMenu, type MenuOp } from './menu';
import { xcall } from './xcall';

const LIMIT_PER_MINUTE = 30;
const STOP_MINUTES = 15;
const STOP_MS = STOP_MINUTES * 60_000;
const MENU_MUTES_MAX = 500;

const stopsInstant = (status: number): boolean => status === 401 || status === 429;
/** X refused the REST call itself. An answer about this one account (missing, suspended, you) gets no better through the menu. */
const needsMenu = (r: XResult): boolean => r.status === 404 || (r.status === 403 && !isAccountAnswer(r.status, r.code));

interface InstantDeps {
  send(msg: ContentMsg): Promise<unknown>;
  config(): Config;
  /** A tweet of this account on the page right now, for X's own menu. */
  articleOf(handle: string): Element | null;
  /** Undo from the toast: the same undo as the bar. */
  undo(handle: string): void;
  /** X says that this account is yours. */
  yours(handle: string): void;
  toast(message: string, onUndo?: () => void): void;
}

export interface Instant {
  /** Starts the X call in the same task as the click. */
  mute(handle: string): void;
  /** Resolves when the unmute has reached X or the paced queue. */
  unmute(handle: string): Promise<void>;
}

export function createInstant(deps: InstantDeps): Instant {
  /** Times of the X calls in the last minute, at most the limit. */
  const recent: number[] = [];
  let stoppedUntil = 0;
  /** One job per handle at a time: an undo waits for the mute that it undoes. */
  const running = new Map<string, Promise<void>>();
  /** Handles muted through X's menu in this tab. A menu mute has no user id, so only the menu can undo it. */
  const menuMuted = new Set<string>();

  function admit(): boolean {
    const now = Date.now();
    if (now < stoppedUntil) return false;
    while (recent.length && recent[0]! <= now - 60_000) recent.shift();
    if (recent.length >= LIMIT_PER_MINUTE) return false;
    recent.push(now);
    return true;
  }

  const notCalled = (handle: string, id: string | null, op: MenuOp): MuteResult =>
    ({ handle, id, status: 0, code: NOT_CALLED, via: 'rest', op });

  async function viaMenu(handle: string, op: MenuOp): Promise<MuteResult> {
    const article = deps.articleOf(handle);
    const clicked = article !== null && await runMenu(article, handle, op, deps.config().selectors);
    return { handle, id: null, status: clicked ? 200 : 0, code: null, via: 'menu', op };
  }

  async function callX(handle: string, op: MenuOp, userId: string | null): Promise<MuteResult> {
    const call: XCall = {
      t: 'xcall', op, handle: op === 'create' ? handle : null, userId, cursor: null, bearer: deps.config().mute.webBearer,
    };
    const r = await xcall(call);
    if (stopsInstant(r.status)) stoppedUntil = Date.now() + STOP_MS;
    if (!needsMenu(r)) return { handle, id: r.id, status: r.status, code: r.code, via: 'rest', op };
    const menu = await viaMenu(handle, op);
    return isOk(menu.status) ? menu : { handle, id: r.id, status: r.status, code: r.code, via: 'rest', op };
  }

  function tellMute(res: MuteResult): void {
    const h = res.handle;
    if (isOk(res.status)) deps.toast(`Muted @${h} on X`, () => deps.undo(h));
    else if (res.status === 0 && res.code === NOT_CALLED) deps.toast('Hidden here. The mute on X comes later.');
    else if (res.status === 0 && res.code === NOT_LOGGED_IN) deps.toast('Hidden here. Log in to X to mute it there.');
    else if (stopsInstant(res.status)) deps.toast(`Hidden here. X limits mutes. Instant mute stops for ${STOP_MINUTES} minutes.`);
    else deps.toast('Hidden here. X did not accept the mute.');
  }

  function tellUnmute(res: MuteResult): void {
    if (isOk(res.status)) deps.toast(`Unmuted @${res.handle} on X`);
    else if (res.status === 0 && res.code === NOT_CALLED) deps.toast('Shown again here. The unmute on X comes later.');
    else deps.toast('Shown again here. X did not accept the unmute.');
  }

  /** Runs jobs of one handle in order; the first starts in the caller's task, so the click reaches X at once. */
  function enqueue(handle: string, job: () => Promise<void>): Promise<void> {
    const prior = running.get(handle);
    const task = (prior ? prior.then(job, job) : job()).finally(() => {
      if (running.get(handle) === task) running.delete(handle);
    });
    running.set(handle, task);
    return task;
  }

  async function recordOf(handle: string): Promise<MuteRecordReply> {
    const reply = await deps.send({ t: 'muteRecord', handle });
    if (!isObj(reply)) return { id: null, stays: false };
    return { id: typeof reply.id === 'string' ? reply.id : null, stays: reply.stays === true };
  }

  async function muteJob(handle: string): Promise<void> {
    const res = admit() ? await callX(handle, 'create', null) : notCalled(handle, null, 'create');
    if (res.via === 'menu' && isOk(res.status)) remember(menuMuted, handle, MENU_MUTES_MAX);
    await deps.send({ t: 'muted', ...res });
    if (res.code === X_SELF_CODE) deps.yours(handle);
    else tellMute(res);
  }

  async function unmuteJob(handle: string): Promise<void> {
    let res: MuteResult;
    if (menuMuted.delete(handle)) {
      res = await viaMenu(handle, 'destroy');
    } else {
      const { id, stays } = await recordOf(handle);
      // No id: xslop did not make this mute (or X gave no id), so xslop must not touch it.
      if (id === null) {
        if (stays) deps.toast(`Shown again here. @${handle} stays muted on X.`);
        return;
      }
      res = admit() ? await callX(handle, 'destroy', id) : notCalled(handle, id, 'destroy');
    }
    await deps.send({ t: 'muted', ...res });
    tellUnmute(res);
  }

  return {
    mute(handle) {
      void enqueue(handle, () => muteJob(handle));
    },
    unmute(handle) {
      return enqueue(handle, () => unmuteJob(handle));
    },
  };
}
