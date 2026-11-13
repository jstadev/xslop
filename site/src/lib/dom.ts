// DOM helpers. All text goes through textContent; no HTML strings, no inline styles, no handlers in attributes.

type AttrValue = string | number | boolean | null | undefined;
type Child = Node | string | null | undefined | false;

/** Creates an element. Attribute names `style` and `on*` are refused so CSP-safe markup stays enforced in code. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'style' || name.startsWith('on')) throw new Error(`refused attribute: ${name}`);
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name === 'className' ? 'class' : name, value === true ? '' : String(value));
    }
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

/** Returns the element that matches `selector`, or throws: a missing element is a markup bug. */
export function req<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The xslop mark from the page sprite (#xs-mark), decorative. */
export function markIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#xs-mark');
  svg.append(use);
  return svg;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Copies text to the clipboard and reports the result on the button for a short time. */
export function bindCopy(button: HTMLButtonElement, getText: () => string): void {
  const label = button.textContent ?? 'Copy';
  let timer = 0;
  button.addEventListener('click', async () => {
    window.clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    timer = window.setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
}
