// The search box, the status tabs and the sort menu. They report changes; thread.ts owns the query.

import { req } from '../lib/dom.ts';
import { cleanSearch, DEFAULT_QUERY, isSortKey, isStatusFilter, type Query, type StatusFilter } from './query.ts';

const SEARCH_DEBOUNCE_MS = 250;

export interface Controls {
  /** Puts every control back on the default query and moves focus to the search box. */
  clear(): void;
}

export function initControls(initial: Query, change: (patch: Partial<Query>) => void): Controls {
  const form = req<HTMLFormElement>('#sl-controls');
  const search = req<HTMLInputElement>('#sl-q');
  const sort = req<HTMLSelectElement>('#sl-sort');
  const tabs = [...form.querySelectorAll<HTMLButtonElement>('button[data-status]')];
  let appliedSearch = initial.q;
  let debounce = 0;

  function pressTab(status: StatusFilter): void {
    for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.status === status));
  }

  function applySearch(): void {
    window.clearTimeout(debounce);
    const q = cleanSearch(search.value);
    if (q === appliedSearch) return;
    appliedSearch = q;
    change({ q });
  }

  search.value = initial.q;
  sort.value = initial.sort;
  pressTab(initial.status);

  search.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    applySearch();
  });

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const status = tab.dataset.status;
      if (!isStatusFilter(status) || tab.getAttribute('aria-pressed') === 'true') return;
      pressTab(status);
      change({ status });
    });
  }

  sort.addEventListener('change', () => {
    if (isSortKey(sort.value)) change({ sort: sort.value });
  });

  return {
    clear() {
      window.clearTimeout(debounce);
      appliedSearch = DEFAULT_QUERY.q;
      search.value = DEFAULT_QUERY.q;
      sort.value = DEFAULT_QUERY.sort;
      pressTab(DEFAULT_QUERY.status);
      search.focus();
    },
  };
}
