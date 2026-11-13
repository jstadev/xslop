// Upgrade from v1.0 stored state (SPEC 12.3): every new field gets its default, every old value stays.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome, type FakeChrome } from '../helpers/chrome';
import { cleanMute } from '../../src/shared/muteplan';
import type { MuteState } from '../../src/shared/types';

let f: FakeChrome;
let readStored: typeof import('../../src/shared/storage').readStored;

beforeEach(async () => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  ({ readStored } = await import('../../src/shared/storage'));
});

describe('migration from v1.0 storage', () => {
  it('turns instant mute on for an existing install, and keeps its settings', async () => {
    f.local.set('settings', { strictness: 'strict', display: 'remove', share: true, mute: false });
    expect((await readStored(['settings'])).settings).toEqual({ strictness: 'strict', display: 'remove', share: true, mute: false, muteOnMark: true });
  });
  it('keeps a choice you made after the upgrade', async () => {
    f.local.set('settings', { strictness: 'balanced', display: 'collapse', share: false, mute: false, muteOnMark: false });
    expect((await readStored(['settings'])).settings.muteOnMark).toBe(false);
  });
  it('gives a v1.0 mute state the new empty fields and keeps its records', async () => {
    const old = { muted: [['a', { at: 1, id: '7' }]], skipped: [['b', 'own']], lost: 1, day: '2026-11-01', count: 3, nextAt: 5, pausedUntil: 0, reason: null, fails: 0, undoAll: false, waiting: null };
    f.local.set('mute', old);
    const { mute } = await readStored(['mute']);
    const clean: MuteState = cleanMute(mute);
    expect(clean).toEqual({ ...old, own: [], ownAt: 0, retry: [], wrongIds: [] });
  });
  it('R3 reads a vote and an outbox entry of an older build without the post text that it stored', async () => {
    const vote = { h: 'slopbot', v: 1, at: 5, tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' };
    const body = { handle: 'slopbot', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: null, context: 'reply' };
    f.local.set('votes', [{ ...vote, text: 'Great point! 🚀' }]);
    f.local.set('outbox', { ops: [{ seq: 1, h: 'slopbot', k: 'vote', body: { ...body, text: 'Great point! 🚀' } }, { seq: 2, h: 'gone', k: 'del' }], obs: [], attempt: 2, nextAt: 9, seq: 2, lastError: 'network' });
    const { votes, outbox } = await readStored(['votes', 'outbox']);
    expect(votes).toEqual([vote]);
    expect(outbox).toEqual({ ops: [{ seq: 1, h: 'slopbot', k: 'vote', body }, { seq: 2, h: 'gone', k: 'del' }], obs: [], attempt: 2, nextAt: 9, seq: 2, lastError: 'network' });
  });
  it('SPEC 13.8 reads the observations that 1.1.3 queued in the three fields of v2', async () => {
    const old = {
      handle: 'slopbot', tweetId: '101', parentTweetId: '100', parentHandle: 'alice', replyAt: '2026-11-07T09:10:12.000Z',
      parentAt: '2026-11-07T09:10:00.000Z', textLen: 37, simhash: '0123456789abcdef', genericScore: 0.8, overlapScore: 0, hasMedia: false, verified: true,
    };
    f.local.set('outbox', { ops: [], obs: [old, { ...old, tweetId: '102', parentTweetId: null }], attempt: 0, nextAt: 0, seq: 0, lastError: null });
    const { outbox } = await readStored(['outbox']);
    expect(outbox.obs).toEqual([{ handle: 'slopbot', tweetId: '101', parentTweetId: '100' }, { handle: 'slopbot', tweetId: '102', parentTweetId: null }]);
  });
  it('SPEC 13.8 reads a list that 1.1.3 stored, with no ids, and a status without the standing fields', async () => {
    const list = { version: 4, generatedAt: '2026-11-07T00:00:00.000Z', etag: '"4"', accounts: [['abe', 50, 2]] };
    f.local.set('list', list);
    f.local.set('status', { banned: false, updateNeeded: false, installError: null, listAt: 9 });
    const got = await readStored(['list', 'status']);
    expect(got.list).toEqual(list);
    expect(got.status).toEqual({ banned: false, updateNeeded: false, installError: null, listAt: 9, standing: null, meAt: 0 });
  });
  it('SPEC 13.10 reads the [handle, id] pairs that a 1.2.0 test build stored as ids beside the rows', async () => {
    const accounts = [['abe', 50, 2], ['bob', 70, 2], ['cat', 60, 1]];
    f.local.set('list', { version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts, ids: [['bob', '702'], ['abe', '701']] });
    expect((await readStored(['list'])).list).toEqual({ version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts, ids: ['701', '702', null] });
    // One pair for each row: still pairs, not ids beside the rows.
    f.local.set('list', { version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts, ids: [['cat', '703'], ['abe', '701'], ['bob', '702']] });
    expect((await readStored(['list'])).list?.ids).toEqual(['701', '702', '703']);
    // That build stored no pairs when the server sent no ids.
    f.local.set('list', { version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts, ids: [] });
    expect((await readStored(['list'])).list?.ids).toEqual([null, null, null]);
  });
  it('SPEC 13.10 keeps ids that are beside the rows, and reads ids of any other shape as none, so the next sync fetches the full list', async () => {
    const list = { version: 5, generatedAt: '2026-11-12T00:00:00.000Z', etag: '"5"', accounts: [['abe', 50, 2], ['bob', 70, 2]] };
    f.local.set('list', { ...list, ids: ['701', null] });
    expect((await readStored(['list'])).list).toEqual({ ...list, ids: ['701', null] });
    for (const ids of [['701'], [['abe', 701]], [['abe']], 'abe', { abe: '701' }]) {
      f.local.set('list', { ...list, ids });
      expect([ids, (await readStored(['list'])).list]).toEqual([ids, list]);
    }
  });
  it('a fresh install reads defaults everywhere', async () => {
    const { settings, mute, config } = await readStored(['settings', 'mute', 'config']);
    expect(settings.muteOnMark).toBe(true);
    expect(mute.own).toEqual([]);
    expect(config).toBeNull();
  });
});
