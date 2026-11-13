// The field that makes the flood part around the words. The headline and the reading blocks are painted into a small
// grid in page coordinates and blurred. Red cuts the cards along the headline; green and blue hold the push direction.
// Alpha marks the reading blocks. They are panes of glass: nothing is cut there, only the bright cards go dim.

export interface FieldZone {
  /** Page coordinates in CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Set for glyph-shaped zones (the headline): the text is drawn; otherwise the zone is a pane of glass. */
  text?: { value: string; font: string; stretch: CanvasFontStretch; baseline: number };
}

export interface FieldGrid {
  width: number;
  height: number;
  pixels: Uint8Array<ArrayBuffer>;
}

const BLUR_PASSES = 3;

/** Box blur along one axis, from src into dst. */
function blurAxis(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, vertical: boolean): void {
  const outer = vertical ? width : height;
  const inner = vertical ? height : width;
  const step = vertical ? width : 1;
  const span = radius * 2 + 1;
  for (let a = 0; a < outer; a++) {
    let index = vertical ? a : a * width;
    let sum = (radius + 1) * src[index]!;
    for (let i = 1; i <= radius; i++) sum += src[index + Math.min(i, inner - 1) * step]!;
    for (let i = 0; i < inner; i++) {
      dst[index + i * step] = sum / span;
      sum += src[index + Math.min(i + radius + 1, inner - 1) * step]! - src[index + Math.max(i - radius, 0) * step]!;
    }
  }
}

/** Blurs the painted masks (destroying them) and encodes them as RGBA: R word mask, G x push, B y push, A glass mask. */
export function encodeField(mask: Float32Array, glass: Float32Array, width: number, height: number, radius: number): Uint8Array<ArrayBuffer> {
  const scratch = new Float32Array(width * height);
  for (const painted of [mask, glass]) {
    for (let pass = 0; pass < BLUR_PASSES; pass++) {
      blurAxis(painted, scratch, width, height, radius, false);
      blurAxis(scratch, painted, width, height, radius, true);
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x + y * width;
      const left = mask[x > 0 ? i - 1 : i]!;
      const right = mask[x < width - 1 ? i + 1 : i]!;
      const up = mask[y > 0 ? i - width : i]!;
      const down = mask[y < height - 1 ? i + width : i]!;
      // Away from the words. The y axis of the grid runs down the page; clip space runs up, so y is flipped.
      const gx = left - right;
      const gy = down - up;
      pixels[i * 4] = Math.round(Math.min(1, mask[i]!) * 255);
      pixels[i * 4 + 1] = Math.round(((Math.max(-1, Math.min(1, gx * 3)) + 1) / 2) * 255);
      pixels[i * 4 + 2] = Math.round(((Math.max(-1, Math.min(1, gy * 3)) + 1) / 2) * 255);
      pixels[i * 4 + 3] = Math.round(Math.min(1, glass[i]!) * 255);
    }
  }
  return pixels;
}

/** Paints the zones into a small grid and encodes it. */
export function buildField(zones: readonly FieldZone[], pageWidth: number, pageHeight: number, cells: number): FieldGrid {
  const scale = cells / pageWidth;
  const width = cells;
  const height = Math.max(2, Math.ceil(pageHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  // Words go to the red channel and glass to the green one. The two add up, so one does not erase the other.
  ctx.globalCompositeOperation = 'lighter';
  ctx.textBaseline = 'alphabetic';
  for (const zone of zones) {
    ctx.fillStyle = zone.text ? '#f00' : '#0f0';
    if (zone.text) {
      ctx.font = zone.text.font.replace(/(\d+(?:\.\d+)?)px/, (_, size: string) => `${Number(size) * scale}px`);
      ctx.fontStretch = zone.text.stretch;
      ctx.fillText(zone.text.value, zone.x * scale, zone.text.baseline * scale);
    } else {
      ctx.beginPath();
      ctx.roundRect(zone.x * scale, zone.y * scale, zone.width * scale, zone.height * scale, 8 * scale);
      ctx.fill();
    }
  }
  const image = ctx.getImageData(0, 0, width, height).data;
  const mask = new Float32Array(width * height);
  const glass = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = image[i * 4]! / 255;
    glass[i] = image[i * 4 + 1]! / 255;
  }
  const pixels = encodeField(mask, glass, width, height, Math.max(3, Math.round(cells / 56)));
  return { width, height, pixels };
}
