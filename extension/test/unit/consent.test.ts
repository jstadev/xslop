// Firefox data collection consent (finding 5): signal sharing fails closed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asFirefox, deliver, fakeChrome, type FakeChrome } from '../helpers/chrome';
import { DEFAULT_SETTINGS, EMPTY_OUTBOX, type Observation, type Outbox, type Settings } from '../../src/shared/types';

let f: FakeChrome;
const content = { id: 'xslop-test-id', tab: { id: 4 } as chrome.tabs.Tab, url: 'https://x.com/alice/status/100' };
const obs: Observation = { handle: 'slopbot', tweetId: '101', parentTweetId: '100' };
const outbox = () => (f.local.get('outbox') as Outbox | undefined) ?? EMPTY_OUTBOX;
const settings = () => f.local.get('settings') as Settings;
type P = { request: (p: object) => Promise<boolean>; remove: (p: object) => Promise<boolean> };

beforeEach(() => {
  vi.resetModules();
  f = fakeChrome();
  (globalThis as { chrome?: typeof chrome }).chrome = f.api;
  asFirefox(f);
  const keys = new Map<string, unknown>();
  vi.doMock('../../src/bg/idb', () => ({ idbGet: async (k: string) => keys.get(k), idbSet: async (k: string, v: unknown) => keys.set(k, v) }));
  f.local.set('settings', { ...DEFAULT_SETTINGS, share: true });
});
afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
  vi.unstubAllGlobals();
});

describe('Firefox data collection consent', () => {
  it('F5 regression: an error or a refusal in the permission prompt means no consent', async () => {
    const p = await import('../../src/popup/pages');
    const perms = f.api.permissions as unknown as P;
    perms.request = async () => {
      throw new Error('data_collection unsupported');
    };
    expect(await p.askDataCollection(true)).toBe(false);
    perms.request = async () => false;
    expect(await p.askDataCollection(true)).toBe(false);
    perms.request = async () => true;
    expect(await p.askDataCollection(true)).toBe(true);
    // Turning sharing off always works, even when the browser fails to remove the permission.
    perms.remove = async () => {
      throw new Error('failed');
    };
    expect(await p.askDataCollection(false)).toBe(true);
  });

  it('F5 regression: without the permission, observations are not queued and sharing turns off', async () => {
    f.granted = false;
    await import('../../src/background');
    expect(await deliver(f, { t: 'observe', items: [obs] }, content)).toEqual({ ok: true });
    expect(outbox().obs).toEqual([]);
    expect(settings().share).toBe(false);
  });

  it('F5 regression: permissions.onRemoved turns sharing off and drops the queued observations', async () => {
    await import('../../src/background');
    // The API is unreachable in this test, so the batch waits in the outbox.
    await deliver(f, { t: 'observe', items: [obs] }, content);
    expect(outbox().obs).toHaveLength(1);
    expect(f.permissionRemoved).toHaveLength(1);
    f.granted = false;
    for (const l of f.permissionRemoved) l({ data_collection: ['browsingActivity'] });
    await vi.waitFor(() => expect(settings().share).toBe(false));
    await vi.waitFor(() => expect(outbox().obs).toEqual([]));
  });

  it('F5 regression: the outbox never sends queued observations once the permission is gone', async () => {
    f.local.set('outbox', { ...EMPTY_OUTBOX, obs: [obs] });
    f.granted = false;
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const o = await import('../../src/bg/outbox');
    await o.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outbox().obs).toEqual([]);
  });

  it('keeps sharing on with the permission', async () => {
    await import('../../src/background');
    await deliver(f, { t: 'observe', items: [obs] }, content);
    expect(outbox().obs.map((o) => o.tweetId)).toEqual(['101']);
    expect(settings().share).toBe(true);
  });
});
