// The factor model of the one-camp veto (SPEC.md 13.4). It decides nothing but the veto.
//
// Model: r ≈ μ + i_u + i_a + f_u·f_a, r = 1 (slop) or 0 (not slop), one factor.
// Loss:  Σ w·(r − pred)² + λ_i·(Σ_a i_a² + Σ_u max(1, W_u)·i_u²) + λ_f·(Σ_u f_u² + Σ_a f_a²)
//        subject to Σ_u W_u·f_u = 0, where W_u is the sum of the rater's vote weights.
// Fit:   alternating exact block minimization. The account block is one 2×2 ridge
//        system per account. The rater block is one 2×2 system per rater plus one
//        Lagrange multiplier for the centering constraint. A third step balances
//        the factor scale between raters and accounts. Each step lowers the
//        loss, so the fit converges; the epoch cap bounds the run time.
// README.md explains the fixed μ, the rater penalty and the centering.
export const MU = 0.5;
const LAMBDA_INTERCEPT = 0.15;
const LAMBDA_FACTOR = 0.03;
export const MAX_EPOCHS = 2000;
const CONVERGENCE_TOLERANCE = 1e-7;
const FACTOR_INIT_SCALE = 0.1;
// Cap on epochs × votes, so a run stays in its time budget at any size. 2000 epochs
// at 100 000 votes; a bigger vote table runs fewer epochs (README.md, Performance).
export const MAX_EPOCH_VOTES = 200_000_000;

export function epochLimit(nVotes: number): number {
  return Math.min(MAX_EPOCHS, Math.ceil(MAX_EPOCH_VOTES / Math.max(1, nVotes)));
}

// One rater is one network: u is the network, value its voice on the account, w the trust of that voice (network.ts).
export interface FactorVote { a: number; u: number; value: 0 | 1; w: number } // sorted by (a, u), w > 0

export interface FactorFit {
  ia: Float64Array;
  fa: Float64Array;
  iu: Float64Array;
  fu: Float64Array;
  epochs: number;
}

// FNV-1a of the id, mapped to [-1, 1): a deterministic, order-free start value.
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 2 ** 31 - 1;
}

// Solves [[sw+λi, swf], [swf, swff+λf]]·[i, f] = [swx, swfx].
export function solveAccount(sw: number, swf: number, swff: number, swx: number, swfx: number): [number, number] {
  const a11 = sw + LAMBDA_INTERCEPT;
  const a22 = swff + LAMBDA_FACTOR;
  const det = a11 * a22 - swf * swf;
  return [(a22 * swx - swf * swfx) / det, (a11 * swfx - swf * swx) / det];
}

export function factorize(votes: FactorVote[], nAccounts: number, raterIds: string[]): FactorFit {
  const nV = votes.length;
  const nU = raterIds.length;
  const vU = new Int32Array(nV);
  const vA = new Int32Array(nV);
  const vX = new Float64Array(nV); // r − μ
  const vW = new Float64Array(nV);
  const accStart = new Int32Array(nAccounts + 1);
  const raterStart = new Int32Array(nU + 1);
  const W = new Float64Array(nU);
  for (let k = 0; k < nV; k++) {
    const v = votes[k]!;
    vA[k] = v.a;
    vU[k] = v.u;
    vX[k] = v.value - MU;
    vW[k] = v.w;
    accStart[v.a + 1]!++;
    raterStart[v.u + 1]!++;
    W[v.u]! += v.w;
  }
  for (let a = 0; a < nAccounts; a++) accStart[a + 1]! += accStart[a]!;
  for (let u = 0; u < nU; u++) raterStart[u + 1]! += raterStart[u]!;
  const raterVotes = new Int32Array(nV);
  const next = raterStart.slice(0, nU);
  for (let k = 0; k < nV; k++) raterVotes[next[vU[k]!]!++] = k;

  const ia = new Float64Array(nAccounts);
  const fa = new Float64Array(nAccounts);
  const iu = new Float64Array(nU);
  const fu = new Float64Array(nU);
  const lambdaU = new Float64Array(nU);
  for (let u = 0; u < nU; u++) {
    if (W[u]! > 0) fu[u] = FACTOR_INIT_SCALE * hashUnit(raterIds[u]!);
    lambdaU[u] = LAMBDA_INTERCEPT * Math.max(1, W[u]!);
  }
  const accountStep = (): number => {
    let delta = 0;
    for (let a = 0; a < nAccounts; a++) {
      const end = accStart[a + 1]!;
      let s0 = 0, s1 = 0, s2 = 0, b1 = 0, b2 = 0;
      for (let k = accStart[a]!; k < end; k++) {
        const u = vU[k]!;
        const w = vW[k]!;
        const f = fu[u]!;
        const x = vX[k]! - iu[u]!;
        s0 += w;
        s1 += w * f;
        s2 += w * f * f;
        b1 += w * x;
        b2 += w * f * x;
      }
      if (s0 === 0) continue;
      const [i, f] = solveAccount(s0, s1, s2, b1, b2);
      delta = Math.max(delta, Math.abs(i - ia[a]!), Math.abs(f - fa[a]!));
      ia[a] = i;
      fa[a] = f;
    }
    return delta;
  };

  const i0 = new Float64Array(nU);
  const f0 = new Float64Array(nU);
  const h12 = new Float64Array(nU);
  const h22 = new Float64Array(nU);
  const raterStep = (): number => {
    let num = 0, den = 0;
    for (let u = 0; u < nU; u++) {
      const Wu = W[u]!;
      if (Wu === 0) continue;
      const end = raterStart[u + 1]!;
      let s1 = 0, s2 = 0, b1 = 0, b2 = 0;
      for (let j = raterStart[u]!; j < end; j++) {
        const k = raterVotes[j]!;
        const a = vA[k]!;
        const w = vW[k]!;
        const f = fa[a]!;
        const x = vX[k]! - ia[a]!;
        s1 += w * f;
        s2 += w * f * f;
        b1 += w * x;
        b2 += w * f * x;
      }
      const a11 = Wu + lambdaU[u]!;
      const a22 = s2 + LAMBDA_FACTOR;
      const det = a11 * a22 - s1 * s1;
      i0[u] = (a22 * b1 - s1 * b2) / det;
      f0[u] = (a11 * b2 - s1 * b1) / det;
      h12[u] = -s1 / det;
      h22[u] = a11 / det;
      num += Wu * f0[u]!;
      den += Wu * Wu * h22[u]!;
    }
    const nu = den > 0 ? num / den : 0; // multiplier that makes Σ W_u·f_u = 0
    let delta = 0;
    for (let u = 0; u < nU; u++) {
      const Wu = W[u]!;
      if (Wu === 0) continue;
      const i = i0[u]! - nu * Wu * h12[u]!;
      const f = f0[u]! - nu * Wu * h22[u]!;
      delta = Math.max(delta, Math.abs(i - iu[u]!), Math.abs(f - fu[u]!));
      iu[u] = i;
      fu[u] = f;
    }
    return delta;
  };

  // f_u·c and f_a/c give the same predictions. The c that minimizes the factor
  // penalty is (Σf_a² / Σf_u²)^¼. ALS alone moves slowly along this direction.
  const balanceStep = (): number => {
    let su = 0, sa = 0;
    for (let u = 0; u < nU; u++) su += fu[u]! * fu[u]!;
    for (let a = 0; a < nAccounts; a++) sa += fa[a]! * fa[a]!;
    if (su === 0 || sa === 0) return 0;
    const c = Math.sqrt(Math.sqrt(sa / su));
    for (let u = 0; u < nU; u++) fu[u]! *= c;
    for (let a = 0; a < nAccounts; a++) fa[a]! /= c;
    return Math.abs(c - 1);
  };

  const limit = epochLimit(nV);
  let epochs = 0;
  if (nV > 0) {
    while (epochs < limit) {
      epochs++;
      const delta = Math.max(accountStep(), raterStep(), balanceStep());
      if (delta < CONVERGENCE_TOLERANCE) break;
    }
  }
  return { ia, fa, iu, fu, epochs };
}

// The one-camp veto (SPEC.md 13.4). A network is two-sided when it has at least TWO_SIDED_MIN_VOICES
// voices on contested accounts (a slop voice and a not-slop voice with standing), slop and not slop among
// them: only such a network has a known stance. An account is fitted when at least FITTED_MIN_VOICES of
// its slop voices come from two-sided networks. A fitted account whose slop voices all lean to one side
// of the factor (|f_a| >= VETO_FACTOR in the fit of its slop voices) fails both crowd tests.
export const TWO_SIDED_MIN_VOICES = 3;
export const FITTED_MIN_VOICES = 4;
export const VETO_FACTOR = 0.5;

// Per network: 1 when it is two-sided.
export function twoSidedNetworks(votes: FactorVote[], nAccounts: number, nNetworks: number): Uint8Array {
  const hasSlop = new Uint8Array(nAccounts);
  const hasNotSlop = new Uint8Array(nAccounts);
  for (const v of votes) (v.value === 1 ? hasSlop : hasNotSlop)[v.a] = 1;
  const contested = new Int32Array(nNetworks);
  const slop = new Int32Array(nNetworks);
  for (const v of votes) {
    if (!hasSlop[v.a] || !hasNotSlop[v.a]) continue;
    contested[v.u]!++;
    slop[v.u]! += v.value;
  }
  return Uint8Array.from(contested, (n, u) => (n >= TWO_SIDED_MIN_VOICES && slop[u]! >= 1 && slop[u]! < n ? 1 : 0));
}

// Per account: the slop voices that come from two-sided networks.
export function twoSidedSlopVoices(votes: FactorVote[], twoSided: Uint8Array, nAccounts: number): Int32Array {
  const out = new Int32Array(nAccounts);
  for (const v of votes) if (v.value === 1 && twoSided[v.u]) out[v.a]!++;
  return out;
}

// The fit of each account on its slop voices alone, with the rater parameters of the full fit held
// fixed and f_u = 0 for every network that is not two-sided: a rater with no known stance moves no f_a.
export function slopSideFit(fit: FactorFit, votes: FactorVote[], twoSided: Uint8Array): FactorFit {
  const n = fit.ia.length;
  const side: FactorFit = { ...fit, fu: fit.fu.map((f, u) => (twoSided[u] ? f : 0)), ia: new Float64Array(n), fa: new Float64Array(n) };
  const [sw, swf, swff, swx, swfx] = [0, 0, 0, 0, 0].map(() => new Float64Array(n)) as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];
  for (const v of votes) {
    if (v.value !== 1) continue;
    const f = side.fu[v.u]!;
    const x = 1 - MU - fit.iu[v.u]!;
    sw[v.a]! += v.w;
    swf[v.a]! += v.w * f;
    swff[v.a]! += v.w * f * f;
    swx[v.a]! += v.w * x;
    swfx[v.a]! += v.w * f * x;
  }
  for (let a = 0; a < n; a++) {
    if (sw[a] === 0) continue;
    [side.ia[a], side.fa[a]] = solveAccount(sw[a]!, swf[a]!, swff[a]!, swx[a]!, swfx[a]!);
  }
  return side;
}
