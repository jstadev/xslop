// The xslop mark as solid geometry: the reply bubble that melts into three drips (brand/mark.svg), with the x cut all
// the way through, so the camera can fly through it. Units of the 32 unit mark, centred on the x, y up.

import { ExtrudeGeometry, Path, Shape } from 'three';

// The centre of the x in the 32 unit mark.
const CX = 15.9;
const CY = 13;
// The x: arms to (CX ± X_DX, CY ± X_DY), round ends.
const X_DX = 5;
const X_DY = 4.8;
const X_HALF_STROKE = 2.15;

function bubbleShape(): Shape {
  const s = new Shape();
  const line = (x: number, y: number) => s.lineTo(x - CX, CY - y);
  const quad = (qx: number, qy: number, x: number, y: number) => s.quadraticCurveTo(qx - CX, CY - qy, x - CX, CY - y);
  // A quarter corner around (x, y), clockwise on the page from angle `a` (y up).
  const corner = (x: number, y: number, r: number, a: number) => s.absarc(x - CX, CY - y, r, a, a - Math.PI / 2, true);
  // A drip end: from (x + w, y) down around a round end of radius r, up to (x - w, y).
  const drip = (x: number, w: number, y: number, r: number) => {
    const h = Math.sqrt(r * r - w * w);
    const a = Math.atan2(h, w);
    s.absarc(x - CX, CY - y - h, r, a, Math.PI - a, true);
  };
  s.moveTo(9 - CX, CY - 1.5);
  line(23, 1.5);
  corner(23, 7.5, 6, Math.PI / 2);
  line(29, 17.8);
  corner(24.6, 17.8, 4.4, 0);
  quad(22.5, 22.2, 22.5, 24.4);
  line(22.5, 24.95);
  drip(21.5, 1, 24.95, 1.65);
  line(20.5, 23.6);
  quad(20.5, 22.3, 19.2, 22.3);
  line(17.6, 22.3);
  quad(16.2, 22.9, 14.8, 22.3);
  quad(12.3, 22.3, 12.3, 24.8);
  line(12.3, 26.75);
  drip(10.3, 2, 26.75, 2.4);
  line(8.3, 24.2);
  quad(8.3, 22.6, 7.4, 22.6);
  corner(7.4, 18.2, 4.4, -Math.PI / 2);
  line(3, 7.5);
  corner(9, 7.5, 6, Math.PI);
  return s;
}

/** The outline of the x: two strokes with round ends, counter-clockwise around the origin. */
function xHole(): Path {
  const p = new Path();
  const len = Math.hypot(X_DX, X_DY);
  const h = X_HALF_STROKE;
  // Where the edges of the two strokes cross: on the axes.
  const ox = (h * len) / X_DY;
  const oy = (h * len) / X_DX;
  const cap = (x: number, y: number, a: number) => p.absarc(x, y, h, a, a + Math.PI, false);
  cap(X_DX, X_DY, Math.atan2(-X_DX, X_DY));
  p.lineTo(0, oy);
  cap(-X_DX, X_DY, Math.atan2(X_DX, X_DY));
  p.lineTo(-ox, 0);
  cap(-X_DX, -X_DY, Math.atan2(X_DX, -X_DY));
  p.lineTo(0, -oy);
  cap(X_DX, -X_DY, Math.atan2(-X_DX, -X_DY));
  p.lineTo(ox, 0);
  p.closePath();
  return p;
}

export function createMarkGeometry(depth: number): ExtrudeGeometry {
  const shape = bubbleShape();
  shape.holes.push(xHole());
  return new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.28,
    bevelSize: 0.22,
    bevelSegments: 2,
    curveSegments: 10,
  });
}
