// Install section. It names the visitor's browser, shows that browser's package and steps, and lists the others below.
// Packages come from GET /downloads/latest.json. Store buttons appear only when latest.json names a store URL.

import { detectBrowser, readBrowserSignals, type BrowserId } from './hero/detect.ts';
import { request } from './lib/api.ts';
import { bindCopy, h, req } from './lib/dom.ts';
import { formatBytes } from './lib/format.ts';
import { describeError } from './lib/messages.ts';
import { parseLatest, type Download, type Latest } from './lib/schema.ts';

type Package = 'chrome' | 'firefox' | 'safari';

interface Guide {
  name: string;
  /** The package this browser takes. Null: the browser cannot load extensions. */
  package: Package | null;
  /** The browser's own extensions page. A page cannot link to it, so the reader copies it. */
  extensionsPage?: string;
}

const GUIDES: Record<Exclude<BrowserId, 'unknown'>, Guide> = {
  chrome: { name: 'Chrome', package: 'chrome', extensionsPage: 'chrome://extensions' },
  edge: { name: 'Edge', package: 'chrome', extensionsPage: 'edge://extensions' },
  brave: { name: 'Brave', package: 'chrome', extensionsPage: 'brave://extensions' },
  opera: { name: 'Opera', package: 'chrome', extensionsPage: 'opera://extensions' },
  vivaldi: { name: 'Vivaldi', package: 'chrome', extensionsPage: 'vivaldi://extensions' },
  arc: { name: 'Arc', package: 'chrome', extensionsPage: 'arc://extensions' },
  firefox: { name: 'Firefox', package: 'firefox', extensionsPage: 'about:debugging#/runtime/this-firefox' },
  'firefox-android': { name: 'Firefox for Android', package: 'firefox' },
  safari: { name: 'Safari', package: 'safari' },
  'phone-other': { name: 'this phone browser', package: null },
};

const OTHERS: readonly (keyof typeof GUIDES)[] = ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'arc', 'firefox', 'firefox-android', 'safari'];

function zipLink(d: Download, label: string): HTMLAnchorElement {
  return h('a', { class: 'btn btn-primary', href: `/downloads/${d.file}`, download: d.file }, label);
}

function zipMeta(d: Download): HTMLElement {
  const copy = h('button', { type: 'button', class: 'btn-text' }, 'Copy SHA-256');
  bindCopy(copy, () => d.sha256);
  return h('div', { class: 'dl-meta' }, h('span', null, `${d.file}, ${formatBytes(d.bytes)}`), h('span', { class: 'sha' }, `SHA-256 ${d.sha256}`), h('span', null, copy));
}

function storeLink(href: string, label: string): HTMLAnchorElement {
  return h('a', { class: 'btn btn-primary', href, rel: 'noopener noreferrer' }, label);
}

function note(text: string): HTMLElement {
  return h('p', { class: 'install-note' }, text);
}

type Inline = (Node | string)[];

function steps(...items: (string | Inline)[]): HTMLElement {
  return h('ol', { class: 'install-steps' }, ...items.map((item) => h('li', null, ...(typeof item === 'string' ? [item] : item))));
}

/** The address of the browser's extensions page, with a copy button: web pages may not link to it. */
function pageAddress(address: string): Inline {
  const copy = h('button', { type: 'button', class: 'btn-text' }, 'Copy');
  bindCopy(copy, () => address);
  return [h('code', null, address), ' ', copy];
}

function chromiumBody(guide: Guide, latest: Latest): Node[] {
  const zip = latest.chrome;
  const parts: Node[] = [];
  if (latest.chromeStoreUrl && guide.name === 'Chrome') parts.push(h('div', { class: 'install-actions' }, storeLink(latest.chromeStoreUrl, 'Get it from the Chrome Web Store')));
  if (!zip) return [...parts, note('The zip is not available right now. Try again later.')];
  parts.push(
    h('div', { class: 'install-actions' }, zipLink(zip, `Download the zip for ${guide.name}`), zipMeta(zip)),
    steps(
      'Unzip the file into a folder that you keep.',
      ['Type this into the address bar: ', ...pageAddress(guide.extensionsPage ?? '')],
      'Turn on Developer mode.',
      'Click Load unpacked and choose the folder.',
      'Open x.com. Each reply now has the xslop x.',
    ),
    note(`${guide.name} loads this as a developer extension. It keeps working after a restart, and ${guide.name} can show a reminder about developer extensions.`),
  );
  return parts;
}

function firefoxBody(guide: Guide, latest: Latest): Node[] {
  if (latest.firefoxUrl) {
    return [h('div', { class: 'install-actions' }, storeLink(latest.firefoxUrl, 'Add to Firefox')), note('The button opens addons.mozilla.org, where you click Add to Firefox.')];
  }
  const zip = latest.firefox;
  if (!zip) return [note('The Firefox zip is not available right now. Try again later.')];
  return [
    h('div', { class: 'install-actions' }, zipLink(zip, 'Download the Firefox zip'), zipMeta(zip)),
    steps(
      ['Type this into the address bar: ', ...pageAddress(guide.extensionsPage ?? '')],
      'Click Load Temporary Add-on.',
      'Choose the zip file.',
      'Open x.com. Each reply now has the xslop x.',
    ),
    note('Firefox removes a temporary add-on when it restarts. Repeat these steps after a restart, until the addons.mozilla.org listing is live.'),
  ];
}

function firefoxAndroidBody(latest: Latest): Node[] {
  if (latest.firefoxUrl) {
    return [
      h('div', { class: 'install-actions' }, storeLink(latest.firefoxUrl, 'Open on addons.mozilla.org')),
      note('Tap the button, then tap Add to Firefox. Log in to x.com in Firefox and the replies get the xslop x.'),
    ];
  }
  return [note('Firefox for Android installs add-ons only from addons.mozilla.org, and the xslop listing is not live yet. Until then, install xslop on a computer and turn on mute sync, so the X app on your phone hides the accounts too.')];
}

function safariBody(latest: Latest): Node[] {
  const zip = latest.safari;
  if (!zip) {
    return [note('A Safari package is not available yet. On a Mac, Chrome or Firefox runs xslop today. Turn on mute sync there, so the X app on your iPhone hides the accounts too.')];
  }
  return [
    h('div', { class: 'install-actions' }, zipLink(zip, 'Download the Safari package'), zipMeta(zip)),
    steps(
      'You need a Mac with Xcode. Unzip the file into a folder that you keep.',
      'In Terminal, run the convert.sh script from the zip. It calls the converter from Apple and makes an Xcode project.',
      'Open the project in Xcode and click Run.',
      'In Safari, open Settings, then Extensions, and turn on xslop.',
    ),
    note('The App Store has no xslop listing. An iPhone needs the same Xcode build, signed with your own Apple account.'),
  ];
}

function guideBody(id: keyof typeof GUIDES, latest: Latest): Node[] {
  const guide = GUIDES[id];
  if (id === 'firefox-android') return firefoxAndroidBody(latest);
  if (guide.package === 'chrome') return chromiumBody(guide, latest);
  if (guide.package === 'firefox') return firefoxBody(guide, latest);
  if (guide.package === 'safari') return safariBody(latest);
  return [note('This browser cannot load extensions. Install xslop on a computer and turn on mute sync, so the X app on your phone hides the accounts too.')];
}

function render(latest: Latest, detected: BrowserId): void {
  req('#install-version').textContent = `Version ${latest.version}`;

  const now = req('#install-now');
  const others = OTHERS.filter((id) => id !== detected);
  if (detected === 'unknown') {
    now.replaceChildren(note('Pick your browser below. xslop runs on Chrome, Edge, Brave, Opera, Vivaldi, Arc, Firefox and Safari.'));
  } else {
    now.replaceChildren(h('p', { class: 'install-detected' }, `You are on ${GUIDES[detected].name}.`), ...guideBody(detected, latest));
  }

  req('#install-others').replaceChildren(
    h('p', { class: 'sub-title' }, 'Other browsers'),
    ...others.map((id) =>
      h('details', { class: 'install-other' }, h('summary', null, h('span', null, GUIDES[id].name), h('span', { class: 'toggle', 'aria-hidden': 'true' })), ...guideBody(id, latest)),
    ),
  );
}

export function initInstall(): void {
  const detected = detectBrowser(readBrowserSignals());
  request('/downloads/latest.json')
    .then((body) => render(parseLatest(body), detected))
    .catch((err: unknown) => {
      const version = req('#install-version');
      version.classList.add('is-error');
      version.textContent = `The download list did not load. ${describeError(err)}`;
      req('#install-now').replaceChildren(note('Download links appear here when the list loads. Reload the page to try again.'));
    });
}
