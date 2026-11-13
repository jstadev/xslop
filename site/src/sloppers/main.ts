// /sloppers entry. Each part starts on its own, so one failure cannot stop the others.

import { initCriteria } from './criteria.ts';
import { initFocal } from './focal.ts';
import { initThread } from './thread.ts';

for (const init of [initFocal, initCriteria, initThread]) {
  try {
    init();
  } catch (err) {
    console.error(`xslop: ${init.name} failed`, err);
  }
}
