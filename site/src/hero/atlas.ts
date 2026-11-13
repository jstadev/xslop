// Paints the reply cards into one texture: one slot per slop account and one per person. The shader only picks a slot.

import { CanvasTexture, type Texture } from 'three';
import { PEOPLE, SLOP, type FloodLine } from './replies.ts';

export const ATLAS_COLUMNS = 4;
const SLOT_W = 512;
const SLOT_H = 176;
const PADDING = 26;

export const SLOP_SLOTS = SLOP.length;
export const PEOPLE_SLOTS = PEOPLE.length;
export const ATLAS_ROWS = Math.ceil((SLOP_SLOTS + PEOPLE_SLOTS) / ATLAS_COLUMNS);

function paintSlot(ctx: CanvasRenderingContext2D, line: FloodLine, x: number, y: number): void {
  // Red channel: text. Green channel: the muted handle line. The shader chooses the colors per theme.
  const left = x + PADDING + 84;
  const textWidth = SLOT_W - PADDING * 2 - 84 - 8;
  ctx.fillStyle = '#ff0000';
  ctx.font = '700 31px "Mona Sans", ui-sans-serif, system-ui, sans-serif';
  ctx.fontStretch = 'semi-expanded';
  ctx.fillText(line.name, left, y + 52, textWidth);
  ctx.fillStyle = '#00ff00';
  ctx.font = '500 28px "Mona Sans", ui-sans-serif, system-ui, sans-serif';
  ctx.fontStretch = 'normal';
  ctx.fillText(`@${line.handle}`, left, y + 88, textWidth);
  ctx.fillStyle = '#ff0000';
  ctx.font = '500 32px "Mona Sans", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(line.text, x + PADDING, y + 142, SLOT_W - PADDING * 2);
}

/** Builds the atlas once the page font is available, so the cards use Mona Sans and not a fallback. */
export async function buildAtlas(): Promise<Texture> {
  await Promise.race([
    document.fonts.load('700 31px "Mona Sans"'),
    new Promise((resolve) => window.setTimeout(resolve, 1500)),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = SLOT_W * ATLAS_COLUMNS;
  canvas.height = SLOT_H * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.textBaseline = 'alphabetic';
  // Additive channels: name in red, handle in green, so one texture carries two text colors.
  ctx.globalCompositeOperation = 'lighter';
  [...SLOP, ...PEOPLE].forEach((line, i) => {
    paintSlot(ctx, line, (i % ATLAS_COLUMNS) * SLOT_W, Math.floor(i / ATLAS_COLUMNS) * SLOT_H);
  });
  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.flipY = false;
  return texture;
}
