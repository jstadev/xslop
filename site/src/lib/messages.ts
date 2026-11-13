// Plain error text for the reader: what happened and what to do next.

import { ApiError } from './api.ts';
import { retryMinutes } from './format.ts';

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const minutes = retryMinutes(err.retryAfter ?? 60);
      return `Too many requests from your network. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    }
    if (err.status === 0) return `${err.message} Check your connection and try again in a minute.`;
    if (err.status >= 500) return 'The xslop server has a problem right now. Try again in a few minutes.';
    return err.message;
  }
  return 'Something went wrong in this page. Reload it and try again.';
}
