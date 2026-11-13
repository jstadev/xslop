// The attack search (round 2): runs the real computeScores over many runs in time, carries what the score
// job stores (standing, reputation, status, listedAt, confirmedAt) forward, and works the queues like an
// admin who approves real slop, rejects everything else with the penalty and accepts every appeal of a
// listed account that is not slop. The attacker owns `standing` installs that earned standing with real
// marks, any number of new installs on new networks, and plays one of the goals of the lane spec.
import { computeScores, type AccountInput, type ClearedVoteInput, type InstallInput, type ScoringInput, type ScoringOutput, type VoteInput } from '../../src/scoring/index.js';
import { DAY, HOUR, rng } from './helpers.js';

export type Goal = 'smear' | 'shield' | 'farm';
export interface Options { seed: number; standing: number; goal: Goal; days?: number; free?: number; honest?: number }
export interface Run { day: number; input: ScoringInput; out: ScoringOutput; admin: number }
export interface Result {
  runs: Run[];
  smearListedRuns: number; // runs in which an account that is not slop was listed
  smearListed: number; // distinct accounts that are not slop and were listed
  shieldHeld: number; // runs in which a real slop account with 6 or more anchors was held by a dispute
  attackerStanding: number; // attacker installs with standing at the end
  penalizedWithStanding: number; // ring installs with standing at the end that the admin caught (a stored wrong row) after their last good mark
  goodMarks: number; // Σ good marks at the end
  adminConfirms: number;
}

const START = Date.parse('2027-01-01T00:00:00.000Z');

export function campaign(o: Options): Result {
  const next = rng(o.seed);
  const days = o.days ?? 24;
  const honestN = o.honest ?? 30;
  const slopPool = Array.from({ length: 200 }, (_, i) => `realslop${String(i).padStart(3, '0')}`);
  const victims = Array.from({ length: 40 }, (_, i) => `victim${String(i).padStart(3, '0')}`);
  const isSlop = (h: string): boolean => h.startsWith('realslop');
  const installs = new Map<string, InstallInput>();
  const add = (id: string, at: number, ipHash = `net-${id}`): InstallInput => {
    const ins: InstallInput = { id, createdAt: new Date(at), ipHash, banned: false, reputation: 0.5, trusted: false, standing: false };
    installs.set(id, ins);
    return ins;
  };
  const honest = Array.from({ length: honestN }, (_, i) => add(`honest${String(i).padStart(3, '0')}`, START + next() * HOUR));
  const ring = Array.from({ length: o.standing }, (_, i) => add(`ring${String(i).padStart(3, '0')}`, START + next() * HOUR));
  const votes = new Map<string, VoteInput>();
  const cast = (u: string, h: string, value: 0 | 1, at: number): void => { votes.set(`${u}/${h}`, { install: u, handle: h, value, at: new Date(at) }); };
  const accounts = new Map<string, AccountInput & { confirmedAt: number | null }>();
  const stateOf = (h: string) => accounts.get(h) ?? {
    handle: h, seed: false, clearedAt: null, override: null, overrideAt: null, listedAt: null, status: 'none' as const, identity: 'ok' as const, evidence: 0,
    protected: false, confirmedAt: null,
  };
  const cleared: ClearedVoteInput[] = [];
  const res: Result = { runs: [], smearListedRuns: 0, smearListed: 0, shieldHeld: 0, attackerStanding: 0, penalizedWithStanding: 0, goodMarks: 0, adminConfirms: 0 };
  const listedVictims = new Set<string>();
  const attackFrom = 10; // the ring behaves like honest users before this day
  let free = 0;

  for (let day = 1; day <= days; day++) {
    const dayStart = START + (day - 1) * DAY;
    // New real slop accounts appear every day; people mark the newest ones most.
    const known = Math.min(slopPool.length, 20 + 6 * day);
    const pick = (): string => slopPool[known - 1 - Math.floor(known * next() ** 2)]!;
    // Honest users: 2 real slop accounts a day each; the ring marks real slop early and often while it earns standing.
    for (const u of honest) for (let k = 0; k < 2; k++) { const h = pick(); if (!votes.has(`${u.id}/${h}`)) cast(u.id, h, 1, dayStart + next() * 10 * HOUR); }
    if (day < attackFrom) {
      for (const u of ring) for (let k = 0; k < 4; k++) { const h = pick(); if (!votes.has(`${u.id}/${h}`)) cast(u.id, h, 1, dayStart + next() * HOUR); }
    } else if (o.goal === 'smear') {
      // Every ring install marks 10 victims a day, and new installs on new networks join each of them.
      const today = new Set<string>();
      for (const [i, u] of ring.entries()) {
        for (let k = 0; k < 10; k++) {
          const h = victims[(i * 10 + k + day * 7) % victims.length]!;
          cast(u.id, h, 1, dayStart + next() * HOUR);
          today.add(h);
        }
      }
      for (const h of [...today, ...victims.slice(0, 10)]) {
        for (let k = 0; k < (o.free ?? 6); k++) cast(add(`free${free++}`, dayStart, `freenet${free}`).id, h, 1, dayStart + next() * HOUR);
      }
    } else if (o.goal === 'shield') {
      // The ring says "not slop" on the real slop accounts that honest users mark most, and deletes the vote
      // as soon as the admin confirms the account.
      const marks = new Map<string, number>();
      for (const v of votes.values()) if (v.value === 1) marks.set(v.handle, (marks.get(v.handle) ?? 0) + 1);
      const open = slopPool.filter((h) => !accounts.get(h)?.override && marks.has(h)).sort((x, y) => marks.get(y)! - marks.get(x)! || (x < y ? -1 : 1)).slice(0, 10);
      for (const [i, u] of ring.entries()) {
        for (const h of slopPool) if (accounts.get(h)?.override === 'confirm' && votes.get(`${u.id}/${h}`)?.value === 0) votes.delete(`${u.id}/${h}`);
        for (let k = 0; k < 10 && open.length > 0; k++) cast(u.id, open[(i * 3 + k) % open.length]!, 0, dayStart + next() * HOUR);
      }
    } else {
      // Farm: mark victims, and after each admin decision delete or flip the vote and mark again.
      for (const [i, u] of ring.entries()) {
        for (let k = 0; k < 6; k++) {
          const h = victims[(i * 6 + k + day) % victims.length]!;
          if (votes.has(`${u.id}/${h}`) && next() < 0.5) votes.delete(`${u.id}/${h}`);
          else cast(u.id, h, next() < 0.5 ? 1 : 0, dayStart + next() * HOUR);
        }
      }
    }

    // The score job at noon.
    const now = dayStart + 12 * HOUR;
    const voteRows = [...votes.values()].filter((v) => v.at.getTime() <= now);
    const handles = [...new Set([...voteRows.map((v) => v.handle), ...accounts.keys()])].sort();
    const networksOf = new Map<string, Set<string>>();
    for (const v of voteRows) if (v.value === 1) (networksOf.get(v.handle) ?? networksOf.set(v.handle, new Set()).get(v.handle)!).add(installs.get(v.install)!.ipHash);
    const recent = (t: number | null): boolean => t !== null && t > now - DAY;
    const all = [...accounts.values()];
    const input: ScoringInput = {
      now: new Date(now),
      installs: [...installs.values()].map((x) => ({ ...x })),
      votes: voteRows,
      // The X facts job: every handle exists, and the votes name posts that the account wrote (a victim's own posts too).
      accounts: handles.map((h) => { const { confirmedAt: _, ...a } = stateOf(h); return { ...a, evidence: Math.min(3, networksOf.get(h)?.size ?? 0) }; }),
      sightings: [],
      clearedVotes: [...cleared],
      autoConfirmsToday: all.filter((a) => recent(a.confirmedAt) && !a.override && !a.seed).length,
      autoFlagsToday: all.filter((a) => recent(a.listedAt?.getTime() ?? null) && a.status === 'flagged' && !a.override && !a.seed).length,
    };
    const out = computeScores(input);
    for (const a of out.accounts) {
      const prev = stateOf(a.handle);
      const listed = a.tier >= 1;
      accounts.set(a.handle, {
        ...prev, status: a.status, listedAt: listed ? prev.listedAt ?? new Date(now) : prev.override === 'confirm' ? prev.listedAt : null,
        confirmedAt: a.parts.reason === 'votes_confirmed' && prev.status !== 'confirmed' ? now : prev.confirmedAt,
      });
      if (listed && !isSlop(a.handle)) { res.smearListedRuns++; listedVictims.add(a.handle); }
      if (isSlop(a.handle) && a.parts.gate === 'dispute' && a.parts.anchors >= 6) res.shieldHeld++;
    }
    for (const i of out.installs) Object.assign(installs.get(i.id)!, { reputation: i.reputation, standing: i.standing });

    // The admin, one hour after the run: the pending queue, the appeals of listed victims, the automatic confirms.
    const at = now + HOUR;
    let decisions = 0;
    for (const a of out.accounts) {
      const s = accounts.get(a.handle)!;
      if (s.override) continue;
      const confirmNow = isSlop(a.handle) && (a.status === 'pending' && a.parts.want !== null || a.parts.reason === 'votes_confirmed');
      const clearNow = !isSlop(a.handle) && (a.status === 'pending' || a.tier >= 1);
      if (confirmNow) {
        accounts.set(a.handle, { ...s, override: 'confirm', overrideAt: new Date(at), listedAt: s.listedAt ?? new Date(at), status: 'confirmed' });
        // The confirm stores the "not slop" votes set before it (round 2 H1), so a later delete keeps the penalty.
        for (const v of votes.values()) {
          if (v.handle !== a.handle || v.value !== 0) continue;
          const ins = installs.get(v.install)!;
          cleared.push({ install: ins.id, ipHash: ins.ipHash, handle: v.handle, value: 0, at: v.at, clearedAt: new Date(at), standing: ins.standing });
        }
        res.adminConfirms++;
        decisions++;
      } else if (clearNow) {
        accounts.set(a.handle, { ...s, override: 'clear', overrideAt: new Date(at), listedAt: null, status: 'cleared' });
        for (const v of votes.values()) {
          if (v.handle !== a.handle) continue;
          const ins = installs.get(v.install)!;
          cleared.push({ install: ins.id, ipHash: ins.ipHash, handle: v.handle, value: v.value, at: v.at, clearedAt: new Date(at), standing: ins.standing });
        }
        decisions++;
      }
    }
    res.runs.push({ day, input, out, admin: decisions });
  }
  const last = res.runs.at(-1)!.out;
  res.smearListed = listedVictims.size;
  res.attackerStanding = last.installs.filter((i) => i.standing && (i.id.startsWith('ring') || i.id.startsWith('free'))).length;
  res.goodMarks = last.installs.reduce((sum, i) => sum + i.goodMarks, 0);
  // The ring stops marking real slop on the attack day, so a ring install that the admin caught after it has no good mark left.
  const caught = new Set(cleared.filter((r) => r.install.startsWith('ring') && (r.value === 1) === !isSlop(r.handle)).map((r) => r.install));
  res.penalizedWithStanding = last.installs.filter((i) => i.standing && caught.has(i.id)).length;
  return res;
}
