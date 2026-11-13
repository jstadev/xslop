// The design-kit ship gate (full mode) on the built site, served with the mocked API.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { serve } from './helpers.ts';

const KIT = '/srv/design-kit/bin/design-kit.mjs';
const OUT = '/tmp/xslop-site-gate';

test('design-kit gate passes in full mode on the landing page, its pages, /admin and /404.html', { skip: !existsSync(KIT) && 'design kit not installed', timeout: 900_000 }, async () => {
  const server = await serve();
  try {
    const run = promisify(execFile);
    let code = 0;
    let stderr = '';
    try {
      const r = await run(process.execPath, [KIT, 'check', `${server.url}/`, '--pages', '/,/admin,/404.html,/how-it-works,/rules,/download,/check,/privacy,/questions', '--out', OUT, '--json'], { maxBuffer: 256 * 1024 * 1024, timeout: 880_000 });
      stderr = r.stderr;
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      code = e.code ?? 1;
      stderr = e.stderr ?? String(err);
    }
    const summary = stderr.split('\n').filter((l) => /Grouped|Before grouping|report\.html/.test(l)).join('\n');
    console.log(summary);
    const report = JSON.parse(readFileSync(`${OUT}/report.json`, 'utf8')) as { findings: { ruleId: string; level: string; page: string; selector: string; message: string }[] };
    const fails = report.findings.filter((f) => f.level === 'fail').map((f) => `${f.ruleId} ${f.page} ${f.selector}: ${f.message}`);
    assert.deepEqual(fails, [], 'design-kit gate failures');
    assert.equal(code, 0, summary);
  } finally {
    await server.close();
  }
});
