// The last thing that goes down the drain: real accounts from the list. Each links to its entry on /sloppers.

import { request } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { parseSloppersPage, type Slopper } from '../lib/schema.ts';

const ACCOUNTS_SHOWN = 14;

function accountLink(account: Slopper): HTMLAnchorElement {
  const handle = `@${account.handle}`;
  const picture = account.avatar
    ? h('img', { class: 'drain-avatar', src: account.avatar, alt: '', width: 32, height: 32, loading: 'lazy', decoding: 'async' })
    : h('span', { class: 'drain-avatar drain-monogram', 'aria-hidden': 'true', 'data-initial': account.handle.charAt(0).toUpperCase() });
  // On a phone the ring shows only the face, so the link gets its name here.
  return h('a', { class: 'drain-account', href: `/sloppers?q=${account.handle}`, 'aria-label': handle }, picture, h('span', { class: 'drain-handle' }, handle));
}

export function initDrain(): void {
  const drain = req('#drain-accounts');
  request(`/api/v1/sloppers?status=confirmed&sort=score&limit=${ACCOUNTS_SHOWN}`)
    .then((body) => {
      const items = parseSloppersPage(body).items.slice(0, ACCOUNTS_SHOWN);
      if (items.length === 0) return;
      drain.replaceChildren(...items.map((item) => h('li', null, accountLink(item))));
      drain.hidden = false;
      document.dispatchEvent(new Event('xslop:accounts'));
    })
    .catch(() => {
      // Without the list the section stays complete: its copy and the link to /sloppers need no live data.
    });
}
