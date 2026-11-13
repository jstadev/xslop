import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp, loggerOptions } from '../src/app.js';
import type { Db } from '../src/db.js';
import { NO_FILES, testConfig } from './helpers/app.js';

const failingDb: Db = {
  query: () => Promise.reject(new Error('database is down')),
  tx: () => Promise.reject(new Error('database is down')),
  session: () => Promise.reject(new Error('database is down')),
  close: async () => undefined,
};

describe('production logger', () => {
  it('logs failures without IPs, bodies or signature headers', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
    const app = await buildApp({ db: failingDb, config: testConfig(), files: NO_FILES, logger: { ...loggerOptions, stream } });
    const secret = 'reply text that must never reach a log';
    const sig = {
      'x-xslop-install': '11111111-1111-4111-8111-111111111111',
      'x-xslop-ts': String(Date.now()),
      'x-xslop-nonce': 'AAAAAAAAAAAAAAAAAAAAAA',
      'x-xslop-sig': 'B'.repeat(85) + 'A',
      'x-forwarded-for': '203.0.113.77',
      cookie: '__Host-xs_admin=cookie-value-secret',
    };
    const r = await app.inject({ method: 'POST', url: '/api/v1/votes', headers: { ...sig, 'content-type': 'application/json' }, payload: { text: secret } });
    expect([r.statusCode, r.json().error.code]).toEqual([500, 'internal_error']);
    const list = await app.inject({ url: '/api/v1/list', headers: { 'x-forwarded-for': '203.0.113.77' } });
    expect([list.statusCode, list.json().error.code]).toEqual([503, 'list_unavailable']);
    const health = await app.inject({ url: '/api/health' });
    expect([health.statusCode, health.json()]).toEqual([503, { ok: false, db: false, scoredAt: null }]);
    await app.close();

    const out = lines.join('');
    expect(out).toContain('request failed');
    expect(out).toContain('"route":"/api/v1/votes"');
    for (const leak of [secret, '203.0.113', 'cookie-value-secret', 'B'.repeat(85), '11111111-1111', 'remoteAddress']) expect(out).not.toContain(leak);
  });

  it('keeps the rows that a database error quotes out of the log', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
    const quoted = '(11111111-1111, somehandle, the text of a vote)';
    const failure = Object.assign(new Error('null value in column "x" violates not-null constraint'), { code: '23502', detail: `Failing row contains ${quoted}.`, where: `row ${quoted}` });
    const db: Db = { ...failingDb, query: () => Promise.reject(failure) };
    const app = await buildApp({ db, config: testConfig(), files: NO_FILES, logger: { ...loggerOptions, stream } });
    expect((await app.inject({ url: '/api/v1/stats' })).statusCode).toBe(500);
    await app.close();
    const out = lines.join('');
    expect(out).toContain('request failed');
    expect(out).toContain('"code":"23502"');
    expect(out).toContain('violates not-null constraint');
    expect(out).not.toContain('the text of a vote');
    expect(out).not.toContain('Failing row');
  });
});
