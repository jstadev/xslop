import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EnvError, loadAppConfig } from '../src/env.js';
import { acceptedCodings } from '../src/lib/encoding.js';
import { base32Decode, checkChallenge, hashPassword, hotp, ipHash, ipPrefix, issueChallenge, parseScryptHash, totpStep, verifyPassword } from '../src/lib/crypto.js';
import { postTime } from '../src/lib/http.js';
import { SlidingLimit, takeAll, TokenBucket } from '../src/lib/ratelimit.js';
import { NonceCache } from '../src/http/signed.js';
import { diffLists, type ListEntry } from '../src/list.js';
import { solvePow } from './helpers/app.js';

const SECRET = Buffer.alloc(32, 3);

describe('ip hash', () => {
  it('uses the IPv4 /24 and the IPv6 /48', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(ipPrefix('garbage')).toBe('unknown');
  });
  it('hashes neighbours alike and keeps 32 hex chars', () => {
    const salt = Buffer.alloc(32, 1);
    const a = ipHash(salt, '203.0.113.1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(ipHash(salt, '203.0.113.200')).toBe(a);
    expect(ipHash(salt, '203.0.114.1')).not.toBe(a);
    expect(ipHash(Buffer.alloc(32, 2), '203.0.113.1')).not.toBe(a);
  });
});

describe('challenge tokens and proof of work', () => {
  const now = 1_800_000_000_000;
  it('accepts a solved, fresh, matching challenge', () => {
    const { token } = issueChallenge(SECRET, 'install', now);
    const nonce = solvePow(token, 12);
    expect(checkChallenge(SECRET, token, nonce, 'install', 12, now + 1000)).toMatchObject({ ok: true });
  });
  it('rejects a wrong proof, purpose, MAC, expiry and shape', () => {
    const { token } = issueChallenge(SECRET, 'install', now);
    const nonce = solvePow(token, 12);
    const bad = nonce === '0' ? '1' : '0';
    // A wrong nonce almost never has 12 zero bits; find one that does not.
    let wrong = bad;
    for (let i = 100000; checkChallenge(SECRET, token, wrong, 'install', 12, now).ok; i++) wrong = String(i);
    expect(checkChallenge(SECRET, token, wrong, 'install', 12, now)).toEqual({ ok: false, reason: 'bad_proof' });
    expect(checkChallenge(SECRET, token, nonce, 'appeal', 12, now)).toEqual({ ok: false, reason: 'invalid_challenge' });
    expect(checkChallenge(Buffer.alloc(32, 4), token, nonce, 'install', 12, now)).toEqual({ ok: false, reason: 'invalid_challenge' });
    expect(checkChallenge(SECRET, token, nonce, 'install', 12, now + 600_000)).toEqual({ ok: false, reason: 'challenge_expired' });
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ n: 'x', exp: 9999999999, p: 'install' })).toString('base64url');
    expect(checkChallenge(SECRET, `${forged}.${mac}`, nonce, 'install', 12, now).ok).toBe(false);
    expect(checkChallenge(SECRET, `${payload}`, nonce, 'install', 12, now).ok).toBe(false);
    expect(checkChallenge(SECRET, `${payload}.${mac}.x`, nonce, 'install', 12, now).ok).toBe(false);
  });
});

describe('admin password hash', () => {
  it('round-trips the scrypt$N$r$p$salt$hash format', async () => {
    const s = await hashPassword('a long admin password');
    expect(s).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const h = parseScryptHash(s)!;
    expect(h.hash.length).toBe(64);
    expect(await verifyPassword('a long admin password', h)).toBe(true);
    expect(await verifyPassword('a long admin passworD', h)).toBe(false);
  });
  it('rejects weak or malformed parameters', () => {
    expect(parseScryptHash('scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88))).toBeNull();
    expect(parseScryptHash('bcrypt$x')).toBeNull();
    expect(parseScryptHash('scrypt$32768$8$1$AAAA$' + 'A'.repeat(88))).toBeNull();
  });
});

describe('admin TOTP (RFC 6238)', () => {
  // The SHA-1 seed of RFC 6238 appendix B, "12345678901234567890", and its base32 spelling.
  const seed = Buffer.from('12345678901234567890', 'ascii');
  it('decodes base32 and refuses characters outside the alphabet', () => {
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(seed);
    expect(base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq')).toEqual(seed);
    for (const bad of ['GEZDGNBV1', 'GEZDGNBV=', 'GEZD GNBV']) expect(base32Decode(bad)).toBeNull();
  });
  it('gives the 6-digit codes of the RFC 6238 test vectors', () => {
    // The vectors have 8 digits; a 6-digit code is the same number modulo 10^6.
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect([t, hotp(seed, Math.floor(t / 30))]).toEqual([t, code.slice(2)]);
  });
  it('accepts one step of drift each way and nothing further', () => {
    const t = 1_111_111_111_000;
    const step = Math.floor(t / 30_000);
    expect(totpStep(seed, '050471', t)).toBe(step);
    expect(totpStep(seed, hotp(seed, step - 1), t)).toBe(step - 1);
    expect(totpStep(seed, hotp(seed, step + 1), t)).toBe(step + 1);
    expect(totpStep(seed, hotp(seed, step - 2), t)).toBeNull();
    expect(totpStep(seed, hotp(seed, step + 2), t)).toBeNull();
    expect(totpStep(Buffer.from('another key of twenty'), '050471', t)).toBeNull();
  });
});

describe('post id time', () => {
  it('reads the time from an X post id and gives an id from before 2010-11-04 the day the ids got a time', () => {
    expect(postTime('0').toISOString()).toBe('2010-11-04T01:42:54.657Z');
    expect(postTime(String(1n << 22n)).toISOString()).toBe('2010-11-04T01:42:54.658Z');
    expect(postTime(String((BigInt(Date.UTC(2026, 10, 12, 12, 0, 0) - 1288834974657) << 22n) | 4095n)).toISOString()).toBe('2026-11-12T12:00:00.000Z');
    // A sequential id of 2009: no time inside.
    expect(postTime('5000000000').toISOString().slice(0, 10)).toBe('2010-11-04');
    expect(postTime('99999999999999999999').getTime()).toBeGreaterThan(Date.UTC(2100, 0, 1));
  });
});

describe('token bucket', () => {
  it('limits, refills over the window and reports Retry-After', () => {
    const b = new TokenBucket(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3].map(() => b.take('k', t).ok)).toEqual([true, true, true]);
    const r = b.take('k', t);
    expect(r).toEqual({ ok: false, retryAfterSec: 20 });
    expect(b.take('other', t).ok).toBe(true);
    expect(b.take('k', t + 20_000).ok).toBe(true);
    expect(b.take('k', t + 20_000).ok).toBe(false);
  });
  it('charges a cost, refunds, and sweeps idle keys', () => {
    const b = new TokenBucket(100, 3_600_000);
    expect(b.take('k', 0, 100).ok).toBe(true);
    expect(b.take('k', 0, 1).ok).toBe(false);
    b.refund('k', 0, 10);
    expect(b.take('k', 0, 10).ok).toBe(true);
    expect(b.peek('k', 0).ok).toBe(false);
    b.take('idle', 0);
    b.take('k', 4_000_000);
    expect(b.size).toBe(1);
  });
});

describe('token bucket key cap and takeAll', () => {
  it('drops the oldest key at the cap', () => {
    const b = new TokenBucket(1, 60_000, 2);
    expect(['a', 'b'].map((k) => b.take(k, 0).ok)).toEqual([true, true]);
    expect(b.take('a', 0).ok).toBe(false);
    expect(b.take('c', 0).ok).toBe(true);
    expect(b.size).toBe(2);
    expect(b.take('a', 0).ok).toBe(true); // 'a' was dropped, so it starts full
  });
  it('takes from every bucket or from none', () => {
    const x = new TokenBucket(10, 60_000);
    const y = new TokenBucket(5, 60_000);
    expect(takeAll(0, 5, [[x, 'k'], [y, 'k']]).ok).toBe(true);
    expect(takeAll(0, 1, [[x, 'k'], [y, 'k']])).toEqual({ ok: false, retryAfterSec: 12 });
    expect(x.peek('k', 0, 5).ok).toBe(true); // x gave nothing for the refused call
  });
});

describe('sliding limit', () => {
  it('allows max events in any window, expires idle keys and caps the key count', () => {
    const s = new SlidingLimit(3, 1000, 2);
    expect([0, 100, 200, 300, 999].map((t) => s.hit('k', t))).toEqual([true, true, true, false, false]);
    expect(s.hit('k', 1001)).toBe(true); // the event at 0 left the window
    expect(s.hit('k', 1050)).toBe(false);
    expect(s.hit('a', 1100)).toBe(true);
    expect(s.hit('b', 1200)).toBe(true); // at the cap: drops 'k', idle longest
    expect(s.size).toBe(2);
    expect(s.hit('k', 1300)).toBe(true);
    expect(s.hit('x', 5000)).toBe(true); // every older key expired
    expect(s.size).toBe(1);
  });
});

describe('nonce cache', () => {
  it('rejects replays inside the TTL, accepts after it, and caps each install', () => {
    const n = new NonceCache(600_000, 3);
    expect(n.check('i', 'a', 0)).toBe('ok');
    expect(n.check('i', 'a', 1000)).toBe('replay');
    expect(n.check('j', 'a', 1000)).toBe('ok');
    expect(n.check('i', 'a', 600_001)).toBe('ok');
    expect(n.check('i', 'b', 600_002)).toBe('ok');
    expect(n.check('i', 'c', 600_003)).toBe('ok');
    expect(n.check('i', 'd', 600_004)).toBe('full');
    expect(n.check('i', 'd', 1_200_002)).toBe('ok');
  });
});

describe('Accept-Encoding', () => {
  it('honours q values and the wildcard', () => {
    expect(acceptedCodings('gzip, deflate, br')).toEqual({ br: true, gzip: true });
    expect(acceptedCodings('br;q=0, gzip;q=0.5')).toEqual({ br: false, gzip: true });
    expect(acceptedCodings('*')).toEqual({ br: true, gzip: true });
    expect(acceptedCodings('*;q=0, gzip')).toEqual({ br: false, gzip: true });
    expect(acceptedCodings('identity')).toEqual({ br: false, gzip: false });
    expect(acceptedCodings(undefined)).toEqual({ br: false, gzip: false });
  });
});

describe('list diff', () => {
  it('adds new and changed entries, removes gone handles', () => {
    const prev = new Map<string, ListEntry>([
      ['a', ['a', 90, 2]],
      ['b', ['b', 50, 1]],
      ['c', ['c', 70, 2]],
    ]);
    const next: ListEntry[] = [
      ['a', 90, 2],
      ['b', 55, 1],
      ['d', 80, 2],
    ];
    expect(diffLists(prev, next)).toEqual({ add: [['b', 55, 1], ['d', 80, 2]], remove: ['c'] });
  });
});

describe('deploy units', () => {
  it('names a V8 heap for the score job: the default is about half of MemoryMax', async () => {
    const unit = await readFile(new URL('../../deploy/units/xslop-score.service', import.meta.url), 'utf8');
    const heapMb = Number(/--max-old-space-size=(\d+)/.exec(unit)?.[1]);
    const limitMb = Number(/^MemoryMax=(\d+)G$/m.exec(unit)?.[1]) * 1024;
    expect(heapMb).toBeGreaterThan(limitMb / 2);
    expect(heapMb).toBeLessThan(limitMb);
  });
});

describe('env', () => {
  const base = { XSLOP_SECRET: 'a'.repeat(64), XSLOP_IP_SALT: 'b'.repeat(64) };
  it('loads defaults', () => {
    const c = loadAppConfig(base);
    expect(c.powBits).toBe(18);
    expect(c.siteOrigin).toBe('https://x-slop.com');
    expect(c.admin).toBeNull();
    expect(c.secret.length).toBe(32);
  });
  it('rejects bad secrets, origins, difficulty and half-set admin', () => {
    expect(() => loadAppConfig({ ...base, XSLOP_SECRET: 'short' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...base, XSLOP_SITE_ORIGIN: 'https://x.test/path' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...base, XSLOP_POW_BITS: '99' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...base, XSLOP_POW_BITS: '23' })).toThrow(EnvError);
    expect(loadAppConfig({ ...base, XSLOP_POW_BITS: '22' }).powBits).toBe(22);
    expect(() => loadAppConfig({ ...base, XSLOP_ADMIN_USER: 'chair' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...base, XSLOP_ADMIN_USER: 'chair', XSLOP_ADMIN_HASH: 'plain' })).toThrow(EnvError);
  });
  it('reads a base32 TOTP secret only next to the admin login, and refuses a short or malformed one', async () => {
    const admin = { ...base, XSLOP_ADMIN_USER: 'chair', XSLOP_ADMIN_HASH: await hashPassword('a long admin password') };
    expect(loadAppConfig(admin).admin!.totp).toBeNull();
    expect(loadAppConfig({ ...admin, XSLOP_ADMIN_TOTP: 'gezdgnbvgy3tqojqgezdgnbvgy3tqojq' }).admin!.totp).toEqual(Buffer.from('12345678901234567890'));
    for (const bad of ['GEZDGNBVGY3TQOJ', 'GEZDGNBVGY3TQOJQ=', 'GEZDGNBVGY3TQOJ1', `${'A'.repeat(129)}`]) {
      expect(() => loadAppConfig({ ...admin, XSLOP_ADMIN_TOTP: bad }), bad).toThrow(EnvError);
    }
    // A TOTP secret without the password login is a mistake, not a second factor.
    expect(() => loadAppConfig({ ...base, XSLOP_ADMIN_TOTP: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })).toThrow(EnvError);
  });
  it('reads the store listings: an unset one is null, a bad one is ignored by name and never stops the start', () => {
    const chrome = 'https://chromewebstore.google.com/detail/xslop/abcdefghijklmnopabcdefghijklmnop';
    const firefox = 'https://addons.mozilla.org/en-US/firefox/addon/xslop/';
    expect(loadAppConfig(base)).toMatchObject({ stores: { chromeStoreUrl: null, firefoxUrl: null }, ignored: [] });
    expect(loadAppConfig({ ...base, XSLOP_CHROME_STORE_URL: '', XSLOP_FIREFOX_STORE_URL: '' })).toMatchObject({ stores: { chromeStoreUrl: null, firefoxUrl: null }, ignored: [] });
    expect(loadAppConfig({ ...base, XSLOP_CHROME_STORE_URL: chrome, XSLOP_FIREFOX_STORE_URL: firefox })).toMatchObject({ stores: { chromeStoreUrl: chrome, firefoxUrl: firefox }, ignored: [] });
    expect(loadAppConfig({ ...base, XSLOP_FIREFOX_STORE_URL: 'https://addons.mozilla.org/firefox/addon/xslop' }).stores.firefoxUrl).toBe('https://addons.mozilla.org/firefox/addon/xslop');
    const badChrome = [
      chrome.replace('https:', 'http:'),
      chrome.replace('google.com', 'google.com.example.net'),
      chrome.replace('https://', 'https://user@'),
      // The right host with a path that is not a listing.
      'https://chromewebstore.google.com/search/xslop',
      'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop',
      chrome.replace(/p$/, 'q'),
      chrome.slice(0, -1),
      `${chrome}?hl=en`,
      // The URL parser resolves %2e%2e: the link would leave the listing.
      'https://chromewebstore.google.com/detail/%2e%2e/abcdefghijklmnopabcdefghijklmnop',
      'javascript:alert(1)',
    ];
    for (const bad of badChrome) {
      expect(loadAppConfig({ ...base, XSLOP_CHROME_STORE_URL: bad, XSLOP_FIREFOX_STORE_URL: firefox }), bad).toMatchObject({ stores: { chromeStoreUrl: null, firefoxUrl: firefox }, ignored: ['XSLOP_CHROME_STORE_URL'] });
    }
    for (const bad of ['https://addons.mozilla.org/en-US/firefox/', 'https://addons.mozilla.org/en-US/android/addon/xslop/', 'https://addons.mozilla.org/en-US/firefox/addon/../../user/1/', firefox.replace('.org', '.org.example.net')]) {
      expect(loadAppConfig({ ...base, XSLOP_FIREFOX_STORE_URL: bad }), bad).toMatchObject({ stores: { firefoxUrl: null }, ignored: ['XSLOP_FIREFOX_STORE_URL'] });
    }
  });
});
