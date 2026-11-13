/** A hashed trigram index for substring search over the /sloppers view. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

/** The shortest search text that the index can answer. */
export const TRIGRAM_LENGTH = 3;

const BUCKET_BITS = 18;
const BUCKETS = 1 << BUCKET_BITS;
const YIELD_EVERY_DOCS = 1 << 14;
const EMPTY = new Uint32Array(0);

/** Trigrams hash into a fixed table: a collision costs one extra verification, never a missed match. */
function bucketOf(s: string, at: number): number {
  return (
    (Math.imul(s.charCodeAt(at), 0x9e3779b1) ^ Math.imul(s.charCodeAt(at + 1), 0x85ebca77) ^ Math.imul(s.charCodeAt(at + 2), 0xc2b2ae3d)) >>>
    (32 - BUCKET_BITS)
  );
}

async function forEachBucket(docs: readonly string[], visit: (bucket: number, doc: number) => void): Promise<void> {
  // seen[b] = doc + 1 once `doc` visited bucket b, so a document appears once per bucket.
  const seen = new Uint32Array(BUCKETS);
  for (let doc = 0; doc < docs.length; doc++) {
    if ((doc & (YIELD_EVERY_DOCS - 1)) === 0) await yieldToEventLoop();
    const s = docs[doc]!;
    for (let i = 0; i + 2 < s.length; i++) {
      const b = bucketOf(s, i);
      if (seen[b] !== doc + 1) {
        seen[b] = doc + 1;
        visit(b, doc);
      }
    }
  }
}

/** An inverted index from hashed trigrams to document ids, in compressed sparse row form (one flat postings array). */
export class TrigramIndex {
  private constructor(
    private readonly starts: Uint32Array,
    private readonly postings: Uint32Array,
  ) {}

  /** Builds in batches, so requests keep running while a large index is made in the web process. */
  static async build(docs: readonly string[]): Promise<TrigramIndex> {
    const starts = new Uint32Array(BUCKETS + 1);
    await forEachBucket(docs, (b) => {
      starts[b + 1]!++;
    });
    for (let b = 0; b < BUCKETS; b++) starts[b + 1]! += starts[b]!;
    const postings = new Uint32Array(starts[BUCKETS]!);
    const next = starts.slice(0, BUCKETS);
    await forEachBucket(docs, (b, doc) => {
      postings[next[b]!++] = doc;
    });
    return new TrigramIndex(starts, postings);
  }

  /** The ids, ascending, of every document that may contain `needle` (at least 3 code units). The caller verifies each one. */
  candidates(needle: string): Uint32Array {
    let shortest: Uint32Array | null = null;
    for (let i = 0; i + 2 < needle.length; i++) {
      const b = bucketOf(needle, i);
      const list = this.postings.subarray(this.starts[b]!, this.starts[b + 1]!);
      if (!shortest || list.length < shortest.length) shortest = list;
      if (list.length === 0) break;
    }
    return shortest ?? EMPTY;
  }
}
