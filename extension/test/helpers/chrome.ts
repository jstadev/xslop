// In-memory stand-in for the extension API surface that xslop uses.
type Fn = (...args: any[]) => any;

export interface FakeChrome {
  api: typeof chrome;
  local: Map<string, unknown>;
  alarms: Map<string, { name: string; scheduledTime: number; periodInMinutes?: number }>;
  /** runtime.sendMessage calls. */
  sent: unknown[];
  /** tabs.sendMessage calls. */
  tabSent: { tabId: number; msg: any }[];
  messageListeners: Fn[];
  /** permissions.onRemoved listeners. */
  permissionRemoved: Fn[];
  /** What permissions.contains answers (Firefox data collection checks). */
  granted: boolean;
  /** tabs.update calls. */
  tabUpdates: unknown[];
  /** tabs.create calls. */
  created: { url?: string }[];
  /** tabs.query filters. */
  tabQueries: chrome.tabs.QueryInfo[];
  /** runtime.onInstalled listeners. */
  installed: Fn[];
  /** runtime.onStartup listeners. */
  startup: Fn[];
  /** alarms.onAlarm listeners. */
  alarmFired: Fn[];
  tabs: chrome.tabs.Tab[];
  onTabMessage: (tabId: number, msg: any) => Promise<unknown>;
  onRuntimeMessage: (msg: any) => Promise<unknown>;
}

export function fakeChrome(): FakeChrome {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const changed: Fn[] = [];
  const f: FakeChrome = {
    api: undefined as unknown as typeof chrome,
    local, alarms: new Map(), sent: [], tabSent: [], messageListeners: [], permissionRemoved: [], granted: true, tabUpdates: [], created: [], tabQueries: [], installed: [], startup: [], alarmFired: [], tabs: [],
    onTabMessage: async () => undefined,
    onRuntimeMessage: async () => ({ ok: true }),
  };
  const area = (m: Map<string, unknown>, name: string) => ({
    async get(keys?: string | string[] | null) {
      const list = keys == null ? [...m.keys()] : typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) if (m.has(k)) out[k] = structuredClone(m.get(k));
      return out;
    },
    async set(obj: Record<string, unknown>) {
      const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: m.get(k), newValue: v };
        m.set(k, structuredClone(v));
      }
      for (const l of changed) l(changes, name);
    },
    async remove(keys: string | string[]) {
      for (const k of typeof keys === 'string' ? [keys] : keys) m.delete(k);
    },
  });
  f.api = {
    runtime: {
      id: 'xslop-test-id',
      getURL: (p: string) => `chrome-extension://xslop-test-id/${p}`,
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' }),
      sendMessage: async (msg: unknown) => {
        f.sent.push(msg);
        return f.onRuntimeMessage(msg);
      },
      onMessage: { addListener: (l: Fn) => f.messageListeners.push(l) },
      onInstalled: { addListener: (l: Fn) => f.installed.push(l) },
      onStartup: { addListener: (l: Fn) => f.startup.push(l) },
    },
    storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: { addListener: (l: Fn) => changed.push(l) } },
    alarms: {
      async create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }) {
        f.alarms.set(name, { name, scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000, periodInMinutes: info.periodInMinutes });
      },
      get: async (name: string) => f.alarms.get(name),
      clear: async (name: string) => f.alarms.delete(name),
      onAlarm: { addListener: (l: Fn) => f.alarmFired.push(l) },
    },
    tabs: {
      query: async (q: chrome.tabs.QueryInfo) => {
        f.tabQueries.push(q);
        return f.tabs;
      },
      sendMessage: async (tabId: number, msg: unknown) => {
        f.tabSent.push({ tabId, msg });
        return f.onTabMessage(tabId, msg);
      },
      create: async (info: { url?: string }) => {
        f.created.push(info);
        return {};
      },
      update: async (info: unknown) => {
        f.tabUpdates.push(info);
        return {};
      },
    },
    permissions: {
      contains: async () => f.granted,
      request: async () => true,
      remove: async () => true,
      onRemoved: { addListener: (l: Fn) => f.permissionRemoved.push(l) },
    },
  } as unknown as typeof chrome;
  return f;
}

/** Deliver a message to the listeners as Chrome does: the listener answers through sendResponse. */
export function deliver(f: FakeChrome, msg: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => {
    let async = false;
    for (const l of f.messageListeners) {
      if (l(msg, sender, resolve) === true) async = true;
    }
    if (!async) resolve(undefined);
  });
}

/** The same API as Firefox exposes it: a `browser` global with getBrowserInfo. Set before the modules load. */
export function asFirefox(f: FakeChrome): void {
  (f.api.runtime as unknown as { getBrowserInfo: () => Promise<{ name: string }> }).getBrowserInfo = async () => ({ name: 'Firefox' });
  (globalThis as { browser?: typeof chrome }).browser = f.api;
}

/** A click that a real person made (happy-dom has no isTrusted). `detail` is the browser's click count: 2 for the second click of a double click. */
export function trustedClick(el: Element, detail = 1): void {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  el.dispatchEvent(ev);
}
