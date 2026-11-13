// @vitest-environment happy-dom
// The mute call that the content script makes in your X session (SPEC 7.7).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { parseBgMsg, type XCall } from '../../src/shared/messages';
import { parseXResult } from '../../src/shared/muteplan';
import { xcall } from '../../src/content/xcall';

const BEARER = DEFAULT_CONFIG.mute.webBearer;
const create: XCall = { t: 'xcall', op: 'create', handle: 'slopbot', userId: null, cursor: null, bearer: BEARER };
let fetchMock: ReturnType<typeof vi.fn>;
const setURL = (u: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(u);

beforeEach(() => {
  setURL('https://x.com/home');
  document.cookie = 'ct0=c%2B0token; path=/';
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id_str: '1234567890', screen_name: 'slopbot' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'ct0=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

describe('X mute call', () => {
  it('posts screen_name to x.com with the web bearer and your csrf token', async () => {
    expect(await xcall(create)).toEqual({ status: 200, id: '1234567890', code: null, ids: null, next: null, name: 'slopbot' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://x.com/i/api/1.1/mutes/users/create.json');
    expect(init).toMatchObject({
      method: 'POST', credentials: 'include', redirect: 'error', body: 'screen_name=slopbot',
      headers: {
        authorization: `Bearer ${BEARER}`, 'x-csrf-token': 'c+0token', 'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes', 'content-type': 'application/x-www-form-urlencoded',
      },
    });
  });

  it('reads your muted ids page by page', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ids: ['1', '2'], next_cursor_str: '1717' }), { status: 200 }));
    const r = await xcall({ ...create, op: 'ids', handle: null, cursor: '-1' });
    expect(r).toMatchObject({ status: 200, ids: ['1', '2'], next: '1717' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://x.com/i/api/1.1/mutes/users/ids.json?count=5000&stringify_ids=true&cursor=-1');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('EXT-2 regression: refuses a page of muted ids that it cannot read whole, so no mute of yours counts as one of xslop', async () => {
    const pages = [
      // A JSON number above 2^53 loses digits: this one reads as 1234567890123456800, the id of another account.
      '{"ids":["1",1234567890123456789],"next_cursor_str":"0"}',
      '{"ids":["1","x2"],"next_cursor_str":"0"}',
      '{"ids":["1",null],"next_cursor_str":"0"}',
      JSON.stringify({ ids: Array.from({ length: 5001 }, (_, i) => String(i + 1)), next_cursor_str: '0' }),
    ];
    for (const body of pages) {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const r = await xcall({ ...create, op: 'ids', handle: null, cursor: '-1' });
      expect([body.slice(0, 48), r.status, r.ids, r.next]).toEqual([body.slice(0, 48), 200, null, null]);
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ids: Array.from({ length: 5000 }, (_, i) => String(i + 1)), next_cursor_str: '7' }), { status: 200 }));
    expect(await xcall({ ...create, op: 'ids', handle: null, cursor: '-1' })).toMatchObject({ ids: expect.arrayContaining(['1', '5000']), next: '7' });
  });

  it('passes the X error code through', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 63, message: 'User has been suspended.' }] }), { status: 403 }));
    expect(await xcall(create)).toMatchObject({ status: 403, code: 63 });
  });

  it('R3 drops an error code outside X\'s range, so the background still reads the answer and its stop rules run', async () => {
    for (const code of [1e9, -1, 1.5, '63']) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code }] }), { status: 403 }));
      const r = await xcall(create);
      expect([code, r, parseXResult(r)]).toEqual([code, { status: 403, id: null, code: null, ids: null, next: null, name: null }, r]);
    }
  });

  it('makes no call when you are not logged in to X, or on another origin', async () => {
    document.cookie = 'ct0=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    expect(await xcall(create)).toMatchObject({ status: 0, code: -1 });
    setURL('https://example.com/home');
    expect(await xcall(create)).toMatchObject({ status: 0, code: -2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('F1 regression: calls only the hard-coded endpoint of each operation, whatever path a message carries', async () => {
    const evil = { ...create, path: '/i/api/1.1/users/report_spam.json' };
    await xcall(parseBgMsg(evil) as XCall);
    await xcall(parseBgMsg({ ...evil, op: 'destroy', handle: null, userId: '5' }) as XCall);
    await xcall(parseBgMsg({ ...evil, op: 'ids', handle: null, cursor: '-1' }) as XCall);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split('?')[0])).toEqual([
      'https://x.com/i/api/1.1/mutes/users/create.json',
      'https://x.com/i/api/1.1/mutes/users/destroy.json',
      'https://x.com/i/api/1.1/mutes/users/ids.json',
    ]);
  });

  it('F2 regression: unmutes by user_id, never by screen_name', async () => {
    await xcall({ ...create, op: 'destroy', handle: 's', userId: '111' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://x.com/i/api/1.1/mutes/users/destroy.json');
    expect(init.body).toBe('user_id=111');
    // No user id: no call at all.
    expect(await xcall({ ...create, op: 'destroy', handle: 's', userId: null })).toMatchObject({ status: 0, code: -3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SPEC 13.6: mutes by user_id when the call carries the id that the list knows, by screen_name only without one', async () => {
    await xcall({ ...create, userId: '987' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://x.com/i/api/1.1/mutes/users/create.json');
    expect(init.body).toBe('user_id=987');
    expect(await xcall({ ...create, handle: null })).toMatchObject({ status: 0, code: -3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SPEC 13.10 item 9 reads the account that X muted from screen_name, in lower case, whatever letter case X writes', async () => {
    for (const [screen, name] of [['SlopBot', 'slopbot'], ['XSLOP_DEMO_OK', 'xslop_demo_ok'], ['xslop_demo_15ch', 'xslop_demo_15ch']]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id_str: '1002', screen_name: screen }), { status: 200 }));
      const r = await xcall({ ...create, handle: null, userId: '1002' });
      expect([screen, r, parseXResult(r)]).toEqual([screen, { status: 200, id: '1002', code: null, ids: null, next: null, name }, r]);
    }
  });

  it('SPEC 13.10 item 9 reads no account from a missing or odd screen_name, also one that lower-cases to a handle', async () => {
    for (const screen of [undefined, null, 1002, '', 'a'.repeat(16), '@slopbot', 'slop bot', ' slopbot', 'slopbot\n', 'Kelvin', 'ｓｌｏｐｂｏｔ', ['slopbot']]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id_str: '1002', screen_name: screen }), { status: 200 }));
      expect([screen, await xcall(create)]).toEqual([screen, { status: 200, id: '1002', code: null, ids: null, next: null, name: null }]);
    }
  });

  it('SPEC 13.10 item 9 an answer of 2 MB: only a checked id and handle leave the page', async () => {
    const pad = 'x'.repeat(2 * 1024 * 1024);
    for (const [answer, name] of [[{ id_str: '1002', screen_name: 'Xslop_Demo_OK', description: pad }, 'xslop_demo_ok'], [{ id_str: '1002', screen_name: pad }, null]] as const) {
      const body = JSON.stringify(answer);
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const r = await xcall(create);
      expect([body.length > 2 * 1024 * 1024, r, JSON.stringify(r).length < 100]).toEqual([true, { status: 200, id: '1002', code: null, ids: null, next: null, name }, true]);
    }
  });

  it('reports a network error as status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await xcall(create)).toMatchObject({ status: 0, code: null });
  });
});
