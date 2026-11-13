import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** True when the module at `url` is the script that node started. */
export function isMain(url: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === url;
  } catch {
    return false;
  }
}
