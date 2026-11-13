// Turns the scroll position into the state of the one scene: which act is on screen and how far it has run.
// Pure, so the choreography can be tested without a browser.

export interface StoryLayout {
  /** Height of the pinned stage, in CSS px. A phone's URL bar does not change it. */
  vh: number;
  threadTop: number;
  bridgeTop: number;
  bridgeBottom: number;
  drainTop: number;
  drainBottom: number;
}

export interface StoryState {
  /** Continuous act: 0 flood, 1 river, 2 bridge, 3 drain. */
  stage: number;
  /** Bridge progress, 0 at the start of the pinned bridge, 1 at its end. */
  bridge: number;
  /** Drain progress, 0 when the drain starts, 1 when the camera has passed through the mark. */
  drain: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const inverseLerp = (a: number, b: number, v: number): number => (b > a ? clamp01((v - a) / (b - a)) : v < a ? 0 : 1);

export function storyState(scrollY: number, layout: StoryLayout): StoryState {
  const { vh, threadTop, bridgeTop, bridgeBottom, drainTop, drainBottom } = layout;
  let stage = inverseLerp(0, Math.max(1, threadTop - vh * 0.15), scrollY);
  if (scrollY >= threadTop) {
    stage = 1;
    const toBridgeStart = bridgeTop - vh * 0.85;
    const toBridgeEnd = bridgeTop + vh * 0.25;
    if (scrollY >= toBridgeStart) stage = 1 + inverseLerp(toBridgeStart, toBridgeEnd, scrollY);
    const toDrainStart = drainTop - vh * 0.75;
    const toDrainEnd = drainTop + vh * 0.2;
    if (scrollY >= toDrainStart) stage = 2 + inverseLerp(toDrainStart, toDrainEnd, scrollY);
  }
  const bridgeStart = bridgeTop + vh * 0.25;
  const bridgeEnd = Math.max(bridgeStart + 1, bridgeBottom - vh * 0.9);
  const drainStart = drainTop + vh * 0.05;
  const drainEnd = Math.max(drainStart + 1, drainBottom - vh * 0.65);
  return {
    stage,
    bridge: inverseLerp(bridgeStart, bridgeEnd, scrollY),
    drain: inverseLerp(drainStart, drainEnd, scrollY),
  };
}

/** What the scene draws for one story state. Each value is a continuous function of the state: a value that starts at a fixed stage makes a step on the screen. */
export interface StoryPicture {
  /** 0: the cards run in their lanes. 1: they are the points of the two galaxies. */
  morph: number;
  /** 0: the galaxies stand. 1: every point is down the drain. */
  drain: number;
  /** How strongly the words part the flood. */
  field: number;
  /** 0: the flood, seen from the ground. 1: the river, seen from above. */
  river: number;
  /** The glow on the horizon of the flood. */
  horizon: number;
  /** How far the beam has crossed the gap. It leaves with the votes. */
  beam: number;
  /** 1 while the votes and the beam show, 0 when the drain has taken them. */
  bridgeFade: number;
  /** 0: no mark. 1: the mark at full size in the centre of the drain. */
  mark: number;
}

/** `ending` is the smoothed pageEnding. */
export function storyPicture({ stage, bridge, drain }: StoryState, ending: number): StoryPicture {
  const pull = Math.max(smootherstep(2.2, 3, stage) * 0.2, drain * 0.9 + 0.1 * smootherstep(2.5, 3, stage));
  const bridgeFade = 1 - Math.min(1, pull * 6);
  return {
    morph: smootherstep(1.28, 1.9, stage),
    // At the end of the page the last points finish their fall, so the last line stands on a clear screen.
    drain: Math.max(pull, ending),
    field: 1 - smootherstep(1.2, 1.5, stage),
    river: stage < 1 ? smootherstep(0.25, 1, stage) : 1 - smootherstep(1, 1.45, stage),
    horizon: 1 - smootherstep(0.6, 1.3, stage),
    beam: smootherstep(0.86, 0.98, bridge) * bridgeFade,
    bridgeFade,
    mark: smootherstep(2.45, 3, stage) * (1 - smootherstep(0.93, 1, drain)),
  };
}

/** How far the page is into its end: 0 until an eighth of a screen is left to scroll, 1 at the end. `left` is the scroll that is left, in CSS px. */
export function pageEnding(left: number, vh: number): number {
  const t = clamp01((left / vh - 0.025) / 0.1);
  return 1 - t * t * (3 - 2 * t);
}

/** One smoothing step toward `target`; `rate` is the fraction per 60 Hz frame. */
export function damp(current: number, target: number, rate: number, dtSec: number): number {
  const k = 1 - Math.pow(1 - rate, dtSec * 60);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 1e-4 ? target : next;
}
