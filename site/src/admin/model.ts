// The admin answers of SPEC 13.8 and 14.2 as typed values. Every reader accepts any input and returns safe defaults.

import { isHandle } from '../lib/handle.ts';
import { bool, num, obj, rows, str, strOrNull, type Row } from './rows.ts';

export const STATUSES = ['none', 'pending', 'flagged', 'confirmed', 'cleared'] as const;
export type Status = (typeof STATUSES)[number];
export const GATES = ['protected', 'identity', 'standing', 'evidence', 'brake', 'dispute', 'review'] as const;
export type Gate = (typeof GATES)[number];
export type Want = 'flagged' | 'confirmed';
export const IDENTITIES = ['unknown', 'ok', 'gone', 'moved'] as const;
export type Identity = (typeof IDENTITIES)[number];

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => ((list as readonly unknown[]).includes(v) ? (v as T) : null);
const count = (r: Row, k: string): number => num(r, k) ?? 0;

/** The constants of SPEC 13.2 as `overview.rules` sends them (14.2). */
export interface Rules {
  standingMinAgeDays: number;
  standingMinGoodMarks: number;
  standingMinReputation: number;
  anchorsFlag: number;
  anchorsConfirm: number;
  evidenceFlag: number;
  evidenceConfirm: number;
  flagMinNetworks: number;
  confirmMinNetworks: number;
  confirmMinTrust: number;
  flagShareBound: number;
  confirmShareBound: number;
  protectedMinFollowers: number;
  maxAutoConfirmsPerDay: number;
  maxAutoFlagsPerDay: number;
  strikeMaxCrowd: number;
  clearedReturnMinNetworks: number;
  seedDisputeMinNetworks: number;
  networkDailyVotes: number;
}

const RULE_KEYS: (keyof Rules)[] = [
  'standingMinAgeDays', 'standingMinGoodMarks', 'standingMinReputation', 'anchorsFlag', 'anchorsConfirm', 'evidenceFlag', 'evidenceConfirm',
  'flagMinNetworks', 'confirmMinNetworks', 'confirmMinTrust', 'flagShareBound', 'confirmShareBound', 'protectedMinFollowers',
  'maxAutoConfirmsPerDay', 'maxAutoFlagsPerDay', 'strikeMaxCrowd', 'clearedReturnMinNetworks', 'seedDisputeMinNetworks', 'networkDailyVotes',
];

/** The rule numbers, or null when the server sent no complete set: the console then states no rule number. */
export function readRules(v: unknown): Rules | null {
  const r = obj(v);
  const out: Partial<Rules> = {};
  for (const k of RULE_KEYS) {
    const n = num(r, k);
    if (n === null) return null;
    out[k] = n;
  }
  return out as Rules;
}

/** `accounts.parts` of SPEC 13.3. */
export interface Parts {
  reason: string;
  want: Want | null;
  gate: Gate | null;
  networks: number;
  anchors: number;
  notSlop: number;
  dissent: number;
  trust: number;
  needed: number;
  disputed: boolean;
  evidence: number;
  behaviour: number;
  sightings: number;
  fastReplyShare: number;
}

export function readParts(v: unknown): Parts {
  const p = obj(v);
  return {
    reason: str(p, 'reason'),
    want: oneOf(['flagged', 'confirmed'] as const, p.want),
    gate: oneOf(GATES, p.gate),
    networks: count(p, 'networks'),
    anchors: count(p, 'anchors'),
    notSlop: count(p, 'notSlop'),
    dissent: count(p, 'dissent'),
    trust: count(p, 'trust'),
    needed: count(p, 'needed'),
    disputed: bool(p, 'disputed'),
    evidence: count(p, 'evidence'),
    behaviour: count(p, 'behaviour'),
    sightings: count(p, 'sightings'),
    fastReplyShare: count(p, 'fastReplyShare'),
  };
}

/** What the sentence builder needs to know about an account: a row of /accounts, a review item or the account page. */
export interface AccountFacts {
  handle: string;
  name: string | null;
  status: Status;
  tier: number;
  score: number;
  seed: boolean;
  override: 'confirm' | 'clear' | null;
  protected: boolean;
  identity: Identity;
  followers: number | null;
  clearPenalty: boolean;
  movedTo: string | null;
  parts: Parts;
  /** A review item (13.8) has no `parts`: it carries no evidence count, no `needed` and no `disputed`, so no sentence may use them. */
  partial: boolean;
}

/**
 * Reads an account row. A review item carries the parts as top-level fields (13.8), an account row carries `parts`;
 * both shapes give the same facts.
 */
export function readAccount(r: Row): AccountFacts {
  const parts = readParts(r.parts !== undefined ? r.parts : r);
  // A review item has no `reason`: rebuild it from the status, as the engine names it (13.3).
  if (!parts.reason && r.parts === undefined) parts.reason = bool(r, 'seed') ? 'seed' : str(r, 'status') === 'confirmed' ? 'votes_confirmed' : str(r, 'status') === 'flagged' ? 'votes_flagged' : str(r, 'status');
  const movedTo = strOrNull(r, 'movedTo');
  return {
    handle: str(r, 'handle'),
    name: strOrNull(r, 'name'),
    status: oneOf(STATUSES, r.status) ?? 'none',
    tier: count(r, 'tier'),
    score: count(r, 'score'),
    seed: bool(r, 'seed'),
    override: oneOf(['confirm', 'clear'] as const, r.override),
    protected: bool(r, 'protected'),
    identity: oneOf(IDENTITIES, r.identity) ?? 'unknown',
    followers: num(r, 'followers'),
    clearPenalty: r.clearPenalty !== false,
    movedTo: movedTo && isHandle(movedTo) ? movedTo : null,
    parts,
    partial: r.parts === undefined,
  };
}

/** `standing` of GET /api/admin/installs/:id (14.2). */
export interface StandingInfo {
  has: boolean;
  trusted: boolean;
  banned: boolean;
  ageDays: number;
  goodMarks: number;
  reputation: number;
  needs: { ageDays: number; goodMarks: number; reputation: number } | null;
}

export function readStanding(v: unknown): StandingInfo {
  const s = obj(v);
  const n = obj(s.needs);
  const needs = num(n, 'ageDays') !== null && num(n, 'goodMarks') !== null && num(n, 'reputation') !== null ? { ageDays: count(n, 'ageDays'), goodMarks: count(n, 'goodMarks'), reputation: count(n, 'reputation') } : null;
  return { has: bool(s, 'has'), trusted: bool(s, 'trusted'), banned: bool(s, 'banned'), ageDays: count(s, 'ageDays'), goodMarks: count(s, 'goodMarks'), reputation: count(s, 'reputation'), needs };
}

export const ACTIVITY_KINDS = ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run', 'vote', 'install'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** Without a filter the server leaves out votes and installs (14.2); the console starts with the same set. */
export const DEFAULT_KINDS: ActivityKind[] = ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run'];

/** One item of the activity feed (14.2). */
export interface Activity {
  key: string;
  at: string;
  kind: ActivityKind;
  source: string;
  subject: string | null;
  data: Row;
}

export function readActivity(v: unknown): Activity[] {
  return rows(v).flatMap((r) => {
    const kind = oneOf(ACTIVITY_KINDS, r.kind);
    const at = str(r, 'at');
    if (!kind || Number.isNaN(Date.parse(at))) return [];
    return [{ key: str(r, 'key') || `${kind}:${at}`, at, kind, source: str(r, 'source'), subject: strOrNull(r, 'subject'), data: obj(r.data) }];
  });
}
