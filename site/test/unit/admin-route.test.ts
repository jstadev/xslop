// Hash routes of the admin console (SPEC 14.3): every view, the old hashes, and every bad parameter that must make no request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_KINDS } from '../../src/admin/model.ts';
import { activityHash, navKey, parseRoute } from '../../src/admin/route.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('every view of 14.3 has its hash', () => {
  assert.deepEqual(parseRoute('').route, { view: 'home' });
  assert.deepEqual(parseRoute('#home').route, { view: 'home' });
  assert.deepEqual(parseRoute('#review').route, { view: 'review', queue: 'pending' });
  assert.deepEqual(parseRoute('#review/disputed').route, { view: 'review', queue: 'disputed' });
  assert.deepEqual(parseRoute('#review/auto').route, { view: 'review', queue: 'auto' });
  assert.deepEqual(parseRoute('#appeals').route, { view: 'appeals', status: 'open' });
  assert.deepEqual(parseRoute('#appeals/rejected').route, { view: 'appeals', status: 'rejected' });
  assert.deepEqual(parseRoute('#accounts').route, { view: 'accounts' });
  assert.deepEqual(parseRoute('#account/growthhacker42').route, { view: 'account', handle: 'growthhacker42' });
  assert.deepEqual(parseRoute('#installs').route, { view: 'installs' });
  assert.deepEqual(parseRoute(`#install/${ID}`).route, { view: 'install', id: ID });
  assert.deepEqual(parseRoute('#activity').route, { view: 'activity', kinds: DEFAULT_KINDS, subject: null });
  assert.deepEqual(parseRoute('#activity?kinds=vote,install&subject=xs_a').route, { view: 'activity', kinds: ['vote', 'install'], subject: 'xs_a' });
  assert.deepEqual(parseRoute(`#activity?kinds=admin&subject=${ID}`).route, { view: 'activity', kinds: ['admin'], subject: ID });
  assert.deepEqual(parseRoute('#lists').route, { view: 'lists' });
  assert.deepEqual(parseRoute('#jobs').route, { view: 'jobs' });
  assert.deepEqual(parseRoute('#help').route, { view: 'help', term: null });
  assert.deepEqual(parseRoute('#help/gate-standing').route, { view: 'help', term: 'gate-standing' });
});

test('the old hashes redirect', () => {
  assert.deepEqual(parseRoute('#overview'), { route: { view: 'home' }, redirect: '#home' });
  assert.deepEqual(parseRoute('#log'), { route: { view: 'activity', kinds: ['admin'], subject: null }, redirect: '#activity?kinds=admin' });
  assert.deepEqual(parseRoute('#help/no-such-word'), { route: { view: 'help', term: null }, redirect: '#help' });
});

test('every bad parameter gives a message, never a request', () => {
  const bad = [
    '#account/GrowthHacker42',
    '#account/a_handle_too_long_x',
    '#account/..%2Fadmin',
    '#account/%E0%A4%A',
    '#account/',
    '#account',
    '#install/not-an-id',
    `#install/${ID.toUpperCase()}`,
    `#install/${ID}x`,
    '#review/everything',
    '#appeals/all',
    '#activity?kinds=admin,nope',
    '#activity?kinds=',
    '#activity?subject=..%2F',
    '#activity?subject=Bad Handle',
    '#accounts/extra',
    '#account/a/b',
    '#settings',
  ];
  for (const hash of bad) assert.equal(parseRoute(hash).route.view, 'bad', hash);
});

test('the activity hash keeps the default filter short', () => {
  assert.equal(activityHash(DEFAULT_KINDS, null), '#activity');
  assert.equal(activityHash(['install', 'admin'], null), '#activity?kinds=admin%2Cinstall');
  assert.equal(activityHash(DEFAULT_KINDS, 'xs_a'), '#activity?subject=xs_a');
  const { route } = parseRoute(activityHash(['install', 'admin'], 'xs_a'));
  assert.deepEqual(route, { view: 'activity', kinds: ['admin', 'install'], subject: 'xs_a' });
});

test('detail pages light their list in the menu', () => {
  assert.equal(navKey({ view: 'account', handle: 'a' }), 'accounts');
  assert.equal(navKey({ view: 'install', id: ID }), 'installs');
  assert.equal(navKey({ view: 'review', queue: 'disputed' }), 'disputed');
  assert.equal(navKey({ view: 'review', queue: 'auto' }), 'review');
  assert.equal(navKey({ view: 'home' }), 'home');
});
