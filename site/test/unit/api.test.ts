import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, request } from '../../src/lib/api.ts';
import { describeError } from '../../src/lib/messages.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = async () =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('request returns parsed JSON and null for 204', async () => {
  respond(200, { ok: 1 });
  assert.deepEqual(await request('/api/v1/stats'), { ok: 1 });
  respond(204, null);
  assert.equal(await request('/api/admin/logout', { method: 'POST', body: {} }), null);
});

test('request maps the SPEC error shape and Retry-After', async () => {
  respond(429, { error: { code: 'rate_limited', message: 'Slow down.' } }, { 'retry-after': '120' });
  const err = await request('/api/v1/stats').catch((e: unknown) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryAfter, 120);
  assert.equal(describeError(err), 'Too many requests from your network. Try again in 2 minutes.');
});

test('request maps network failure and non-JSON errors', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const net = await request('/api/v1/stats').catch((e: unknown) => e);
  assert.ok(net instanceof ApiError && net.status === 0 && net.code === 'network');
  globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
  const gw = await request('/api/v1/stats').catch((e: unknown) => e);
  assert.ok(gw instanceof ApiError && gw.status === 502 && gw.code === 'http_502');
  assert.match(describeError(gw), /problem right now/);
});

test('request refuses cross-origin paths and sends JSON bodies', async () => {
  await assert.rejects(request('//evil.example/x'), (e: unknown) => e instanceof ApiError && e.code === 'bad_path');
  await assert.rejects(request('https://evil.example/x'), (e: unknown) => e instanceof ApiError && e.code === 'bad_path');
  let sent = 0;
  globalThis.fetch = async () => {
    sent++;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // The URL parser reads a backslash as a slash and drops tabs and newlines: each of these leaves the origin.
  for (const path of ['/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example/x', '/\r/evil.example/x']) {
    await assert.rejects(request(path, { method: 'POST', body: {}, headers: { 'x-csrf': 't' } }), (e: unknown) => e instanceof ApiError && e.code === 'bad_path', JSON.stringify(path));
  }
  assert.equal(sent, 0);
  let seen: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    seen = init;
    return new Response('{"a":1}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  await request('/api/v1/appeals', { method: 'POST', body: { handle: 'abc' }, headers: { 'x-csrf': 't' } });
  const headers = seen?.headers as Record<string, string>;
  assert.equal(seen?.method, 'POST');
  assert.equal(seen?.body, '{"handle":"abc"}');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-csrf'], 't');
  assert.equal(seen?.credentials, 'same-origin');
});

test('request refuses an answer that is too large, before it parses the answer', async () => {
  respond(200, { pad: 'x'.repeat(4_000_000) });
  const big = await request('/api/v1/stats').catch((e: unknown) => e);
  assert.ok(big instanceof ApiError && big.code === 'bad_response');
  assert.equal(big.message, 'The server sent a response that is too large.');
  // A body that never ends: a request that read it would end in a timeout, not in "too large".
  globalThis.fetch = async () => new Response(new ReadableStream(), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '9000000' } });
  const declared = await request('/api/v1/stats', { timeoutMs: 200 }).catch((e: unknown) => e);
  assert.ok(declared instanceof ApiError && declared.message === 'The server sent a response that is too large.');
  globalThis.fetch = async () => new Response('{"broken"', { status: 200, headers: { 'content-type': 'application/json' } });
  const broken = await request('/api/v1/stats').catch((e: unknown) => e);
  assert.ok(broken instanceof ApiError && broken.message === 'The server sent a response that could not be read.');
});

test('an abort while the body is read counts as aborted, not as a bad response', async () => {
  globalThis.fetch = async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    response.text = async () => {
      throw new DOMException('stopped', 'AbortError');
    };
    return response;
  };
  await assert.rejects(request('/api/v1/sloppers'), (err) => err instanceof ApiError && err.code === 'aborted');
});

test('requests stay out of the HTTP cache unless the caller opts in', async () => {
  const seen: (RequestCache | undefined)[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(init?.cache);
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };
  await request('/api/admin/overview');
  await request('/api/v1/sloppers', { cache: 'default' });
  assert.deepEqual(seen, ['no-store', 'default']);
});

test('request times out', async () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  const err = await request('/api/v1/stats', { timeoutMs: 20 }).catch((e: unknown) => e);
  assert.ok(err instanceof ApiError && err.code === 'timeout');
});
