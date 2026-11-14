/** The history of SPEC 14.1: events of the score job and the X facts job, and one job_runs row per run. */
import type { Queryable } from './db.js';

export interface HistoryEvent {
  subject: string;
  data: unknown;
}

/** Writes events of one kind in the transaction of the change. No row holds an address, an ip_hash or a post text. */
export async function writeEvents(q: Queryable, source: 'score' | 'facts', kind: 'status' | 'identity' | 'standing', events: readonly HistoryEvent[]): Promise<void> {
  if (events.length === 0) return;
  await q.query('insert into events (source, kind, subject, data) select $1, $2, s, d from unnest($3::text[], $4::jsonb[]) as u(s, d)', [
    source,
    kind,
    events.map((e) => e.subject),
    events.map((e) => JSON.stringify(e.data)),
  ]);
}

/** One row for a run that did work or failed: `detail` is the object of jobs.detail, or {"error"}. */
export async function recordRun(q: Queryable, job: 'score' | 'profiles', startedAt: Date, ok: boolean, detail: unknown): Promise<void> {
  await q.query('insert into job_runs (job, started_at, ended_at, ok, detail) values ($1, $2, $3, $4, $5::jsonb)', [job, startedAt, new Date(), ok, JSON.stringify(detail)]);
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
