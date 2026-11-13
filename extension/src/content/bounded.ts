/** Add `value` and forget the oldest entry once the set holds more than `max`. */
export function remember<T>(set: Set<T>, value: T, max: number): void {
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value as T);
}
