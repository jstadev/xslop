// The launch model of SPEC.md 13.9 item 12, shared by simulation.test.ts and the README numbers.
// 200 users install on day 0. Each day each user marks 3 accounts (Zipf over 300 accounts), the
// engine runs at noon, the X facts job has checked every marked account (identity ok, evidence =
// min(slop networks, 3) of the run before), and an admin approves the pending queue once a day
// (every pending account whose crowd confirm test passes). The job stores what the engine returns.
import { computeScores, type AccountInput, type AccountScore, type InstallInput, type VoteInput } from '../../src/scoring/index.js';
import { DAY, HOUR, rng } from './helpers.js';

export interface LaunchDay { day: number; admin: number; auto: number; confirmed: number; flagged: number; pending: number; standing: number; autoNew: number }

export function launch(days = 14, o: { users?: number; pool?: number; perDay?: number; seed?: number; admin?: boolean } = {}): LaunchDay[] {
  const users = o.users ?? 200;
  const pool = o.pool ?? 300;
  const perDay = o.perDay ?? 3;
  const next = rng(o.seed ?? 12);
  const start = Date.parse('2026-12-01T00:00:00.000Z');
  const cum: number[] = [];
  let s = 0;
  for (let i = 1; i <= pool; i++) cum.push((s += 1 / i));
  const draw = (): number => {
    const x = next() * s;
    let lo = 0, hi = pool - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m]! < x) lo = m + 1; else hi = m; }
    return lo;
  };
  const handle = (a: number): string => `launch${String(a).padStart(3, '0')}`;
  const installs: InstallInput[] = Array.from({ length: users }, (_, i) => ({
    id: `user${String(i).padStart(3, '0')}`, createdAt: new Date(start + next() * HOUR), ipHash: `net${i}`, banned: false, reputation: 0.5, trusted: false, standing: false,
  }));
  const votes: VoteInput[] = [];
  const voted = new Set<string>();
  const state = new Map<string, AccountInput>();
  const stateOf = (h: string): AccountInput => state.get(h) ?? {
    handle: h, seed: false, clearedAt: null, override: null, overrideAt: null, listedAt: null, status: 'none', identity: 'ok', evidence: 0, protected: false,
  };
  const out: LaunchDay[] = [];
  for (let day = 1; day <= days; day++) {
    const dayStart = start + (day - 1) * DAY;
    const now = new Date(dayStart + DAY - 12 * HOUR + DAY / 2); // noon of the day
    for (const u of installs) {
      for (let k = 0; k < perDay; k++) {
        const h = handle(draw());
        if (voted.has(`${u.id}/${h}`)) continue;
        voted.add(`${u.id}/${h}`);
        votes.push({ install: u.id, handle: h, value: 1, at: new Date(dayStart + next() * (now.getTime() - dayStart)) });
      }
    }
    const handles = [...new Set(votes.map((v) => v.handle))].sort();
    const result = computeScores({ now, installs, votes, accounts: handles.map(stateOf), sightings: [], clearedVotes: [], autoConfirmsToday: 0, autoFlagsToday: 0 });
    let autoNew = 0;
    for (const a of result.accounts) {
      const prev = stateOf(a.handle);
      if (a.parts.reason === 'votes_confirmed' && prev.status !== 'confirmed') autoNew++;
      const listed = a.tier >= 1;
      state.set(a.handle, {
        ...prev, status: a.status, evidence: Math.min(a.parts.networks, 3),
        listedAt: listed ? prev.listedAt ?? now : null,
      });
    }
    for (const i of result.installs) {
      const ins = installs.find((x) => x.id === i.id)!;
      ins.reputation = i.reputation;
      ins.standing = i.standing;
    }
    const count = (pick: (a: AccountScore) => boolean) => result.accounts.filter(pick).length;
    out.push({
      day,
      admin: count((a) => a.parts.reason === 'override_confirm'),
      auto: count((a) => a.parts.reason === 'votes_confirmed'),
      confirmed: count((a) => a.status === 'confirmed'),
      flagged: count((a) => a.status === 'flagged'),
      pending: count((a) => a.status === 'pending'),
      standing: result.installs.filter((i) => i.standing).length,
      autoNew,
    });
    // The admin works through the queue one hour after the run.
    if (o.admin ?? true) {
      const at = new Date(now.getTime() + HOUR);
      for (const a of result.accounts) {
        if (a.status === 'pending' && a.parts.want === 'confirmed') {
          state.set(a.handle, { ...stateOf(a.handle), override: 'confirm', overrideAt: at, listedAt: at, status: 'confirmed' });
        }
      }
    }
  }
  return out;
}
