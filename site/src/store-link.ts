// The install links of the landing page lead to /download. In a browser that installs from the Chrome Web Store they lead
// straight to the listing, once /downloads/latest.json names it. The badge in the hero shows only then.
// Until the answer comes, and when it fails, every link keeps /download: nothing on the page waits or moves.

import { detectBrowser, installsFromChromeStore, readBrowserSignals } from './hero/detect.ts';
import { request } from './lib/api.ts';
import { parseLatest } from './lib/schema.ts';

export function initStoreLinks(): void {
  if (!installsFromChromeStore(detectBrowser(readBrowserSignals()))) return;
  request('/downloads/latest.json', { cache: 'default' }).then(
    (body) => {
      const url = parseLatest(body).chromeStoreUrl;
      if (!url) return;
      for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-store-link]')) {
        link.href = url;
        link.hidden = false;
      }
    },
    (err: unknown) => console.warn('xslop: the download list did not load, the install links keep /download', err),
  );
}
