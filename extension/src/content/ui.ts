// The xslop button and the collapsed-tweet bar, each inside its own shadow root. DOM APIs only.

// xslop blue #3368fe (brand/tokens.css): 4.55:1 on X lights out, 4.61:1 on X light, 3.57:1 on X dim (icons and focus need 3:1).
// Link text mixes the blue with X's theme text colour, so it keeps 4.5:1 on every X theme.
// The icon and hover circle match X's own action icons: 18.75 px icon, 34.75 px circle, drawn without taking layout space.
const FONT = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const CSS = `
:host { all: initial; display: inline-flex; align-items: center; color: var(--xslop-text); font-family: ${FONT}; }
:host(.xslop-bar) { display: block; }
button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
.mark { position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: var(--xslop-icon-size, 18.75px); height: var(--xslop-icon-size, 18.75px); color: var(--xslop-secondary); transition: color .15s; }
.mark svg { position: relative; width: 100%; height: 100%; display: block; }
.mark::before { content: ''; position: absolute; inset: -8px; border-radius: 999px; transition: background-color .15s; }
.mark[aria-pressed="true"] { color: #3368fe; }
.mark[aria-pressed="true"]::before { background-color: rgba(51, 104, 254, .12); }
.mark:focus-visible, .link:focus-visible { outline: 2px solid #3368fe; outline-offset: 2px; border-radius: 999px; }
.tip { position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%); white-space: nowrap;
  padding: 3px 7px; border-radius: 4px; font: 12px/16px ${FONT}; color: #fff; background: rgba(39, 44, 48, .95);
  pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 1; }
.mark:focus-visible .tip { opacity: 1; transition-delay: .4s; }
/* A touch screen keeps :hover after a tap, which would keep the button blue after an undo. */
@media (hover: hover) {
  .mark:hover { color: #3368fe; }
  .mark:hover::before { background-color: rgba(51, 104, 254, .12); }
  .mark:hover .tip { opacity: 1; transition-delay: .4s; }
}
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; box-sizing: border-box; width: 100%;
  padding: 10px 16px; font-size: 14px; line-height: 20px; }
.msg, .sep { color: var(--xslop-secondary); }
.link { font-weight: 600; color: color-mix(in oklab, #3368fe 80%, currentColor); padding: 2px 2px; border-radius: 4px; }
.link:hover { text-decoration: underline; }
@media (max-width: 700px), (pointer: coarse) {
  /* 44 px across the empty gap and X's row padding. A tap on X's neighbouring icon must stay X's. */
  .mark::after { content: ''; position: absolute; inset-block: calc((var(--xslop-icon-size, 18.75px) - 44px) / 2);
    inset-inline: calc(-1 * var(--xslop-gap, 0px)) -16px; }
  .link { min-height: 44px; padding: 0 6px; }
  .bar { padding: 0 12px; }
  .tip { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .mark, .mark::before, .tip { transition: none; }
}
`;

/** Adopts one shared sheet per CSS text. Some engines refuse a sheet made in the content script world: a style element then. */
const sheets = new Map<string, CSSStyleSheet | null>();

function styleRoot(root: ShadowRoot, css: string): void {
  if (!sheets.has(css)) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      sheets.set(css, sheet);
    } catch {
      sheets.set(css, null);
    }
  }
  const sheet = sheets.get(css);
  if (sheet) {
    try {
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Fall through to a style element.
    }
  }
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
}

let markTemplate: Element | null | undefined;

/** The brand mark (bundled at build time from brand/mark-mono.svg), cloned for each use. */
function mark(): Element {
  if (markTemplate === undefined) {
    const doc = new DOMParser().parseFromString(__MARK_SVG__, 'image/svg+xml');
    const svg = doc.documentElement;
    markTemplate = svg.namespaceURI === 'http://www.w3.org/2000/svg' && svg.localName === 'svg' ? svg : null;
  }
  if (markTemplate) {
    const el = document.importNode(markTemplate, true);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('focusable', 'false');
    return el;
  }
  const span = document.createElement('span');
  span.textContent = 'x';
  return span;
}

/** Closed: page scripts cannot read your votes out of the button labels. The e2e test build uses open roots. */
const SHADOW_MODE: ShadowRootMode = typeof __SHADOW__ === 'string' && __SHADOW__ === 'open' ? 'open' : 'closed';

export function makeHost(tag: 'div' | 'span', className: string, css: string): { el: HTMLElement; root: ShadowRoot } {
  const el = document.createElement(tag);
  el.className = className;
  const root = el.attachShadow({ mode: SHADOW_MODE });
  styleRoot(root, css);
  return { el, root };
}

/** The parent of `n`, also across the edge of a shadow root. */
const parentOf = (n: Element): Element | null => n.parentElement ?? (n.getRootNode() as Partial<ShadowRoot>).host ?? null;

/**
 * True when `el` has a size and no element from `el` up to the page root hides it with `visibility` or a
 * combined opacity under 0.5. A page that fades xslop's control out cannot collect a click on it.
 */
export function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  let opacity = 1;
  for (let n: Element | null = el; n; n = parentOf(n)) {
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    const o = parseFloat(cs.opacity);
    if (Number.isFinite(o)) opacity *= o;
  }
  return opacity >= 0.5;
}

/** Only real input may vote or mute, and one press counts once: the second click of a double click does nothing. */
export const trusted = (fn: () => void) => (e: Event): void => {
  e.preventDefault();
  e.stopPropagation();
  if (e.isTrusted && (e as MouseEvent).detail < 2) fn();
};

/** Keeps X from opening the tweet, or running a key shortcut, when you press an xslop control. */
function shield(el: HTMLElement): void {
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
}

export interface MarkButton {
  el: HTMLElement;
  /** `mutes`: a click also mutes on X, so the tooltip says so. */
  set(handle: string, pressed: boolean, mutes: boolean): void;
}

export function makeButton(onClick: () => void): MarkButton {
  const { el, root } = makeHost('span', 'xslop-host', CSS);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mark';
  const tip = document.createElement('span');
  tip.className = 'tip';
  tip.setAttribute('aria-hidden', 'true');
  b.append(mark(), tip);
  b.addEventListener('click', trusted(onClick));
  root.append(b);
  shield(el);
  return {
    el,
    set(handle, pressed, mutes) {
      b.setAttribute('aria-label', pressed ? `Unmark @${handle} as slop` : `Mark @${handle} as slop`);
      b.setAttribute('aria-pressed', String(pressed));
      tip.textContent = pressed ? 'Marked as slop. Click to undo.' : mutes ? 'Mark as slop, hide and mute' : 'Mark as slop and hide';
    },
  };
}

interface BarAction {
  label: string;
  run: () => void;
}

export interface Bar {
  el: HTMLElement;
  focusLast(): void;
  /** Closes the space the tweet left, from its height to the bar's own. No motion under reduced motion. */
  shrinkFrom(height: number): void;
}

const COLLAPSE_MS = 180;

/** One line: message · action · action. */
export function makeBar(message: string, actions: BarAction[]): Bar {
  const { el, root } = makeHost('div', 'xslop-bar', CSS);
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', message);
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = message;
  bar.append(msg);
  const buttons: HTMLButtonElement[] = [];
  for (const a of actions) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = a.label;
    b.addEventListener('click', trusted(a.run));
    buttons.push(b);
    bar.append(sep, b);
  }
  root.append(bar);
  shield(el);
  return {
    el,
    focusLast: () => buttons[buttons.length - 1]?.focus(),
    shrinkFrom(height) {
      if (height < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const to = el.getBoundingClientRect().height;
      if (to >= height) return;
      el.animate([{ height: `${height}px` }, { height: `${to}px` }], { duration: COLLAPSE_MS, easing: 'cubic-bezier(.2, 0, 0, 1)' });
    },
  };
}
