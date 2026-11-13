// The list query: what the controls hold, how a deep link is read once, and how it is written back.

const STATUS_FILTERS = ['all', 'confirmed', 'flagged'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

const SORT_KEYS = ['score', 'recent', 'votes', 'handle'] as const;
type SortKey = (typeof SORT_KEYS)[number];

export interface Query {
  q: string;
  status: StatusFilter;
  sort: SortKey;
}

export const DEFAULT_QUERY: Query = { q: '', status: 'all', sort: 'score' };

const MAX_SEARCH = 40;

const includes = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export const isStatusFilter = (v: unknown): v is StatusFilter => includes(STATUS_FILTERS, v);
export const isSortKey = (v: unknown): v is SortKey => includes(SORT_KEYS, v);

/** What the server gets: trimmed, a leading @ dropped, at most 40 characters. */
export function cleanSearch(raw: string): string {
  return raw.trim().replace(/^@/, '').slice(0, MAX_SEARCH).trim();
}

/** Reads the deep link. Called once at load; the URL is never a source of truth after that. */
export function readQuery(search: string): Query {
  const params = new URLSearchParams(search);
  const status = params.get('status');
  const sort = params.get('sort');
  return {
    q: cleanSearch(params.get('q') ?? ''),
    status: isStatusFilter(status) ? status : DEFAULT_QUERY.status,
    sort: isSortKey(sort) ? sort : DEFAULT_QUERY.sort,
  };
}

function toParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status !== DEFAULT_QUERY.status) params.set('status', query.status);
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  return params;
}

/** The address bar shows the current query; only defaults are left out, so a shared link stays short. */
export function queryString(query: Query): string {
  const text = toParams(query).toString();
  return text ? `?${text}` : '';
}

export function apiPath(query: Query, cursor: string | null, limit: number): string {
  const params = toParams(query);
  if (cursor !== null) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return `/api/v1/sloppers?${params}`;
}
