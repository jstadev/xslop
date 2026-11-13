// The thread: pages, states and the query. `query` is the only source of truth; the URL only reflects it.

import { ApiError, request } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { formatCount } from '../lib/format.ts';
import { describeError } from '../lib/messages.ts';
import { parseSloppersPage, type Slopper, type SloppersPage } from '../lib/schema.ts';
import { initControls } from './controls.ts';
import { bindRows, createLamp } from './interactions.ts';
import { apiPath, DEFAULT_QUERY, queryString, readQuery, type Query } from './query.ts';
import { renderRow } from './row.ts';

const PAGE_SIZE = 60;
const LOAD_AHEAD = '900px 0px';
const SKELETON_ROWS = 6;
/** Rows that can sit in the first viewport skip lazy loading, so the faces you see first arrive first. */
const EAGER_ROWS = 8;

const accounts = (n: number, status = ''): string => `${formatCount(n)} ${status}${n === 1 ? 'account' : 'accounts'}`;

function resultLine(query: Query, total: number): string {
  const noun = accounts(total, query.status === 'all' ? '' : `${query.status} `);
  return query.q ? `${noun} ${total === 1 ? 'matches' : 'match'} “${query.q}”` : noun;
}

function emptyText(query: Query): string {
  if (query.q) return `No account on the list matches “${query.q}”. Check the spelling, or try part of a name.`;
  if (query.status === 'flagged') return 'No account is flagged right now.';
  if (query.status === 'confirmed') return 'No account is confirmed yet.';
  return 'The list is empty right now.';
}

/** A cursor lives for one rebuild of the list on the server. Trying the same cursor again can never work. */
const isExpiredCursor = (err: unknown): boolean => err instanceof ApiError && (err.code === 'stale_cursor' || err.code === 'invalid_cursor');

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'btn btn-quiet sl-link' }, label);
  button.addEventListener('click', action);
  return button;
}

function skeletonRow(): HTMLLIElement {
  return h('li', { class: 'sl-slop is-skeleton', 'aria-hidden': 'true' }, h('div', { class: 'sl-row' }, h('span', { class: 'sl-face' }), h('div', { class: 'sl-body' }, h('p', { class: 'sl-head' }), h('p', { class: 'sl-facts' }))));
}

export function initThread(): void {
  const result = req('#sl-result');
  const list = req<HTMLOListElement>('#sl-list');
  const note = req('#sl-note');
  const moreBox = req('#sl-more');
  const moreButton = req<HTMLButtonElement>('#sl-more-button');

  let query = readQuery(location.search);
  let next: string | null = null;
  let active: AbortController | null = null;
  const rows = new Map<string, Slopper>();
  const lamp = createLamp();
  const controls = initControls(query, setQuery);

  function setQuery(patch: Partial<Query>): void {
    query = { ...query, ...patch };
    history.replaceState(null, '', `${location.pathname}${queryString(query)}${location.hash}`);
    void fetchPage(null);
  }

  function clearFilters(): void {
    controls.clear();
    setQuery(DEFAULT_QUERY);
  }

  function setNote(state: 'empty' | 'error' | 'end', children: Node[]): void {
    note.dataset.state = state;
    note.replaceChildren(...children);
  }

  function clearNote(): void {
    // Removing the focused Try again button would send keyboard users back to the top of the page.
    if (note.contains(document.activeElement)) result.focus();
    delete note.dataset.state;
    note.replaceChildren();
  }

  function clearRows(): void {
    list.replaceChildren();
    rows.clear();
    lamp.clear();
  }

  function appendRows(page: SloppersPage): void {
    const fragment = document.createDocumentFragment();
    for (const item of page.items) {
      if (rows.has(item.handle)) continue;
      rows.set(item.handle, item);
      const row = renderRow(item, rows.size <= EAGER_ROWS);
      fragment.append(row);
      lamp.watch(row);
    }
    list.append(fragment);
  }

  function showEmpty(): void {
    const children: Node[] = [h('p', null, emptyText(query))];
    if (query.q !== '' || query.status !== 'all') children.push(actionButton('Clear search and filters', clearFilters));
    setNote('empty', children);
  }

  function showEnd(takeFocus: boolean): void {
    const end = h('p', { tabindex: '-1' }, `End of the list: ${accounts(rows.size)}.`);
    setNote('end', [end]);
    if (takeFocus) end.focus();
  }

  function showPage(page: SloppersPage): void {
    next = page.next;
    result.textContent = rows.size === 0 ? '' : resultLine(query, page.total);
    const buttonHadFocus = document.activeElement === moreButton;
    moreBox.hidden = next === null;
    if (next !== null) {
      // A new observation reports the current position, so a tall screen keeps loading without a scroll.
      pageObserver?.unobserve(moreBox);
      pageObserver?.observe(moreBox);
    } else if (rows.size === 0) {
      showEmpty();
    } else {
      showEnd(buttonHadFocus);
    }
  }

  function restart(): void {
    // The HTTP cache can still hold a first page that carries the expired cursor.
    void fetchPage(null, 'no-cache');
    window.scrollTo(0, 0);
  }

  function showError(err: unknown, cursor: string | null): void {
    moreBox.hidden = true;
    if (isExpiredCursor(err)) {
      setNote('error', [h('p', null, 'The list changed while you were reading.'), actionButton('Start from the top', restart)]);
      return;
    }
    if (cursor === null) {
      clearRows();
      result.textContent = '';
    }
    const lead = cursor === null ? 'The list did not load.' : 'The next accounts did not load.';
    setNote('error', [h('p', null, `${lead} ${describeError(err)}`), actionButton('Try again', () => void fetchPage(cursor))]);
  }

  // Clears both: a page request that a new search replaced never reaches its own cleanup.
  function clearBusy(): void {
    list.removeAttribute('aria-busy');
    moreButton.removeAttribute('aria-busy');
  }

  async function fetchPage(cursor: string | null, cache: RequestCache = 'default'): Promise<void> {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    clearNote();
    if (cursor === null && rows.size === 0) list.replaceChildren(...Array.from({ length: SKELETON_ROWS }, skeletonRow));
    (cursor === null ? list : moreButton).setAttribute('aria-busy', 'true');
    try {
      const page = parseSloppersPage(await request(apiPath(query, cursor, PAGE_SIZE), { signal: controller.signal, cache }));
      if (controller !== active) return;
      if (cursor === null) clearRows();
      appendRows(page);
      showPage(page);
    } catch (err) {
      if (controller === active) showError(err, cursor);
    } finally {
      if (controller === active) {
        active = null;
        clearBusy();
      }
    }
  }

  function loadMore(): void {
    if (active === null && next !== null) void fetchPage(next);
  }

  const pageObserver =
    'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) loadMore();
        }, { rootMargin: LOAD_AHEAD })
      : null;

  moreButton.addEventListener('click', loadMore);
  bindRows(list, (handle) => rows.get(handle));
  void fetchPage(null);
}
