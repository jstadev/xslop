/** Reads and validates the environment once at start. A bad value stops the process with the name of the variable, never its value. */
import { fileURLToPath } from 'node:url';
import { base32Decode, parseScryptHash, type ScryptHash } from './lib/crypto.js';

/** The release root: server/.. holds site/dist, extension/dist and seed/. */
export const releaseRoot = fileURLToPath(new URL('../..', import.meta.url));
export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const extensionConfigFile = fileURLToPath(new URL('../config/extension-config.json', import.meta.url));

export interface AppConfig {
  secret: Buffer;
  ipSalt: Buffer;
  powBits: number;
  siteOrigin: string;
  staticRoot: string;
  configFile: string;
  /**
   * null when XSLOP_ADMIN_USER and XSLOP_ADMIN_HASH are both unset: the admin API answers 503.
   * `totp` is the key of XSLOP_ADMIN_TOTP; when it is set, a login also needs the current code.
   */
  admin: { user: string; hash: ScryptHash; totp?: Buffer | null } | null;
  /** The store listings that `/downloads/latest.json` names (section 5.7). */
  stores: StoreUrls;
  /** Optional variables with a bad value. The app runs without them and logs one warning for each at start. */
  ignored: string[];
}

export interface StoreUrls {
  chromeStoreUrl: string | null;
  firefoxUrl: string | null;
}

export class EnvError extends Error {}

type Env = Record<string, string | undefined>;

function hexKey(env: Env, name: string): Buffer {
  const v = env[name];
  if (!v || !/^[0-9a-fA-F]{64}$/.test(v)) throw new EnvError(`${name} must be 64 hex characters`);
  return Buffer.from(v, 'hex');
}

export function requireDatabaseUrl(env: Env = process.env): string {
  const v = env.DATABASE_URL;
  if (!v || !/^postgres(ql)?:\/\//.test(v)) throw new EnvError('DATABASE_URL must be a postgres:// URL');
  return v;
}

export function loadPort(env: Env = process.env): number {
  const port = Number(env.PORT ?? '3995');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EnvError('PORT must be 1..65535');
  return port;
}

/** A listing URL exactly as the store writes it. The slug has no dot, so no path segment can climb. */
const STORE_LISTINGS = [
  ['XSLOP_CHROME_STORE_URL', 'chromeStoreUrl', /^https:\/\/chromewebstore\.google\.com\/detail\/[A-Za-z0-9%_-]{1,128}\/[a-p]{32}$/],
  ['XSLOP_FIREFOX_STORE_URL', 'firefoxUrl', /^https:\/\/addons\.mozilla\.org\/(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?\/)?firefox\/addon\/[A-Za-z0-9%_-]{1,128}\/?$/],
] as const;

/** An unset store URL is left out. A bad one is left out too and named in `ignored`: a store link never stops the server. */
function loadStores(env: Env): { stores: StoreUrls; ignored: string[] } {
  const stores: StoreUrls = { chromeStoreUrl: null, firefoxUrl: null };
  const ignored: string[] = [];
  for (const [name, field, pattern] of STORE_LISTINGS) {
    const v = env[name];
    if (!v) continue;
    // The URL parser must keep every character: it resolves a %2e segment, which the pattern cannot see.
    if (pattern.test(v) && URL.parse(v)?.href === v) stores[field] = v;
    else ignored.push(name);
  }
  return { stores, ignored };
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  const powBits = Number(env.XSLOP_POW_BITS ?? '18');
  if (!Number.isInteger(powBits) || powBits < 8 || powBits > 22) throw new EnvError('XSLOP_POW_BITS must be an integer 8..22 (the extension refuses more than 22)');

  const originRaw = env.XSLOP_SITE_ORIGIN ?? 'https://x-slop.com';
  let siteOrigin: string;
  try {
    siteOrigin = new URL(originRaw).origin;
  } catch {
    throw new EnvError('XSLOP_SITE_ORIGIN must be an absolute URL');
  }
  if (siteOrigin !== originRaw.replace(/\/$/, '')) throw new EnvError('XSLOP_SITE_ORIGIN must be an origin (scheme://host[:port])');

  const user = env.XSLOP_ADMIN_USER;
  const hashRaw = env.XSLOP_ADMIN_HASH;
  const totpRaw = env.XSLOP_ADMIN_TOTP;
  let admin: AppConfig['admin'] = null;
  if (user || hashRaw || totpRaw) {
    if (!user || !/^[A-Za-z0-9_.@-]{1,64}$/.test(user)) throw new EnvError('XSLOP_ADMIN_USER must be 1..64 of [A-Za-z0-9_.@-]');
    const hash = hashRaw ? parseScryptHash(hashRaw) : null;
    if (!hash) throw new EnvError('XSLOP_ADMIN_HASH must be scrypt$N$r$p$saltB64$hashB64 (run hash-password.js)');
    // At least 80 bits (RFC 4226 asks for 128 and recommends 160: 32 characters).
    const totp = totpRaw ? (/^[A-Za-z2-7]{16,128}$/.test(totpRaw) ? base32Decode(totpRaw) : null) : null;
    if (totpRaw && !totp) throw new EnvError('XSLOP_ADMIN_TOTP must be a base32 secret of 16 to 128 characters (A-Z, 2-7, no padding)');
    admin = { user, hash, totp };
  }

  return {
    secret: hexKey(env, 'XSLOP_SECRET'),
    ipSalt: hexKey(env, 'XSLOP_IP_SALT'),
    powBits,
    siteOrigin,
    staticRoot: env.XSLOP_STATIC_ROOT || releaseRoot,
    configFile: extensionConfigFile,
    admin,
    ...loadStores(env),
  };
}
