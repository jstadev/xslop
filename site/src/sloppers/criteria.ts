// "How an account gets on this list", rendered from GET /api/v1/criteria so the numbers on the page come from the scoring code.

import { request } from '../lib/api.ts';
import { h, req } from '../lib/dom.ts';
import { describeError } from '../lib/messages.ts';
import { parseCriteria, type Criteria, type CriteriaTier } from '../lib/schema.ts';
import { STAMP } from './row.ts';

const list = (items: string[]): HTMLElement => h('ul', { class: 'sl-crit-list' }, ...items.map((text) => h('li', null, text)));

const heading = (...content: (HTMLElement | string | null)[]): HTMLElement => h('h3', { class: 'sl-crit-h' }, ...content);

const section = (title: HTMLElement, ...content: HTMLElement[]): HTMLElement => h('section', { class: 'sl-crit-tier' }, title, ...content);

function tierSection(tier: CriteriaTier): HTMLElement {
  const stamp = h('span', { class: 'sl-stamp', 'data-status': tier.status }, STAMP[tier.status]);
  return section(heading(stamp, tier.title === STAMP[tier.status] ? null : tier.title), h('p', null, tier.summary), list(tier.rules));
}

function render(body: HTMLElement, c: Criteria): void {
  body.replaceChildren(...c.tiers.map(tierSection));
  if (c.weights.length > 0) body.append(section(heading('Which votes count more'), list(c.weights)));
  if (c.protections.length > 0) body.append(section(heading('What protects the list'), list(c.protections)));
  body.append(section(heading('Appeals'), h('p', null, c.appeal)));
}

export function initCriteria(): void {
  const body = req('#sl-criteria-body');

  function showFailure(err: unknown): void {
    const retry = h('button', { type: 'button', class: 'btn btn-quiet sl-link' }, 'Try again');
    retry.addEventListener('click', () => void load());
    body.replaceChildren(h('p', null, `The criteria did not load. ${describeError(err)}`), retry);
  }

  async function load(): Promise<void> {
    body.setAttribute('aria-busy', 'true');
    try {
      render(body, parseCriteria(await request('/api/v1/criteria', { cache: 'default' })));
    } catch (err) {
      showFailure(err);
    } finally {
      body.removeAttribute('aria-busy');
    }
  }

  void load();
}
