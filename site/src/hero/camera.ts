// Where the camera stands in each act and on the way between them. Pure, so the whole path can be tested for steps without a GPU.

import { smootherstep } from './story.ts';

export type Vec3 = [x: number, y: number, z: number];

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

export type ActPoses = readonly [flood: CameraPose, river: CameraPose, bridge: CameraPose, drain: CameraPose];

/** In landscape the bridge sits this fraction of the screen height below the middle. It matches --bridge-centre (60lvh) in site.css. */
const BRIDGE_DROP = 0.1;
/** The camera sits this far above the point it looks at on the bridge. */
const BRIDGE_TILT = 3.5;
/** The dive ends here, behind the mark. */
const DIVE_END_Z = -6;
/** At the end of the dive the camera looks this far straight ahead. */
const DIVE_LOOK_AHEAD = 10;

/** How far above the bridge the camera must look so that the bridge lands BRIDGE_DROP below the middle of a 42° view. */
function bridgeRise(distance: number): number {
  const k = 2 * BRIDGE_DROP * Math.tan((21 * Math.PI) / 180);
  return (k * (BRIDGE_TILT * BRIDGE_TILT + distance * distance)) / (distance - BRIDGE_TILT * k);
}

export function cameraPoses(aspect: number): ActPoses {
  const portrait = aspect < 1;
  const up: Vec3 = [0, 1, 0];
  // The bridge and the drain sit below the text, so the camera looks a little above them.
  const landscapeDistance = 36 * Math.max(1, 1.6 / aspect);
  const bridge = portrait ? { rise: 3, distance: 40 } : { rise: bridgeRise(landscapeDistance), distance: landscapeDistance };
  const drain = portrait ? { rise: 7, distance: 55 } : { rise: 0, distance: 30 };
  return [
    { position: [0, portrait ? 17 : 13, portrait ? 38 : 25], target: [0, 0, portrait ? -22 : -15], up },
    { position: [0, portrait ? 80 : 62, -34], target: [0, 0, -34], up: [0, 0, -1] },
    { position: [0, bridge.rise + BRIDGE_TILT, bridge.distance], target: [0, bridge.rise, 0], up },
    { position: [0, drain.rise, drain.distance], target: [0, drain.rise, 0], up },
  ];
}

function mix(from: Vec3, to: Vec3, t: number): Vec3 {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/** The camera for a stage (0 flood, 1 river, 2 bridge, 3 drain) and a drain progress (0 to 1). */
export function cameraPose(poses: ActPoses, stage: number, drain: number): CameraPose {
  const act = Math.min(2, Math.floor(stage));
  const t = smootherstep(0, 1, stage - act);
  const from = poses[act]!;
  const to = poses[act + 1]!;
  const position = mix(from.position, to.position, t);
  const target = mix(from.target, to.target, t);
  // The last act dollies through the hole in the mark, straight down its axis.
  // The dive blends in from zero. A formula that starts at a fixed stage moves the picture in one step.
  const dive = Math.pow(drain, 1.8);
  position[1] *= 1 - dive;
  position[2] += (DIVE_END_Z - position[2]) * dive;
  target[1] *= 1 - dive;
  target[2] += (position[2] - DIVE_LOOK_AHEAD - target[2]) * dive;
  return { position, target, up: mix(from.up, to.up, t) };
}
