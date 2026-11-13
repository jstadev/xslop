// The Firefox event page stops after 30 s without work, and the content script sends its observations on a 30 s
// timer. If the two meet, the message finds no receiver. This is a race, so one page load proves nothing: the run
// loads the page 16 times and counts the batches that never reach the server. It takes about 9 minutes.
import { poll, stepper } from './util.mjs';

const LOADS = 16;
const BATCH_WAIT_MS = 48_000; // the 30 s timer, the stop of the event page and a margin

export async function firefoxIdle({ d, world }) {
  const results = [];
  await poll(async () => (await world.sql('select id from installs')).length, { what: 'install row', ms: 120_000 });
  const popup = await d.open(`${d.origin}/popup.html`);
  await poll(async () => (await d.run(popup, () => document.getElementById('stat-list').textContent)) !== '0', { what: 'list count in the popup', ms: 30_000 });
  await d.front(popup);
  await d.click(popup, 'label.switch:has(#share)');
  const asked = await d.answerPrompt(true);
  if (asked.error) throw new Error(asked.error);
  await poll(async () => (await d.run(popup, async (e) => (await e.storage.local.get('settings')).settings)).share === true, { what: 'share in storage', ms: 8_000 });
  const x = await d.open('about:blank');

  await stepper(results)(`Firefox idle: all ${LOADS} batches of observations reach the server`, async () => {
    const lost = [];
    for (let load = 1; load <= LOADS; load++) {
      await d.run(popup, (e) => e.storage.session.remove('seen')); // the background reports a post once per session
      const from = world.api.length;
      await d.goto(x, 'https://x.com/alice/status/100');
      await d.front(x);
      await poll(() => world.api.slice(from).some((a) => a.path === '/api/v1/observations' && a.status === 202), { what: 'the batch', ms: BATCH_WAIT_MS }).catch(() => lost.push(load));
    }
    if (lost.length) throw new Error(`the batch of page load ${lost.join(', ')} of ${LOADS} never reached the server`);
    return `${LOADS} of ${LOADS} batches accepted with status 202`;
  });
  return results;
}
