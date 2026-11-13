// One handle on the extension API: Firefox exposes the promise-based `browser`, Chrome `chrome`.
export const ext: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? globalThis.chrome;

export const API_BASE: string = __XSLOP_API__;
export const VERSION: string = __XSLOP_VERSION__;

/** Firefox has `browser.runtime.getBrowserInfo`; Chrome has not. */
export const IS_FIREFOX = typeof (globalThis as { browser?: { runtime?: { getBrowserInfo?: unknown } } }).browser?.runtime?.getBrowserInfo === 'function';

/** Firefox 140+: the optional data collection permission that signal sharing needs. */
export const DATA_COLLECTION = { data_collection: ['browsingActivity'] };

type Perms = { contains(p: object): Promise<boolean>; request(p: object): Promise<boolean>; remove(p: object): Promise<boolean> };
export const perms = (): Perms => ext.permissions as unknown as Perms;

/** True when signal sharing may run: on Firefox only with the data collection permission. Any error means no. */
export async function dataConsent(): Promise<boolean> {
  if (!IS_FIREFOX) return true;
  try {
    return (await perms().contains(DATA_COLLECTION)) === true;
  } catch {
    return false;
  }
}

/** True when a message comes from this extension's own contexts. */
export const ownSender = (sender: chrome.runtime.MessageSender): boolean => sender.id === ext.runtime.id;

/** onMessage with an async handler; works with Chrome's sendResponse and Firefox's promise style. */
export function listen(handler: (msg: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown> | undefined): void {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!ownSender(sender)) return false;
    const r = handler(msg, sender);
    if (!r) return false;
    r.then(sendResponse, (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : 'failed' }));
    return true;
  });
}
