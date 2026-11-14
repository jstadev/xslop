// #help (SPEC 14.3): how an account gets on the list in short, then every word of the console with its definition.

import { h } from '../../lib/dom.ts';
import { formatCount, formatPercent } from '../../lib/format.ts';
import { GLOSSARY, type Term, type TermKey } from '../glossary.ts';
import { overview, session } from '../session.ts';
import { block, note } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

const GROUPS: Term['group'][] = ['Statuses', 'Gates', 'Votes and voters', 'Accounts', 'System'];

function flow(): Node {
  const r = session.rules;
  const c = (k: keyof NonNullable<typeof r>): string => (r ? formatCount(r[k]) : 'enough');
  const steps = [
    'A user clicks the xslop button on a post. The extension hides and mutes the account for that user at once, and sends one vote.',
    'The X facts job checks the handle on X and the post that the vote names.',
    `The score job counts the votes. Flagged needs ${c('flagMinNetworks')} slop networks${r ? ` and a cautious share of ${formatPercent(r.flagShareBound)}` : ''}, ${c('anchorsFlag')} anchor and a checked post from ${c('evidenceFlag')} network. Confirmed needs ${c('confirmMinNetworks')} slop networks${r ? `, a share of ${formatPercent(r.confirmShareBound)}` : ''}, ${c('anchorsConfirm')} anchors and checked posts from ${c('evidenceConfirm')} networks.`,
    'When the votes pass but a check is missing, the account is pending and waits for you in the review queue.',
    'The server publishes a new list version. Extensions fetch it and hide the account; mute sync mutes it by X id.',
    'Ways out: not slop votes with standing, an accepted appeal, your clear, or a handle that moved to another X account.',
  ];
  return h('ol', { class: 'flow' }, ...steps.map((s) => h('li', null, s)));
}

export async function help(route: { term: TermKey | null }, ctx: Ctx): Promise<Node[]> {
  await overview(ctx.signal).catch(() => null);
  const rules = session.rules;
  const entries = Object.entries(GLOSSARY) as [TermKey, Term][];
  const nodes = [
    head('Help', 'How an account gets on the list, and what each word of this console means.'),
    rules ? null : note('The server sent no rule numbers, so the definitions name no number.'),
    block('How an account gets on the list', flow()),
    ...GROUPS.map((group) =>
      block(
        group,
        h(
          'dl',
          { class: 'glossary' },
          ...entries.filter(([, t]) => t.group === group).map(([key, t]) => h('div', { id: `term-${key}`, class: 'gloss', 'data-current': route.term === key ? 'true' : null }, h('dt', null, t.word), h('dd', null, t.def(rules)))),
        ),
      ),
    ),
  ].filter((n): n is HTMLElement => n !== null);
  if (route.term) {
    const key = route.term;
    queueMicrotask(() => requestAnimationFrame(() => document.getElementById(`term-${key}`)?.scrollIntoView({ block: 'center' })));
  }
  return nodes;
}
