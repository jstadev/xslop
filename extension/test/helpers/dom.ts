// Load a fixture page into the happy-dom document.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
export const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8');

export function parseFixture(name: string): Document {
  return new DOMParser().parseFromString(fixture(name), 'text/html');
}

/** Put the fixture body into the live document at an x.com URL. */
export function mountFixture(name: string, url: string): void {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.body.replaceChildren(...[...parseFixture(name).body.childNodes].map((n) => document.importNode(n, true)));
}

export const frames = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
};

export const articleOf = (id: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')].find((a) =>
    [...a.querySelectorAll('time')].some((t) => t.closest(`a[href$="/status/${id}"]`)),
  )!;

export const cellOf = (id: string): HTMLElement => articleOf(id).closest<HTMLElement>('[data-testid="cellInnerDiv"]')!;

/** The closed shadow root of an xslop host, kept by setup.ts (the page itself cannot get it). */
export const rootOf = (el: Element | null | undefined): ShadowRoot | null =>
  (el && (globalThis as { __xslopRoots?: WeakMap<Element, ShadowRoot> }).__xslopRoots?.get(el)) ?? null;

/** Text of the xslop bar in a cell (inside its shadow root), or null. */
export function barText(id: string): string | null {
  return rootOf(cellOf(id).querySelector(':scope > .xslop-bar'))?.textContent ?? null;
}

export function barButton(id: string, label: string): HTMLButtonElement {
  const root = rootOf(cellOf(id).querySelector(':scope > .xslop-bar'))!;
  return [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

export const markButton = (id: string): HTMLButtonElement | null =>
  rootOf(articleOf(id).querySelector('.xslop-host'))?.querySelector('button') ?? null;

/** True when CSS (content.css rules) would hide the tweet. */
export function isHidden(id: string): boolean {
  const cell = cellOf(id);
  return cell.hasAttribute('data-xslop-cell') || articleOf(id).hasAttribute('data-xslop-article');
}
