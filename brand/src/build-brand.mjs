// Regenerates the brand files in brand/ from the logo geometry below and Mona Sans (SIL OFL 1.1).
// Text in og.svg is converted to outlines, so the files need no font at render time.
// One-off designer tool, not part of the release build. Run it from a scratch folder that has
// fontkit@2.0.4, wawoff2@2.0.1 and @fontsource-variable/mona-sans installed, with rsvg-convert on PATH:
//   node /path/to/brand/src/build-brand.mjs /path/to/brand
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'noop.js'));
const fontkit = require('fontkit');
const wawoff2 = require('wawoff2');
const out = process.argv[2];
if (!out) throw new Error('usage: node build-brand.mjs <brand-dir>');

const LOGO = '#007bff'; // the logo blue (--xs-logo): 5.28:1 on black, 3.98:1 on white. Logo files only.
const BRAND = '#3368fe'; // the interface blue (--xs-brand): 4.55:1 on black, 4.61:1 on white.
const INK_DARK = '#e9ebee';
const MUTED_DARK = '#8e9398';
const LINE_DARK = '#2b2e32';

// 32-unit mark, fitted by hand to the logo image: a reply bubble that melts into three drips, with an x cut through it.
const MARK = 'M9 1.5H23A6 6 0 0 1 29 7.5V17.8A4.4 4.4 0 0 1 24.6 22.2Q22.5 22.2 22.5 24.4V24.95A1.65 1.65 0 1 1 20.5 24.95V23.6Q20.5 22.3 19.2 22.3H17.6Q16.2 22.9 14.8 22.3Q12.3 22.3 12.3 24.8V26.75A2.4 2.4 0 1 1 8.3 26.75V24.2Q8.3 22.6 7.4 22.6A4.4 4.4 0 0 1 3 18.2V7.5A6 6 0 0 1 9 1.5z';
const MARK_X = 'M10.9 8.2l10 9.6m0-9.6-10 9.6';
const MARK_X_STROKE = 4.3;
// 16-unit variant, snapped to the pixel grid for 16 px rendering: the low middle bump is left out.
const MARK16 = 'M4 1h8a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2q-1.5 0-1.5 1.5v.75a.75.75 0 0 1-1.5 0V12q0-1-1-1H7.5q-1 0-1 1v1.75a1.25 1.25 0 0 1-2.5 0V12q0-1-1-1a2 2 0 0 1-2-2V4a3 3 0 0 1 3-3z';
const MARK16_X = 'M5.5 4l5 5m0-5-5 5';
// The lettering "slop", traced with potrace from the logo image. Units of the mark; it starts at x 30.5 of the lockup.
const WORD = 'M17.05 1.7c-.3.3-.3.3-.3 9.15 0 9.65-.05 9.25.65 9.75 .7.55.85 1.45.3 2.5-.6 1.2-.25 2.25.7 2.45 1.3.25 2.05-1.05 1.45-2.4-.5-1.15-.2-2.05.85-2.4 1.45-.5 1.4-.05 1.35-10.4-.05-10.15.3-8.95-2.65-8.95-2.05 0-2.05 0-2.35.3zM30.3 6c-4.55.65-7.4 3.65-7.4 7.8 0 3.25 1.25 5.4 3.9 6.7 1.6.75 1.95 1.6 1.25 2.95-.6 1.2-.1 2.35 1.05 2.35 1.1 0 1.65-1.05 1.25-2.25-.5-1.35.35-2.55 1.8-2.55 1.75 0 2.15 1.8.95 4.25-1.05 2.1-.4 3.85 1.35 3.85 1.8 0 2.4-1.6 1.45-3.85-.95-2.45-.65-3.95 1.15-5.3 5.5-4.35 3.8-12.4-2.9-13.8-.9-.2-2.95-.3-3.85-.15zM32.95 10.75c3.15 1.55 1.75 6.3-1.75 6.1-1.95-.15-3.15-1.5-3.05-3.4 .2-2.25 2.75-3.7 4.8-2.7zM49.6 6.05c-1 .3-1.4.45-2.15 1l-.65.45 0-.45c0-.8-.2-.85-2.55-.85-2.9 0-2.55-1.4-2.55 10.05 0 10.3-.05 9.85.6 10.2 .85.45 1 1.35.45 2.35-.75 1.35-.15 2.65 1.2 2.65 1.3 0 1.85-1.2 1.2-2.75-.5-1.15-.25-1.85.75-2.3 .8-.4.8-.4.85-3.25 0-2.45 0-2.5.25-2.7 .75-.6 1.75.55 1.75 2 0 .7 0 .8.25 1 .6.5 1.45.05 1.45-.7 0-.8.4-1.3 1.05-1.3 1.05 0 1.35 1.25.75 2.8-.65 1.55-.2 2.75 1.05 2.75 1.25 0 1.8-1.1 1.3-2.75-.55-1.75-.15-3.05 1.25-4.05 3.7-2.65 4.85-6.8 2.85-10.55-1.5-2.85-5.7-4.5-9.1-3.6zM52.2 10.95c1.35.7 1.95 2.1 1.5 3.65-.85 2.8-5.6 2.85-6.5.1-.9-2.8 2.25-5.15 5-3.75zM6.8 6.1c-4.55.6-7.15 3.35-6.05 6.35 .7 1.8 2.35 2.6 6.2 3.05 2.1.25 2.55.45 2.55 1.05 0 1.25-3.85 1.3-6.5.1-1.3-.65-1.25-.65-2.15.8-1.15 1.95-1.1 2 1.5 3.1 1.75.8 2.2 1.6 1.6 2.9-.5 1.2.05 2.35 1.15 2.35 1.1 0 1.7-1.15 1.25-2.45-.45-1.2.2-2.35 1.3-2.35 1.55 0 1.8 2.75.5 5.2-1.1 1.95-.5 3.65 1.2 3.65 1.75 0 2.45-1.7 1.6-3.8-1.2-2.95-.75-4.8 1.45-5.85 2.85-1.35 3.65-4.4 1.6-6.35-1-1.05-1.95-1.35-5.8-1.85-1.4-.2-1.85-.35-2-.8-.6-1.4 2.85-1.75 5.8-.55 1.2.5 1.3.45 1.85-.5 1.35-2.35 1.35-2.5.55-2.9-1.9-.95-5.25-1.5-7.6-1.15z';
const WORD_X = 30.5;
const LOCKUP_W = 93;

const ttf = Buffer.from(await wawoff2.decompress(readFileSync(require.resolve('@fontsource-variable/mona-sans/files/mona-sans-latin-wdth-normal.woff2'))));
const font = fontkit.create(ttf);
const round = (d) => d.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 10) / 10));

/** Outline `text` at the given weight and width; returns the path in font units and its advance. */
function outline(text, wght, wdth, track = 0) {
  const v = font.getVariation({ wght, wdth });
  let x = 0;
  let d = '';
  for (const { id } of font.glyphsForString(text)) {
    const g = v.getGlyph(id);
    d += g.path.scale(1, -1).translate(x, 0).toSVG();
    x += g.advanceWidth + track;
  }
  return { d: round(d), width: x - track };
}

const markGroup = (id, fill = LOGO, xFill = '#000') =>
  `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><path d="${MARK_X}" stroke="${xFill}" stroke-width="${MARK_X_STROKE}" stroke-linecap="round"/></mask></defs><path mask="url(#${id})" fill="${fill}" d="${MARK}"/>`;

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="xslop">${markGroup('xslop-x')}</svg>\n`;
const monoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">${markGroup('xslop-x-mono', 'currentColor')}</svg>\n`;
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><defs><mask id="x" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="#fff"/><path d="${MARK16_X}" stroke="#000" stroke-width="2" stroke-linecap="round"/></mask></defs><path mask="url(#x)" fill="${LOGO}" d="${MARK16}"/></svg>\n`;

const wordPath = (attrs) => `<path ${attrs} transform="translate(${WORD_X} 0)" d="${WORD}"/>`;
const wordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOCKUP_W} 32" width="${LOCKUP_W * 2}" height="64" role="img" aria-label="xslop"><style>.t{fill:#13191f}@media (prefers-color-scheme:dark){.t{fill:${INK_DARK}}}</style>${markGroup('xslop-wx')}${wordPath('class="t"')}</svg>\n`;

// Open Graph card, 1200 x 630.
function textAt(text, x, y, size, wght, wdth, fill, track = 0) {
  const o = outline(text, wght, wdth, track);
  return { svg: `<path fill="${fill}" transform="translate(${x} ${y}) scale(${size / 1000})" d="${o.d}"/>`, width: (o.width * size) / 1000 };
}
const og = [];
og.push(`<rect width="1200" height="630" fill="#000"/>`);
og.push(`<g transform="translate(80 64) scale(2)">${markGroup('og-x')}${wordPath(`fill="${INK_DARK}"`)}</g>`);
og.push(textAt('Hide AI reply slop', 80, 272, 96, 800, 125, INK_DARK, -12).svg);
og.push(textAt('on X.', 80, 370, 96, 800, 125, INK_DARK, -12).svg);
const rows = [['@growth_mindset_daily', 470], ['@insightful_takes_ai', 548]];
for (const [handle, y] of rows) {
  og.push(`<rect x="80" y="${y - 44}" width="1040" height="64" rx="12" fill="none" stroke="${LINE_DARK}" stroke-width="2"/>`);
  og.push(`<g transform="translate(100 ${y - 30}) scale(1.1)">${markGroup(`og-r${y}`)}</g>`);
  const a = textAt('Hidden reply from ', 152, y, 28, 500, 100, MUTED_DARK);
  og.push(a.svg);
  const b = textAt(handle, 152 + a.width, y, 28, 700, 100, INK_DARK);
  og.push(b.svg);
  const c = textAt('Show  ·  Undo', 152 + a.width + b.width + 28, y, 28, 600, 100, BRAND);
  og.push(c.svg);
}
og.push(textAt('x-slop.com', 80, 170, 26, 500, 100, MUTED_DARK).svg);
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">${og.join('')}</svg>\n`;

writeFileSync(join(out, 'mark.svg'), markSvg);
writeFileSync(join(out, 'mark-mono.svg'), monoSvg);
writeFileSync(join(out, 'favicon.svg'), faviconSvg);
writeFileSync(join(out, 'wordmark.svg'), wordmarkSvg);
writeFileSync(join(out, 'src', 'og.svg'), ogSvg);

const render = (src, size, dest) => execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), join(out, src), '-o', join(out, dest)]);
render('favicon.svg', 16, 'icon-16.png');
for (const size of [32, 48, 128]) render('mark.svg', size, `icon-${size}.png`);
execFileSync('rsvg-convert', ['-w', '1200', '-h', '630', join(out, 'src', 'og.svg'), '-o', join(out, 'og.png')]);
console.log('brand files written to', out);
