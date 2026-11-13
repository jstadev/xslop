// Landing page entry. Each part starts on its own, so one failure cannot stop the others.

import { initBridge } from './bridge.ts';
import { initHero } from './hero/boot.ts';
import { initDrain } from './hero/drain.ts';
import { initThread } from './hero/thread.ts';
import { initSwapWord } from './hero/swap-word.ts';
import { initStats } from './stats.ts';

/** These sections moved to their own pages. A link with the old anchor (an old extension, a bookmark) still lands in the right place. */
const MOVED = new Map([
  ['#how', '/how-it-works'],
  ['#rules', '/rules'],
  ['#install', '/download'],
  ['#appeal', '/check'],
  ['#privacy', '/privacy'],
  ['#faq', '/questions'],
]);

const moved = MOVED.get(location.hash);
if (moved) {
  location.replace(`${moved}${location.search}`);
} else {
  for (const init of [initThread, initHero, initSwapWord, initBridge, initDrain, initStats]) {
    try {
      init();
    } catch (err) {
      console.error(`xslop: ${init.name} failed`, err);
    }
  }
}
