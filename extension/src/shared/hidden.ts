// SPEC 7.3: hidden set = personal slop votes + (global tier 2, plus tier 1 when Strict) - personal not-slop votes.
import { scoreOf, tierOf, type Strictness } from './types';

export type HideReason = { kind: 'personal' } | { kind: 'global'; score: number };

export function hideReason(
  handle: string,
  votes: ReadonlyMap<string, 0 | 1>,
  list: ReadonlyMap<string, number>,
  strictness: Strictness,
): HideReason | null {
  const v = votes.get(handle);
  if (v === 1) return { kind: 'personal' };
  if (v === 0 || strictness === 'off') return null;
  const p = list.get(handle);
  if (p === undefined) return null;
  const tier = tierOf(p);
  if (tier === 2 || (tier === 1 && strictness === 'strict')) return { kind: 'global', score: scoreOf(p) };
  return null;
}
