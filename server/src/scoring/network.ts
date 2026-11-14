// Distinct networks (ipHash) are the unit of independence (SPEC.md 12.4 and 13.2). This module
// groups installs into networks, applies the daily budgets of each network, finds the struck
// networks, and collapses the votes of each network on an account into one voice.
import type { FactorVote } from './factorize.js';
import type { PreparedAccount, PreparedClearedVote, PreparedInstall, PreparedVote } from './input.js';
import { DAY_MS } from './weight.js';

// A network that votes more than this in 24 hours waits: the excess votes
// count later, one by one, as the budget frees up.
export const NETWORK_DAILY_VOTES = 50;
// Votes of one network that carry standing in 24 hours (SPEC.md 13.12 "Standing budget"): one identity with
// standing cannot flag or dispute many accounts in a day before a person can react. There is no waiting list.
export const STANDING_DAILY = 5;

// A strike: an admin cleared an account with the penalty, and the rows of a network in cleared_votes
// for that account say slop. This many strikes inside the window silence the network until one window
// after its newest strike. An account that more slop networks WITH standing than STRIKE_MAX_CROWD marked
// gives those networks no strike: there the admin overruled a real crowd. A network without standing
// gets the strike at any crowd size (SPEC.md 13.10 item 5).
export const STRIKE_LIMIT = 2;
export const STRIKE_WINDOW_DAYS = 30;
export const STRIKE_MAX_CROWD = 10;

// Dense network id per install (installs sorted by id).
export function networkIndex(installs: PreparedInstall[]): Int32Array {
  const ids = new Map<string, number>();
  return Int32Array.from(installs, (ins) => {
    let n = ids.get(ins.ipHash);
    if (n === undefined) ids.set(ins.ipHash, (n = ids.size));
    return n;
  });
}

// One stable name per network for the factor model: the id of its first install.
export function networkNames(installs: PreparedInstall[], network: Int32Array): string[] {
  const names: string[] = [];
  installs.forEach((ins, i) => { names[network[i]!] ??= ins.id; });
  return names;
}

// The votes that pick() lets in, grouped by network.
function byNetwork(votes: PreparedVote[], network: Int32Array, pick: (k: number) => boolean): Map<number, number[]> {
  const perNetwork = new Map<number, number[]>();
  votes.forEach((v, k) => {
    if (!pick(k)) return;
    const n = network[v.u]!;
    let queue = perNetwork.get(n);
    if (!queue) perNetwork.set(n, (queue = []));
    queue.push(k);
  });
  return perNetwork;
}

// Per vote: 1 when the vote carries the standing of its install (SPEC.md 13.12 "Standing budget"): a vote of an
// install with standing carries standing when fewer than STANDING_DAILY votes of its network, slop and not slop
// together, carried standing in the 24 hours before it. A vote past that never carries standing, so a user who
// marks many accounts keeps standing for the first STANDING_DAILY marks of each day. A vote after now carries none.
// `spent` holds slots that already carried standing (a recorded time, or a deleted vote). A recorded slot stays
// at its old time, so a delete or a value change does not free the place. A vote with standingAtMs already
// carried standing: it keeps that place and does not take a second one.
export function carriesStanding(
  votes: PreparedVote[], network: Int32Array, weight: Float64Array, standing: Uint8Array, nowMs: number,
  spent: readonly { n: number; atMs: number }[] = [],
): Uint8Array {
  const out = new Uint8Array(votes.length);
  const spentByNet = new Map<number, number[]>();
  for (const s of spent) {
    if (s.atMs > nowMs) continue;
    let list = spentByNet.get(s.n);
    if (!list) spentByNet.set(s.n, (list = []));
    list.push(s.atMs);
  }
  const queues = byNetwork(votes, network, (k) => weight[votes[k]!.u]! > 0 && standing[votes[k]!.u] === 1);
  const nets = new Set<number>([...queues.keys(), ...spentByNet.keys()]);
  for (const n of nets) {
    const queue = queues.get(n) ?? [];
    const slot = (k: number): number => {
      const v = votes[k]!;
      return Number.isNaN(v.standingAtMs) ? v.atMs : v.standingAtMs;
    };
    queue.sort((x, y) => slot(x) - slot(y) || x - y);
    const phantom = (spentByNet.get(n) ?? []).sort((a, b) => a - b);
    const carried: number[] = [];
    let p = 0;
    const pull = (until: number): void => {
      while (p < phantom.length && phantom[p]! <= until) carried.push(phantom[p++]!);
    };
    for (const k of queue) {
      const v = votes[k]!;
      const fixed = !Number.isNaN(v.standingAtMs);
      const at = fixed ? v.standingAtMs : v.atMs;
      if (at > nowMs) break;
      pull(at);
      if (fixed) {
        out[k] = 1; // the slot is already in `phantom`; do not push it again
        continue;
      }
      if (carried.length < STANDING_DAILY || carried[carried.length - STANDING_DAILY]! <= at - DAY_MS) {
        out[k] = 1;
        carried.push(at);
      }
    }
  }
  return out;
}

// Per vote: 1 when the vote counts now under the daily budget of its network. The queue of a network holds the
// votes that carry standing first, then the slop votes without standing, each in time order. So installs without
// standing on a shared address never take the places of an install with standing. A vote is released at its own
// time, at the release of the vote before it, or one day after the vote NETWORK_DAILY_VOTES places earlier,
// whichever is latest: releases never go back in time, and any 24 hours release at most NETWORK_DAILY_VOTES votes.
// A vote without weight (banned, struck) and a not-slop vote without standing count nowhere, so they use no place.
export function withinBudget(votes: PreparedVote[], network: Int32Array, weight: Float64Array, withStanding: Uint8Array, nowMs: number): Uint8Array {
  const out = new Uint8Array(votes.length);
  const pick = (k: number): boolean => weight[votes[k]!.u]! > 0 && (votes[k]!.value === 1 || withStanding[k] === 1);
  for (const queue of byNetwork(votes, network, pick).values()) {
    queue.sort((x, y) => withStanding[y]! - withStanding[x]! || votes[x]!.atMs - votes[y]!.atMs || x - y);
    const release = new Float64Array(queue.length);
    queue.forEach((k, i) => {
      let at = votes[k]!.atMs;
      if (i > 0) at = Math.max(at, release[i - 1]!);
      if (i >= NETWORK_DAILY_VOTES) at = Math.max(at, release[i - NETWORK_DAILY_VOTES]! + DAY_MS);
      release[i] = at;
      if (at <= nowMs) out[k] = 1;
    });
  }
  return out;
}

// A network is silenced when its STRIKE_LIMIT newest strikes lie inside one window and the newest one is
// younger than a window.
function silenced(times: number[], nowMs: number): boolean {
  if (times.length < STRIKE_LIMIT) return false;
  times.sort((x, y) => y - x);
  const windowMs = STRIKE_WINDOW_DAYS * DAY_MS;
  return nowMs - times[0]! < windowMs && times[0]! - times[STRIKE_LIMIT - 1]! < windowMs;
}

// Per network: 0 when it counts, 1 when its installs without standing count for nothing, 2 when all its
// installs count for nothing. Strikes come only from the rows of cleared_votes (SPEC.md 13.5), so a vote
// that is deleted or changed after the clear changes no strike. Per cleared account the rows of a network
// count by majority. When any row of the network had standing, only those rows make the majority,
// the same rule as the voice, so a not-slop row without standing cannot cancel a slop row with
// standing. The strike has standing when a slop row of the network had standing at the clear.
// A strike without standing silences only the installs without standing of the network: installs on a
// shared address cannot silence the install with standing there. Rows of a starter account, of an account
// that an admin confirms now and of a clear in the future give none. The rows of a banned install count
// too: a ban does not lift a strike, and the output does not depend on whether the loader loads it.
export function struckNetworks(
  rows: PreparedClearedVote[], accounts: PreparedAccount[], installs: PreparedInstall[], network: Int32Array, nowMs: number, nNetworks: number,
): Uint8Array {
  const networkOf = new Map<string, number>();
  installs.forEach((ins, u) => networkOf.set(ins.ipHash, network[u]!));
  const strikes: number[][] = Array.from({ length: nNetworks }, () => []);
  const standingStrikes: number[][] = Array.from({ length: nNetworks }, () => []);
  for (let start = 0; start < rows.length; ) {
    const a = rows[start]!.a;
    let end = start;
    const lean = new Map<string, { margin: number; voice: number; voiced: boolean; at: number; standing: boolean }>();
    for (; end < rows.length && rows[end]!.a === a; end++) {
      const r = rows[end]!;
      if (r.clearedAtMs > nowMs) continue;
      const row = lean.get(r.ipHash) ?? { margin: 0, voice: 0, voiced: false, at: r.clearedAtMs, standing: false };
      row.margin += r.value === 1 ? 1 : -1;
      if (r.standing) {
        row.voiced = true;
        row.voice += r.value === 1 ? 1 : -1;
      }
      row.at = Math.max(row.at, r.clearedAtMs);
      row.standing ||= r.value === 1 && r.standing;
      lean.set(r.ipHash, row);
    }
    const acc = accounts[a]!;
    const slop = [...lean].filter(([, row]) => (row.voiced ? row.voice : row.margin) > 0);
    const crowd = slop.filter(([, row]) => row.standing).length > STRIKE_MAX_CROWD;
    if (!acc.seed && acc.override !== 'confirm') {
      for (const [ip, row] of slop) {
        const n = networkOf.get(ip);
        if (n === undefined || (row.standing && crowd)) continue;
        strikes[n]!.push(row.at);
        if (row.standing) standingStrikes[n]!.push(row.at);
      }
    }
    start = end;
  }
  return Uint8Array.from(strikes, (times, n) => (silenced(standingStrikes[n]!, nowMs) ? 2 : silenced(times, nowMs) ? 1 : 0));
}

export interface NetworkTally {
  slopNetworks: Int32Array; // per account
  slopTrust: Float64Array; // per account: Σ voice trust of the slop networks
  anchors: Int32Array; // per account: slop networks whose voice has standing
  anchorTrust: Float64Array;
  notSlop: Int32Array; // per account: not-slop networks whose voice has standing
  notSlopTrust: Float64Array;
  dissent: Int32Array; // per account: not-slop networks without standing (in no test)
  voices: FactorVote[]; // the voices of the factor model (every slop voice, not slop with standing), sorted by (account, network)
}

interface Side { slop: number; notSlop: number; bestSlop: number; bestNotSlop: number }
const emptySide = (): Side => ({ slop: 0, notSlop: 0, bestSlop: 0, bestNotSlop: 0 });

// One voice per network on each account (SPEC.md 13.2). If votes that carry standing (withStanding) on the
// network count, only they make the voice: the weighted majority, with the trust of the most trusted voter
// on its side; an even split has no voice. Else a slop vote of the others makes a slop voice without
// standing. "Not slop" counts only with standing: a network with nothing but not-slop votes without
// standing has no voice and counts in dissent alone. counted holds the votes that passed the budget,
// inert the not-slop votes without standing that would count if they had standing (weight, not before
// the clear). votes must be sorted by (a, u).
export function tallyNetworks(
  votes: PreparedVote[], counted: Uint8Array, inert: Uint8Array, network: Int32Array, trust: Float64Array, weight: Float64Array, withStanding: Uint8Array,
  nAccounts: number,
): NetworkTally {
  const t: NetworkTally = {
    slopNetworks: new Int32Array(nAccounts), slopTrust: new Float64Array(nAccounts),
    anchors: new Int32Array(nAccounts), anchorTrust: new Float64Array(nAccounts),
    notSlop: new Int32Array(nAccounts), notSlopTrust: new Float64Array(nAccounts), dissent: new Int32Array(nAccounts),
    voices: [],
  };
  for (let start = 0; start < votes.length; ) {
    const a = votes[start]!.a;
    let end = start;
    const sides = new Map<number, [Side, Side]>(); // per network: [votes without standing, votes with standing]
    const dissenting = new Set<number>();
    for (; end < votes.length && votes[end]!.a === a; end++) {
      const v = votes[end]!;
      const n = network[v.u]!;
      if (inert[end]) dissenting.add(n);
      if (!counted[end]) continue;
      let pair = sides.get(n);
      if (!pair) sides.set(n, (pair = [emptySide(), emptySide()]));
      const side = pair[withStanding[end]!]!;
      if (v.value === 1) {
        side.slop += weight[v.u]!;
        side.bestSlop = Math.max(side.bestSlop, trust[v.u]!);
      } else {
        side.notSlop += weight[v.u]!;
        side.bestNotSlop = Math.max(side.bestNotSlop, trust[v.u]!);
      }
    }
    for (const n of [...sides.keys()].sort((x, y) => x - y)) {
      const [plain, withS] = sides.get(n)!;
      const hasStanding = withS.slop + withS.notSlop > 0;
      const s = hasStanding ? withS : plain;
      if (s.slop === s.notSlop) continue;
      const value: 0 | 1 = s.slop > s.notSlop ? 1 : 0;
      const w = value === 1 ? s.bestSlop : s.bestNotSlop;
      dissenting.delete(n);
      if (value === 1) {
        t.slopNetworks[a]!++;
        t.slopTrust[a]! += w;
        if (hasStanding) { t.anchors[a]!++; t.anchorTrust[a]! += w; }
      } else {
        t.notSlop[a]!++;
        t.notSlopTrust[a]! += w;
      }
      t.voices.push({ a, u: n, value, w });
    }
    t.dissent[a] = dissenting.size;
    start = end;
  }
  return t;
}
