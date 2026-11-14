// Reads the page's color tokens, so the scene follows brand/tokens.css and the theme of the page.

import { Color } from 'three';
import { currentTheme } from '../theme.ts';

export interface Palette {
  dark: boolean;
  bg: Color;
  accent: Color;
  cardFill: Color;
  cardBorder: Color;
  cardText: Color;
  cardMuted: Color;
  personFill: Color;
  personText: Color;
  halo: Color;
  vote: Color;
}

/** Resolves a CSS color (any syntax, oklch included) to sRGB by painting one pixel. */
function readToken(paint: CanvasRenderingContext2D, styles: CSSStyleDeclaration, token: string): Color {
  paint.fillStyle = styles.getPropertyValue(token).trim();
  paint.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = paint.getImageData(0, 0, 1, 1).data;
  return new Color(r / 255, g / 255, b / 255);
}

export function readPalette(): Palette {
  const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!paint) throw new Error('2d canvas unavailable');
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): Color => readToken(paint, styles, name);
  const dark = currentTheme() === 'dark';
  const bg = token('--color-bg');
  const text = token('--color-text');
  const line = token('--color-line');
  const muted = token('--color-text-muted');
  const accent = token('--xs-brand');
  return {
    dark,
    bg,
    accent,
    cardFill: token('--color-surface'),
    cardBorder: line.clone().lerp(text, 0.1),
    cardText: muted.clone().lerp(text, 0.18),
    cardMuted: muted.clone().lerp(line, 0.35),
    personFill: text.clone(),
    personText: bg.clone(),
    halo: dark ? text.clone() : accent.clone(),
    vote: text.clone(),
  };
}
