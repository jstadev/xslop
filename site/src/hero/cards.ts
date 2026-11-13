// Lays out the flood: lanes of reply cards. One lane is one slop account; the people are scattered between the lanes.

import { PEOPLE_SLOTS, SLOP_SLOTS } from './atlas.ts';

export const CARD_W = 4.2;
export const CARD_H = CARD_W / 2.909;
export const FIELD_LENGTH = 190;
export const NEAR_Z = 30;

const LANE_GAP = 4.7;
const ROW_GAP = 3.1;
const MAX_LANES = 64;
const PEOPLE_SHARE = 0.034;
const LAYOUT_SEED = 40179;

export interface CardField {
  laneCount: number;
  /** All instances. People come first, so the halo pass can draw just the first `people` of them. */
  total: number;
  people: number;
  /** Per instance: lane x, lane index, phase, kind (0 slop, 1 person). */
  a: Float32Array<ArrayBuffer>;
  /** Per instance: speed, atlas slot, two seeds. */
  b: Float32Array<ArrayBuffer>;
  seed: Float32Array<ArrayBuffer>;
  laneX: Float32Array<ArrayBuffer>;
  laneSlot: Uint16Array<ArrayBuffer>;
}

/** A small seeded generator, so the flood has the same shape on every visit. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World position along the lane at time `t`. The vertex shader runs the same formula. */
export function cardDepth(phase: number, speed: number, t: number): number {
  return ((phase + speed * t) % FIELD_LENGTH) - (FIELD_LENGTH - NEAR_Z);
}

export function buildCards(aspect: number): CardField {
  const random = seededRandom(LAYOUT_SEED);
  // A phone can turn, so the field is as wide as the wider of its two views needs.
  const farHalfWidth = FIELD_LENGTH * 0.42 * Math.max(aspect, 1 / aspect) + 20;
  const laneCount = Math.min(MAX_LANES, Math.ceil((farHalfWidth * 2) / LANE_GAP));
  const rows = Math.ceil(FIELD_LENGTH / ROW_GAP);
  const laneX = new Float32Array(laneCount);
  const laneSpeed = new Float32Array(laneCount);
  const laneSlot = new Uint16Array(laneCount);
  for (let i = 0; i < laneCount; i++) {
    laneX[i] = (i - (laneCount - 1) / 2) * LANE_GAP;
    laneSpeed[i] = 1.25 + random() * 0.9;
    // 7 and 24 share no factor, so the lanes walk through every account before one repeats.
    laneSlot[i] = (i * 7 + 3) % SLOP_SLOTS;
  }

  const people = Math.round(laneCount * rows * PEOPLE_SHARE);
  const total = laneCount * rows + people;
  const a = new Float32Array(total * 4);
  const b = new Float32Array(total * 4);
  const seed = new Float32Array(total * 4);
  const fillSeeds = (i: number): void => {
    b[i * 4 + 2] = random();
    b[i * 4 + 3] = random();
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = random();
  };

  for (let i = 0; i < people; i++) {
    a[i * 4] = (random() - 0.5) * (laneCount - 1) * LANE_GAP;
    a[i * 4 + 1] = Math.floor(random() * laneCount);
    a[i * 4 + 2] = random() * FIELD_LENGTH;
    a[i * 4 + 3] = 1;
    b[i * 4] = 0.75 + random() * 0.3;
    b[i * 4 + 1] = SLOP_SLOTS + (i % PEOPLE_SLOTS);
    fillSeeds(i);
  }

  let index = people;
  for (let lane = 0; lane < laneCount; lane++) {
    const stagger = random() * ROW_GAP;
    for (let row = 0; row < rows; row++) {
      a[index * 4] = laneX[lane]!;
      a[index * 4 + 1] = lane;
      a[index * 4 + 2] = row * ROW_GAP + stagger;
      b[index * 4] = laneSpeed[lane]!;
      b[index * 4 + 1] = laneSlot[lane]!;
      fillSeeds(index);
      index++;
    }
  }
  return { laneCount, total, people, a, b, seed, laneX, laneSlot };
}
