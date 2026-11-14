/** In-memory rate limits for one process (section 5.8). Every map has a key cap, so memory stays bounded. */

const MAX_KEYS = 200_000;

interface Bucket {
  tokens: number;
  at: number;
}

type Take = { ok: true } | { ok: false; retryAfterSec: number };

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private lastSweep = 0;

  constructor(
    readonly capacity: number,
    windowMs: number,
    private readonly maxKeys = MAX_KEYS,
  ) {
    this.perMs = capacity / windowMs;
  }

  private fresh(b: Bucket, now: number): number {
    if (now <= b.at) return b.tokens;
    return Math.min(this.capacity, b.tokens + (now - b.at) * this.perMs);
  }

  /**
   * The bucket for `key`. A new key is stored when the map has room, or when the oldest key has refilled.
   * A short oldest key stays, so a full map cannot reset a bucket that is still paying for a limit.
   * Returns null when `key` is new and that oldest key is still short.
   */
  private current(key: string, now: number): Bucket | null {
    let b = this.buckets.get(key);
    if (b) {
      if (now > b.at) {
        b.tokens = this.fresh(b, now);
        b.at = now;
      }
      return b;
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value!;
      const oldest = this.buckets.get(oldestKey)!;
      if (this.fresh(oldest, now) < this.capacity) return null;
      this.buckets.delete(oldestKey);
    }
    b = { tokens: this.capacity, at: now };
    this.buckets.set(key, b);
    return b;
  }

  private wait(b: Bucket, cost: number): number {
    return Math.max(1, Math.ceil((Math.min(cost, this.capacity) - b.tokens) / this.perMs / 1000));
  }

  /** Takes `cost` tokens, or none when the bucket holds fewer. */
  take(key: string, now: number, cost = 1): Take {
    this.sweep(now);
    const b = this.current(key, now);
    if (!b || b.tokens < cost) return { ok: false, retryAfterSec: this.wait({ tokens: b?.tokens ?? 0, at: now }, cost) };
    b.tokens -= cost;
    return { ok: true };
  }

  /** Reports whether `cost` tokens are there, without taking them. */
  peek(key: string, now: number, cost = 1): Take {
    const b = this.current(key, now);
    if (!b || b.tokens < cost) return { ok: false, retryAfterSec: this.wait({ tokens: b?.tokens ?? 0, at: now }, cost) };
    return { ok: true };
  }

  /** Returns tokens taken for an attempt that must not count (for example a successful login). */
  refund(key: string, now: number, cost = 1): void {
    const b = this.current(key, now);
    if (!b) return;
    b.tokens = Math.min(this.capacity, b.tokens + cost);
  }

  /** Drops full buckets once a minute so memory follows the active keys only. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.perMs >= this.capacity) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Takes `cost` from every bucket, or from none when one of them is short; the wait is the longest one. */
export function takeAll(now: number, cost: number, pairs: [TokenBucket, string][]): Take {
  let wait = 0;
  for (const [b, key] of pairs) {
    const r = b.peek(key, now, cost);
    if (!r.ok) wait = Math.max(wait, r.retryAfterSec);
  }
  if (wait > 0) return { ok: false, retryAfterSec: wait };
  for (const [b, key] of pairs) b.take(key, now, cost);
  return { ok: true };
}

/**
 * At most `max` events per key in any `windowMs`: a log of the accepted times. Map order is the
 * order of the last accepted event, so expired keys are a prefix of the map. The key cap drops
 * the oldest key when that key is under its limit. A key that is still at its limit stays.
 */
export class SlidingLimit {
  private readonly log = new Map<string, number[]>();

  constructor(
    readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** Records one event and returns true, or records nothing and returns false when the key is at its limit. */
  hit(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    for (const [k, times] of this.log) {
      if (times[times.length - 1]! > cutoff) break;
      this.log.delete(k);
    }
    const known = this.log.get(key);
    const live = (known ?? []).filter((t) => t > cutoff);
    if (live.length >= this.max) return false;
    live.push(now);
    if (known) this.log.delete(key);
    if (!known && this.log.size >= this.maxKeys) {
      const oldestKey = this.log.keys().next().value!;
      const oldest = this.log.get(oldestKey)!;
      let n = 0;
      for (const t of oldest) if (t > cutoff) n++;
      if (n >= this.max) return false;
      this.log.delete(oldestKey);
    }
    this.log.set(key, live);
    return true;
  }

  get size(): number {
    return this.log.size;
  }
}

const HOUR = 3_600_000;
const MIN = 60_000;
/** The one key of the `sightingsStored` bucket. */
export const SIGHTINGS_KEY = 'all';

export function createLimits() {
  return {
    challenge: new TokenBucket(30, HOUR),
    // Registrations that succeeded (section 13.8), so empty or invalid requests cannot close registration for a network.
    installs: new TokenBucket(5, HOUR),
    // Not in the spec table. Every registration request, far above what people on one network send, so a flood of
    // replayed challenges reaches no database.
    installRequests: new TokenBucket(120, MIN),
    votesHour: new TokenBucket(120, HOUR),
    // Per network of registration, the identity the engine uses: it counts 50 a day (NETWORK_DAILY_VOTES), so
    // this is four days of backlog. An install without standing has no daily limit of its own.
    votesNetworkDay: new TokenBucket(200, 24 * HOUR),
    // An install with standing has its own daily limit instead (section 13.8): new installs on its address cannot use it up.
    votesStandingDay: new TokenBucket(120, 24 * HOUR),
    observations: new TokenBucket(1500, HOUR),
    observationsIp: new TokenBucket(3000, HOUR),
    // Sightings per install and handle: one install alone cannot build a behaviour record.
    sightingsPerHandle: new SlidingLimit(3, 24 * HOUR),
    // Not in the spec table. Sightings per network of registration and handle, so the installs of one network do
    // not add up: in one day a network alone stays below the 10 sightings that behaviour needs to count.
    sightingsPerHandleNetwork: new SlidingLimit(9, 24 * HOUR),
    // Not in the spec table. Stored sightings of all networks together, under the one key SIGHTINGS_KEY. The limits
    // above are per install and per network, so without this one the table grows with the number of networks:
    // 3000 an hour is 0.65 GB per network in the 30 days that a sighting lives (303 bytes a row with its indexes).
    // This bounds the table at 7.2 million rows, about 2.2 GB.
    sightingsStored: new TokenBucket(10_000, HOUR),
    // Not in the spec table. Stored sightings per network of registration: one network takes at most 1/24 of
    // what all networks together may store in a day.
    sightingsNetworkDay: new TokenBucket(10_000, 24 * HOUR),
    // Every signed route, per network, before the body, the install lookup and the signature check.
    signed: new TokenBucket(600, MIN),
    me: new TokenBucket(30, HOUR),
    accounts: new TokenBucket(60, MIN),
    appealsPost: new TokenBucket(3, HOUR),
    // Not in the spec table: every route has a limit (section 3).
    appealsGet: new TokenBucket(60, MIN),
    publicList: new TokenBucket(120, MIN),
    sloppers: new TokenBucket(120, MIN),
    // One page of the list shows up to 100 avatars, so the limit is far above the page limit.
    avatars: new TokenBucket(1200, MIN),
    health: new TokenBucket(120, MIN),
    adminLoginFailures: new TokenBucket(5, 15 * MIN),
    // Not in the spec table. Password checks of all networks together, under one key. A valid unused TOTP code does
    // not spend it, so a flood of wrong passwords cannot shut the admin out. The bucket refills with time.
    adminLoginGlobal: new TokenBucket(30, 15 * MIN),
    // Not in the spec table. Wrong codes with the right password, of all networks together under one key: only a
    // holder of the password spends it, and the 5 failures per network do not stop a guesser with many networks.
    adminCodeFailures: new TokenBucket(10, 15 * MIN),
    admin: new TokenBucket(300, MIN),
    // Not in the spec table. Changes only: a stolen session cannot rewrite the list in one burst.
    adminWrite: new TokenBucket(30, MIN),
    static: new TokenBucket(1200, MIN),
  };
}

export type Limits = ReturnType<typeof createLimits>;
