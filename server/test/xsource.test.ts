import { describe, expect, it } from 'vitest';
import { avatarUrlOf, createXSource, detectImageType, embedToken, MAX_JSON_BYTES, PACE_MS, TRIES_PER_PROFILE, type XSource } from '../src/lib/xsource.js';

// Real answers of 2026-11-12 (one live check, 4 requests), trimmed to the fields that the parser reads. The account is
// the developer account of X, an organisation. Its live profile request answered 404 (the known false 404 of
// fxtwitter), so the profile fixture is the author object of the fxtwitter post answer, which has the same fields.
const POST_ID = '1212092628029698048';
const PARENT_ID = '1212092627178287104';
const AUTHOR_ID = '2244994945';
const EMBED_POST = { __typename: 'Tweet', id_str: POST_ID, in_reply_to_status_id_str: PARENT_ID, user: { id_str: AUTHOR_ID, screen_name: 'XDevelopers' } };
const FX_POST = { code: 200, message: 'OK', tweet: { id: POST_ID, replying_to_status: PARENT_ID, author: { id: AUTHOR_ID, screen_name: 'XDevelopers' } } };
const FX_PROFILE = {
  code: 200,
  message: 'OK',
  user: { id: AUTHOR_ID, screen_name: 'XDevelopers', name: 'Developers', followers: 697066, avatar_url: 'https://pbs.twimg.com/profile_images/1683501992314798080/xl1POYLw_200x200.jpg' },
};
const FX_404 = '{"code":404,"message":"User not found"}';
const EMBED_404 = '<!DOCTYPE html>\n<html lang="en" class="dog">\n  <head>\n    <title>X / ?</title>';

const EMBED = 'https://cdn.syndication.twimg.com/';
const FX = 'https://api.fxtwitter.com/';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

function source(answer: (url: string) => Response | Promise<Response>): { src: XSource; calls: Call[]; sleeps: number[] } {
  let t = 5_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const src = createXSource({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {}, at: t });
      return answer(String(input));
    }) as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  });
  return { src, calls, sleeps };
}

describe('xsource: real answers', () => {
  it('reads a post from the embed answer of X, and does not ask fxtwitter', async () => {
    const { src, calls } = source(() => json(EMBED_POST));
    expect(await src.post(POST_ID)).toEqual({ authorId: AUTHOR_ID, authorHandle: 'xdevelopers', inReplyTo: PARENT_ID, via: 'embed' });
    expect(calls.map((c) => c.url)).toEqual([`${EMBED}tweet-result?id=${POST_ID}&token=${embedToken(POST_ID)}`]);
    expect(embedToken(POST_ID)).toMatch(/^[0-9a-z]{4,20}$/);
  });

  it('reads the post from fxtwitter when the embed answer fails (source one fails, source two answers)', async () => {
    const { src, calls } = source((url) => (url.startsWith(EMBED) ? new Response('boom', { status: 503 }) : json(FX_POST)));
    expect(await src.post(POST_ID)).toEqual({ authorId: AUTHOR_ID, authorHandle: 'xdevelopers', inReplyTo: PARENT_ID, via: 'fxtwitter' });
    expect(calls.map((c) => c.url)).toEqual([expect.stringMatching(/^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=/), `${FX}status/${POST_ID}`]);
  });

  it('reads a profile, rewrites the avatar size and lowers the case of the handle', async () => {
    const { src, calls } = source(() => json(FX_PROFILE));
    expect(await src.profile('xdevelopers')).toEqual({ xId: AUTHOR_ID, name: 'Developers', followers: 697066, avatarUrl: 'https://pbs.twimg.com/profile_images/1683501992314798080/xl1POYLw_x96.jpg' });
    expect(calls.map((c) => c.url)).toEqual([`${FX}xdevelopers`]);
  });

  it('says missing only when both sources say so; a tombstone is missing too', async () => {
    const both = source((url) => (url.startsWith(EMBED) ? new Response(EMBED_404, { status: 404, headers: { 'content-type': 'text/html' } }) : new Response(FX_404, { status: 404 })));
    expect(await both.src.post(POST_ID)).toBe('missing');
    const tomb = source((url) => (url.startsWith(EMBED) ? json({ __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post was deleted' } } }) : new Response(FX_404, { status: 404 })));
    expect(await tomb.src.post(POST_ID)).toBe('missing');
    // One source cannot be read: no proof that the post is gone.
    const half = source((url) => (url.startsWith(EMBED) ? new Response(EMBED_404, { status: 404 }) : new Response('down', { status: 502 })));
    expect(await half.src.post(POST_ID)).toBe('failed');
  });

  it('tries a profile 404 three times at the pace, and a late answer counts', async () => {
    let n = 0;
    const late = source(() => (++n < TRIES_PER_PROFILE ? new Response(FX_404, { status: 404 }) : json(FX_PROFILE)));
    expect(await late.src.profile('xdevelopers')).toMatchObject({ xId: AUTHOR_ID });
    expect(late.sleeps).toEqual(Array(TRIES_PER_PROFILE - 1).fill(PACE_MS));
    const gone = source(() => new Response(FX_404, { status: 404 }));
    expect(await gone.src.profile('xdevelopers')).toBe('missing');
    expect(gone.calls).toHaveLength(TRIES_PER_PROFILE);
  });

  it('stops at a rate limit: a 429 of the embed source asks no second source', async () => {
    const { src, calls } = source(() => new Response('{}', { status: 429 }));
    expect(await src.post(POST_ID)).toBe('rate_limited');
    expect(calls).toHaveLength(1);
    expect(await source(() => new Response('{}', { status: 429 })).src.profile('xdevelopers')).toBe('rate_limited');
    const second = source((url) => (url.startsWith(EMBED) ? new Response('', { status: 500 }) : new Response('{}', { status: 429 })));
    expect(await second.src.post(POST_ID)).toBe('rate_limited');
  });
});

describe('xsource: guards', () => {
  it('sends every request to a fixed host, without redirects, with a timeout, at most one per 2 s over all hosts', async () => {
    const { src, calls } = source((url) => (url.startsWith('https://pbs.twimg.com/') ? new Response(new Uint8Array([0xff, 0xd8, 0xff, 0])) : url.startsWith(EMBED) ? new Response('', { status: 500 }) : url.includes('/status/') ? json(FX_POST) : json(FX_PROFILE)));
    await src.post(POST_ID);
    const p = await src.profile('xdevelopers');
    await src.avatar((p as { avatarUrl: string }).avatarUrl);
    expect(calls).toHaveLength(4);
    expect(src.requests).toBe(4);
    for (const [i, c] of calls.entries()) {
      expect(c.init.redirect).toBe('error');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(new URL(c.url).hostname).toMatch(/^(cdn\.syndication\.twimg\.com|api\.fxtwitter\.com|pbs\.twimg\.com)$/);
      if (i > 0) expect(c.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(PACE_MS);
    }
  });

  it('lets no value reach a URL without its pattern', async () => {
    const { src, calls } = source(() => json(FX_PROFILE));
    for (const bad of ['12a', '-1', '1e5', '1/../x', '', '1'.repeat(21), '12 3']) expect(await src.post(bad), bad).toBe('failed');
    for (const bad of ['a/b', 'XDevelopers', 'x'.repeat(16), '', 'a b', '..']) expect(await src.profile(bad), bad).toBe('failed');
    expect(await src.avatar('https://evil.test/profile_images/1/a_x96.jpg')).toBeNull();
    expect(await src.avatar('https://pbs.twimg.com/profile_images/1/a_normal.jpg')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('rejects hostile answers: wrong types, another post, another account, a bad handle or reply id', async () => {
    const hostile: [string, unknown][] = [
      ['author id as a number', { ...EMBED_POST, user: { id_str: 2244994945, screen_name: 'XDevelopers' } }],
      ['author id not digits', { ...EMBED_POST, user: { id_str: '22449x4945', screen_name: 'XDevelopers' } }],
      ['author id too long', { ...EMBED_POST, user: { id_str: '1'.repeat(21), screen_name: 'XDevelopers' } }],
      ['handle not a handle', { ...EMBED_POST, user: { id_str: AUTHOR_ID, screen_name: 'x.developers' } }],
      ['handle too long', { ...EMBED_POST, user: { id_str: AUTHOR_ID, screen_name: 'XDevelopersXDevs' } }],
      ['no user', { ...EMBED_POST, user: null }],
      ['user is an array', { ...EMBED_POST, user: [AUTHOR_ID] }],
      ['reply id as a number', { ...EMBED_POST, in_reply_to_status_id_str: 1212092627178287104 }],
      ['reply id not digits', { ...EMBED_POST, in_reply_to_status_id_str: '1212/../1' }],
      ['another post', { ...EMBED_POST, id_str: PARENT_ID }],
      ['post id as a number', { ...EMBED_POST, id_str: 1212092628029698048 }],
      ['another type', { ...EMBED_POST, __typename: 'TweetWithVisibilityResults' }],
      ['an array', [EMBED_POST]],
      ['a string', 'Tweet'],
    ];
    for (const [name, body] of hostile) {
      const { src } = source((url) => (url.startsWith(EMBED) ? json(body) : new Response(FX_404, { status: 404 })));
      expect(await src.post(POST_ID), name).toBe('failed');
    }
    const fxHostile: unknown[] = [
      { ...FX_POST, tweet: { ...FX_POST.tweet, author: { id: 2244994945, screen_name: 'XDevelopers' } } },
      { ...FX_POST, tweet: { ...FX_POST.tweet, replying_to_status: { id: PARENT_ID } } },
      { ...FX_POST, tweet: { ...FX_POST.tweet, id: PARENT_ID } },
    ];
    for (const body of fxHostile) expect(await source((url) => (url.startsWith(EMBED) ? new Response('', { status: 500 }) : json(body))).src.post(POST_ID)).toBe('failed');
    // A profile of another account, or with a bad id, is refused whole; a bad optional field is dropped.
    expect(await source(() => json({ user: { ...FX_PROFILE.user, screen_name: 'someone_else' } })).src.profile('xdevelopers')).toBe('failed');
    expect(await source(() => json({ user: { ...FX_PROFILE.user, id: 2244994945 } })).src.profile('xdevelopers')).toBe('failed');
    expect(await source(() => json({ user: { ...FX_PROFILE.user, followers: -1, name: 7, avatar_url: 'https://evil.test/a.jpg' } })).src.profile('xdevelopers')).toEqual({
      xId: AUTHOR_ID,
      name: null,
      followers: null,
      avatarUrl: null,
    });
    // A handle in another case is the same account.
    expect(await source(() => json({ user: { ...FX_PROFILE.user, screen_name: 'xDEVELOPERS' } })).src.profile('xdevelopers')).toMatchObject({ xId: AUTHOR_ID });
    expect(await source(() => new Response('not json', { status: 200 })).src.profile('xdevelopers')).toBe('failed');
  });

  it('refuses a redirect, a body past the byte cap, and a declared huge body, and stops reading at the cap', async () => {
    const redirect = source(() => Promise.reject(new TypeError('fetch failed: unexpected redirect')));
    expect(await redirect.src.post(POST_ID)).toBe('failed');
    expect(await redirect.src.profile('xdevelopers')).toBe('failed');
    expect(await redirect.src.avatar('https://pbs.twimg.com/profile_images/1/a_x96.jpg')).toBeNull();

    const declared = source(() => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_JSON_BYTES + 1) } }));
    expect(await declared.src.profile('xdevelopers')).toBe('failed');

    let sent = 0;
    let cancelled = false;
    const CHUNK = 64 * 1024;
    const huge = source(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              sent += CHUNK;
              c.enqueue(new Uint8Array(CHUNK).fill(0x20));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    expect(await huge.src.profile('xdevelopers')).toBe('failed');
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * CHUNK);
  });

  it('cancels every response body that it does not read', async () => {
    const cancelled: string[] = [];
    const tracked = (name: string, status: number) => new Response(new ReadableStream<Uint8Array>({ cancel: () => void cancelled.push(name) }), { status });
    const { src } = source((url) => (url.startsWith(EMBED) ? tracked('embed 503', 503) : url.startsWith(`${FX}status/`) ? tracked('fx 429', 429) : url.startsWith(FX) ? tracked('profile 500', 500) : tracked('avatar 404', 404)));
    await src.post(POST_ID);
    await src.profile('xdevelopers');
    await src.avatar('https://pbs.twimg.com/profile_images/1/a_x96.jpg');
    expect(cancelled.sort()).toEqual(['avatar 404', 'embed 503', 'fx 429', 'profile 500']);
  });

  it('rewrites the avatar size and accepts only the image host', () => {
    expect(avatarUrlOf('https://pbs.twimg.com/profile_images/123/abc_normal.jpg')).toBe('https://pbs.twimg.com/profile_images/123/abc_x96.jpg');
    expect(avatarUrlOf('https://pbs.twimg.com/profile_images/123/abc_400x400.png')).toBe('https://pbs.twimg.com/profile_images/123/abc_x96.png');
    expect(avatarUrlOf('https://pbs.twimg.com/profile_images/123/plain.webp')).toBe('https://pbs.twimg.com/profile_images/123/plain.webp');
    const bad = [
      'https://evil.test/x.jpg',
      'http://pbs.twimg.com/profile_images/1/a.jpg',
      'https://pbs.twimg.com:8443/profile_images/1/a_normal.jpg',
      'https://user:pass@pbs.twimg.com/profile_images/1/a_normal.jpg',
      'https://pbs.twimg.com.evil.test/profile_images/1/a_normal.jpg',
      'https://pbs.twimg.com/media/secret.jpg',
      'https://pbs.twimg.com/profile_images/1/a_normal.jpg?x=1',
      'https://pbs.twimg.com/profile_images/1/a.gif',
      'https://pbs.twimg.com/profile_images/a.jpg',
      'not a url',
      42,
      null,
    ];
    for (const b of bad) expect(avatarUrlOf(b), String(b)).toBeNull();
  });

  it('detects only JPEG, PNG and WebP from the bytes', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    for (const bad of [Buffer.from('GIF89a'), Buffer.from('<svg/>'), Buffer.alloc(16), Buffer.from('RIFFxxxxAVI LIST'), Buffer.from([0xff, 0xd8])]) {
      expect(detectImageType(bad)).toBeNull();
    }
  });
});
