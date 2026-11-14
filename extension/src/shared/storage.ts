// Typed reads of storage.local; missing or old-shaped keys fall back to defaults.
import { parseConfig } from './config';
import { ext } from './ext';
import { isObj } from './util';
import { STORED_DEFAULTS, type Observation, type OutOp, type Stored, type StoredList } from './types';

export type StoredKey = keyof Stored;

/** An older build stored the post text with each vote. No build reads or sends it, so a read leaves it out. */
function withoutText<T extends object>(vote: T): T {
  const { text: _, ...rest } = vote as T & { text?: unknown };
  return rest as T;
}

/** An older build stored more fields with each observation (text features, times). A read keeps the three that the server takes. */
const observation = ({ handle, tweetId, parentTweetId }: Observation): Observation => ({ handle, tweetId, parentTweetId });

const isPair = (x: unknown): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string';

/**
 * The ids of a stored list, one beside each row. A 1.2.0 test build stored them as [handle, id] pairs: they move
 * beside their rows. Any other shape counts as none, as in a list of 1.1.3, so the next sync fetches the full list.
 */
function idsBesideRows(list: StoredList): StoredList {
  const { ids, ...rest } = list;
  const got: unknown[] | null = Array.isArray(ids) ? ids : null;
  if (!got) return rest;
  if (got.length === list.accounts.length && got.every((id) => id === null || typeof id === 'string')) return list;
  if (!got.every(isPair)) return rest;
  const byHandle = new Map(got);
  return { ...rest, ids: list.accounts.map(([h]) => byHandle.get(h) ?? null) };
}

export async function readStored<K extends StoredKey>(keys: readonly K[]): Promise<Pick<Stored, K>> {
  const raw = (await ext.storage.local.get(keys as unknown as string[])) as Record<string, unknown>;
  const out = {} as Pick<Stored, K>;
  for (const k of keys) {
    const def = STORED_DEFAULTS[k];
    const v = raw[k];
    if (v === undefined || v === null) out[k] = def;
    // A config stored by an older version gets the keys that it lacks; one out of shape counts as none.
    else if (k === 'config') out[k] = parseConfig(v) as Stored[K];
    else if (isObj(def) && isObj(v)) out[k] = { ...def, ...v } as Stored[K];
    else if (Array.isArray(def) === Array.isArray(v)) out[k] = v as Stored[K];
    else out[k] = def;
  }
  const stored: Partial<Stored> = out;
  if (stored.list) stored.list = idsBesideRows(stored.list);
  if (stored.votes) stored.votes = stored.votes.map(withoutText);
  if (stored.outbox) {
    const ops: unknown = stored.outbox.ops;
    const obs: unknown = stored.outbox.obs;
    const cleanOps: OutOp[] = Array.isArray(ops)
      ? ops.flatMap((op): OutOp[] => {
          if (!isObj(op)) return [];
          if (op.k === 'vote' && isObj(op.body)) return [{ ...op, body: withoutText(op.body) } as unknown as OutOp];
          return [op as unknown as OutOp];
        })
      : [];
    const cleanObs: Observation[] = Array.isArray(obs) ? obs.flatMap((o) => (isObj(o) ? [observation(o as unknown as Observation)] : [])) : [];
    stored.outbox = { ...stored.outbox, ops: cleanOps, obs: cleanObs };
  }
  return out;
}

export const ALL_KEYS = Object.keys(STORED_DEFAULTS) as StoredKey[];
