// Remote config (SPEC 7.6): data only. The built-in defaults are the same file that the server serves.
// The config never chooses an X endpoint (content/xcall.ts) or an action in X's menu (content/menu.ts).
import defaults from '../../../server/config/extension-config.json';
import { BEARER_RE, cmpVersion, isInt, isNum, isObj, isStr, VERSION_RE } from './util';

export const SELECTOR_KEYS = [
  'article', 'cell', 'userName', 'userLink', 'text', 'time', 'statusLink', 'actionBar',
  'ownProfile', 'protected', 'promoted', 'quote', 'replyingTo', 'media',
  'caret', 'menu', 'menuItem',
] as const;
type SelectorKey = (typeof SELECTOR_KEYS)[number];
export type Selectors = Record<SelectorKey, string>;

/** Added after v1.0: a stored or served config without these keys uses the built-in value. */
const LATER_SELECTORS: readonly SelectorKey[] = ['caret', 'menu', 'menuItem'];

export interface MuteConfig {
  enabled: boolean;
  maxPerDay: number;
  minIntervalSec: number;
  jitter: number;
  webBearer: string;
}

export interface Config {
  v: 1;
  minVersion: string;
  selectors: Selectors;
  observe: { enabled: boolean; batchMax: number; flushSec: number };
  mute: MuteConfig;
}

/** The fixed pacing band. A config can make mute sync slower, never faster. */
const MAX_MUTES_PER_DAY = 40;
const MAX_JITTER = 0.5;
/** Release builds never mute faster than every 90 s; the e2e test build lowers the floor to 1 s. */
export const MIN_MUTE_SEC: number = typeof __MIN_MUTE_SEC__ === 'number' ? __MIN_MUTE_SEC__ : 90;

/** The mute config inside the fixed pacing band, whatever the config says. */
const paced = (m: MuteConfig): MuteConfig => ({
  enabled: m.enabled,
  maxPerDay: Math.min(m.maxPerDay, MAX_MUTES_PER_DAY),
  minIntervalSec: Math.max(m.minIntervalSec, MIN_MUTE_SEC),
  jitter: Math.min(m.jitter, MAX_JITTER),
  webBearer: m.webBearer,
});

/** Return a clean Config with only known fields, or null when any field is out of shape. Unknown fields are ignored. */
export function parseConfig(x: unknown): Config | null {
  if (!isObj(x) || x.v !== 1 || !isStr(x.minVersion, 14) || !VERSION_RE.test(x.minVersion)) return null;
  const s = x.selectors;
  if (!isObj(s)) return null;
  const selectors = {} as Selectors;
  for (const k of SELECTOR_KEYS) {
    const v = s[k] ?? (LATER_SELECTORS.includes(k) ? defaults.selectors[k] : undefined);
    if (!isStr(v, 400, 1)) return null;
    selectors[k] = v;
  }
  const o = x.observe;
  if (!isObj(o) || typeof o.enabled !== 'boolean' || !isInt(o.batchMax, 1, 100) || !isInt(o.flushSec, 5, 3600)) return null;
  const m = x.mute;
  if (
    !isObj(m) || typeof m.enabled !== 'boolean' || !isInt(m.maxPerDay, 0, 500) ||
    !isNum(m.minIntervalSec, 0, 86400) || !isNum(m.jitter, 0, 1) ||
    typeof m.webBearer !== 'string' || !BEARER_RE.test(m.webBearer)
  ) return null;
  return {
    v: 1,
    minVersion: x.minVersion,
    selectors,
    observe: { enabled: o.enabled, batchMax: o.batchMax, flushSec: o.flushSec },
    mute: paced({ enabled: m.enabled, maxPerDay: m.maxPerDay, minIntervalSec: m.minIntervalSec, jitter: m.jitter, webBearer: m.webBearer }),
  };
}

const builtIn = parseConfig(defaults);
if (!builtIn) throw new Error('server/config/extension-config.json is not a valid config');
export const DEFAULT_CONFIG: Config = builtIn;

/** The mute config to use: the stored config (or the default), always inside the pacing band. */
export const muteOf = (c: Config | null): MuteConfig => paced((c ?? DEFAULT_CONFIG).mute);

/** True when this extension version may use the config. */
export const configFits = (c: Config, version: string): boolean => cmpVersion(version, c.minVersion) >= 0;
