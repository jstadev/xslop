// Notices a device that cannot keep up, and picks its cheaper picture. Pure, so the thresholds can be tested without a GPU.

/** A window also ends after this much time, so a device that draws a few frames per second gets its cheaper picture in seconds. */
const WINDOW_MS = 2000;
const MIN_FRAMES = 5;

/**
 * Returns a sampler that takes frame times in ms and calls `onSlow` with the median of each window whose median is over budget.
 * The median ignores the long frames that say nothing about the GPU: a tab or a laptop that slept, a compile, a busy main thread.
 * A browser that caps frames at 30 per second (energy saver, low power mode) has a median of 33.3 ms and stays under a 34 ms budget.
 */
export function frameWatchdog(settleFrames: number, windowFrames: number, budgetMs: number, onSlow: (medianMs: number) => void): (frameMs: number) => void {
  let settle = settleFrames;
  let total = 0;
  const times: number[] = [];
  return (frameMs) => {
    if (settle > 0) {
      settle--;
      return;
    }
    times.push(frameMs);
    total += frameMs;
    if (times.length < windowFrames && (total < WINDOW_MS || times.length < MIN_FRAMES)) return;
    const median = times.sort((a, b) => a - b)[times.length >> 1]!;
    times.length = 0;
    total = 0;
    if (median > budgetMs) onSlow(median);
  };
}

/** The pixel ratio after a slow window. Each side loses a quarter to a half, more when the frames are far over budget. It never goes below `floor`: there the scene runs on as it is. */
export function cheaperPixelRatio(current: number, medianMs: number, budgetMs: number, floor: number): number {
  return Math.max(floor, current * Math.min(0.75, Math.max(0.5, Math.sqrt(budgetMs / medianMs))));
}
