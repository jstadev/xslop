// The focal post: the live count, the mosaic of real avatars and the engagement row. All numbers come from the API.

import { request } from '../lib/api.ts';
import { h, prefersReducedMotion, req } from '../lib/dom.ts';
import { formatCount, formatRelative, formatStat } from '../lib/format.ts';
import { parseSloppersPage, parseStats, type Slopper, type SloppersPage, type Stats } from '../lib/schema.ts';

const OVERVIEW_PATH = '/api/v1/sloppers?limit=100';
const REFRESH_AFTER_MS = 60_000;
const COUNT_UP_MS = 700;
const MOSAIC_STAGGER_MS = 24;
const MOSAIC_MAX_PAGES = 4;
const TILE_PX = 54;
const METRICS = ['confirmed', 'flagged', 'votes', 'installs'] as const;

function countUp(el: HTMLElement, target: number): void {
  if (prefersReducedMotion() || target === 0) {
    el.textContent = formatCount(target);
    return;
  }
  const start = performance.now();
  const frame = (now: number): void => {
    const progress = Math.min(1, (now - start) / COUNT_UP_MS);
    el.textContent = formatCount(Math.round(target * (1 - (1 - progress) ** 3)));
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const avatars = (items: readonly Slopper[]): string[] => items.flatMap((s) => (s.avatar === null ? [] : [s.avatar]));

/** The wall size comes from the CSS: columns from the grid, the row cap from --sl-rows. */
function mosaicSize(mosaic: HTMLElement): { columns: number; maxRows: number } {
  const style = getComputedStyle(mosaic);
  return { columns: style.gridTemplateColumns.split(' ').length, maxRows: Number(style.getPropertyValue('--sl-rows')) || 4 };
}

/** Faces from the first page, plus later pages until the wall is full. A failed later page keeps what arrived. */
async function mosaicFaces(mosaic: HTMLElement, first: SloppersPage): Promise<string[]> {
  const { columns, maxRows } = mosaicSize(mosaic);
  const faces = avatars(first.items);
  let next = first.next;
  try {
    for (let pages = 1; next !== null && faces.length < columns * maxRows && pages < MOSAIC_MAX_PAGES; pages++) {
      const page = parseSloppersPage(await request(`${OVERVIEW_PATH}&cursor=${encodeURIComponent(next)}`, { cache: 'default' }));
      faces.push(...avatars(page.items));
      next = page.next;
    }
  } catch {
    // The wall shows the full rows it has.
  }
  return faces;
}

/** Real faces only, in full rows. A list with too few photos for one row shows no wall at all. */
function renderMosaic(mosaic: HTMLElement, faces: readonly string[]): void {
  const { columns, maxRows } = mosaicSize(mosaic);
  const rows = Math.min(maxRows, Math.floor(faces.length / columns));
  if (rows === 0) {
    mosaic.hidden = true;
    return;
  }
  const shown = faces.slice(0, rows * columns);
  const face = (className: string, src: string): HTMLImageElement =>
    h('img', { class: className, src, alt: '', width: TILE_PX, height: TILE_PX, decoding: 'async' });
  mosaic.style.setProperty('--sl-rows', String(rows));
  mosaic.replaceChildren(
    ...shown.map((src, i) => {
      const tile = face('sl-tile', src);
      tile.style.setProperty('--sl-delay', `${((i % columns) + Math.floor(i / columns)) * MOSAIC_STAGGER_MS}ms`);
      return tile;
    }),
    // The spotlight layer: the same faces in color. The CSS shows it through a soft circle at the mouse.
    h('div', { class: 'sl-lit' }, ...shown.map((src) => face('sl-lit-tile', src))),
  );
}

export function initFocal(): void {
  const countLine = req('#sl-count-line');
  const count = req('#sl-count');
  const noun = req('#sl-count-noun');
  const barCount = req('#sl-bar-count');
  const updated = req('#sl-updated');
  const mosaic = req('#sl-mosaic');
  const metrics = req('#sl-metrics');
  const failure = req('#sl-focal-error');
  let loadedAt = 0;
  let statsShown = false;

  // A dead tile keeps its place, so the wall does not reflow after it has landed.
  mosaic.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLImageElement) event.target.classList.add('is-dead');
    },
    true,
  );

  // The mouse is the light: the CSS centres the spotlight on these two values.
  mosaic.addEventListener('pointermove', (event) => {
    const box = mosaic.getBoundingClientRect();
    mosaic.style.setProperty('--sl-x', `${event.clientX - box.left}px`);
    mosaic.style.setProperty('--sl-y', `${event.clientY - box.top}px`);
  });

  function showTotal(total: number, generatedAt: string): void {
    if (count.classList.contains('is-loading')) {
      count.classList.remove('is-loading');
      countUp(count, total);
    } else {
      count.textContent = formatCount(total);
    }
    noun.textContent = total === 1 ? 'slopper' : 'sloppers';
    barCount.textContent = `${formatCount(total)} ${total === 1 ? 'account' : 'accounts'}`;
    updated.textContent = `Updated ${formatRelative(generatedAt)}`;
  }

  function showStats(stats: Stats): void {
    for (const key of METRICS) {
      const cell = req(`dd[data-stat="${key}"]`, metrics);
      cell.textContent = formatStat(stats[key]);
      cell.title = formatCount(stats[key]);
    }
    statsShown = true;
    metrics.hidden = false;
  }

  /** One short line: the same outage already explains itself, with its reason, on the list below. */
  function showFailure(): void {
    countLine.hidden = true;
    mosaic.hidden = true;
    const retry = h('button', { type: 'button', class: 'btn-text' }, 'Try again');
    retry.addEventListener('click', () => {
      failure.hidden = true;
      countLine.hidden = false;
      mosaic.hidden = false;
      void loadOverview();
    });
    failure.replaceChildren(h('p', null, 'The count did not load.'), retry);
    failure.hidden = false;
  }

  async function loadOverview(): Promise<void> {
    try {
      const page = parseSloppersPage(await request(OVERVIEW_PATH, { cache: 'default' }));
      showTotal(page.total, page.generatedAt);
      if (loadedAt === 0) renderMosaic(mosaic, await mosaicFaces(mosaic, page));
      loadedAt = Date.now();
    } catch {
      // A failed refresh keeps the last good numbers on screen.
      if (loadedAt === 0) showFailure();
    }
  }

  async function loadStats(): Promise<void> {
    try {
      showStats(parseStats(await request('/api/v1/stats', { cache: 'default' })));
    } catch {
      // The row is extra: without stats the post still stands on the count.
      metrics.hidden = !statsShown;
    }
  }

  void loadOverview();
  void loadStats();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || loadedAt === 0 || Date.now() - loadedAt < REFRESH_AFTER_MS) return;
    loadedAt = Date.now();
    void loadOverview();
    void loadStats();
  });
}
