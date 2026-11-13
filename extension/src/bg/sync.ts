// SPEC 7.4: global list sync (full list with ETag, then deltas, 410 -> full), config sync, and your standing (SPEC 13.8).
import { configFits, parseConfig } from '../shared/config';
import { VERSION } from '../shared/ext';
import { applyDelta, applyIds, fromMap, parseDelta, parseList, toMap } from '../shared/list';
import type { StoredList } from '../shared/types';
import { isObj } from '../shared/util';
import { publicGet, readJson, signedFetch } from './api';
import { save, state } from './store';
import { broadcast } from './tabs';

export const LIST_ALARM = 'list';
export const CONFIG_ALARM = 'config';
/** Above every list and delta that the row caps of shared/list.ts accept (about 10 MB with the ids). */
const LIST_BYTES = 16 * 1024 * 1024;
/** /api/v1/me also lists up to 5000 of your votes, about 400 KB. */
const ME_BYTES = 512 * 1024;
/** xslop reads your standing at most this often. */
const ME_EVERY_MS = 10 * 60_000;

let listing: Promise<boolean> | null = null;

async function fetchFull(etag: string | null): Promise<StoredList | null> {
  const res = await publicGet('/api/v1/list', etag ? { 'if-none-match': etag } : {});
  if (res.status === 304) return null;
  if (res.status !== 200) throw new Error(`list ${res.status}`);
  const list = parseList(await readJson(res, LIST_BYTES), res.headers.get('etag'));
  if (!list) throw new Error('list shape');
  return list;
}

/** Bring the stored list up to date. Resolves true when it changed. Single flight. */
export function syncList(): Promise<boolean> {
  listing ??= (async () => {
    const s = await state();
    // A list that a build before 1.2.0 stored has no X ids, and a delta only carries the ids of the rows that it
    // changes: such a list is fetched in full once.
    const cur = s.list?.ids ? s.list : null;
    let changed = false;
    if (cur) {
      const res = await publicGet(`/api/v1/list/delta?since=${cur.version}`);
      if (res.status === 200) {
        const d = parseDelta(await readJson(res, LIST_BYTES));
        if (!d || d.from !== cur.version) throw new Error('delta shape');
        const m = toMap(cur.accounts);
        applyDelta(m, d);
        const accounts = fromMap(m);
        const next: StoredList = {
          version: d.version, generatedAt: new Date().toISOString(), etag: `"${d.version}"`, accounts, ids: applyIds(cur, d, accounts),
        };
        await save('list', next);
        await broadcast({ t: 'list', from: d.from, version: d.version, add: d.add, remove: d.remove });
        changed = true;
      } else if (res.status === 410) {
        const full = await fetchFull(cur.etag);
        if (full) {
          await save('list', full);
          await broadcast({ t: 'listReload' });
          changed = true;
        }
      }
    } else {
      const full = await fetchFull(null);
      if (full) {
        await save('list', full);
        await broadcast({ t: 'listReload' });
        changed = true;
      }
    }
    const after = await state();
    await save('status', { ...after.status, listAt: Date.now() });
    return changed;
  })().finally(() => {
    listing = null;
  });
  return listing;
}

/** Fetch /api/v1/config; keep the last good one. Resolves true when the active config changed. */
export async function syncConfig(): Promise<boolean> {
  const res = await publicGet('/api/v1/config');
  if (res.status !== 200) return false;
  const cfg = parseConfig(await readJson(res));
  if (!cfg) return false;
  const s = await state();
  if (!configFits(cfg, VERSION)) {
    if (!s.status.updateNeeded) await save('status', { ...s.status, updateNeeded: true });
    return false;
  }
  if (s.status.updateNeeded) await save('status', { ...s.status, updateNeeded: false });
  if (JSON.stringify(cfg) === JSON.stringify(s.config)) return false;
  await save('config', cfg);
  await broadcast({ t: 'config' });
  return true;
}

/** `standing` of a /me answer. Null when the answer has none (an older server) or one out of shape. */
export const parseStanding = (x: unknown): boolean | null => (isObj(x) && typeof x.standing === 'boolean' ? x.standing : null);

/** Read whether your marks count for the shared list (GET /api/v1/me), at most every 10 minutes, once this install exists. */
export async function syncMe(): Promise<void> {
  const s = await state();
  if (!s.identity || Date.now() - s.status.meAt < ME_EVERY_MS) return;
  const standing = parseStanding(await readJson(await signedFetch('GET', '/api/v1/me'), ME_BYTES));
  const after = await state();
  await save('status', { ...after.status, standing, meAt: Date.now() });
}
