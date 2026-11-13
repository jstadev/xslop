import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../../src/lib/api.ts';
import { parseAccount, parseAppealCreated, parseAppealState, parseChallenge, parseLatest, parseStats } from '../../src/lib/schema.ts';

const stats = { confirmed: 793, flagged: 4, votes: 10, installs: 2, sightings: 0, generatedAt: '2026-11-07T10:00:00.000Z' };

test('parseStats accepts the SPEC shape and rejects bad numbers', () => {
  assert.deepEqual(parseStats(stats), stats);
  assert.throws(() => parseStats({ ...stats, votes: -1 }), ApiError);
  assert.throws(() => parseStats({ ...stats, votes: 1.5 }), ApiError);
  assert.throws(() => parseStats({ ...stats, generatedAt: 'yesterday' }), ApiError);
  assert.throws(() => parseStats(null), ApiError);
  assert.throws(() => parseStats([]), ApiError);
});

const sha = 'a'.repeat(64);

test('parseLatest validates file names, hashes and store URLs', () => {
  const ok = parseLatest({ version: '1.0.0', chrome: { file: 'xslop-chrome-v1.0.0.zip', sha256: sha, bytes: 10 }, firefox: { file: 'xslop-firefox-v1.0.0.zip', sha256: sha, bytes: 10 } });
  assert.equal(ok.chrome?.file, 'xslop-chrome-v1.0.0.zip');
  assert.equal(ok.chromeStoreUrl, null);
  assert.equal(ok.firefoxUrl, null);

  const bad = parseLatest({
    version: '1.0.0',
    chrome: { file: '../../etc/passwd', sha256: sha, bytes: 10 },
    firefox: { file: 'xslop-chrome-v1.0.0.zip', sha256: sha, bytes: 10 },
    chromeStoreUrl: 'https://evil.example/chromewebstore.google.com',
    firefoxUrl: 'http://addons.mozilla.org/x',
  });
  assert.equal(bad.chrome, null, 'path traversal file name is dropped');
  assert.equal(bad.firefox, null, 'chrome file in the firefox slot is dropped');
  assert.equal(bad.chromeStoreUrl, null);
  assert.equal(bad.firefoxUrl, null, 'http is refused');

  const store = parseLatest({ version: '1.2.3', chromeStoreUrl: 'https://chromewebstore.google.com/detail/xslop/abc', firefoxUrl: 'https://user:pw@addons.mozilla.org/x' });
  assert.equal(store.chromeStoreUrl, 'https://chromewebstore.google.com/detail/xslop/abc');
  assert.equal(store.firefoxUrl, null, 'credentials in URL are refused');
  assert.throws(() => parseLatest({ version: 'v1' }), ApiError);
  assert.equal(parseLatest({ version: '1.0.0', chrome: { file: 'xslop-chrome-v1.0.0.zip', sha256: 'XYZ', bytes: 10 } }).chrome, null);
});

const account = {
  handle: 'someone',
  status: 'confirmed',
  tier: 2,
  score: 87,
  seed: true,
  votes: { slop: 3, notSlop: 1 },
  sightings: 12,
  signals: { fastReplyShare: 0.5, replies: 14 },
  evidence: [
    // An answer of the API before round 2 still carries the text that the voter sent.
    { text: '<b>any text</b>', tweetId: '123', at: '2026-11-07T10:00:00Z' },
    { tweetId: '12a', at: '2026-11-07T10:00:00Z' },
    { tweetId: '124', at: '2026-11-07T11:00:00Z' },
    { tweetId: '125', at: '2026-11-07T10:00:00Z' },
  ],
  appealOpen: false,
};

test('parseAccount keeps the post id and the time of each evidence item, never the text, from an old and a new answer', () => {
  const a = parseAccount(account);
  assert.deepEqual(a.evidence, [{ tweetId: '123', at: '2026-11-07T10:00:00Z' }, { tweetId: '124', at: '2026-11-07T11:00:00Z' }], 'bad tweet id dropped; only the first three items are read');
  assert.deepEqual(parseAccount({ ...account, evidence: [{ tweetId: '126', at: 'yesterday' }, { tweetId: 127, at: '2026-11-07T10:00:00Z' }, 'x'] }).evidence, []);
  assert.deepEqual(a.signals, { fastReplyShare: 0.5, replies: 14 });
  assert.equal(parseAccount({ ...account, signals: null }).signals, null);
  // A v1 answer carried three shares and no count: the page refuses it instead of showing half of it.
  assert.throws(() => parseAccount({ ...account, signals: { fastReplyShare: 0.5, duplicateShare: 0.1, genericShare: 0.9 } }), ApiError);
});

test('parseAccount rejects bad fields', () => {
  for (const patch of [{ status: 'banned' }, { tier: 3 }, { score: 101 }, { handle: 'Bad Handle' }, { votes: { slop: -1, notSlop: 0 } }, { signals: { fastReplyShare: 2, replies: 3 } }, { signals: { fastReplyShare: 0.2, replies: -1 } }, { signals: { fastReplyShare: 0.2, replies: 1.5 } }, { status: 'cleared' }, { status: 'pending' }, { appealOpen: 'no' }]) {
    assert.throws(() => parseAccount({ ...account, ...patch }), ApiError, JSON.stringify(patch));
  }
});

test('parseChallenge and appeal shapes', () => {
  assert.deepEqual(parseChallenge({ challenge: 'abcdefgh.ijklmnop', difficulty: 18 }), { challenge: 'abcdefgh.ijklmnop', difficulty: 18 });
  assert.throws(() => parseChallenge({ challenge: 'no-dot', difficulty: 18 }), ApiError);
  assert.throws(() => parseChallenge({ challenge: 'abcdefgh.ijklmnop', difficulty: 40 }), ApiError);
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(parseAppealCreated({ appealId: id, code: 'xslop-AB12CD', status: 'open' }).code, 'xslop-AB12CD');
  assert.throws(() => parseAppealCreated({ appealId: id, code: '<b>x</b>', status: 'open' }), ApiError);
  assert.equal(parseAppealState({ appealId: id, handle: 'abc', status: 'accepted', createdAt: '2026-11-07T10:00:00Z', decidedAt: null }).decidedAt, null);
  assert.throws(() => parseAppealState({ appealId: 'x', handle: 'abc', status: 'open', createdAt: '2026-11-07T10:00:00Z' }), ApiError);
});
