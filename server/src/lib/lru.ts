/** Least-recently-used cache bounded by a summed cost and an entry count. */
export class CostBoundedCache<V> {
  private readonly entries = new Map<string, { value: V; cost: number }>();
  private total = 0;

  constructor(
    private readonly maxCost: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores the value and evicts the oldest entries until both bounds hold. A value above the cost bound is not stored. */
  set(key: string, value: V, cost: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.total -= old.cost;
    }
    if (cost > this.maxCost) return;
    this.entries.set(key, { value, cost });
    this.total += cost;
    for (const [k, entry] of this.entries) {
      if (this.total <= this.maxCost && this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
      this.total -= entry.cost;
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  get cost(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }
}
