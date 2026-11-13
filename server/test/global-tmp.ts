import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One temp folder per test run. Workers inherit TMPDIR, so every mkdtemp in the tests lands here and is removed at the end. */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'xslop-test-'));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
