// What a view gets from the router, and the head that every view shares.

import { h } from '../lib/dom.ts';

export interface Ctx {
  /** Aborts when the reader opens another view, reloads or logs out. */
  signal: AbortSignal;
  /** Renders this view again with fresh data (a filter change, the r key). */
  reload: () => void;
  /** Reloads the menu counts and this view, after a write that succeeded. */
  afterWrite: () => Promise<void>;
}

/** The title row of a view with its one-line purpose and a reload button. */
export function head(title: string, lede: string | Node, ...extra: (Node | null)[]): HTMLElement {
  return h(
    'header',
    { class: 'view-head' },
    h('div', { class: 'view-title' }, h('h1', { class: 'adm-h1', id: 'view-title', tabindex: -1 }, title), h('p', { class: 'lede' }, lede)),
    h('div', { class: 'view-tools' }, ...extra, h('button', { type: 'button', class: 'btn btn-quiet btn-small', 'data-reload': '' }, 'Reload')),
  );
}

/** Links between the parts of one view (queues, appeal states), with a count when known. */
export function tabs(label: string, items: { href: string; text: string; count?: number | null; current: boolean }[]): HTMLElement {
  return h(
    'nav',
    { class: 'subtabs', 'aria-label': label },
    ...items.map((t) =>
      h('a', { href: t.href, 'aria-current': t.current ? 'page' : null }, t.text, typeof t.count === 'number' ? h('span', { class: 'count' }, String(t.count)) : null),
    ),
  );
}

export const ROW_LIMITS = ['50', '100', '200', '500'] as const;

export function limitSelect(id: string, value = '100'): HTMLElement[] {
  const select = h('select', { id, name: 'limit' }, ...ROW_LIMITS.map((v) => h('option', { value: v, selected: v === value }, v)));
  return [h('label', { for: id }, 'Rows'), select];
}

export function limitOf(root: ParentNode, id: string): string {
  const v = root.querySelector<HTMLSelectElement>(`#${id}`)?.value ?? '100';
  return (ROW_LIMITS as readonly string[]).includes(v) ? v : '100';
}
