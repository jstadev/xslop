// Starts the scene in every browser that gives a WebGL2 context, loads it lazily, connects it to the page and brings it back when a start fails or the browser drops it.
// The static page is only for a browser with no WebGL2. Every word and every control is in the HTML before the scene starts.

import { req } from '../lib/dom.ts';
import { isSoftwareRenderer } from './detect.ts';
import type { FieldZone } from './field.ts';
import type { SceneCanvas, SceneControl } from './scene.ts';
import { xslop } from './state.ts';
import type { StoryLayout } from './story.ts';
import { startStoryPage } from './story-page.ts';

const AUTO_HIT_MS = 2600;
const LAYOUT_SETTLE_MS = 180;
/** The field is blurred, so a pane of glass needs this margin to dim the bright cards fully at its own edge. */
const ZONE_MARGIN_PX = 16;
/** Waits before a new start of the scene. The wait grows while the starts fail and stays at the last value. */
const RETRY_MS = [1000, 2000, 4000, 8000] as const;

type SceneModule = typeof import('./scene.ts');

const importScene = (): Promise<SceneModule> => import('./scene.ts');

/** Loads the scene file. A file that failed once stays failed for the document under its URL, in every browser, and a second import() makes no request.
 * A query makes a new URL. The source of `importScene` holds the name of the built file. */
function loadScene(failures: number): Promise<SceneModule> {
  const file = failures > 0 ? /["'`]([^"'`]+)["'`]/.exec(String(importScene))?.[1] : undefined;
  return file ? import(/* @vite-ignore */ new URL(`${file}?retry=${failures}`, import.meta.url).href) : importScene();
}

/** The canvas of the scene with its GL context, or null when the browser gives no WebGL2 context. This is the only context of the page. */
function createCanvas(): SceneCanvas | null {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  // The same drawing buffer that three.js asks for by itself.
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, stencil: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return { canvas, gl, slow: isSoftwareRenderer(String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER))) };
}

function pageTop(el: Element): number {
  return el.getBoundingClientRect().top + window.scrollY;
}

function storyLayout(): StoryLayout {
  const thread = req('#thread');
  const bridge = req('.bridge-track');
  const drain = req('.drain-track');
  return {
    vh: req('.bridge-pin').getBoundingClientRect().height,
    threadTop: pageTop(thread),
    bridgeTop: pageTop(bridge),
    bridgeBottom: pageTop(bridge) + bridge.getBoundingClientRect().height,
    drainTop: pageTop(drain),
    drainBottom: pageTop(drain) + drain.getBoundingClientRect().height,
  };
}

function textWidth(text: string, font: string): number {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  context.font = font;
  context.fontStretch = 'expanded';
  return context.measureText(text).width;
}

/** The headline zones are the laid-out words, so the flood parts around the letters themselves. The X logo is a block like the panes of glass: nothing is cut behind it. */
function titleZones(): FieldZone[] {
  const title = req('#hero-title');
  const style = getComputedStyle(title);
  const fontSize = parseFloat(style.fontSize);
  const font = `${style.fontWeight} ${style.fontSize} "Mona Sans", sans-serif`;
  const range = document.createRange();
  const zones: FieldZone[] = [];
  for (const line of title.querySelectorAll('.title-line')) {
    const box = line.getBoundingClientRect();
    const top = box.top + window.scrollY;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const data = node.textContent ?? '';
      const text = data.trim();
      if (!text || node.parentElement?.closest('.x-name')) continue;
      range.setStart(node, data.length - data.trimStart().length);
      range.setEnd(node, data.trimEnd().length);
      const run = range.getBoundingClientRect();
      const paint = textWidth(text, font);
      zones.push({
        x: run.left + (run.width - paint) / 2,
        y: top,
        width: paint,
        height: box.height,
        text: { value: text, font, stretch: 'expanded' as const, baseline: top + box.height / 2 + fontSize * 0.3 },
      });
    }
    for (const logo of line.querySelectorAll('.x-logo svg')) {
      const mark = logo.getBoundingClientRect();
      zones.push({ x: mark.left, y: mark.top + window.scrollY, width: mark.width, height: mark.height });
    }
  }
  return zones;
}

/** The panes of glass and the reading blocks. The flood runs under them; the scene only dims its bright cards there. */
function blockZones(): FieldZone[] {
  const zones: FieldZone[] = [];
  for (const el of document.querySelectorAll('[data-flood-avoid]:not(#hero-title), [data-river-avoid], .column')) {
    const box = el.getBoundingClientRect();
    if (box.width > 0) {
      zones.push({
        x: box.left - ZONE_MARGIN_PX,
        y: box.top + window.scrollY - ZONE_MARGIN_PX,
        width: box.width + ZONE_MARGIN_PX * 2,
        height: box.height + ZONE_MARGIN_PX * 2,
      });
    }
  }
  return zones;
}

export function initHero(): void {
  const root = document.documentElement;
  let scene: SceneControl | null = null;
  /** True from the first WebGL2 context on. From then on the page has the layout of the scene, and it keeps it. */
  let staged = false;
  let touched = false;
  let settleTimer = 0;
  let failedStarts = 0;
  let failedLoads = 0;

  const layoutWatch = new ResizeObserver(() => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => scene?.refreshLayout(), LAYOUT_SETTLE_MS);
  });

  function announceHit(_handle: string, accountsLeft: number): void {
    touched = true;
    if (accountsLeft === 0) xslop.set(true);
  }

  function playFirstHit(): void {
    if (!scene || touched || xslop.on || window.scrollY > 0) return;
    scene.hitNext();
  }

  function connect(control: SceneControl): void {
    scene = control;
    failedStarts = 0;
    // The visitor can reach the switch before the scene has loaded.
    if (xslop.on) control.setClean(true);
    layoutWatch.observe(req('main'));
    window.setTimeout(playFirstHit, AUTO_HIT_MS);
  }

  /** A start failed or the browser took the GL context away: the next start comes after a wait, on a new canvas. */
  function startLater(): void {
    scene?.destroy();
    scene = null;
    window.setTimeout(start, RETRY_MS[Math.min(failedStarts++, RETRY_MS.length - 1)]);
  }

  function start(): void {
    const target = createCanvas();
    if (!target) {
      // No WebGL2 is the only case for the static page. A later try that gets a context changes the page to the scene.
      if (!staged) root.classList.add('no-scene');
      startLater();
      return;
    }
    if (!staged) {
      staged = true;
      root.classList.remove('no-scene');
      root.classList.add('has-scene');
      startStoryPage(storyLayout);
    }
    loadScene(failedLoads)
      .then(
        ({ startScene }) =>
          startScene({
            ...target,
            host: req('#scene'),
            pointerArea: req('#flood'),
            avoid: () => [...titleZones(), ...blockZones()],
            fieldHeight: () => pageTop(req('.bridge-track')),
            layout: storyLayout,
            onHit: announceHit,
            onLost: startLater,
          }),
        (err: unknown) => {
          failedLoads++;
          throw err;
        },
      )
      .then(connect, (err: unknown) => {
        console.warn('xslop: the scene did not start', err);
        // The failed start never reached destroy(), so its context goes here.
        target.gl.getExtension('WEBGL_lose_context')?.loseContext();
        startLater();
      });
  }

  xslop.subscribe((on) => {
    touched = true;
    if (!scene) return;
    scene.setClean(on);
    // The thread folds, so the blocks that the flood parts around change their size.
    scene.refreshLayout();
  });
  document.addEventListener('xslop:hit', (event) => {
    if (event instanceof CustomEvent) scene?.hitHandle(event.detail);
  });

  start();
}
