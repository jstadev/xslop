// Row behaviour through delegated listeners, so a page of rows adds no listeners of its own.

import type { Slopper } from '../lib/schema.ts';
import { noPhoto, panelContent } from './row.ts';

type FindRow = (handle: string) => Slopper | undefined;

function toggleRow(button: HTMLButtonElement, find: FindRow): void {
  const row = button.closest<HTMLElement>('.sl-slop');
  const panel = row?.querySelector<HTMLElement>('.sl-panel');
  const slopper = find(row?.dataset.handle ?? '');
  if (!row || !panel || !slopper) return;
  const open = button.getAttribute('aria-expanded') !== 'true';
  if (open && panel.childElementCount === 0) panel.append(...panelContent(slopper));
  panel.hidden = !open;
  row.classList.toggle('is-open', open);
  button.setAttribute('aria-expanded', String(open));
}

export function bindRows(list: HTMLElement, find: FindRow): void {
  list.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('.sl-show');
    if (button) {
      toggleRow(button, find);
      return;
    }
    // A tap anywhere else on the line opens it too, unless it is a control, the open record or a text selection.
    if (event.target.closest('a, button, .sl-panel') || window.getSelection()?.isCollapsed === false) return;
    const rowButton = event.target.closest('.sl-slop')?.querySelector<HTMLButtonElement>('.sl-show');
    if (rowButton) toggleRow(rowButton, find);
  });

  // Capture phase: error events do not bubble. A dead avatar becomes the default picture in the same box, so nothing moves.
  list.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLImageElement) event.target.replaceWith(noPhoto());
    },
    true,
  );
}

interface Lamp {
  watch(row: Element): void;
  clear(): void;
}

/** Touch screens have no hover, so the row at the middle of the screen lights up as you scroll. */
export function createLamp(): Lamp {
  const touch = window.matchMedia('(hover: none)').matches && 'IntersectionObserver' in window;
  const observer = touch
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) entry.target.classList.toggle('is-lit', entry.isIntersecting);
        },
        { rootMargin: '-50% 0px -50% 0px' },
      )
    : null;
  return {
    watch: (row) => observer?.observe(row),
    clear: () => observer?.disconnect(),
  };
}
