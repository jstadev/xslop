// Shapes of the data that the background stores and the other contexts read.

export type Strictness = 'off' | 'balanced' | 'strict';
type Display = 'collapse' | 'remove';

export interface Settings {
  strictness: Strictness;
  display: Display;
  /** Anonymous signal sharing (observations). Off until you turn it on. */
  share: boolean;
  /** Bulk mute sync of the global list to your X account, paced. Off until you turn it on. */
  mute: boolean;
  /** A click on the xslop button also mutes that account on your X account, at once. */
  muteOnMark: boolean;
}

export const DEFAULT_SETTINGS: Settings = { strictness: 'balanced', display: 'collapse', share: false, mute: false, muteOnMark: true };

export type VoteContext = 'reply' | 'post';

/** One personal vote. v = 1 slop, 0 not slop (allow list). */
export interface Vote {
  h: string;
  v: 0 | 1;
  at: number;
  tweetId: string;
  parentTweetId: string | null;
  postedAt: string | null;
  context: VoteContext;
}

/** [handle, score 0..100, tier 1|2], the server list row. */
export type ListRow = [string, number, number];

export interface StoredList {
  version: number;
  generatedAt: string;
  etag: string | null;
  /** Sorted by handle. */
  accounts: ListRow[];
  /**
   * The X user id of each row, in the order of `accounts`, null for a row without one (SPEC 13.8, 13.10). Missing in
   * a list that a build before 1.2.0 stored: the next sync then fetches the full list.
   */
  ids?: (string | null)[];
}

/** One observation (SPEC 13.8): a reply and the post that it answers. The server reads the times from the ids. */
export interface Observation {
  handle: string;
  tweetId: string;
  parentTweetId: string | null;
}

export interface Identity {
  installId: string;
  createdAt: string;
}

export interface Stats {
  day: string;
  hidden: number;
}

/** One mute that xslop made. `id` is null when xslop muted through X's own menu, which returns no id. */
export interface MuteRecord {
  at: number;
  id: string | null;
  /** When you took back the mark. xslop then undoes this mute, unless bulk sync still wants the account. */
  undoAt?: number;
}

/** Mute state. `muted` is the record of every mute that xslop made, with the X user id that X returned. */
export interface MuteState {
  muted: [string, MuteRecord][];
  /** Handles xslop never touches: 'own' = you muted them before; 'missing' = X has no such account; 'rejected' = X refused. */
  skipped: [string, 'own' | 'missing' | 'rejected'][];
  /** Records without an X user id that xslop dropped without an unmute. The popup tells you to check them in X. */
  lost: number;
  day: string;
  count: number;
  nextAt: number;
  pausedUntil: number;
  reason: string | null;
  fails: number;
  undoAll: boolean;
  waiting: 'tab' | 'login' | null;
  /** The X user ids that you muted yourself, read from X at most every 6 hours, without the ones that xslop made. */
  own: string[];
  /** When xslop last read `own`. 0 = never. */
  ownAt: number;
  /** Instant mutes that did not land yet, with the time from which the paced sync may mute them instead. */
  retry: [string, number][];
  /**
   * [handle, X user id]: the list gave this id to this handle, and X answered the mute by that id with an account on
   * your allow list (SPEC 13.10 item 9). xslop does not mute by that id again while the list gives it to that handle.
   */
  wrongIds: [string, string][];
}

export const EMPTY_MUTE: MuteState = {
  muted: [], skipped: [], lost: 0, day: '', count: 0, nextAt: 0,
  pausedUntil: 0, reason: null, fails: 0, undoAll: false, waiting: null, own: [], ownAt: 0, retry: [], wrongIds: [],
};

export interface Status {
  banned: boolean;
  /** The server config needs a newer extension version. */
  updateNeeded: boolean;
  installError: string | null;
  listAt: number;
  /** Your marks count for the shared list (GET /api/v1/me). Null until the server says so; an older server never does. */
  standing: boolean | null;
  /** When xslop last read /api/v1/me. 0 = never. */
  meAt: number;
}

const DEFAULT_STATUS: Status = { banned: false, updateNeeded: false, installError: null, listAt: 0, standing: null, meAt: 0 };

/** Pack a list row for fast lookups: score * 4 + tier. */
export const pack = (score: number, tier: number): number => score * 4 + tier;
export const tierOf = (packed: number): number => packed & 3;
export const scoreOf = (packed: number): number => packed >> 2;

/** Vote body as the server takes it (SPEC 5.2). */
export interface VoteBody {
  handle: string;
  value: 'slop' | 'not_slop';
  tweetId: string;
  parentTweetId: string | null;
  postedAt: string | null;
  context: VoteContext;
}

export type OutOp =
  | { seq: number; h: string; k: 'vote'; body: VoteBody }
  | { seq: number; h: string; k: 'del' };

/** Pending writes; survives service worker restarts. */
export interface Outbox {
  ops: OutOp[];
  obs: Observation[];
  attempt: number;
  nextAt: number;
  seq: number;
  lastError: string | null;
}

export const EMPTY_OUTBOX: Outbox = { ops: [], obs: [], attempt: 0, nextAt: 0, seq: 0, lastError: null };

/** Everything in storage.local. Only the background writes it. */
export interface Stored {
  settings: Settings;
  votes: Vote[];
  list: StoredList | null;
  config: import('./config').Config | null;
  identity: Identity | null;
  outbox: Outbox;
  mute: MuteState;
  stats: Stats;
  status: Status;
}

export const STORED_DEFAULTS: Stored = {
  settings: DEFAULT_SETTINGS, votes: [], list: null, config: null, identity: null,
  outbox: EMPTY_OUTBOX, mute: EMPTY_MUTE, stats: { day: '', hidden: 0 }, status: DEFAULT_STATUS,
};
