import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, MIN_MUTE_SEC, configFits, muteOf, parseConfig } from '../../src/shared/config';
import { MUTE_WORDS, UNMUTE_WORDS } from '../../src/content/menu';
import { fakeChrome } from '../helpers/chrome';

const file = JSON.parse(readFileSync(new URL('../../../server/config/extension-config.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(file);

describe('remote config (SPEC 7.6)', () => {
  it('the served file is valid and is the built-in default', () => {
    expect(parseConfig(file)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.mute.webBearer.startsWith('AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs')).toBe(true);
    expect(DEFAULT_CONFIG.mute).toMatchObject({ enabled: true, maxPerDay: 40, minIntervalSec: 90, jitter: 0.3 });
  });

  it('keeps only known fields', () => {
    const c = clone();
    c.extra = 1;
    c.selectors.extra = 'div';
    c.mute.extra = true;
    const p = parseConfig(c)!;
    expect(p).toEqual(DEFAULT_CONFIG);
    expect(JSON.stringify(p)).not.toContain('extra');
  });

  const bad: [string, (c: any) => void][] = [
    ['wrong v', (c) => { c.v = 2; }],
    ['bad minVersion', (c) => { c.minVersion = 'latest'; }],
    ['missing selector', (c) => { delete c.selectors.article; }],
    ['empty selector', (c) => { c.selectors.text = ''; }],
    ['selector not a string', (c) => { c.selectors.text = 5; }],
    ['batchMax over 100', (c) => { c.observe.batchMax = 101; }],
    ['a negative mute interval', (c) => { c.mute.minIntervalSec = -1; }],
    ['jitter over 1', (c) => { c.mute.jitter = 1.5; }],
    ['bearer with a space', (c) => { c.mute.webBearer = 'Bearer ' + 'A'.repeat(100); }],
    ['bearer under 100 characters', (c) => { c.mute.webBearer = 'A'.repeat(99); }],
    ['bearer over 200 characters', (c) => { c.mute.webBearer = 'A'.repeat(201); }],
    ['bearer with a slash', (c) => { c.mute.webBearer = 'A'.repeat(100) + '/x'; }],
    ['missing protected selector', (c) => { delete c.selectors.protected; }],
    ['not an object', (c) => { c.mute = null; }],
  ];
  it.each(bad)('rejects %s', (_, mutate) => {
    const c = clone();
    mutate(c);
    expect(parseConfig(c)).toBeNull();
  });

  it('F1 regression: ignores X paths from an old config and clamps pacing to 40 a day, 90 s, jitter 0.5', () => {
    const c = clone();
    Object.assign(c.mute, {
      createPath: '/i/api/1.1/users/report_spam.json', destroyPath: '/i/api/1.1/friendships/create.json',
      idsPath: '/i/api/1.1/friends/ids.json', maxPerDay: 500, minIntervalSec: 30, jitter: 1,
    });
    const p = parseConfig(c)!;
    expect(p).not.toBeNull();
    expect(Object.keys(p.mute).sort()).toEqual(['enabled', 'jitter', 'maxPerDay', 'minIntervalSec', 'webBearer']);
    expect(JSON.stringify(p)).not.toContain('report_spam');
    expect(p.mute).toMatchObject({ maxPerDay: 40, minIntervalSec: 90, jitter: 0.5 });
    expect(file.mute).not.toHaveProperty('createPath');
  });

  it('F1 regression: clamps pacing at use time too, for a config stored before the band existed', () => {
    const stored = { ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, maxPerDay: 500, minIntervalSec: 1, jitter: 1 } };
    expect(muteOf(stored)).toMatchObject({ maxPerDay: 40, minIntervalSec: MIN_MUTE_SEC, jitter: 0.5 });
    expect(MIN_MUTE_SEC).toBe(90);
    expect(muteOf({ ...DEFAULT_CONFIG, mute: { ...DEFAULT_CONFIG.mute, maxPerDay: 3, minIntervalSec: 600, jitter: 0.1 } }))
      .toMatchObject({ maxPerDay: 3, minIntervalSec: 600, jitter: 0.1 });
    expect(muteOf(null)).toEqual(DEFAULT_CONFIG.mute);
  });

  it('F1 regression: accepts a base64url bearer of 100 to 200 characters', () => {
    for (const b of ['A'.repeat(100), 'A'.repeat(200), 'Ab0_-%3D'.repeat(13)]) {
      const c = clone();
      c.mute.webBearer = b;
      expect(parseConfig(c)?.mute.webBearer).toBe(b);
    }
  });

  describe('v1.1 keys', () => {
    const v10 = () => {
      const c = clone();
      for (const k of ['caret', 'menu', 'menuItem']) delete c.selectors[k];
      return c;
    };
    it('a v1.0 config without the new keys still works and gets the built-in values', () => {
      const p = parseConfig(v10())!;
      expect(p.selectors.caret).toBe('[data-testid="caret"]');
      expect(p.selectors.menuItem).toBe(file.selectors.menuItem);
    });
    it('a config stored by v1.0 reads the same, and one out of shape reads as none', async () => {
      const f = fakeChrome();
      (globalThis as { chrome?: typeof chrome }).chrome = f.api;
      vi.resetModules();
      const { readStored } = await import('../../src/shared/storage');
      f.local.set('config', v10());
      expect((await readStored(['config'])).config?.selectors.caret).toBe(file.selectors.caret);
      f.local.set('config', { v: 9 });
      expect((await readStored(['config'])).config).toBeNull();
    });
    it('uses selectors from the config', () => {
      const c = clone();
      c.selectors.caret = '[data-testid="more"]';
      expect(parseConfig(c)!.selectors.caret).toBe('[data-testid="more"]');
    });
    it('rejects an empty selector', () => {
      const c = clone();
      c.selectors.caret = '';
      expect(parseConfig(c)).toBeNull();
    });
  });

  describe('the words that choose a menu item (SPEC 12.3)', () => {
    it('are not in the served config, and a config that carries them cannot set them', () => {
      expect(file).not.toHaveProperty('muteWords');
      expect(file).not.toHaveProperty('unmuteWords');
      const p = parseConfig({ ...clone(), muteWords: ['block'], unmuteWords: ['follow'] })!;
      expect(p).toEqual(DEFAULT_CONFIG);
      expect(JSON.stringify(p)).not.toContain('block');
    });
    it('name every required language', () => {
      for (const w of ['mute', 'silenciar', 'masquer', 'stummschalten', 'silenzia', 'σίγαση', 'negeren', 'sessize al', 'игнорировать', 'ミュート', '뮤트']) {
        expect(MUTE_WORDS).toContain(w);
      }
      expect(MUTE_WORDS.some((w) => w === '隐藏' || w === '静音')).toBe(true);
      expect(UNMUTE_WORDS.length).toBeGreaterThanOrEqual(13);
    });
    it('are in lower case, because the item text is', () => {
      for (const w of [...MUTE_WORDS, ...UNMUTE_WORDS]) expect(w).toBe(w.toLowerCase());
    });
    it('hold no word that names Block, Follow or Report', () => {
      expect([...MUTE_WORDS, ...UNMUTE_WORDS].join(' ')).not.toMatch(/block|bloque|follow|report|engelle|заблок|ブロック|차단|屏蔽|封鎖/);
    });
  });

  it('checks minVersion against this extension version', () => {
    expect(configFits({ ...DEFAULT_CONFIG, minVersion: '1.0.0' }, '1.0.0')).toBe(true);
    expect(configFits({ ...DEFAULT_CONFIG, minVersion: '1.2.0' }, '1.10.0')).toBe(true);
    expect(configFits({ ...DEFAULT_CONFIG, minVersion: '2.0.0' }, '1.9.9')).toBe(false);
  });
});
