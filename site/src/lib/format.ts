// Locale-aware formatting. English copy, so the formatters use en.

const count = new Intl.NumberFormat('en');
const percent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export function formatCount(n: number): string {
  return count.format(n);
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Full digits below one million, compact above ("1.4M"), so a stat always fits its cell. */
export function formatStat(n: number): string {
  return n >= 1_000_000 ? compact.format(n) : count.format(n);
}

export function formatPercent(share: number): string {
  return percent.format(share);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${count.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${count.format(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "3 minutes ago", "yesterday". `now` is injectable for tests. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diffSec = Math.round((Date.parse(iso) - now) / 1000);
  // Every date here is a past server event, so a date "in the future" only means the device clock is behind.
  if (diffSec > -45) return 'just now';
  if (diffSec > -3600) return relative.format(Math.round(diffSec / 60), 'minute');
  if (diffSec > -86400) return relative.format(Math.round(diffSec / 3600), 'hour');
  return relative.format(Math.round(diffSec / 86400), 'day');
}

export function formatDate(iso: string): string {
  return `${date.format(new Date(iso))} UTC`;
}

const day = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

/** "Nov 7, 2026": the calendar day, for records where the time adds nothing. */
export function formatDay(iso: string): string {
  return day.format(new Date(iso));
}

/** Whole minutes for a Retry-After value, at least 1. */
export function retryMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}
