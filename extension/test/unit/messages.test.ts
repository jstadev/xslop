import { describe, expect, it } from 'vitest';
import { parseBgMsg, parseContentMsg, parsePageMsg } from '../../src/shared/messages';

const vote = { t: 'vote', handle: '@SlopBot ', value: 'slop', tweetId: '101', parentTweetId: '100', postedAt: '2026-11-07T09:10:12.000Z', context: 'reply' };
const obs = { handle: 'slopbot', tweetId: '101', parentTweetId: '100' };

describe('content script messages', () => {
  it('normalizes the handle of a vote', () => {
    expect(parseContentMsg(vote)).toEqual({ ...vote, handle: 'slopbot' });
  });
  it.each([
    ['an unknown field', { ...vote, install: 'x' }],
    ['the post text', { ...vote, text: 'Great point!' }],
    ['a bad value', { ...vote, value: 'spam' }],
    ['a bad tweet id', { ...vote, tweetId: '12a' }],
    ['a bad handle', { ...vote, handle: 'no spaces here!' }],
    ['a bad date', { ...vote, postedAt: 'now' }],
    ['a bad context', { ...vote, context: 'dm' }],
  ])('rejects a vote with %s', (_, m) => {
    expect(parseContentMsg(m)).toBeNull();
  });
  it('SPEC 13.8 accepts observations of three fields and nothing more', () => {
    expect(parseContentMsg({ t: 'observe', items: [obs] })).toEqual({ t: 'observe', items: [obs] });
    expect(parseContentMsg({ t: 'observe', items: [{ ...obs, parentTweetId: null }] })).toEqual({ t: 'observe', items: [{ ...obs, parentTweetId: null }] });
    expect(parseContentMsg({ t: 'observe', items: [] })).toBeNull();
    expect(parseContentMsg({ t: 'observe', items: Array(101).fill(obs) })).toBeNull();
  });
  it.each([
    ['the text', { ...obs, text: 'Great point!' }],
    ['a field of an older build', { ...obs, simhash: '0123456789abcdef' }],
    ['the parent handle', { ...obs, parentHandle: 'alice' }],
    ['no parent field', { handle: 'slopbot', tweetId: '101' }],
    ['a bad handle', { ...obs, handle: 'Bad Handle!' }],
    ['a bad post id', { ...obs, tweetId: '1e5' }],
    ['a bad parent id', { ...obs, parentTweetId: 100 }],
  ])('rejects an observation with %s', (_, item) => {
    expect(parseContentMsg({ t: 'observe', items: [item] })).toBeNull();
  });
  it('rejects unknown message types', () => {
    expect(parseContentMsg({ t: 'settings', patch: { share: true } })).toBeNull();
    expect(parseContentMsg('vote')).toBeNull();
  });
});

describe('instant mute messages (SPEC 12.3)', () => {
  const muted = { t: 'muted', handle: '@SlopBot', id: '123', status: 200, code: null, via: 'rest', op: 'create' };
  it('normalizes the handle and takes the X answer', () => {
    expect(parseContentMsg(muted)).toEqual({ ...muted, handle: 'slopbot' });
    expect(parseContentMsg({ ...muted, id: null, via: 'menu', op: 'destroy', status: 0, code: -4 })).toEqual({ ...muted, handle: 'slopbot', id: null, via: 'menu', op: 'destroy', status: 0, code: -4 });
  });
  it.each([
    ['an unknown field', { ...muted, extra: 1 }],
    ['a bad handle', { ...muted, handle: 'no spaces here!' }],
    ['a non-numeric id', { ...muted, id: '12a' }],
    ['a status over 999', { ...muted, status: 1000 }],
    ['a negative status', { ...muted, status: -1 }],
    ['a code that is not a number', { ...muted, code: 'x' }],
    ['an unknown way', { ...muted, via: 'api' }],
    ['the read operation', { ...muted, op: 'ids' }],
  ])('rejects a result with %s', (_, m) => {
    expect(parseContentMsg(m)).toBeNull();
  });
  it('validates a request for the recorded id', () => {
    expect(parseContentMsg({ t: 'muteRecord', handle: 'SlopBot' })).toEqual({ t: 'muteRecord', handle: 'slopbot' });
    expect(parseContentMsg({ t: 'muteRecord', handle: 'bad handle!' })).toBeNull();
    expect(parseContentMsg({ t: 'muteRecord', handle: 'a', id: '1' })).toBeNull();
  });
});

describe('page messages', () => {
  it('validates settings patches', () => {
    expect(parsePageMsg({ t: 'settings', patch: { strictness: 'strict', share: true } })).toEqual({ t: 'settings', patch: { strictness: 'strict', share: true } });
    expect(parsePageMsg({ t: 'settings', patch: { strictness: 'max' } })).toBeNull();
    expect(parsePageMsg({ t: 'settings', patch: { share: 'yes' } })).toBeNull();
    expect(parsePageMsg({ t: 'settings', patch: { theme: 'dark' } })).toBeNull();
    expect(parsePageMsg({ t: 'settings', patch: { muteOnMark: false } })).toEqual({ t: 'settings', patch: { muteOnMark: false } });
    expect(parsePageMsg({ t: 'settings', patch: { muteOnMark: 'no' } })).toBeNull();
  });
  it('validates a restored vote', () => {
    const v = { h: 'slopbot', v: 1, at: 5, tweetId: '101', parentTweetId: null, postedAt: null, context: 'reply' };
    expect(parsePageMsg({ t: 'restore', vote: v })).toEqual({ t: 'restore', vote: v });
    expect(parsePageMsg({ t: 'restore', vote: { ...v, text: 'Great point!' } })).toBeNull();
    expect(parsePageMsg({ t: 'restore', vote: { ...v, h: 'Bad!' } })).toBeNull();
  });
});

describe('background messages', () => {
  const call = { t: 'xcall', op: 'create', handle: 'slopbot', userId: null, cursor: null, bearer: 'A'.repeat(104) };
  it('accepts an X call by operation only', () => {
    expect(parseBgMsg(call)).toEqual(call);
    expect(parseBgMsg({ ...call, op: 'destroy', handle: null, userId: '1234' })).toMatchObject({ op: 'destroy', userId: '1234' });
    expect(parseBgMsg({ ...call, op: 'block' })).toBeNull();
    expect(parseBgMsg({ ...call, userId: '12a' })).toBeNull();
    expect(parseBgMsg({ ...call, bearer: 'A'.repeat(60) })).toBeNull();
  });
  it('F1 regression: drops any path that a message carries', () => {
    const m = parseBgMsg({ ...call, path: '/i/api/1.1/users/report_spam.json' });
    expect(m).toEqual(call);
    expect(m).not.toHaveProperty('path');
  });
  it('validates diffs', () => {
    expect(parseBgMsg({ t: 'votes', set: [['a', 1]], del: ['b'] })).toEqual({ t: 'votes', set: [['a', 1]], del: ['b'] });
    expect(parseBgMsg({ t: 'votes', set: [['a', 2]], del: [] })).toBeNull();
    expect(parseBgMsg({ t: 'list', from: 1, version: 2, add: [['a', 50, 2]], remove: [] })).toMatchObject({ t: 'list', version: 2 });
    expect(parseBgMsg({ t: 'settings', settings: { strictness: 'off' } })).toBeNull();
    const settings = { strictness: 'off', display: 'collapse', share: false, mute: false, muteOnMark: true };
    expect(parseBgMsg({ t: 'settings', settings })).toEqual({ t: 'settings', settings });
    expect(parseBgMsg({ t: 'settings', settings: { ...settings, muteOnMark: undefined } })).toBeNull();
  });
});
