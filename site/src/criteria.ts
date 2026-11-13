// The rules page. The rules come from GET /api/v1/criteria, so every number on the page comes from the scoring code.
// If that call fails, the plain rules in the HTML stay.

import { request } from './lib/api.ts';
import { h, req } from './lib/dom.ts';
import { parseCriteria, type Criteria } from './lib/schema.ts';

function ruleBlock(title: string, ...body: Node[]): HTMLElement {
  return h('div', null, h('dt', { class: 'h3' }, title), h('dd', null, ...body));
}

function bullets(items: string[]): HTMLElement {
  return h('ul', { class: 'rule-list' }, ...items.map((item) => h('li', null, item)));
}

function renderCriteria(root: HTMLElement, criteria: Criteria): void {
  const blocks = criteria.tiers.map((tier) => ruleBlock(tier.title, h('p', null, tier.summary), bullets(tier.rules)));
  if (criteria.weights.length > 0) blocks.push(ruleBlock('Which votes count more', bullets(criteria.weights)));
  if (criteria.protections.length > 0) blocks.push(ruleBlock('What protects the list', bullets(criteria.protections)));
  blocks.push(ruleBlock('Appeals', h('p', null, criteria.appeal)));
  root.replaceChildren(h('dl', { class: 'rules' }, ...blocks));
}

export function initCriteria(): void {
  const root = req('#criteria-body');
  request('/api/v1/criteria')
    .then((body) => renderCriteria(root, parseCriteria(body)))
    .catch(() => {
      // The plain rules in the HTML carry no numbers, so they stay true without the live criteria.
    });
}
