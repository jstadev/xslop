// Background state: storage.local loaded once per worker life, kept in memory, written through.
// A caller reads with state() and writes with save() without an await between them: the memory
// copy changes at once, so concurrent handlers never lose each other's updates.
// Each key is written in order. A later save of that key is the value storage keeps.
import { ext } from '../shared/ext';
import { ALL_KEYS, readStored } from '../shared/storage';
import type { Stored } from '../shared/types';

let cache: Promise<Stored> | null = null;
let loaded: Stored | null = null;
let tail: Promise<unknown> = Promise.resolve();
const gen = new Map<string, number>();

export function state(): Promise<Stored> {
  cache ??= (readStored(ALL_KEYS) as Promise<Stored>).then((s) => (loaded = s));
  return cache;
}

export async function save<K extends keyof Stored>(key: K, value: Stored[K]): Promise<void> {
  const cur = loaded ?? (await state());
  cur[key] = value;
  const mine = (gen.get(key) ?? 0) + 1;
  gen.set(key, mine);
  const task = tail.then(async () => {
    if (gen.get(key) !== mine) return;
    await ext.storage.local.set({ [key]: value });
  });
  tail = task.then(() => undefined, () => undefined);
  await task;
}
