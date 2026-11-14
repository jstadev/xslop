// DOM pieces of the console: times, terms, sentences, tables, checklists, the two-click button and the status line.

import { ApiError } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { formatCount, formatRelative } from '../lib/format.ts';
import { postUrl, profileUrl } from '../lib/handle.ts';
import { describeError } from '../lib/messages.ts';
import type { Mark, Seg } from './explain.ts';
import { GLOSSARY, isTerm, type TermKey } from './glossary.ts';
import { HANDLE_RE, UUID_RE } from './route.ts';
import { session, SessionEnded } from './session.ts';

type Child = Node | string | null | undefined | false;

const status = (): HTMLElement => req('#status');

export function say(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const el = status();
  el.textContent = text;
  el.dataset.kind = kind;
}

/** Reports a failed request in the status line. An abort (a newer request of the view) and a session end say nothing. */
export function fail(err: unknown): void {
  if (err instanceof SessionEnded || (err instanceof ApiError && err.code === 'aborted')) return;
  if (err instanceof ApiError && err.status === 403) {
    say('The server refused the action (403). Reload the page and try again.', 'error');
    return;
  }
  say(describeError(err), 'error');
}

export const isAbort = (err: unknown): boolean => err instanceof SessionEnded || (err instanceof ApiError && err.code === 'aborted');

const localFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' });

/** The full local time: "Nov 13, 2026, 2:03:05 PM". */
export function localTime(iso: string): string {
  return localFormat.format(new Date(iso));
}

const validTime = (iso: string | null | undefined): iso is string => typeof iso === 'string' && iso !== '' && !Number.isNaN(Date.parse(iso));

/** A relative time ("3 minutes ago") with the full local time on hover and focus. */
export function time(iso: string | null | undefined, empty = 'never'): Node | string {
  if (!validTime(iso)) return empty;
  return h('time', { datetime: iso, tabindex: 0, 'data-tip': localTime(iso) }, formatRelative(iso));
}

/** A glossary word: a link to its definition, with the definition on hover and focus. */
export function termLink(key: TermKey, text: string = GLOSSARY[key].word): HTMLAnchorElement {
  return h('a', { class: 'term', href: `#help/${key}`, 'data-term': key }, text);
}

export function accountLink(handle: string, text = `@${handle}`): Node | string {
  return HANDLE_RE.test(handle) ? h('a', { href: `#account/${handle}`, class: 'handle' }, text) : text;
}

export function installLink(id: string): Node | string {
  return UUID_RE.test(id) ? h('a', { href: `#install/${id}`, class: 'mono', 'data-tip': id }, id.slice(0, 8)) : id.slice(0, 8) || 'unknown';
}

export function xProfile(handle: string): Node | null {
  return HANDLE_RE.test(handle) ? h('a', { href: profileUrl(handle), rel: 'noopener noreferrer', target: '_blank', class: 'ext' }, 'Open on X') : null;
}

export function postLink(tweetId: string, text: string): Node | string {
  const url = postUrl(tweetId);
  return url ? h('a', { href: url, rel: 'noopener noreferrer', target: '_blank', class: 'ext' }, text) : text;
}

/** A sentence of the explain module as DOM: terms and subjects become links. */
export function sentence(segs: Seg[], cls = ''): HTMLElement {
  const el = h('p', { class: `sentence ${cls}`.trim() });
  for (const s of segs) {
    if (typeof s === 'string') el.append(s);
    else if (s.t === 'term') el.append(termLink(s.term, s.text));
    else if (s.t === 'handle') el.append(accountLink(s.handle));
    else if (s.t === 'install') el.append(installLink(s.id));
    else el.append(h('a', { href: '#lists' }, `version ${formatCount(s.version)}`));
  }
  return el;
}

export function pill(status: string): HTMLElement {
  return h('span', { class: 'pill', 'data-status': status }, status === 'none' ? 'not listed' : status);
}

const MARK_TEXT: Record<Mark, [string, string]> = {
  met: ['✓', 'met'],
  unmet: ['✗', 'not met'],
  open: ['?', 'not tested yet'],
  none: ['·', 'does not apply'],
};

export function mark(m: Mark, need = ''): HTMLElement {
  const [glyph, words] = MARK_TEXT[m];
  // The glyph is an image with the words as its name, so a screen reader says "met" where the eye sees the check mark.
  return h('span', { class: 'mark', 'data-mark': m }, h('span', { class: 'glyph', role: 'img', 'aria-label': words }, glyph), need);
}

export interface Column<T> {
  label: string;
  term?: TermKey;
  cell: (row: T) => Child;
  className?: string;
}

/** A table that turns into label and value lines below 48rem. Each header links to its definition. */
export function table<T>(label: string, columns: Column<T>[], items: T[], empty: string, id?: string): HTMLElement {
  const head = h('thead', null, h('tr', null, ...columns.map((c) => h('th', { scope: 'col', class: c.className }, c.term ? termLink(c.term, c.label) : c.label))));
  const body = h('tbody');
  if (items.length === 0) body.append(h('tr', null, h('td', { colspan: columns.length, class: 'empty' }, empty)));
  for (const item of items) body.append(h('tr', null, ...columns.map((c) => h('td', { class: c.className, 'data-label': c.label }, c.cell(item)))));
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': label, tabindex: 0 }, h('table', { class: 'grid', id }, head, body));
}

/** A titled part of a page. */
export function block(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'block' }, h('h2', { class: 'block-title' }, title), ...children);
}

/** Label and value lines. A label may be a glossary term. */
export function facts(items: [string | Node, Child][]): HTMLElement {
  return h('dl', { class: 'facts' }, ...items.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v ?? 'none'))));
}

export function note(text: string | Node, cls = ''): HTMLElement {
  return h('p', { class: `note ${cls}`.trim() }, text);
}

/** Every write asks once: the first click arms the button for 4 s and names what the second click sends. */
export function guarded(label: string, className: string, action: () => Promise<void>, armedLabel = `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`): HTMLButtonElement {
  const button = h('button', { type: 'button', class: `btn btn-small ${className}` }, label);
  let armed = false;
  let timer = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = armedLabel;
      button.dataset.armed = 'true';
      timer = window.setTimeout(() => {
        armed = false;
        button.textContent = label;
        delete button.dataset.armed;
      }, 4000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    delete button.dataset.armed;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await action();
    } catch (err) {
      fail(err);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = label;
      }
    }
  });
  return button;
}

// The definition box: one element for every term and time, placed next to the element under the pointer or the focus.

let tipFor: HTMLElement | null = null;

function tipText(el: HTMLElement): string | null {
  const key = el.dataset.term;
  if (key && isTerm(key)) return `${GLOSSARY[key].word}: ${GLOSSARY[key].def(session.rules)}`;
  return el.dataset.tip ?? null;
}

function showTip(el: HTMLElement): void {
  const text = tipText(el);
  const tip = req('#tip');
  if (!text) return;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = el;
  tip.textContent = text;
  tip.hidden = false;
  el.setAttribute('aria-describedby', 'tip');
  placeTip(tip, el);
}

/** Below the element when it fits, else above it; never past the sides of the window. */
function placeTip(tip: HTMLElement, el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8));
  const below = box.bottom + 6 + tip.offsetHeight < window.innerHeight;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(below ? box.bottom + 6 : box.top - 6 - tip.offsetHeight)}px`;
}

export function hideTip(): void {
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
  const tip = document.querySelector<HTMLElement>('#tip');
  if (tip) {
    tip.hidden = true;
    tip.textContent = '';
  }
}

const tipTarget = (e: Event): HTMLElement | null => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-term], [data-tip]') : null);

export function installTips(): void {
  document.addEventListener('pointerover', (e) => {
    const el = tipTarget(e);
    if (el && el !== tipFor) showTip(el);
    else if (!el && tipFor && document.activeElement !== tipFor) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e);
    if (el) showTip(el);
    else hideTip();
  });
  document.addEventListener('focusout', () => hideTip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  });
  // On scroll the tip follows an element that keeps the focus or the pointer; any other tip closes.
  window.addEventListener(
    'scroll',
    () => {
      const tip = document.querySelector<HTMLElement>('#tip');
      if (tipFor && tip && (document.activeElement === tipFor || tipFor.matches(':hover'))) placeTip(tip, tipFor);
      else hideTip();
    },
    { passive: true },
  );
}
