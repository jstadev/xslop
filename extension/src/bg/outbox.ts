// SPEC 7.4: outbox of votes, vote deletes and observations in storage.local, flushed with
// exponential backoff and full jitter. The latest op per handle wins, so the server converges.
import { dataConsent, ext } from '../shared/ext';
import { OBS_MAX } from '../shared/messages';
import type { Observation, OutOp, VoteBody } from '../shared/types';
import { ApiError, resetInstall, signedFetch } from './api';
import { save, state } from './store';

export const OUTBOX_ALARM = 'outbox';
const OBS_QUEUE_MAX = 2000;
const BASE_SEC = 30;
const CAP_SEC = 3600;

/** Delay before retry `attempt` (1-based): 30 s * 2^(attempt-1), capped at 1 h, full jitter in [50%, 100%]. */
export function backoffSec(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(CAP_SEC, BASE_SEC * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + rand * 0.5));
}

type NewOp = { h: string; k: 'vote'; body: VoteBody } | { h: string; k: 'del' };

async function putOp(op: NewOp): Promise<void> {
  const s = await state();
  const seq = s.outbox.seq + 1;
  const ops = s.outbox.ops.filter((o) => o.h !== op.h);
  ops.push({ ...op, seq } as OutOp);
  await save('outbox', { ...s.outbox, ops, seq });
}

/** Send now, unless a backoff is running: then the outbox alarm sends at its time. */
export async function flushDue(): Promise<void> {
  if ((await state()).outbox.nextAt <= Date.now()) void flush();
}

export async function enqueueVote(body: VoteBody): Promise<void> {
  await putOp({ h: body.handle, k: 'vote', body });
  await flushDue();
}

export async function enqueueDelete(handle: string): Promise<void> {
  await putOp({ h: handle, k: 'del' });
  await flushDue();
}

/** Observations may be queued and sent: you turned sharing on, and on Firefox the permission is still granted. */
export async function obsConsent(): Promise<boolean> {
  return (await state()).settings.share && (await dataConsent());
}

export async function enqueueObservations(items: Observation[]): Promise<void> {
  const s = await state();
  const obs = s.outbox.obs.concat(items);
  await save('outbox', { ...s.outbox, obs: obs.length > OBS_QUEUE_MAX ? obs.slice(obs.length - OBS_QUEUE_MAX) : obs });
  await flushDue();
}

type Result = 'ok' | 'drop' | 'retry' | 'stop';

/** Map a send failure to an action. 401 registers again once per flush; 4xx input errors drop the item. */
async function classify(e: unknown, reRegistered: { done: boolean }): Promise<{ r: Result; retryAfter: number | null; msg: string }> {
  if (!(e instanceof ApiError)) return { r: 'retry', retryAfter: null, msg: 'network' };
  if (e.status === 403 && e.code === 'banned') {
    const s = await state();
    await save('status', { ...s.status, banned: true });
    return { r: 'stop', retryAfter: null, msg: e.code };
  }
  if (e.status === 401 && !reRegistered.done && (e.code === 'unknown_install' || e.code === 'bad_signature')) {
    reRegistered.done = true;
    await resetInstall(e.code === 'bad_signature');
    return { r: 'retry', retryAfter: 0, msg: e.code };
  }
  if (e.status === 429 || e.status >= 500 || e.status === 401 || e.status === 408) return { r: 'retry', retryAfter: e.retryAfterSec, msg: e.code };
  return { r: 'drop', retryAfter: null, msg: e.code };
}

async function send(op: OutOp): Promise<void> {
  if (op.k === 'vote') await signedFetch('POST', '/api/v1/votes', op.body);
  else await signedFetch('DELETE', `/api/v1/votes/${op.h}`);
}

let flushing: Promise<void> | null = null;
let again = false;

/** Send everything pending. Single flight: a call during a flush runs one more pass after it. */
export function flush(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    let ok = true;
    do {
      again = false;
      ok = await pass();
    } while (again && ok);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** One pass over the outbox. Resolves false when it stopped on a failure (a backoff now runs). */
async function pass(): Promise<boolean> {
  const s = await state();
  if (s.status.banned) return false;
  const re = { done: false };
  let failure: { retryAfter: number | null; msg: string } | null = null;

  for (let i = 0; i < 1000 && !failure; i++) {
    const cur = await state();
    const op = cur.outbox.ops[0];
    const batch = op ? null : cur.outbox.obs.slice(0, OBS_MAX);
    if (!op && !batch?.length) break;
    if (batch && !(await obsConsent())) {
      // Consent is gone: the queued observations never leave this device.
      const after = await state();
      await save('outbox', { ...after.outbox, obs: [] });
      break;
    }
    let result: Result = 'ok';
    try {
      if (op) await send(op);
      else await signedFetch('POST', '/api/v1/observations', { items: batch });
    } catch (e) {
      const c = await classify(e, re);
      result = c.r;
      if (c.r === 'retry' && c.retryAfter === 0) continue; // registered again: try the same item now
      if (c.r === 'retry' || c.r === 'stop') failure = c;
    }
    if (result === 'retry' || result === 'stop') break;
    // Sent or dropped: remove it unless a newer op for the same handle replaced it meanwhile.
    const after = await state();
    if (op) {
      await save('outbox', { ...after.outbox, ops: after.outbox.ops.filter((o) => o.seq !== op.seq) });
    } else {
      await save('outbox', { ...after.outbox, obs: after.outbox.obs.slice(batch!.length) });
    }
  }

  const end = await state();
  if (failure) {
    if (end.status.banned) {
      await save('outbox', { ...end.outbox, lastError: 'banned' });
      return false;
    }
    const attempt = end.outbox.attempt + 1;
    // A Retry-After above the backoff cap (a full network gets one of 30 days) must not park the votes until the browser restarts.
    const delay = Math.min(CAP_SEC, Math.max(backoffSec(attempt), failure.retryAfter ?? 0));
    const nextAt = Date.now() + delay * 1000;
    await save('outbox', { ...end.outbox, attempt, nextAt, lastError: failure.msg });
    await ext.alarms.create(OUTBOX_ALARM, { when: nextAt });
    return false;
  }
  if (end.outbox.attempt || end.outbox.lastError) {
    await save('outbox', { ...end.outbox, attempt: 0, nextAt: 0, lastError: null });
    await ext.alarms.clear(OUTBOX_ALARM);
  }
  return true;
}
