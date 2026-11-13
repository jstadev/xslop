// One path, run unchanged in every browser. It drives the real package through real input and reads the
// real outcome: rows in the server's database, requests that reached X's stand-in, and what the pages show.
import { join } from 'node:path';
import { CT0, X_IDS } from './world.mjs';
import { poll, sleep, stepper } from './util.mjs';

const tweet = (id) => `article[data-testid="tweet"]:has(a[href$="/status/${id}"] time)`;
const cell = (id) => `[data-testid="cellInnerDiv"]:has(a[href$="/status/${id}"] time)`;
const STATUS_URL = 'https://x.com/alice/status/100';
const HOST_ORIGINS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://x-slop.com/*'];
const fail = (message) => {
  throw new Error(message);
};
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const same = (got, want, what) => {
  if (canon(got) !== canon(want)) fail(`${what}: got ${canon(got)}, want ${canon(want)}`);
};

const collapsed = (d, tab, id) => d.run(tab, (_, sel) => document.querySelector(sel)?.getAttribute('data-xslop-cell') ?? null, cell(id));
const buttonCount = (d, tab) => d.run(tab, () => document.querySelectorAll('.xslop-host').length);

/** Runs the path and returns the step results. `ext` reads the extension API through the popup tab that stays open. */
export async function runScenario({ d, world, shots, version, powBits, webBearer, onboardingTab = true }) {
  const results = [];
  const step = stepper(results);
  const shot = (tab, name) => d.shot(tab, join(shots, `${name}.png`)).catch(() => undefined);
  const ext = (fn, ...args) => d.run(popup, fn, ...args);
  const stored = (key) => ext(async (x, k) => (await x.storage.local.get(k))[k], key);
  const voteRow = (handle) => world.sql('select value, tweet_id, parent_tweet_id, text, posted_at from votes where handle = $1', [handle]).then((r) => r[0]);
  /** The database row can appear before the proxy reads the answer: wait for the status of the first such request. */
  const answered = (method, path) => poll(() => world.api.find((a) => a.method === method && a.path === path && a.status), { what: `an answer to ${method} ${path}`, ms: 10_000 });
  const xCall = (op, ms = 20_000, from = 0) => poll(() => world.x.slice(from).find((c) => c.op === op), { what: `X ${op} call`, ms });
  let popup = null;
  let x = null;
  let onboarding = null;

  await step('background registers: proof of work and key accepted by the real server', async () => {
    const rows = await poll(async () => {
      const r = await world.sql('select id, ext_version from installs');
      return r.length ? r : null;
    }, { what: 'install row', ms: 240_000 });
    const ch = world.api.find((a) => a.path === '/api/v1/challenge?purpose=install');
    const post = await answered('POST', '/api/v1/installs');
    if (rows.length !== 1 || post.status !== 201) fail(`installs: ${JSON.stringify(rows)}, POST ${post.status}`);
    same(rows[0].ext_version, version, 'ext_version');
    return `install ${rows[0].id}; ${powBits}-bit proof sent ${post.at - ch.at} ms after the challenge; 201`;
  });

  await step(onboardingTab ? 'onboarding tab opens by itself and renders; Next works with real input' : 'onboarding renders in a tab that the test opens; Next works with real input', async () => {
    onboarding = onboardingTab
      ? await poll(async () => (await d.tabs()).find((t) => t.url === `${d.origin}/onboarding.html`), { what: 'onboarding tab', ms: 15_000 })
      : { tab: await d.open(`${d.origin}/onboarding.html`) };
    await d.front(onboarding.tab);
    const view = await d.run(onboarding.tab, () => ({
      h1: document.querySelector('#step-1 h1').textContent,
      step: document.getElementById('step-now').textContent,
      muteMark: document.getElementById('mute-mark').checked,
      logo: document.querySelector('.head img').naturalWidth,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    same([view.h1, view.step, view.muteMark], ['One click does three things', '1', true], 'step 1');
    if (!view.logo) fail('the logo did not load');
    if (view.bg === 'rgba(0, 0, 0, 0)') fail('the stylesheet did not apply');
    await d.click(onboarding.tab, '#step-1 button.next');
    await poll(() => d.run(onboarding.tab, () => !document.getElementById('step-2').hidden && document.activeElement?.tagName === 'H1'), { what: 'step 2 with focus', ms: 8_000 });
    await shot(onboarding.tab, 'onboarding-step2');
    return `heading "${view.h1}", logo ${view.logo}px, background ${view.bg}`;
  });

  await step('popup page renders the list and the state', async () => {
    popup = await d.open(`${d.origin}/popup.html`);
    await d.front(popup);
    await poll(async () => (await d.run(popup, () => document.getElementById('stat-list').textContent)) !== '0', { what: 'list count in the popup', ms: 30_000 });
    const view = await d.run(popup, () => ({
      headline: document.getElementById('headline').textContent,
      list: document.getElementById('stat-list').textContent,
      access: document.getElementById('access').hidden,
      logo: document.querySelector('.head img').naturalWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    same(view.headline, 'Hiding', 'headline');
    same(view.list.replace(/\D/g, ''), String(world.listSize), 'accounts on the list');
    if (!view.access) fail('the host access notice shows although access is granted');
    if (!view.logo) fail('the logo did not load');
    if (view.overflow > 0) fail(`horizontal overflow ${view.overflow}px`);
    await shot(popup, 'popup');
    return `headline "${view.headline}", ${view.list} accounts, no access notice`;
  });

  await step('storage.local, storage.session, alarms and IndexedDB hold the expected state', async () => {
    const state = await ext(async (e) => {
      await e.storage.session.set({ browsertest: 'ok' });
      const session = (await e.storage.session.get('browsertest')).browsertest;
      await e.storage.session.remove('browsertest');
      const key = await new Promise((resolve, reject) => {
        const open = indexedDB.open('xslop', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('kv').objectStore('kv').get('device');
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            const k = get.result;
            resolve({ type: k.privateKey.type, extractable: k.privateKey.extractable, curve: k.privateKey.algorithm.namedCurve, jwk: Object.keys(k.publicJwk).sort() });
          };
        };
      });
      return { all: Object.keys(await e.storage.local.get(null)).sort(), identity: (await e.storage.local.get('identity')).identity, alarms: (await e.alarms.getAll()).map((a) => [a.name, a.periodInMinutes]), session, key };
    });
    const [row] = await world.sql('select id from installs');
    same(state.identity?.installId, row.id, 'install id in storage');
    same(state.session, 'ok', 'storage.session round trip');
    same(state.alarms.filter((a) => a[1]).sort(), [['config', 360], ['list', 10]], 'alarms');
    same(state.key, { type: 'private', extractable: false, curve: 'P-256', jwk: ['crv', 'kty', 'x', 'y'] }, 'device key in IndexedDB');
    for (const k of ['config', 'identity', 'list']) if (!state.all.includes(k)) fail(`storage has no ${k}`);
    return `alarms ${JSON.stringify(state.alarms)}; key non-extractable ${state.key.curve}; storage keys ${state.all.join(',')}`;
  });

  await step('permissions: all host permissions are granted after install', async () => {
    const p = await ext(async (e, origins) => ({ has: await e.permissions.contains({ origins }), all: await e.permissions.getAll() }), HOST_ORIGINS);
    if (!p.has) fail(`missing host permission: ${JSON.stringify(p.all)}`);
    return JSON.stringify(p.all);
  });

  await step('content script runs on the X fixture: buttons, list hide, sizes from the shadow CSS', async () => {
    x = await d.open(STATUS_URL);
    await d.front(x);
    await poll(async () => (await buttonCount(d, x)) >= 9, { what: 'xslop buttons', ms: 20_000 });
    await poll(async () => (await collapsed(d, x, '104')) === 'collapsed', { what: 'global list hide of @globalslop', ms: 15_000 });
    const view = await d.run(x, (_, own, ad, reply) => ({
      own: document.querySelector(own)?.querySelectorAll('.xslop-host').length ?? -1,
      ad: document.querySelectorAll('[data-testid="placementTracking"] .xslop-host').length,
      width: document.querySelector(`${reply} .xslop-host`).getBoundingClientRect().width,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      inputs: document.querySelector(`${reply} [role="group"]`).children.length,
    }), tweet('106'), tweet('107'), tweet('101'));
    same([view.own, view.ad], [0, 0], 'buttons on your own tweet and on the ad');
    const want = parseFloat(view.rootFont) * 1.25;
    if (Math.abs(view.width - want) > 0.6) fail(`button width ${view.width}, want ${want} (the shadow CSS did not apply)`);
    await shot(x, 'x-status');
    return `button ${view.width}px wide (root font ${view.rootFont}), none on your own tweet or the ad`;
  });

  const firstCreate = world.x.length;
  await step('a real click hides the tweet, mutes on X in your session and sends a signed vote', async () => {
    await d.click(x, `${tweet('101')} .xslop-host`);
    await poll(async () => (await collapsed(d, x, '101')) === 'collapsed' && (await collapsed(d, x, '103')) === 'collapsed', { what: 'collapse of both @slopbot replies', ms: 8_000 });
    const call = await xCall('create', 20_000, firstCreate);
    const h = call.headers;
    same([call.host, call.method, call.body], ['x.com', 'POST', 'screen_name=slopbot'], 'X call');
    same(h.origin, 'https://x.com', 'Origin header of the X call (page fetch, not extension fetch)');
    same(h['sec-fetch-site'], 'same-origin', 'sec-fetch-site of the X call');
    same(h['x-csrf-token'], CT0, 'x-csrf-token');
    same(h.authorization, `Bearer ${webBearer}`, 'authorization');
    same(h['x-twitter-auth-type'], 'OAuth2Session', 'x-twitter-auth-type');
    same(h['content-type'], 'application/x-www-form-urlencoded', 'content-type');
    if (!/(^|; )ct0=/.test(h.cookie ?? '') || !/(^|; )auth_token=/.test(h.cookie ?? '')) fail(`the X call had no session cookies: ${h.cookie}`);
    const vote = await poll(() => voteRow('slopbot'), { what: 'vote row', ms: 20_000 });
    same([vote.value, vote.tweet_id, vote.parent_tweet_id, vote.text], [1, '101', '100', null], 'vote row, without the post text');
    same((await answered('POST', '/api/v1/votes')).status, 200, 'POST /api/v1/votes status');
    const muted = await poll(async () => (await stored('mute')).muted.find((m) => m[0] === 'slopbot'), { what: 'mute record', ms: 10_000 });
    same(muted[1].id, X_IDS.slopbot, 'recorded X user id');
    await shot(x, 'x-after-click');
    const toast = await d.run(x, () => {
      const t = document.querySelector('.xslop-toast');
      return t ? { w: t.getBoundingClientRect().width, h: t.getBoundingClientRect().height } : null;
    });
    if (!toast || toast.w < 10) fail(`no visible toast host: ${JSON.stringify(toast)}`);
    return `Origin ${h.origin}, sec-fetch-site ${h['sec-fetch-site']}, cookies sent, vote row stored, mute id ${muted[1].id}`;
  });

  await step('storage.session and the hidden counter work through the background', async () => {
    const hidden = await poll(async () => {
      const s = await stored('stats');
      return s && s.hidden >= 3 ? s : null;
    }, { what: 'hidden counter', ms: 10_000 });
    const session = await ext(async (e) => (await e.storage.session.get('hidden')).hidden);
    if (!session?.ids?.includes('101')) fail(`storage.session hidden: ${JSON.stringify(session)}`);
    return `${hidden.hidden} hidden today; ids in storage.session: ${session.ids.join(',')}`;
  });

  await step('keyboard undo: Enter on the focused Undo unmutes by id and deletes the vote', async () => {
    await d.front(x);
    const focused = await d.run(x, () => document.activeElement?.className);
    if (focused !== 'xslop-bar') {
      await d.click(x, `${cell('101')} .xslop-bar`);
      for (const k of ['Tab', 'Tab']) await d.press(x, k);
    }
    const from = world.x.length;
    await d.press(x, 'Enter');
    const call = await xCall('destroy', 15_000, from);
    same([call.method, call.body], ['POST', `user_id=${X_IDS.slopbot}`], 'destroy call');
    await poll(async () => (await collapsed(d, x, '101')) === null, { what: 'tweet shown again', ms: 8_000 });
    await poll(async () => (await world.sql("select count(*)::int as n from votes where handle = 'slopbot'"))[0].n === 0, { what: 'vote deleted on the server', ms: 15_000 });
    return `focus was on ${focused}; unmute body ${call.body}; vote row deleted`;
  });

  await step("X refuses REST (404): X's own menu mutes, and only the Mute item is clicked", async () => {
    world.xAnswers.push({ status: 404, json: { errors: [{ code: 34, message: 'not found' }] } });
    await d.front(x);
    await d.click(x, `${tweet('102')} .xslop-host`);
    await poll(async () => (await collapsed(d, x, '102')) === 'collapsed', { what: 'collapse', ms: 8_000 });
    const clicks = await poll(async () => {
      const c = await d.run(x, () => (window.wrappedJSObject ?? window).__xMenuClicks);
      return c?.length ? c : null;
    }, { what: 'click in the X menu', ms: 15_000 });
    same(clicks, ['Mute @human_dev'], 'menu clicks');
    const left = await d.run(x, () => [document.querySelectorAll('[role="menu"]').length, document.querySelectorAll('head ~ style, html > style').length]);
    same(left[0], 0, 'open menus after the run');
    return `menu clicks ${JSON.stringify(clicks)}; style elements left under html: ${left[1]}`;
  });

  await step('settings change in the popup reaches the open X tab', async () => {
    await d.front(popup);
    await d.click(popup, 'label:has(input[name="display"][value="remove"])');
    await poll(async () => (await stored('settings')).display === 'remove', { what: 'stored setting', ms: 8_000 });
    await d.front(x);
    await poll(async () => (await collapsed(d, x, '104')) === 'removed', { what: 'remove mode on the X tab', ms: 8_000 });
    await d.front(popup);
    await d.click(popup, 'label:has(input[name="display"][value="collapse"])');
    await d.front(x);
    await poll(async () => (await collapsed(d, x, '104')) === 'collapsed', { what: 'collapse mode on the X tab', ms: 8_000 });
    return 'display remove and collapse both applied live';
  });

  await step('the stopped background wakes on the next click and signs with the stored key', async () => {
    await d.stopBackground();
    await d.front(x);
    await d.click(x, `${tweet('105')} .xslop-host`);
    const vote = await poll(() => voteRow('flaggedone'), { what: 'vote row after the restart', ms: 30_000 });
    same([vote.value, vote.tweet_id], [1, '105'], 'vote row');
    const bad = world.api.filter((a) => a.status === 401 || a.status === 403);
    same(bad, [], 'rejected signed requests');
    return `vote stored after the background was stopped; ${world.api.filter((a) => a.path === '/api/v1/votes').length} vote POSTs, none rejected`;
  });

  await step('the mute of that click stays: the woken background does not undo it', async () => {
    await sleep(4000);
    const undone = world.x.filter((c) => c.op === 'destroy' && c.body === `user_id=${X_IDS.flaggedone}`);
    const mute = await stored('mute');
    const rec = mute.muted.find((m) => m[0] === 'flaggedone');
    if (undone.length) fail(`the background unmuted the account that you just marked: ${undone.length} destroy call(s) for user_id=${X_IDS.flaggedone}, record ${JSON.stringify(rec ?? null)}`);
    if (!rec) fail(`no mute record for @flaggedone: ${JSON.stringify(mute.muted)}`);
    return `no destroy call in 4 s; record id ${rec[1].id}`;
  });

  await step('twitter.com and mobile.x.com: button appears and the X call stays on that origin', async () => {
    const tw = await d.open('https://twitter.com/alice/status/100');
    await d.front(tw);
    await poll(async () => (await buttonCount(d, tw)) >= 5, { what: 'buttons on twitter.com', ms: 20_000 });
    const from = world.x.length;
    await d.click(tw, `${tweet('109')} .xslop-host`);
    const call = await xCall('create', 15_000, from);
    same([call.host, call.headers.origin], ['twitter.com', 'https://twitter.com'], 'X call on twitter.com');
    await poll(async () => (await stored('mute')).muted.some((m) => m[0] === 'photoguy'), { what: 'mute record for the twitter.com click', ms: 10_000 });
    await d.closeTab(tw);
    const mob = await d.open('https://mobile.x.com/alice/status/100');
    await d.front(mob);
    await poll(async () => (await buttonCount(d, mob)) >= 5, { what: 'buttons on mobile.x.com', ms: 20_000 });
    await d.closeTab(mob);
    return `twitter.com call on ${call.headers.origin}; mobile.x.com shows buttons`;
  });

  await step('onboarding Done leaves for x.com', async () => {
    await d.front(onboarding.tab);
    await d.run(onboarding.tab, () => {
      document.getElementById('step-2').hidden = true;
      document.getElementById('step-3').hidden = false;
    });
    await d.click(onboarding.tab, '#done');
    await poll(async () => (await d.tabs()).some((t) => t.tab === onboarding.tab && t.url === 'https://x.com/home'), { what: 'navigation to x.com/home', ms: 15_000 });
    await d.front(onboarding.tab);
    await poll(async () => (await buttonCount(d, onboarding.tab)) >= 3, { what: 'buttons on /home', ms: 20_000 });
    await d.front(x);
    return 'tab moved to https://x.com/home and the buttons appeared';
  });

  return { results, popup: () => popup, x: () => x, ext };
}

/** Extension errors from every context. Runs last, after the engine's own steps. */
export async function finalChecks({ d, world, results }) {
  const errors = await d.errors();
  const notices = d.teardownNotices ? `; Firefox logged ${d.teardownNotices} notices about tabs that left with a message or listener under way` : '';
  const served = [...new Set(world.x.map((c) => c.host))].join(', ');
  const traffic = `; proxy served the API and ${served}, refused ${new Set(world.refused).size} other hosts (the browser's own traffic)`;
  results.push({ name: 'no error from the extension in any context', pass: errors.length === 0, evidence: (errors.length ? errors.join(' | ') : 'none') + notices + traffic });
}
