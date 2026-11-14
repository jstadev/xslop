// #jobs (SPEC 14.2, 14.3): the runs of the score job and the X facts job: time, duration, result and the main numbers.

import { h } from '../../lib/dom.ts';
import { formatCount } from '../../lib/format.ts';
import { plural, seconds } from '../explain.ts';
import type { TermKey } from '../glossary.ts';
import { num, obj, rows, str, type Row } from '../rows.ts';
import { api } from '../session.ts';
import { block, note, table, time } from '../ui.ts';
import { head, type Ctx } from '../view.ts';
import { healthLine } from './home.ts';

type Job = 'score' | 'profiles';

/** The main numbers of a run, from `detail` (the same object as jobs.detail). */
export function runNumbers(job: Job, detail: Row): string {
  const n = (k: string): number => num(detail, k) ?? 0;
  if (job === 'score') {
    const parts = [
      `${plural(n('accounts'), 'account')} scored`,
      `${formatCount(n('accountsChanged'))} changed`,
      `${formatCount(n('listed'))} listed`,
      detail.listChanged === true ? `new list version ${formatCount(n('version'))}` : 'list unchanged',
      `${formatCount(n('pending'))} pending`,
      `${plural(n('standingInstalls'), 'install')} with standing`,
    ];
    if (n('struckNetworks')) parts.push(`${plural(n('struckNetworks'), 'network')} silenced by strikes`);
    if (n('votesHeld')) parts.push(`${plural(n('votesHeld'), 'vote')} past the daily budget`);
    return `${parts.join(', ')}.`;
  }
  const parts = [`${plural(n('picked'), 'account')} picked`, `${plural(n('requests'), 'request')}`, `${formatCount(n('ok'))} found`, `${formatCount(n('missing'))} missing`, `${formatCount(n('failed'))} failed`, `${plural(n('evidence'), 'post')} checked`, `${plural(n('verified'), 'reply', 'replies')} checked`];
  if (n('renamed')) parts.push(`${plural(n('renamed'), 'rename')}`);
  if (str(detail, 'stopped')) parts.push(`stopped early (${str(detail, 'stopped')})`);
  return `${parts.join(', ')}.`;
}

const JOBS: { job: Job; name: string; term: TermKey; stale: number; what: string }[] = [
  { job: 'score', name: 'score job', term: 'score-job', stale: 15, what: 'Counts the votes, sets each status and standing, and publishes the list.' },
  { job: 'profiles', name: 'X facts job', term: 'facts-job', stale: 10, what: 'Checks handles, X ids, the posts that votes name, and reply timing on X.' },
];

export async function jobs(_route: unknown, ctx: Ctx): Promise<Node[]> {
  const answers = await Promise.all(JOBS.map((j) => api(`/api/admin/jobs?job=${j.job}&limit=50`, { signal: ctx.signal })));
  return [
    head('Jobs', 'The two background jobs, run by run. A failed run shows its error.'),
    ...JOBS.map((j, i) => {
      const body = obj(answers[i]);
      const runs = rows(body.runs);
      const failed = runs.filter((r) => r.ok !== true).length;
      return block(
        j.name === 'score job' ? 'Score job' : 'X facts job',
        h('p', { class: 'lede' }, j.what),
        healthLine(j.name, j.term, obj(body.last), j.stale),
        note(`The newest ${plural(runs.length, 'run')}, ${formatCount(failed)} failed. A run that found its lock held is not recorded.`),
        table(
          `Runs of the ${j.name}`,
          [
            { label: 'Started', cell: (r: Row) => time(str(r, 'startedAt')) },
            { label: 'Duration', className: 'num', cell: (r) => (num(r, 'ms') === null ? 'not known' : seconds(num(r, 'ms') ?? 0)) },
            { label: 'Result', cell: (r) => h('span', { class: 'result', 'data-ok': r.ok === true ? 'true' : 'false' }, r.ok === true ? 'succeeded' : 'failed') },
            { label: 'What it did', className: 'wide', cell: (r) => (r.ok === true ? runNumbers(j.job, obj(r.detail)) : h('span', { class: 'error-text' }, str(obj(r.detail), 'error') || 'No error text was recorded.')) },
          ],
          runs,
          `No run of the ${j.name} is recorded in the last 30 days.`,
          `jobs-${j.job}`,
        ),
      );
    }),
  ];
}
