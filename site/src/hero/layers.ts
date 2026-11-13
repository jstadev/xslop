// Builds the drawn parts of the scene. Each part takes shared uniforms and owns its geometry and material.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Blending,
  type Color,
  type DataTexture,
  type IUniform,
  type Texture,
} from 'three';
import { ATLAS_COLUMNS, ATLAS_ROWS } from './atlas.ts';
import { CARD_W, FIELD_LENGTH, NEAR_Z, seededRandom, type CardField } from './cards.ts';
import { createMarkGeometry } from './mark-geometry.ts';
import type { Palette } from './palette.ts';
import {
  BEAM_FRAGMENT,
  BEAM_VERTEX,
  CARD_FRAGMENT,
  CARD_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  HALO_FRAGMENT,
  HALO_VERTEX,
  MARK_FRAGMENT,
  MARK_VERTEX,
  SPARK_FRAGMENT,
  SPARK_VERTEX,
  VOTE_FRAGMENT,
  VOTE_VERTEX,
} from './shaders.ts';

const SPARKS_PER_LANE = 26;
const VOTES_PER_SIDE = 26;
/** Vote thickness: pixels of a line, as a share of half the viewport height. */
const LINE_PX = 2.8;
/** Half the height of the beam, in clip space. */
const BEAM_HALF_WIDTH = 0.096;

export const GALAXY_RADIUS = 7.2;

/** Uniforms that more than one part reads. */
export interface Shared {
  uTime: IUniform<number>;
  uField0: IUniform<Vector3>;
  uStage: IUniform<{ x: number; y: number; z: number; w: number }>;
  uGalaxy: IUniform<{ x: number; y: number; z: number; w: number }>;
  uAxis: IUniform<Vector2>;
  uFieldView: IUniform<Vector3>;
  uField: IUniform<DataTexture>;
  uLanes: IUniform<DataTexture>;
  uCardSize: IUniform<{ x: number; y: number }>;
  uPush: IUniform<number>;
  uPixel: IUniform<number>;
  uResolution: IUniform<Vector2>;
  uAspect: IUniform<number>;
  uBg: IUniform<Color>;
  uAccent: IUniform<Color>;
}

/** Every part follows the theme: colors copy over and the blend mode switches. */
export interface Themed {
  setPalette(palette: Palette): void;
}

function glowBlending(palette: Palette): Blending {
  return palette.dark ? AdditiveBlending : NormalBlending;
}

function quad(): PlaneGeometry {
  return new PlaneGeometry(1, 1);
}

function material(vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>, extra: ConstructorParameters<typeof ShaderMaterial>[0] = {}): ShaderMaterial {
  return new ShaderMaterial({ glslVersion: GLSL3, uniforms, vertexShader, fragmentShader, ...extra });
}

const OVERLAY = { transparent: true, depthWrite: false, premultipliedAlpha: true } as const;

function floating(mesh: Mesh | Points, renderOrder: number): void {
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
}

export interface CardLayer extends Themed {
  meshes: (Mesh | Points)[];
  uHover: IUniform<number>;
}

export function createCardLayer(shared: Shared, field: CardField, atlas: Texture): CardLayer {
  const uHover: IUniform<number> = { value: -1 };
  const shape = quad();
  const geometry = new InstancedBufferGeometry();
  geometry.index = shape.index;
  geometry.setAttribute('position', shape.getAttribute('position'));
  geometry.setAttribute('uv', shape.getAttribute('uv'));
  geometry.setAttribute('aA', new InstancedBufferAttribute(field.a, 4));
  geometry.setAttribute('aB', new InstancedBufferAttribute(field.b, 4));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(field.seed, 4));
  geometry.instanceCount = field.total;

  const cardUniforms: Record<string, IUniform> = {
    ...shared,
    uHover,
    uAtlas: { value: atlas },
    uCardFill: { value: null },
    uCardBorder: { value: null },
    uCardText: { value: null },
    uCardMuted: { value: null },
    uPersonFill: { value: null },
    uPersonText: { value: null },
    uAtlasRows: { value: ATLAS_ROWS },
    uAtlasColumns: { value: ATLAS_COLUMNS },
  };
  const cards = new Mesh(geometry, material(CARD_VERTEX, CARD_FRAGMENT, cardUniforms));
  floating(cards, 0);

  const haloGeometry = new InstancedBufferGeometry();
  haloGeometry.index = geometry.index;
  for (const name of ['position', 'aA', 'aB', 'aSeed']) haloGeometry.setAttribute(name, geometry.getAttribute(name));
  haloGeometry.instanceCount = field.people;
  const haloUniforms: Record<string, IUniform> = { ...shared, uHalo: { value: null } };
  const haloMaterial = material(HALO_VERTEX, HALO_FRAGMENT, haloUniforms, OVERLAY);
  const halos = new Mesh(haloGeometry, haloMaterial);
  floating(halos, 1);

  const sparks = createSparks(shared, field);
  const sparkMaterial = sparks.material as ShaderMaterial;

  return {
    meshes: [cards, halos, sparks],
    uHover,
    setPalette(palette) {
      cardUniforms.uCardFill!.value = palette.cardFill;
      cardUniforms.uCardBorder!.value = palette.cardBorder;
      cardUniforms.uCardText!.value = palette.cardText;
      cardUniforms.uCardMuted!.value = palette.cardMuted;
      cardUniforms.uPersonFill!.value = palette.personFill;
      cardUniforms.uPersonText!.value = palette.personText;
      haloUniforms.uHalo!.value = palette.halo;
      haloMaterial.blending = glowBlending(palette);
      sparkMaterial.blending = glowBlending(palette);
    },
  };
}

function createSparks(shared: Shared, field: CardField): Points {
  const count = field.laneCount * SPARKS_PER_LANE;
  const start = new Float32Array(count * 4);
  const direction = new Float32Array(count * 3);
  const random = seededRandom(77);
  for (let i = 0; i < count; i++) {
    const lane = Math.floor(i / SPARKS_PER_LANE);
    start[i * 4] = field.laneX[lane]! + (random() - 0.5) * CARD_W * 0.8;
    start[i * 4 + 1] = lane;
    start[i * 4 + 2] = NEAR_Z - random() * FIELD_LENGTH * 0.8;
    start[i * 4 + 3] = 3 + random() * 9;
    direction[i * 3] = (random() - 0.5) * 1.4;
    direction[i * 3 + 1] = 0.5 + random() * 1.2;
    direction[i * 3 + 2] = (random() - 0.5) * 1.2;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aS', new BufferAttribute(start, 4));
  geometry.setAttribute('aDir', new BufferAttribute(direction, 3));
  const { uTime, uField0, uLanes, uStage, uPixel, uAccent } = shared;
  const sparks = new Points(geometry, material(SPARK_VERTEX, SPARK_FRAGMENT, { uTime, uField0, uLanes, uStage, uPixel, uAccent }, OVERLAY));
  floating(sparks, 2);
  return sparks;
}

export interface BridgeLayer extends Themed {
  meshes: Mesh[];
  /** Places the layer for this frame: vote progress, beam reach and fade, each 0 to 1. */
  update(bridge: number, lit: number, fade: number, viewportHeight: number): void;
}

export function createBridgeLayer(shared: Shared): BridgeLayer {
  const { uTime, uAspect, uAccent, uGalaxy, uAxis } = shared;
  const total = VOTES_PER_SIDE * 2;
  const from = new Float32Array(total * 4);
  const start = new Float32Array(total);
  const random = seededRandom(991);
  for (let i = 0; i < total; i++) {
    const left = i < VOTES_PER_SIDE;
    const angle = random() * Math.PI * 2;
    const radius = 1.8 + random() * GALAXY_RADIUS * 0.72;
    from[i * 4] = left ? -1 : 1;
    from[i * 4 + 1] = Math.cos(angle) * radius;
    from[i * 4 + 2] = Math.sin(angle) * radius * 0.55;
    from[i * 4 + 3] = (random() - 0.5) * 1.5;
    // One side votes first, the other later: the bridge needs both.
    const order = (left ? i : i - VOTES_PER_SIDE) / VOTES_PER_SIDE;
    start[i] = left ? 0.06 + order * 0.38 : 0.5 + order * 0.34;
  }
  const shape = quad();
  const voteGeometry = new InstancedBufferGeometry();
  voteGeometry.index = shape.index;
  voteGeometry.setAttribute('position', shape.getAttribute('position'));
  voteGeometry.setAttribute('aFrom', new InstancedBufferAttribute(from, 4));
  voteGeometry.setAttribute('aStart', new InstancedBufferAttribute(start, 1));
  voteGeometry.instanceCount = total;

  const voteUniforms: Record<string, IUniform> = { uBridge: { value: 0 }, uAspect, uGalaxy, uAxis, uLineWidth: { value: 0.002 }, uFade: { value: 1 }, uVote: { value: null } };
  const votes = new Mesh(voteGeometry, material(VOTE_VERTEX, VOTE_FRAGMENT, voteUniforms, { ...OVERLAY, depthTest: false, side: DoubleSide }));
  floating(votes, 3);

  const beamUniforms: Record<string, IUniform> = {
    uTime,
    uAccent,
    uAspect,
    uGalaxy,
    uAxis,
    uLit: { value: 0 },
    uHalfWidth: { value: BEAM_HALF_WIDTH },
  };
  const beamMaterial = material(BEAM_VERTEX, BEAM_FRAGMENT, beamUniforms, { ...OVERLAY, depthTest: false, side: DoubleSide });
  const beam = new Mesh(quad(), beamMaterial);
  floating(beam, 4);

  return {
    meshes: [votes, beam],
    update(bridge, lit, fade, viewportHeight) {
      // Before the first vote and after the fade the layer draws nothing, so it leaves without a step.
      votes.visible = bridge > 0 && fade > 0;
      beam.visible = votes.visible;
      voteUniforms.uBridge!.value = bridge;
      voteUniforms.uFade!.value = fade;
      voteUniforms.uLineWidth!.value = LINE_PX / viewportHeight;
      beamUniforms.uLit!.value = lit;
    },
    setPalette(palette) {
      voteUniforms.uVote!.value = palette.vote;
      beamMaterial.blending = glowBlending(palette);
    },
  };
}

export interface Glow extends Themed {
  mesh: Mesh;
  /** Sets how strong the glow is, relative to the theme strength. */
  update(strength: number): void;
}

function createGlow(center: Vector3, width: number, height: number, darkStrength: number, lightStrength: number): Glow {
  const uniforms: Record<string, IUniform> = {
    uGlowCenter: { value: center },
    uGlowSize: { value: { x: width, y: height } },
    uGlowColor: { value: null },
    uGlowStrength: { value: 0 },
  };
  let theme = darkStrength;
  const mesh = new Mesh(quad(), material(GLOW_VERTEX, GLOW_FRAGMENT, uniforms, OVERLAY));
  floating(mesh, -1);
  return {
    mesh,
    update(strength) {
      mesh.visible = strength > 0.001;
      uniforms.uGlowStrength!.value = theme * strength;
    },
    setPalette(palette) {
      uniforms.uGlowColor!.value = palette.accent;
      theme = palette.dark ? darkStrength : lightStrength;
    },
  };
}

export function createHorizonGlow(): Glow {
  return createGlow(new Vector3(0, 0, -150), 210, 16, 1.15, 0.32);
}

export function createMarkGlow(): Glow {
  return createGlow(new Vector3(0, 0, -7), 52, 42, 1.25, 0.5);
}

export function createMark(shared: Shared): Mesh {
  const { uAccent, uBg } = shared;
  const mark = new Mesh(createMarkGeometry(1.8), material(MARK_VERTEX, MARK_FRAGMENT, { uAccent, uBg }, { side: DoubleSide }));
  mark.position.set(0, 0, -2);
  mark.frustumCulled = false;
  return mark;
}
