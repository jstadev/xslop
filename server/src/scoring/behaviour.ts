// Reply timing (SPEC.md 13.3): information for the review queue and for the public page of a listed
// account. It never changes a status. Fixed weights on features of verified sightings only: the X facts
// job checked that each post exists, that the account wrote it and that it answers the stored parent.
import type { SightingInput } from './types.js';

export const BEHAVIOUR_FEATURES = [
  'fastReplyShare', // share of replies with latency ≤ 60 s
  'veryFastReplyShare', // share of replies with latency ≤ 20 s
  'logMedianLatency', // ln(1 + median latency in s)
  'logMaxRepliesPerHour', // ln(1 + most replies in one rolling hour)
  'logDistinctParents', // ln(1 + distinct parent posts)
] as const;
const FAST_REPLY_SEC = 60;
const VERY_FAST_REPLY_SEC = 20;
const ROLLING_WINDOW_MS = 3_600_000;
export const BEHAVIOUR_MIN_SIGHTINGS = 10; // fewer verified sightings: parts.behaviour is 0

// z_k = (x_k − center_k) / scale_k; score = σ(bias + Σ weight_k·z_k). Center: a typical human reply
// pattern, scale: a typical spread, so a human-like account has z ≈ 0 and scores σ(−3) ≈ 0.05.
export const BEHAVIOUR_MODEL = Object.freeze({
  center: [0.2, 0.05, 6.0, 1.1, 1.8],
  scale: [0.25, 0.2, 1.5, 0.7, 1.0],
  weights: [1.0, 1.0, -0.8, 0.6, 0.3],
  bias: -3,
});

// Features of one account (NaN = missing). Sightings come newest first (input.ts).
export function accountFeatures(sightings: SightingInput[]): Float64Array {
  const out = new Float64Array(BEHAVIOUR_FEATURES.length).fill(Number.NaN);
  const n = sightings.length;
  if (n === 0) return out;
  const latencies: number[] = [];
  const parents = new Set<string>();
  let fast = 0, veryFast = 0, maxPerHour = 0;
  for (let j = 0, i = 0; j < n; j++) {
    const s = sightings[j]!;
    const t = s.replyAt.getTime();
    while (sightings[i]!.replyAt.getTime() - t >= ROLLING_WINDOW_MS) i++;
    maxPerHour = Math.max(maxPerHour, j - i + 1);
    if (s.latencySec !== null && s.latencySec >= 0) {
      latencies.push(s.latencySec);
      if (s.latencySec <= FAST_REPLY_SEC) fast++;
      if (s.latencySec <= VERY_FAST_REPLY_SEC) veryFast++;
    }
    if (s.parentTweetId !== null) parents.add(s.parentTweetId);
  }
  const L = latencies.length;
  if (L > 0) {
    latencies.sort((x, y) => x - y);
    const median = L % 2 ? latencies[(L - 1) / 2]! : (latencies[L / 2 - 1]! + latencies[L / 2]!) / 2;
    out[0] = fast / L;
    out[1] = veryFast / L;
    out[2] = Math.log1p(median);
  }
  out[3] = Math.log1p(maxPerHour);
  out[4] = Math.log1p(parents.size);
  return out;
}

export function behaviourScore(x: Float64Array): number {
  const m = BEHAVIOUR_MODEL;
  let z = m.bias;
  for (let k = 0; k < x.length; k++) {
    const v = x[k]!;
    if (!Number.isNaN(v)) z += (m.weights[k]! * (v - m.center[k]!)) / m.scale[k]!;
  }
  return 1 / (1 + Math.exp(-z));
}
