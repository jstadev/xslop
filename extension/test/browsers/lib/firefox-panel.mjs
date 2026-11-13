// The real toolbar panel of Firefox, in a real window under Xvfb, with an operating system mouse click. It answers one
// question that a tab cannot: does the sharing switch still work when the permission prompt opens over the panel?
import { execFileSync, spawn } from 'node:child_process';
import { poll, sleep, stepper } from './util.mjs';
import { FirefoxDriver } from './firefox.mjs';

const SHARE = { data_collection: ['browsingActivity'] };

/** Starts an X server on a display that the server picks. It writes the number when it is ready. */
function startXvfb() {
  const child = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Xvfb stopped with code ${code}`)));
    child.stdout.once('data', (number) => resolve({ display: `:${String(number).trim()}`, child }));
  });
}

export async function firefoxPanel({ binary, geckodriver, world, work, addon, shots }) {
  const results = [];
  const step = stepper(results);
  const x = await startXvfb();
  const env = { ...process.env, DISPLAY: x.display };
  let d = null;
  try {
    d = await FirefoxDriver.launch({
      binary, geckodriver, proxyPort: world.proxyPort, work, addonPath: addon, headless: false, env,
      prefs: { 'extensions.openPopupWithoutUserGesture.enabled': true },
    });
    const page = await d.open(`${d.origin}/popup.html`);
    await poll(async () => (await world.sql('select id from installs')).length, { what: 'install row', ms: 120_000 });
    await d.front(page);
    const xdo = (...args) => execFileSync('xdotool', args, { env });
    const rootShot = (name) => {
      try {
        execFileSync('import', ['-window', 'root', `${shots}/${name}.png`], { env });
      } catch {
        // A screenshot is evidence, not a step. ImageMagick may be missing.
      }
    };
    const views = () => d.run(page, (e) => e.extension.getViews({ type: 'popup' }).length);
    const settings = () => d.run(page, async (e) => (await e.storage.local.get('settings')).settings ?? {});

    // Xvfb has no window manager, so nothing gives the Firefox window the focus. Firefox shows no permission prompt in a window that is not active.
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'firefox'], { env, encoding: 'utf8' }).trim().split('\n');
    xdo('windowfocus', '--sync', ids[0]);
    await sleep(300);

    await step('Firefox panel: the real toolbar panel opens', async () => {
      await d.run(page, (e) => void e.action.openPopup().catch(() => undefined));
      await poll(async () => (await views()) === 1, { what: 'the panel to open', ms: 10_000 });
      await poll(() => d.run(page, (e) => e.extension.getViews({ type: 'popup' })[0]?.document.readyState === 'complete'), { what: 'the panel to load', ms: 10_000 });
      return 'one popup view';
    });

    const where = await d.run(page, (e) => {
      const w = e.extension.getViews({ type: 'popup' })[0];
      const el = w?.document.querySelector('label.switch:has(#share)');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(w.mozInnerScreenX + r.x + r.width / 2), y: Math.round(w.mozInnerScreenY + r.y + r.height / 2) };
    });

    await step('Firefox panel: a real click on the sharing switch brings the permission prompt', async () => {
      if (!where) throw new Error('the switch is not in the panel');
      rootShot('panel-before-click');
      xdo('mousemove', String(where.x), String(where.y));
      await sleep(250);
      xdo('click', '1');
      await sleep(400);
      rootShot('panel-after-click');
      const open = await d.chrome(`
        const done = arguments[arguments.length - 1];
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const end = Date.now() + 15000;
        const look = () => {
          const n = win.document.getElementById('addon-webext-permissions-notification');
          if (n && win.PopupNotifications.panel.state === 'open') done(true);
          else if (Date.now() > end) done(false);
          else win.setTimeout(look, 100);
        };
        look();`);
      if (!open) throw new Error('no prompt after the click');
      return `click at ${where.x},${where.y}`;
    });

    const after = await views();
    rootShot('panel-with-prompt');

    await step('Firefox panel: accepting the prompt turns sharing on', async () => {
      const asked = await d.answerPrompt(true);
      if (asked.error) throw new Error(asked.error);
      await poll(() => d.run(page, (e, p) => e.permissions.contains(p), SHARE), { what: 'the permission', ms: 8_000 });
      await sleep(1500);
      const share = (await settings()).share === true;
      if (!share) throw new Error(`the permission is granted, but settings.share stays off. Popup views while the prompt was open: ${after}. The panel closed with the prompt, so its handler never wrote the setting.`);
      return `settings.share is true; popup views while the prompt was open: ${after}`;
    });
    return { version: d.version, loaded: 'temporary add-on, real window under Xvfb', results };
  } finally {
    await d?.quit().catch(() => undefined);
    x.child.kill('SIGKILL');
  }
}
