// Background state: storage.local loaded once per worker life, kept in memory, written through.
// A caller reads with state() and writes with save() without an await between them: the memory
// copy changes at once, so concurrent handlers never lose each other's updates.
import { ext } from '../shared/ext';
import { ALL_KEYS, readStored } from '../shared/storage';
import type { Stored } from '../shared/types';

let cache: Promise<Stored> | null = null;
let loaded: Stored | null = null;

export function state(): Promise<Stored> {
  cache ??= (readStored(ALL_KEYS) as Promise<Stored>).then((s) => (loaded = s));
  return cache;
}

export async function save<K extends keyof Stored>(key: K, value: Stored[K]): Promise<void> {
  (loaded ?? (await state()))[key] = value;
  await ext.storage.local.set({ [key]: value });
}
