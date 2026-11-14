// The download page. The hero names the visitor's browser and shows its main action and steps. Below it, one card for
// each browser: the browsers that run xslop today, then the browsers that wait for a store listing.
// Packages come from GET /downloads/latest.json. A store button appears only when latest.json names a store URL, so a
// listing that goes live moves its browser to the supported list with no change of code.

import { detectBrowser, installsFromChromeStore, readBrowserSignals, type BrowserId } from './hero/detect.ts';
import { request } from './lib/api.ts';
import { bindCopy, h, req } from './lib/dom.ts';
import { formatBytes } from './lib/format.ts';
import { describeError } from './lib/messages.ts';
import { parseLatest, type Download, type Latest } from './lib/schema.ts';

export type Browser = Exclude<BrowserId, 'phone-other' | 'unknown'>;
type Package = 'chrome' | 'firefox' | 'safari';
/** The download list, while it loads, or after it failed. */
type List = Latest | 'loading' | 'failed';

interface Guide {
  name: string;
  /** The browser's own extensions page. A page cannot link to it, so the reader copies it. */
  extensionsPage?: string;
}

/** Every browser in the order of the cards: the Chromium browsers, Firefox on a computer and on Android, then Safari. */
const GUIDES: Record<Browser, Guide> = {
  chrome: { name: 'Chrome', extensionsPage: 'chrome://extensions' },
  brave: { name: 'Brave', extensionsPage: 'brave://extensions' },
  vivaldi: { name: 'Vivaldi', extensionsPage: 'vivaldi://extensions' },
  arc: { name: 'Arc', extensionsPage: 'arc://extensions' },
  edge: { name: 'Edge', extensionsPage: 'edge://extensions' },
  opera: { name: 'Opera', extensionsPage: 'opera://extensions' },
  firefox: { name: 'Firefox', extensionsPage: 'about:debugging#/runtime/this-firefox' },
  'firefox-android': { name: 'Firefox for Android' },
  safari: { name: 'Safari' },
};

const BROWSERS = Object.keys(GUIDES) as Browser[];
const CHROMIUM: readonly Browser[] = ['chrome', 'brave', 'vivaldi', 'arc', 'edge', 'opera'];

/** The two lists of cards. Firefox joins the supported browsers once latest.json names its addons.mozilla.org listing. */
export function browserSections(firefoxUrl: string | null): { supported: Browser[]; soon: Browser[] } {
  const runs = (id: Browser): boolean => CHROMIUM.includes(id) || (firefoxUrl !== null && (id === 'firefox' || id === 'firefox-android'));
  return { supported: BROWSERS.filter(runs), soon: BROWSERS.filter((id) => !runs(id)) };
}

/** "A, B and C". */
export function listNames(ids: readonly Browser[]): string {
  const names = ids.map((id) => GUIDES[id].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/** The hero has the one main action of the page. The buttons of the cards are quiet. */
type Kind = 'btn-primary' | 'btn-quiet';

/** One way to install xslop in one browser. The hero shows all of it; a card folds the steps. */
interface Way {
  /** A sentence about the browser, above the action. */
  lead?: string;
  /** The main action: a store button or the zip button. Empty when the browser has none today. */
  main: Node[];
  /** The file, the size and the SHA-256 of the zip of the main action. */
  meta?: Node;
  /** The steps or the second way. With a label, the hero gives it a title and a card folds it. */
  more?: { label?: string; nodes: Node[] };
  /** A card of the coming soon list folds the whole way under this label: a small option, not the main way. */
  fold?: string;
}

function note(text: string): HTMLElement {
  return h('p', { class: 'install-note' }, text);
}

function actions(...children: Node[]): HTMLElement {
  return h('div', { class: 'install-actions' }, ...children);
}

type Inline = (Node | string)[];

/** A numbered path, as on /check. The words of a step are one element beside its number. */
function steps(...items: (string | Inline)[]): HTMLElement {
  return h('ol', { class: 'install-steps' }, ...items.map((item) => h('li', null, h('span', null, ...(typeof item === 'string' ? [item] : item)))));
}

/** The address of the browser's extensions page, with a copy button: web pages may not link to it. */
function pageAddress(address: string): Inline {
  const copy = h('button', { type: 'button', class: 'btn-text' }, 'Copy');
  bindCopy(copy, () => address);
  return [h('code', null, address), ' ', copy];
}

function zipMeta(d: Download, pending: boolean): HTMLElement {
  const copy = h('button', { type: 'button', class: 'btn-text' }, 'Copy SHA-256');
  bindCopy(copy, () => d.sha256);
  return h(
    'div',
    { class: pending ? 'dl-meta is-pending' : 'dl-meta', 'aria-hidden': pending ? 'true' : null },
    h('span', null, `${d.file}, ${formatBytes(d.bytes)}`),
    h('span', { class: 'sha' }, `SHA-256 ${d.sha256}`),
    h('span', null, copy),
  );
}

/** The zip button and its file line. While the list loads, both hold their place with the same size, so nothing moves when the answer comes. */
function zip(list: List, target: Package, label: string, kind: Kind): { link: Node; meta?: Node } {
  if (list === 'failed') return { link: note('Download links appear here when the list loads. Reload the page to try again.') };
  if (list === 'loading') {
    const placeholder: Download = { file: `xslop-${target}-v0.0.0.zip`, sha256: '0'.repeat(64), bytes: 90_000 };
    return { link: h('a', { class: `btn ${kind}`, 'aria-disabled': 'true' }, label), meta: zipMeta(placeholder, true) };
  }
  const d = list[target];
  if (!d) return { link: note('The zip is not available right now. Try again later.') };
  return { link: h('a', { class: `btn ${kind}`, href: `/downloads/${d.file}`, download: d.file }, label), meta: zipMeta(d, false) };
}

function storeLink(href: string, label: string, kind: Kind): HTMLAnchorElement {
  return h('a', { class: `btn ${kind}`, href, rel: 'noopener noreferrer' }, label);
}

/** The official badge of the Chrome Web Store, unchanged (developer.chrome.com/docs/webstore/branding). It always links to the listing. */
function chromeStoreBadge(href: string): HTMLAnchorElement {
  return h('a', { class: 'store-badge', href, rel: 'noopener noreferrer', 'aria-label': 'Available in the Chrome Web Store' });
}

function chromiumWay(id: Browser, list: List, kind: Kind): Way {
  const { name, extensionsPage = '' } = GUIDES[id];
  const store = typeof list === 'object' && list.chromeStoreUrl && installsFromChromeStore(id) ? list.chromeStoreUrl : null;
  const { link, meta } = zip(list, 'chrome', `Download the zip for ${name}`, store ? 'btn-quiet' : kind);
  const install = [
    steps(
      'Unzip the file into a folder that you keep.',
      ['Type this into the address bar: ', ...pageAddress(extensionsPage)],
      'Turn on Developer mode.',
      'Click Load unpacked and choose the folder.',
      'Open x.com. Each post and reply now has the xslop x.',
    ),
    note(`${name} loads this as a developer extension. It keeps working after a restart, and ${name} can show a reminder about developer extensions.`),
  ];
  // The store first. The zip stays as the second way.
  if (store) return { main: [chromeStoreBadge(store)], more: { label: 'Or install the zip yourself', nodes: [actions(link, ...(meta ? [meta] : [])), ...install] } };
  return { main: [link], ...(meta && { meta }), more: { label: 'How to install', nodes: install } };
}

function firefoxWay(list: List, kind: Kind): Way {
  const url = typeof list === 'object' ? list.firefoxUrl : null;
  if (url) return { main: [storeLink(url, 'Add to Firefox', kind)], more: { nodes: [note('The button opens addons.mozilla.org, where you click Add to Firefox.')] } };
  const { link, meta } = zip(list, 'firefox', 'Download the Firefox zip', kind);
  return {
    lead: 'The addons.mozilla.org listing is not live yet. Until then, you can try xslop as a temporary add-on.',
    fold: 'Try it now',
    main: [link],
    ...(meta && { meta }),
    more: {
      label: 'How to install',
      nodes: [
        steps(
          ['Type this into the address bar: ', ...pageAddress(GUIDES.firefox.extensionsPage ?? '')],
          'Click Load Temporary Add-on.',
          'Choose the zip file.',
          'Open x.com. Each post and reply now has the xslop x.',
        ),
        note('Firefox removes a temporary add-on when it restarts. Repeat these steps after a restart, until the addons.mozilla.org listing is live.'),
      ],
    },
  };
}

function firefoxAndroidWay(list: List, kind: Kind): Way {
  const url = typeof list === 'object' ? list.firefoxUrl : null;
  if (url) {
    return {
      main: [storeLink(url, 'Open on addons.mozilla.org', kind)],
      more: { nodes: [note('Tap the button, then tap Add to Firefox. Log in to x.com in Firefox and the posts and replies get the xslop x.')] },
    };
  }
  return {
    lead: 'Firefox for Android installs add-ons only from addons.mozilla.org, and the xslop listing is not live yet. Until then, install xslop on a computer and turn on mute sync, so the X app on your phone hides the accounts too.',
    main: [],
  };
}

function safariWay(list: List, kind: Kind): Way {
  if (typeof list === 'object' && !list.safari) {
    return { lead: 'A Safari package is not available yet. On a Mac, Chrome runs xslop today. Turn on mute sync there, so the X app on your iPhone hides the accounts too.', main: [] };
  }
  const { link, meta } = zip(list, 'safari', 'Download the Safari package', kind);
  return {
    lead: 'The App Store has no xslop listing. With a Mac and Xcode, you can build it yourself.',
    fold: 'Build it yourself on a Mac',
    main: [link],
    ...(meta && { meta }),
    more: {
      label: 'How to build it',
      nodes: [
        steps(
          'You need a Mac with Xcode. Unzip the file into a folder that you keep.',
          'In Terminal, run the convert.sh script from the zip. It calls the converter from Apple and makes an Xcode project.',
          'Open the project in Xcode and click Run.',
          'In Safari, open Settings, then Extensions, and turn on xslop.',
        ),
        note('An iPhone needs the same Xcode build, signed with your own Apple account.'),
      ],
    },
  };
}

function wayFor(id: Browser, list: List, kind: Kind): Way {
  if (id === 'firefox') return firefoxWay(list, kind);
  if (id === 'firefox-android') return firefoxAndroidWay(list, kind);
  if (id === 'safari') return safariWay(list, kind);
  return chromiumWay(id, list, kind);
}

/** The hero: the visitor's browser, its main action, then its steps. A browser with no action today points to the supported list. */
function hero(detected: BrowserId, list: List, supported: readonly Browser[]): Node[] {
  let way: Way;
  if (detected === 'unknown') way = { lead: `Pick your browser below. xslop runs on ${listNames(supported)} today.`, main: [] };
  else if (detected === 'phone-other') way = { lead: 'This browser cannot load extensions. Install xslop on a computer and turn on mute sync, so the X app on your phone hides the accounts too.', main: [] };
  else way = wayFor(detected, list, 'btn-primary');
  const main = way.main.length > 0 ? way.main : [h('a', { class: 'btn btn-quiet', href: '#supported' }, 'See the supported browsers')];
  return [
    detected === 'unknown' || detected === 'phone-other' ? null : h('p', { class: 'install-detected' }, `You are on ${GUIDES[detected].name}.`),
    way.lead ? h('p', { class: 'dl-now-lead' }, way.lead) : null,
    actions(...main, ...(way.meta ? [way.meta] : [])),
    way.more?.label ? h('p', { class: 'sub-title' }, way.more.label) : null,
    ...(way.more?.nodes ?? []),
  ].filter((node): node is Node => node !== null);
}

function fold(label: string, ...children: Node[]): HTMLDetailsElement {
  return h('details', { class: 'dl-fold' }, h('summary', null, h('span', null, label), h('span', { class: 'toggle', 'aria-hidden': 'true' })), ...children);
}

function card(id: Browser, list: List, detected: BrowserId): HTMLLIElement {
  const way = wayFor(id, list, 'btn-quiet');
  const yours = id === detected;
  const rest = [...(way.meta ? [way.meta] : []), ...(way.more?.nodes ?? [])];
  const body: Node[] = [];
  if (way.lead) body.push(h('p', { class: 'dl-card-lead' }, way.lead));
  if (way.fold) {
    body.push(fold(way.fold, actions(...way.main), ...(way.more?.label ? [h('p', { class: 'sub-title' }, way.more.label)] : []), ...rest));
  } else {
    if (way.main.length > 0) body.push(actions(...way.main));
    if (rest.length > 0) body.push(...(way.more?.label ? [fold(way.more.label, ...rest)] : rest));
  }
  return h(
    'li',
    { class: yours ? 'dl-card is-yours' : 'dl-card', id: `browser-${id}` },
    h('div', { class: 'dl-card-head' }, h('h3', { class: 'dl-card-name' }, GUIDES[id].name), yours ? h('span', { class: 'dl-yours' }, 'Your browser') : null),
    ...body,
  );
}

function render(list: List, detected: BrowserId): void {
  const { supported, soon } = browserSections(typeof list === 'object' ? list.firefoxUrl : null);
  const now = req('#install-now');
  now.setAttribute('aria-busy', String(list === 'loading'));
  now.replaceChildren(...hero(detected, list, supported));
  req('#supported-list').replaceChildren(...supported.map((id) => card(id, list, detected)));
  req('#soon-list').replaceChildren(...soon.map((id) => card(id, list, detected)));
}

export function initInstall(): void {
  const detected = detectBrowser(readBrowserSignals());
  render('loading', detected);
  request('/downloads/latest.json')
    .then(parseLatest)
    .then(
      (latest) => {
        req('#install-version').textContent = `Version ${latest.version}`;
        render(latest, detected);
      },
      (err: unknown) => {
        const version = req('#install-version');
        version.classList.add('is-error');
        version.textContent = `The download list did not load. ${describeError(err)}`;
        render('failed', detected);
      },
    );
}
