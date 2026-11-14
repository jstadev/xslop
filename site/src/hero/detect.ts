// Reads what the visitor's browser reports about itself. Pure, so every browser can be tested from its strings.

export type BrowserId =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'arc'
  | 'firefox'
  | 'firefox-android'
  | 'safari'
  | 'phone-other'
  | 'unknown';

export interface BrowserSignals {
  userAgent: string;
  /** navigator.brave exists only in Brave: its user agent is identical to Chrome's. */
  brave: boolean;
  /** Arc sets --arc-palette-* on the page root and reports a Chrome user agent. */
  arc: boolean;
}

export function detectBrowser({ userAgent: ua, brave, arc }: BrowserSignals): BrowserId {
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua);
  if (/Firefox\//.test(ua) && !/Seamonkey/i.test(ua)) return android ? 'firefox-android' : 'firefox';
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'phone-other' : 'safari';
  if (android) return 'phone-other';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Vivaldi\//.test(ua)) return 'vivaldi';
  if (brave) return 'brave';
  if (arc) return 'arc';
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'unknown';
}

/** True for the browsers that install an extension from the Chrome Web Store. Edge and Opera have stores of their own. */
export function installsFromChromeStore(id: BrowserId): boolean {
  return id === 'chrome' || id === 'brave' || id === 'vivaldi' || id === 'arc';
}

/** True for a GL that runs on the CPU: the scene would draw a few frames per second there. */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|basic render/i.test(name);
}

export function readBrowserSignals(): BrowserSignals {
  return {
    userAgent: navigator.userAgent,
    brave: 'brave' in navigator,
    arc: getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-background').trim() !== '',
  };
}
