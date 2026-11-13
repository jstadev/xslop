// A word breaks into pixels and comes back as the other word, every 3 s. The headline goes "slop", "bots", "slop", ...
// and the last line of the page goes "bots", "AI", "bots", ....
// The word in the HTML stays, so the line reads the same for screen readers, search and copy, and
// a page without JavaScript keeps it. A canvas over the word draws the change and the other word.

import { h, req } from '../lib/dom.ts';

const CYCLE_MS = 3000;
const MORPH_MS = 950;
/** Mosaic block sizes in em, fine to coarse. The morph climbs these steps and comes back down. */
const LEVELS = [0.02, 0.034, 0.052, 0.074, 0.1, 0.13];
/** The part of the morph in which the blocks change word, from left to right with noise. */
const SWAP_FROM = 0.2;
const SWAP_TO = 0.8;
/** Blocks this close to the change front light up in the accent colour. */
const FRONT = 0.08;
const MAX_DPR = 2;
const CANVAS_FONT = '"Mona Sans Canvas", "Mona Sans", sans-serif';

type Rgb = readonly [number, number, number];

interface Layout {
  width: number;
  height: number;
  blockUnit: number;
  /** The other word starts where the HTML word starts, so the word space stays. "bots" is 0.19 em wider than "slop" and ends inside the canvas margin (0.35 em). */
  left: number;
  baseline: number;
  font: string;
  spacing: string;
  /** Summed-area tables of the glyph alpha of both words, (width + 1) x (height + 1). */
  words: [Uint32Array, Uint32Array];
  ink: Rgb;
  accent: Rgb;
}

function hash(a: number, b: number, c: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A CSS colour as sRGB bytes; the canvas does the conversion. Null when the canvas does not know the colour syntax. */
function toRgb(ctx: CanvasRenderingContext2D, color: string): Rgb | null {
  ctx.fillStyle = '#010203';
  ctx.fillStyle = color;
  if (ctx.fillStyle === '#010203') return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** CANVAS_FONT is wide by itself (site.css), because a Safari canvas has no fontStretch. Without letterSpacing, "bots" stays inside the margin. */
function setFont(ctx: CanvasRenderingContext2D, font: string, spacing: string): void {
  ctx.font = font;
  ctx.fontStretch = 'expanded';
  ctx.letterSpacing = spacing;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

function glyphSum(width: number, height: number, layout: Pick<Layout, 'font' | 'spacing' | 'baseline' | 'left'>, text: string): Uint32Array {
  const canvas = h('canvas', { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sum = new Uint32Array((width + 1) * (height + 1));
  if (!ctx) return sum;
  setFont(ctx, layout.font, layout.spacing);
  ctx.fillText(text, layout.left, layout.baseline);
  const alpha = ctx.getImageData(0, 0, width, height).data;
  const stride = width + 1;
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let col = 0; col < width; col++) {
      row += alpha[(y * width + col) * 4 + 3]!;
      sum[(y + 1) * stride + col + 1] = sum[y * stride + col + 1]! + row;
    }
  }
  return sum;
}

/** Glyph coverage of one block, 0 to 1. */
function coverage(s: Uint32Array, stride: number, x0: number, y0: number, x1: number, y1: number): number {
  const total = s[y1 * stride + x1]! - s[y0 * stride + x1]! - s[y1 * stride + x0]! + s[y0 * stride + x0]!;
  return total / ((x1 - x0) * (y1 - y0) * 255);
}

export function initSwapWord(): void {
  swapWord(req('#hero-title'), 'bots');
  swapWord(req('#end-statement'), 'AI');
}

/** `title` is the line that holds the `.swap-word`; its colour is the colour of the other word. */
function swapWord(title: HTMLElement, otherWord: string): void {
  const word = req('.swap-word', title);
  const canvas = h('canvas', { class: 'swap-canvas', 'aria-hidden': 'true' });
  const mosaic = h('canvas');
  const ctx = canvas.getContext('2d');
  const mosaicCtx = mosaic.getContext('2d');
  const probe = h('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!ctx || !mosaicCtx || !probe) return;
  const weight = getComputedStyle(word).fontWeight;
  // The canvas draws with the page font, so it starts when that font is there (or has failed and both fall back).
  void document.fonts
    .load(`${weight} 1em ${CANVAS_FONT}`, `${word.textContent ?? ''}${otherWord}`)
    .catch(() => undefined)
    .then(() => run(title, word, otherWord, canvas, ctx, mosaic, mosaicCtx, probe));
}

function run(
  title: HTMLElement,
  word: HTMLElement,
  otherWord: string,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  mosaic: HTMLCanvasElement,
  mosaicCtx: CanvasRenderingContext2D,
  probe: CanvasRenderingContext2D,
): void {
  word.append(canvas);
  let layout: Layout | null = null;
  let shown: 0 | 1 = 0;
  let timer = 0;
  let frame = 0;
  let visible = true;

  function measure(): Layout | null {
    const box = canvas.getBoundingClientRect();
    const wordBox = word.getBoundingClientRect();
    if (box.width < 1 || wordBox.width < 1) return null;
    const style = getComputedStyle(word);
    // The line's colour: the word itself is transparent while the other word shows.
    const ink = toRgb(probe, getComputedStyle(title).color);
    const accent = toRgb(probe, style.getPropertyValue('--color-accent').trim());
    if (!ink || !accent) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.round(box.width * dpr);
    const height = Math.round(box.height * dpr);
    const fontPx = parseFloat(style.fontSize) * dpr;
    const font = `${style.fontWeight} ${fontPx}px ${CANVAS_FONT}`;
    const spacing = `${(parseFloat(style.letterSpacing) || 0) * dpr}px`;
    const text = word.firstChild?.textContent?.trim() ?? '';
    setFont(probe, font, spacing);
    const metrics = probe.measureText(text);
    const ascent = metrics.fontBoundingBoxAscent;
    const share = ascent / (ascent + metrics.fontBoundingBoxDescent) || 0.8;
    // The box of an inline word is the font's ascent plus descent, so the baseline is at the ascent's share of it.
    const baseline = (wordBox.top - box.top + wordBox.height * share) * dpr;
    const left = (wordBox.left - box.left) * dpr;
    const base = { font, spacing, baseline, left };
    canvas.width = width;
    canvas.height = height;
    return {
      ...base,
      width,
      height,
      blockUnit: fontPx,
      words: [glyphSum(width, height, base, text), glyphSum(width, height, base, otherWord)],
      ink,
      accent,
    };
  }

  /** The word between two morphs: the HTML word, or the other word on the canvas over the hidden HTML word. */
  function drawRest(): void {
    layout ??= measure();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const other = shown === 1 && layout !== null;
    word.classList.toggle('is-swapped', other);
    if (!layout || !other) return;
    setFont(ctx, layout.font, layout.spacing);
    ctx.fillStyle = `rgb(${layout.ink.join(' ')})`;
    ctx.fillText(otherWord, layout.left, layout.baseline);
  }

  /** One frame of the morph away from word `from`, at progress t (0 to 1). */
  function drawMorph(l: Layout, from: 0 | 1, t: number): void {
    const rise = smoothstep(1 - Math.abs(2 * t - 1));
    const level = Math.round(rise * (LEVELS.length - 1));
    const block = Math.max(2, Math.round(LEVELS[level]! * l.blockUnit));
    const mix = Math.min(1, Math.max(0, (t - SWAP_FROM) / (SWAP_TO - SWAP_FROM)));
    const cols = Math.ceil(l.width / block);
    const rows = Math.ceil(l.height / block);
    const stride = l.width + 1;
    const oldWord = l.words[from];
    const newWord = l.words[from === 0 ? 1 : 0];
    if (mosaic.width !== cols || mosaic.height !== rows) {
      mosaic.width = cols;
      mosaic.height = rows;
    }
    const image = mosaicCtx.createImageData(cols, rows);
    const px = image.data;
    for (let row = 0; row < rows; row++) {
      const y0 = row * block;
      const y1 = Math.min(l.height, y0 + block);
      // At the coarse steps a few rows tear sideways by one block, a new tear on each step.
      const tear = level >= 3 && hash(row, level, from) > 0.86 ? (hash(level, row, 7) > 0.5 ? 1 : -1) : 0;
      for (let col = 0; col < cols; col++) {
        const src = Math.min(cols - 1, Math.max(0, col - tear));
        const x0 = src * block;
        const x1 = Math.min(l.width, x0 + block);
        // The front moves left to right; the noise makes it ragged.
        const gate = 0.6 * hash(src, row, block) + 0.4 * (x0 / l.width);
        const covOld = coverage(oldWord, stride, x0, y0, x1, y1);
        const covNew = coverage(newWord, stride, x0, y0, x1, y1);
        const front = mix > 0 && mix < 1 && Math.abs(mix - gate) < FRONT && Math.max(covOld, covNew) > 0.04;
        const cov = mix > gate ? covNew : covOld;
        const alpha = front ? 1 : cov < 0.1 ? 0 : Math.min(1, Math.ceil(cov * 1.3 * 4) / 4);
        if (alpha === 0) continue;
        const rgb = front ? l.accent : l.ink;
        const i = (row * cols + col) * 4;
        px[i] = rgb[0];
        px[i + 1] = rgb[1];
        px[i + 2] = rgb[2];
        px[i + 3] = Math.round(alpha * 255);
      }
    }
    mosaicCtx.putImageData(image, 0, 0);
    ctx.clearRect(0, 0, l.width, l.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mosaic, 0, 0, cols * block, rows * block);
    // A thin gap between large blocks reads as a screen of pixels, not as a blur.
    if (block >= 8) {
      const gap = Math.max(1, Math.round(block * 0.08));
      ctx.globalCompositeOperation = 'destination-out';
      for (let x = block - gap; x < l.width; x += block) ctx.fillRect(x, 0, gap, l.height);
      for (let y = block - gap; y < l.height; y += block) ctx.fillRect(0, y, l.width, gap);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function morph(): void {
    timer = 0;
    if (!visible || document.hidden) return;
    layout ??= measure();
    const l = layout;
    if (!l) return;
    const from = shown;
    const start = performance.now();
    word.classList.add('is-swapped');
    const step = (now: number): void => {
      const t = (now - start) / MORPH_MS;
      if (t >= 1) {
        frame = 0;
        shown = from === 0 ? 1 : 0;
        drawRest();
        schedule(CYCLE_MS - MORPH_MS);
        return;
      }
      drawMorph(l, from, Math.max(0, t));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function schedule(delay: number): void {
    if (timer || frame) return;
    timer = window.setTimeout(morph, delay);
  }

  /** A new size or colour scheme: measure again, and redraw now unless a morph runs (the next one measures). */
  function remeasure(): void {
    layout = null;
    if (!frame) drawRest();
  }

  let settle = 0;
  new ResizeObserver(() => {
    window.clearTimeout(settle);
    settle = window.setTimeout(remeasure, 120);
  }).observe(title);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) schedule(CYCLE_MS - MORPH_MS);
  }).observe(title);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(CYCLE_MS - MORPH_MS);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', remeasure);
}
