// The Firefox parts of the path that have no Chromium counterpart: host access that you can decline, the data
// collection prompt, and the permission prompts' real answers.
import { poll, sleep, stepper } from './util.mjs';

const HOST_ORIGINS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://x-slop.com/*'];
const SHARE = { data_collection: ['browsingActivity'] };
const STATUS_URL = 'https://x.com/alice/status/100';
const fail = (message) => {
  throw new Error(message);
};

export async function firefoxSteps({ d, world, popup, x, results }) {
  const step = stepper(results);
  const buttons = (tab) => d.run(tab, () => document.querySelectorAll('.xslop-host').length);
  const settings = () => d.run(popup, async (e) => (await e.storage.local.get('settings')).settings);
  const hasShare = () => d.run(popup, (e, p) => e.permissions.contains(p), SHARE);

  await step('Firefox: host access taken back: the popup says so and x.com gets no button', async () => {
    await d.run(popup, (e, origins) => e.permissions.remove({ origins }), HOST_ORIGINS);
    await d.front(popup);
    await poll(() => d.run(popup, () => !document.getElementById('access').hidden), { what: 'the access notice', ms: 8_000 });
    await d.goto(x, STATUS_URL);
    await d.front(x);
    await sleep(2000);
    const n = await buttons(x);
    if (n !== 0) fail(`${n} buttons on x.com without host access`);
    return 'notice visible; no content script on x.com';
  });

  await step('Firefox: Allow access button asks with a real prompt; a refusal changes nothing', async () => {
    await d.front(popup);
    await d.click(popup, '#access-grant');
    const asked = await d.answerPrompt(false);
    if (asked.error) fail(asked.error);
    await poll(() => d.run(popup, () => !document.getElementById('access-help').hidden), { what: 'the help text after a refusal', ms: 8_000 });
    const access = await d.run(popup, (e, origins) => e.permissions.contains({ origins }), HOST_ORIGINS);
    if (access) fail('access granted after a refusal');
    return `prompt read: ${asked.text}`;
  });

  await step('Firefox: Allow access button; accepting restores x.com and the sync', async () => {
    const before = world.api.length;
    await d.front(popup);
    await d.click(popup, '#access-grant');
    const asked = await d.answerPrompt(true);
    if (asked.error) fail(asked.error);
    await poll(() => d.run(popup, () => document.getElementById('access').hidden), { what: 'the notice to hide', ms: 8_000 });
    await d.goto(x, STATUS_URL);
    await d.front(x);
    await poll(async () => (await buttons(x)) >= 5, { what: 'buttons after the grant', ms: 15_000 });
    await poll(() => world.api.length > before, { what: 'startup sync after permissions.onAdded', ms: 10_000 });
    return `prompt read: ${asked.text}; ${world.api.length - before} API calls after the grant`;
  });

  await step('Firefox: share switch needs the data collection prompt; a refusal leaves it off', async () => {
    await d.front(popup);
    if (await hasShare()) fail('browsingActivity is granted before you opt in');
    await d.click(popup, 'label.switch:has(#share)');
    const asked = await d.answerPrompt(false);
    if (asked.error) fail(asked.error);
    await poll(() => d.run(popup, () => !document.getElementById('share').checked), { what: 'the switch to go back', ms: 8_000 });
    if ((await settings()).share !== false || await hasShare()) fail('share is on after a refusal');
    return `prompt read: ${asked.text}`;
  });

  await step('Firefox: accepting the prompt turns sharing on; observations reach the real server without text', async () => {
    await d.front(popup);
    await d.click(popup, 'label.switch:has(#share)');
    const asked = await d.answerPrompt(true);
    if (asked.error) fail(asked.error);
    await poll(async () => (await settings()).share === true, { what: 'share in storage', ms: 8_000 });
    if (!(await hasShare())) fail('browsingActivity not granted after accepting');
    await d.goto(x, STATUS_URL);
    await d.front(x);
    await poll(async () => (await buttons(x)) >= 5, { what: 'buttons on the page', ms: 15_000 });
    // A page that goes to the background sends its batch at once, so the check need not wait for the 30 s timer.
    await d.front(popup);
    const rows = await poll(async () => {
      const r = await world.sql('select tweet_id, handle, simhash from sightings');
      return r.length ? r : null;
    }, { what: 'sighting rows after the page went to the background', ms: 20_000 });
    const obs = world.api.find((a) => a.path === '/api/v1/observations');
    if (obs?.status !== 202) fail(`POST /api/v1/observations answered ${obs?.status}`);
    const wire = Buffer.concat(obs.body).toString('utf8');
    const { items } = JSON.parse(wire);
    if ('text' in items[0] || wire.includes('game changer')) fail(`the observation carries reply text: ${wire.slice(0, 300)}`);
    return `prompt read: ${asked.text}; ${rows.length} sightings stored, for example ${rows[0].handle} ${rows[0].simhash}; the request body has the fields ${Object.keys(items[0]).sort().join(',')} and no reply text`;
  });

  await step('Firefox: taking the permission back stops sharing at once', async () => {
    await d.run(popup, (e, p) => e.permissions.remove(p), SHARE);
    await poll(async () => (await settings()).share === false, { what: 'share off after permissions.onRemoved', ms: 8_000 });
    return 'settings.share false after permissions.onRemoved';
  });
}
