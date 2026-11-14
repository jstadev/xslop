// Hash routes of SPEC 14.3. The hash is the only source of the view; a bad handle or id gives a message and no request.

import { isTerm, type TermKey } from './glossary.ts';
import { ACTIVITY_KINDS, DEFAULT_KINDS, type ActivityKind } from './model.ts';

export const QUEUES = ['pending', 'disputed', 'auto'] as const;
export type Queue = (typeof QUEUES)[number];
export const APPEAL_STATES = ['open', 'accepted', 'rejected'] as const;
export type AppealState = (typeof APPEAL_STATES)[number];

export type Route =
  | { view: 'home' }
  | { view: 'review'; queue: Queue }
  | { view: 'appeals'; status: AppealState }
  | { view: 'accounts' }
  | { view: 'account'; handle: string }
  | { view: 'installs' }
  | { view: 'install'; id: string }
  | { view: 'activity'; kinds: ActivityKind[]; subject: string | null }
  | { view: 'lists' }
  | { view: 'jobs' }
  | { view: 'help'; term: TermKey | null }
  | { view: 'bad'; message: string };

export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An activity subject: a handle or an install id (14.2). */
export const isSubject = (v: string): boolean => HANDLE_RE.test(v) || UUID_RE.test(v);

const oneOf = <T extends string>(list: readonly T[], v: string | undefined, fallback: T): T | null =>
  v === undefined || v === '' ? fallback : (list as readonly string[]).includes(v) ? (v as T) : null;

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The hash of an activity filter; the default set gives the plain `#activity`. */
export function activityHash(kinds: readonly ActivityKind[], subject: string | null): string {
  const params = new URLSearchParams();
  const sorted = ACTIVITY_KINDS.filter((k) => kinds.includes(k));
  if (sorted.join(',') !== DEFAULT_KINDS.join(',')) params.set('kinds', sorted.join(','));
  if (subject) params.set('subject', subject);
  const q = params.toString();
  return q ? `#activity?${q}` : '#activity';
}

/** Reads a hash ("#review/pending"). `redirect` is set for the old hashes of 13.11 and for a bare section name. */
export function parseRoute(hash: string): { route: Route; redirect?: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path = '', query = ''] = raw.split('?', 2);
  const [name = '', arg, extra] = path.split('/');
  if (extra !== undefined) return { route: { view: 'bad', message: 'This address has too many parts. Pick a section in the menu.' } };
  switch (name) {
    case '':
    case 'home':
      return { route: { view: 'home' } };
    case 'overview':
      return { route: { view: 'home' }, redirect: '#home' };
    case 'log':
      return { route: { view: 'activity', kinds: ['admin'], subject: null }, redirect: '#activity?kinds=admin' };
    case 'review': {
      const queue = oneOf(QUEUES, arg, 'pending');
      return queue ? { route: { view: 'review', queue } } : { route: { view: 'bad', message: 'The review queues are pending, disputed and automatic. Pick one in the menu.' } };
    }
    case 'appeals': {
      const status = oneOf(APPEAL_STATES, arg, 'open');
      return status ? { route: { view: 'appeals', status } } : { route: { view: 'bad', message: 'Appeals are open, accepted or rejected. Pick one in the menu.' } };
    }
    case 'account': {
      const handle = arg === undefined ? null : decode(arg);
      if (handle === null || !HANDLE_RE.test(handle)) {
        return { route: { view: 'bad', message: 'This address names no valid handle. A handle has 1 to 15 lower-case letters, digits or underscores.' } };
      }
      return { route: { view: 'account', handle } };
    }
    case 'install': {
      const id = arg === undefined ? null : decode(arg);
      if (id === null || !UUID_RE.test(id)) return { route: { view: 'bad', message: 'This address names no valid install id. An install id is a UUID in lower case.' } };
      return { route: { view: 'install', id } };
    }
    case 'activity': {
      const params = new URLSearchParams(query);
      const kindsRaw = params.get('kinds');
      const kinds = kindsRaw === null ? DEFAULT_KINDS : kindsRaw.split(',').filter((k): k is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(k));
      const subject = params.get('subject');
      if (kinds.length === 0 || (kindsRaw !== null && kinds.length !== kindsRaw.split(',').length)) {
        return { route: { view: 'bad', message: 'This activity filter names an unknown kind. Open the activity page from the menu.' } };
      }
      if (subject !== null && !isSubject(subject)) return { route: { view: 'bad', message: 'The activity filter needs a handle or an install id.' } };
      return { route: { view: 'activity', kinds, subject } };
    }
    case 'help': {
      if (arg === undefined) return { route: { view: 'help', term: null } };
      return isTerm(arg) ? { route: { view: 'help', term: arg } } : { route: { view: 'help', term: null }, redirect: '#help' };
    }
    case 'accounts':
    case 'installs':
    case 'lists':
    case 'jobs':
      return arg === undefined ? { route: { view: name } } : { route: { view: 'bad', message: 'This address has too many parts. Pick a section in the menu.' } };
    default:
      return { route: { view: 'bad', message: 'The console has no page at this address. Pick a section in the menu.' } };
  }
}

/** The menu entry that a route belongs to. */
export function navKey(route: Route): string {
  if (route.view === 'review') return route.queue === 'disputed' ? 'disputed' : 'review';
  if (route.view === 'account') return 'accounts';
  if (route.view === 'install') return 'installs';
  return route.view;
}
