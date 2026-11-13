// The one three.js scene of the landing page: the flood, the river, the bridge, the drain.
// Loaded lazily; the page works without it. Everything moves in the vertex shader; the frame loop only sets uniforms.

import {
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  NoToneMapping,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildAtlas } from './atlas.ts';
import { cameraPose, cameraPoses } from './camera.ts';
import { CARD_H, CARD_W, FIELD_LENGTH, NEAR_Z, buildCards, cardDepth } from './cards.ts';
import { buildField, type FieldZone } from './field.ts';
import { GALAXY_RADIUS, createBridgeLayer, createCardLayer, createHorizonGlow, createMark, createMarkGlow, type Shared } from './layers.ts';
import { readPalette } from './palette.ts';
import { SLOP } from './replies.ts';
import { damp, pageEnding, storyPicture, storyState, type StoryLayout, type StoryState } from './story.ts';
import { cheaperPixelRatio, frameWatchdog } from './watchdog.ts';

/** The canvas of the scene and its GL context. The page makes them, so it knows that the browser has WebGL2 before it loads this file. */
export interface SceneCanvas {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /** True for a GL that runs on the CPU. A scene that comes back on such a GL in the middle of a visit starts at its cheapest picture. */
  slow: boolean;
}

export interface SceneOptions extends SceneCanvas {
  host: HTMLElement;
  /** The element that receives pointer picks (the hero section). */
  pointerArea: HTMLElement;
  /** Elements whose text the flood must avoid; read again when the layout changes. */
  avoid: () => FieldZone[];
  /** Page height the field must cover, in CSS px. */
  fieldHeight: () => number;
  layout: () => StoryLayout;
  /** Called when the visitor hits a card: the account and how many accounts are left. */
  onHit: (handle: string, accountsLeft: number) => void;
  /** Called when the browser took the GL context away. The page starts a new scene on a new canvas. */
  onLost: () => void;
}

export interface SceneControl {
  /** True: the slop lanes burst and only the people stay. False: the flood comes back. */
  setClean(clean: boolean): void;
  /** Hits the slop account nearest the middle of the screen. Returns its handle, or null when none is left. */
  hitNext(): string | null;
  /** Hits every lane of this account (the thread's x buttons). */
  hitHandle(handle: string): void;
  /** Reads the page again after its layout changed. */
  refreshLayout(): void;
  destroy(): void;
}

const WAVE_SPEED = 130;
const GALAXY_SEPARATION = { landscape: 11.5, portrait: 9.5 };
const CUT_NONE = -1;
const REGROW_MS = 2200;
const CUT_NEAR = NEAR_Z - 8;
/** How fast the shown story follows the scroll position. */
const STORY_DAMP = 0.14;
/** The cheapest picture. A device that is slow at this resolution keeps the scene and draws fewer frames. */
const MIN_PIXEL_RATIO = 0.5;
const FRAME_BUDGET_MS = 34;
/** Picks ignore these targets: they are controls or text that the flood parts around. */
const NOT_A_CARD = 'a,button,input,select,textarea,[role="switch"],[data-flood-avoid]';

const SLOT_HANDLES = SLOP.map((line) => line.handle);

function createLaneTexture(data: Float32Array<ArrayBuffer>, laneCount: number): DataTexture {
  const texture = new DataTexture(data, laneCount, 1, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function createFieldTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export async function startScene(options: SceneOptions): Promise<SceneControl> {
  const { canvas, gl } = options;
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  let pixelRatio = options.slow ? MIN_PIXEL_RATIO : Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 1.75);
  const renderer = new WebGLRenderer({ canvas, context: gl, antialias: true, stencil: false });
  // three.js reads the alpha setting from a given context. The scene is opaque, as before.
  renderer.setClearAlpha(1);
  renderer.outputColorSpace = 'srgb-linear';
  renderer.toneMapping = NoToneMapping;

  const atlas = await buildAtlas();
  let palette = readPalette();

  const viewport = { width: 1, height: 1 };
  let layout = options.layout();
  const camera = new PerspectiveCamera(42, 1, 0.5, 360);
  const field = buildCards(options.host.clientWidth / Math.max(1, options.host.clientHeight));

  // R cut time, G cut depth, B regrow time, per lane.
  const laneData = new Float32Array(field.laneCount * 4).fill(CUT_NONE);
  const lanes = createLaneTexture(laneData, field.laneCount);
  const fieldTexture = createFieldTexture();

  const shared: Shared = {
    uTime: { value: 0 },
    uField0: { value: new Vector3(FIELD_LENGTH, NEAR_Z, WAVE_SPEED) },
    uStage: { value: { x: 0, y: 0, z: 1, w: 0 } },
    uGalaxy: { value: { x: GALAXY_SEPARATION.landscape, y: GALAXY_RADIUS, z: 0.55, w: 0.05 } },
    uAxis: { value: new Vector2(1, 0) },
    uFieldView: { value: new Vector3(1, 1, 0) },
    uField: { value: fieldTexture },
    uLanes: { value: lanes },
    uCardSize: { value: { x: CARD_W, y: CARD_H } },
    uPush: { value: 0.045 },
    uPixel: { value: 1 },
    uResolution: { value: new Vector2(1, 1) },
    uAspect: { value: 1 },
    uBg: { value: palette.bg },
    uAccent: { value: palette.accent },
  };

  const scene = new Scene();
  const cardLayer = createCardLayer(shared, field, atlas);
  const bridgeLayer = createBridgeLayer(shared);
  const horizon = createHorizonGlow();
  const markGlow = createMarkGlow();
  const mark = createMark(shared);
  scene.add(...cardLayer.meshes, ...bridgeLayer.meshes, horizon.mesh, markGlow.mesh, mark);
  const themed = [cardLayer, bridgeLayer, horizon, markGlow];

  function applyPalette(): void {
    palette = readPalette();
    scene.background = palette.bg;
    shared.uBg.value = palette.bg;
    shared.uAccent.value = palette.accent;
    for (const part of themed) part.setPalette(palette);
  }
  applyPalette();

  let poses = cameraPoses(1);
  const viewPoint = new Vector3();
  let cleanFactor = 0;

  function applyStory(state: StoryState): void {
    const pose = cameraPose(poses, state.stage, state.drain);
    const sway = state.stage < 1 ? Math.sin(shared.uTime.value * 0.2) * (1 - state.stage) * 2.4 : 0;
    camera.position.set(pose.position[0] + sway, pose.position[1], pose.position[2]);
    camera.up.set(...pose.up);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();

    const picture = storyPicture(state, ending);
    const stage = shared.uStage.value;
    stage.x = picture.morph;
    stage.y = picture.drain;
    stage.z = picture.field;
    stage.w = picture.river;

    bridgeLayer.update(state.bridge, picture.beam, picture.bridgeFade, viewport.height);
    horizon.update(picture.horizon * (1 + cleanFactor * 0.6));

    mark.visible = picture.mark > 0.001;
    mark.scale.setScalar(0.34 + 0.2 * picture.mark);
    mark.position.y = 3 * (1 - picture.mark);
    markGlow.update(picture.mark * (0.85 + state.drain * 0.3));
  }

  function applySize(): void {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(viewport.width, viewport.height, false);
    shared.uPixel.value = pixelRatio;
    renderer.getDrawingBufferSize(shared.uResolution.value);
  }

  function measure(): void {
    viewport.width = options.host.clientWidth;
    viewport.height = options.host.clientHeight;
    applySize();
    camera.aspect = viewport.width / viewport.height;
    camera.fov = viewport.width < viewport.height ? 56 : 42;
    camera.updateProjectionMatrix();
    poses = cameraPoses(camera.aspect);
    shared.uAspect.value = camera.aspect;
    const portrait = camera.aspect < 1;
    shared.uAxis.value.set(portrait ? 0 : 1, portrait ? 1 : 0);
    shared.uGalaxy.value.x = portrait ? GALAXY_SEPARATION.portrait : GALAXY_SEPARATION.landscape;
    shared.uFieldView.value.x = viewport.height;
  }

  function refreshLayout(): void {
    layout = options.layout();
    const fieldHeight = options.fieldHeight();
    const grid = buildField(options.avoid(), viewport.width, fieldHeight, narrow ? 140 : 280);
    fieldTexture.image = { data: grid.pixels, width: grid.width, height: grid.height };
    // A new size needs a new GPU texture: the old storage is immutable.
    fieldTexture.dispose();
    fieldTexture.needsUpdate = true;
    shared.uFieldView.value.y = fieldHeight;
  }

  measure();
  refreshLayout();

  const pageEnd = (): number => pageEnding(document.documentElement.scrollHeight - window.innerHeight - window.scrollY, layout.vh);
  // The story starts where the page is, so a reload or a new start in the middle of the page does not sweep the camera through the acts.
  const story = storyState(window.scrollY, layout);
  /** How far the page is into its end, smoothed like the story. */
  let ending = pageEnd();
  const onScreen = new Set<Element>();
  let frameHandle = 0;
  let looping = false;
  let last = performance.now();
  let visible = document.visibilityState === 'visible';

  /** A slow device gets a lower resolution. The scene never stops for speed. */
  function lowerQuality(medianMs: number): void {
    const next = cheaperPixelRatio(pixelRatio, medianMs, FRAME_BUDGET_MS, MIN_PIXEL_RATIO);
    if (next === pixelRatio) return;
    pixelRatio = next;
    applySize();
  }
  const sampleFrame = frameWatchdog(20, 60, FRAME_BUDGET_MS, lowerQuality);

  function frame(now: number): void {
    frameHandle = 0;
    const elapsed = now - last;
    last = now;
    const dt = Math.min(0.1, elapsed / 1000);
    shared.uTime.value += dt;
    shared.uFieldView.value.z = window.scrollY;
    const target = storyState(window.scrollY, layout);
    story.stage = damp(story.stage, target.stage, STORY_DAMP, dt);
    story.bridge = damp(story.bridge, target.bridge, STORY_DAMP, dt);
    story.drain = damp(story.drain, target.drain, STORY_DAMP, dt);
    ending = damp(ending, pageEnd(), STORY_DAMP, dt);
    applyStory(story);
    renderer.render(scene, camera);
    if (shouldLoop()) {
      sampleFrame(elapsed);
      schedule();
    }
  }

  function shouldLoop(): boolean {
    return onScreen.size > 0 && visible;
  }

  function schedule(): void {
    if (!frameHandle) frameHandle = requestAnimationFrame(frame);
  }

  function updateLoop(): void {
    const should = shouldLoop();
    if (should && !looping) last = performance.now();
    looping = should;
    if (should) schedule();
  }

  const onVisibility = (): void => {
    visible = document.visibilityState === 'visible';
    updateLoop();
  };

  const onResize = (): void => {
    if (options.host.clientWidth === viewport.width && options.host.clientHeight === viewport.height) return;
    measure();
    refreshLayout();
  };

  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = (): void => {
    applyPalette();
  };

  function now(): number {
    return shared.uTime.value;
  }

  function cutLane(lane: number, depth: number, delay = 0): void {
    laneData[lane * 4] = now() + delay;
    laneData[lane * 4 + 1] = depth;
    laneData[lane * 4 + 2] = CUT_NONE;
    lanes.needsUpdate = true;
  }

  function laneIsAlive(lane: number): boolean {
    const cut = laneData[lane * 4]!;
    return cut === CUT_NONE || cut > now();
  }

  const handleOf = (lane: number): string => SLOT_HANDLES[field.laneSlot[lane]!] ?? '';

  function cutHandle(handle: string, depth: number): void {
    for (let lane = 0; lane < field.laneCount; lane++) if (handleOf(lane) === handle) cutLane(lane, depth);
  }

  function accountsLeft(): number {
    const alive = new Set<number>();
    for (let lane = 0; lane < field.laneCount; lane++) if (laneIsAlive(lane)) alive.add(field.laneSlot[lane]!);
    return alive.size;
  }

  /** The nearest live slop card under the pointer. Cards are billboards, so the test runs in view space. */
  function cardAt(clientX: number, clientY: number): { instance: number; lane: number; depth: number } | null {
    if (story.stage > 1.4) return null;
    const ndcX = (clientX / viewport.width) * 2 - 1;
    const ndcY = 1 - (clientY / viewport.height) * 2;
    const scaleX = camera.projectionMatrix.elements[0]!;
    const scaleY = camera.projectionMatrix.elements[5]!;
    const t = now();
    let nearest = Infinity;
    let hit: { instance: number; lane: number; depth: number } | null = null;
    for (let i = field.people; i < field.total; i++) {
      const lane = field.a[i * 4 + 1]!;
      if (!laneIsAlive(lane)) continue;
      const depth = cardDepth(field.a[i * 4 + 2]!, field.b[i * 4]!, t);
      viewPoint.set(field.laneX[lane]!, 0, depth).applyMatrix4(camera.matrixWorldInverse);
      const distance = -viewPoint.z;
      if (distance < camera.near || distance >= nearest) continue;
      if (Math.abs(ndcX - (scaleX * viewPoint.x) / distance) > (scaleX * CARD_W) / (2 * distance)) continue;
      if (Math.abs(ndcY - (scaleY * viewPoint.y) / distance) > (scaleY * CARD_H) / (2 * distance)) continue;
      nearest = distance;
      hit = { instance: i, lane, depth };
    }
    return hit;
  }

  const area = options.pointerArea;
  let hoverFrame = 0;
  let hoverEvent: PointerEvent | null = null;

  function setHover(instance: number): void {
    cardLayer.uHover.value = instance;
    area.classList.toggle('is-over-card', instance >= 0);
  }

  function isOnPage(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(NOT_A_CARD) !== null;
  }

  function updateHover(): void {
    hoverFrame = 0;
    if (!hoverEvent) return;
    const event = hoverEvent;
    hoverEvent = null;
    setHover(isOnPage(event.target) ? -1 : (cardAt(event.clientX, event.clientY)?.instance ?? -1));
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    hoverEvent = event;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
  };

  const onPointerLeave = (): void => {
    hoverEvent = null;
    setHover(-1);
  };

  const onClick = (event: MouseEvent): void => {
    if (isOnPage(event.target)) return;
    const hit = cardAt(event.clientX, event.clientY);
    if (!hit) return;
    const handle = handleOf(hit.lane);
    cutHandle(handle, hit.depth);
    setHover(-1);
    options.onHit(handle, accountsLeft());
  };

  const sections = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onScreen.add(entry.target);
        else onScreen.delete(entry.target);
      }
      updateLoop();
    },
    { rootMargin: '10% 0px' },
  );

  const onContextLost = (): void => {
    options.onLost();
  };

  // The browser can take the context away while the scene builds. No event tells the page then, so the start fails and the page tries again.
  if (gl.isContextLost()) throw new Error('GL context lost during the start');

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  scheme.addEventListener('change', onScheme);
  area.addEventListener('pointermove', onPointerMove, { passive: true });
  area.addEventListener('pointerleave', onPointerLeave);
  area.addEventListener('click', onClick);
  canvas.addEventListener('webglcontextlost', onContextLost);
  for (const section of document.querySelectorAll('[data-scene-section]')) sections.observe(section);

  options.host.append(canvas);

  let regrowTimer = 0;

  function regrowAll(): void {
    const time = now();
    for (let lane = 0; lane < field.laneCount; lane++) laneData[lane * 4 + 2] = time;
    lanes.needsUpdate = true;
    regrowTimer = window.setTimeout(() => {
      laneData.fill(CUT_NONE);
      lanes.needsUpdate = true;
    }, REGROW_MS);
  }

  return {
    setClean(clean) {
      window.clearTimeout(regrowTimer);
      options.host.dataset.clean = String(clean);
      cleanFactor = clean ? 1 : 0;
      if (clean) {
        const middle = (field.laneCount - 1) / 2;
        for (let lane = 0; lane < field.laneCount; lane++) cutLane(lane, CUT_NEAR, (Math.abs(lane - middle) / middle) * 0.5);
      } else {
        regrowAll();
      }
    },
    hitNext() {
      const middle = (field.laneCount - 1) / 2;
      let best = -1;
      for (let lane = 0; lane < field.laneCount; lane++) {
        if (laneIsAlive(lane) && (best < 0 || Math.abs(lane - middle) < Math.abs(best - middle))) best = lane;
      }
      if (best < 0) return null;
      const handle = handleOf(best);
      cutHandle(handle, CUT_NEAR);
      return handle;
    },
    hitHandle(handle) {
      cutHandle(handle, CUT_NEAR);
    },
    refreshLayout() {
      refreshLayout();
    },
    destroy() {
      window.clearTimeout(regrowTimer);
      if (frameHandle) cancelAnimationFrame(frameHandle);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      sections.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      scheme.removeEventListener('change', onScheme);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerleave', onPointerLeave);
      area.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      area.classList.remove('is-over-card');
      renderer.dispose();
      // A browser keeps only a few GL contexts alive, so this one goes now and not at the next garbage collection.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
