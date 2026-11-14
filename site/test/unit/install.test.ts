// The browser lists of /download: which browsers run xslop today, which wait for a store listing, and the names in a sentence.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSections, listNames } from '../../src/install.ts';

test('without a Firefox listing, the Chromium browsers are supported and Firefox, Firefox for Android and Safari are coming soon', () => {
  assert.deepEqual(browserSections(null), {
    supported: ['chrome', 'brave', 'vivaldi', 'arc', 'edge', 'opera'],
    soon: ['firefox', 'firefox-android', 'safari'],
  });
});

test('a Firefox listing in latest.json moves both Firefox cards to the supported browsers; Safari stays coming soon', () => {
  assert.deepEqual(browserSections('https://addons.mozilla.org/firefox/addon/xslop/'), {
    supported: ['chrome', 'brave', 'vivaldi', 'arc', 'edge', 'opera', 'firefox', 'firefox-android'],
    soon: ['safari'],
  });
});

test('listNames joins the names with commas and a final "and"', () => {
  assert.equal(listNames(browserSections(null).supported), 'Chrome, Brave, Vivaldi, Arc, Edge and Opera');
  assert.equal(listNames(['edge', 'safari']), 'Edge and Safari');
  assert.equal(listNames(['firefox']), 'Firefox');
  assert.equal(listNames([]), '');
});
