// Live numbers from GET /api/v1/stats. Missing data shows as text, never as an invented number.
// The status line stays empty while the numbers are fine and speaks only when they fail.

import { request } from './lib/api.ts';
import { req } from './lib/dom.ts';
import { formatCount, formatStat } from './lib/format.ts';
import { describeError } from './lib/messages.ts';
import { parseStats, type Stats } from './lib/schema.ts';

const REFRESH_AFTER_MS = 60_000;

export function initStats(): void {
  const row = req('#stats');
  const updated = req('#stats-updated');
  let loadedAt = 0;
  let pending = false;

  function show(stats: Stats): void {
    for (const dd of row.querySelectorAll<HTMLElement>('dd[data-stat]')) {
      const key = dd.dataset.stat as keyof Stats;
      const value = stats[key];
      if (typeof value !== 'number') continue;
      dd.textContent = formatStat(value);
      dd.title = formatCount(value);
    }
    row.classList.remove('is-unavailable');
    row.setAttribute('aria-busy', 'false');
    updated.textContent = '';
  }

  // The row keeps its space while it is unavailable, so the strip and the hero below it never move.
  function fail(err: unknown): void {
    row.classList.add('is-unavailable');
    row.setAttribute('aria-busy', 'false');
    updated.textContent = `Live numbers are unavailable right now. ${describeError(err)}`;
  }

  async function load(): Promise<void> {
    if (pending) return;
    pending = true;
    try {
      show(parseStats(await request('/api/v1/stats')));
      loadedAt = Date.now();
    } catch (err) {
      fail(err);
    } finally {
      pending = false;
    }
  }

  void load();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - loadedAt > REFRESH_AFTER_MS) void load();
  });
}
