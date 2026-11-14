// #activity (SPEC 14.2, 14.3): the feed of every recorded change, grouped by day, with kind and subject filters and
// "Show older" by cursor. The filter lives in the hash.

import { h } from '../../lib/dom.ts';
import { normalizeHandle } from '../../lib/handle.ts';
import { appendByDay, KIND_LABEL } from '../feed.ts';
import { ACTIVITY_KINDS, readActivity, type ActivityKind } from '../model.ts';
import { obj, str } from '../rows.ts';
import { activityHash, UUID_RE } from '../route.ts';
import { api } from '../session.ts';
import { fail, note, say } from '../ui.ts';
import { head, type Ctx } from '../view.ts';

const KIND_HINT: Record<ActivityKind, string> = {
  admin: 'your decisions and logins',
  status: 'status changes by the score job',
  identity: 'identity checks by the X facts job',
  standing: 'installs that gained or lost standing',
  list: 'new list versions',
  appeal: 'appeals that arrived',
  run: 'failed job runs',
  vote: 'every vote (many)',
  install: 'every new install (many)',
};

const CURSOR = /^[A-Za-z0-9_.:-]{1,120}$/;

function url(kinds: readonly ActivityKind[], subject: string | null, cursor: string | null): string {
  const p = new URLSearchParams({ kinds: kinds.join(',') });
  if (subject) p.set('subject', subject);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', '50');
  return `/api/admin/activity?${p}`;
}

export async function activity(route: { kinds: ActivityKind[]; subject: string | null }, ctx: Ctx): Promise<Node[]> {
  const { kinds, subject } = route;
  const body = obj(await api(url(kinds, subject, null), { signal: ctx.signal }));
  const items = readActivity(body.items);
  let next = str(body, 'next');

  const boxes = ACTIVITY_KINDS.map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'kind', value: k, checked: kinds.includes(k) }), h('span', { class: 'box', 'aria-hidden': 'true' }), ` ${KIND_LABEL[k] === 'You' ? 'Your actions' : KIND_LABEL[k]}`, h('span', { class: 'check-hint' }, KIND_HINT[k])));
  const subjectInput = h('input', { id: 'activity-subject', name: 'subject', type: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 36, placeholder: 'handle or install id…', value: subject ?? '', 'data-filter': '' });
  const form = h(
    'form',
    { class: 'activity-filter', id: 'activity-filter' },
    h('fieldset', { class: 'kinds' }, h('legend', null, 'Show'), ...boxes),
    h('div', { class: 'filters' }, h('label', { for: 'activity-subject' }, 'Only for'), subjectInput, h('button', { type: 'submit', class: 'btn btn-quiet btn-small' }, 'Apply')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = [...form.querySelectorAll<HTMLInputElement>('input[name="kind"]:checked')].map((i) => i.value as ActivityKind);
    if (chosen.length === 0) {
      say('Choose at least one kind of activity.', 'error');
      return;
    }
    const raw = subjectInput.value.trim().toLowerCase();
    const who = raw === '' ? null : UUID_RE.test(raw) ? raw : normalizeHandle(raw);
    if (who === null && raw !== '') {
      say('Type a handle of 1 to 15 letters, digits or underscores, or a full install id.', 'error');
      subjectInput.setAttribute('aria-invalid', 'true');
      return;
    }
    const hash = activityHash(chosen, who);
    if (location.hash === hash) ctx.reload();
    else location.hash = hash;
  });

  const days = h('div', { class: 'days', id: 'activity-feed' });
  appendByDay(days, items);
  const more = h('button', { type: 'button', class: 'btn btn-quiet', id: 'activity-more' }, 'Show older');
  const end = h('p', { class: 'note', id: 'activity-end' });
  const showEnd = (): void => {
    more.hidden = !next;
    end.textContent = next ? '' : items.length === 0 ? '' : 'This is the oldest recorded item for this filter.';
  };
  more.addEventListener('click', async () => {
    if (!next || !CURSOR.test(next)) return;
    more.disabled = true;
    more.setAttribute('aria-busy', 'true');
    try {
      const page = obj(await api(url(kinds, subject, next), { signal: ctx.signal }));
      const older = readActivity(page.items);
      items.push(...older);
      appendByDay(days, older);
      next = str(page, 'next');
      showEnd();
    } catch (err) {
      fail(err);
    } finally {
      more.disabled = false;
      more.removeAttribute('aria-busy');
    }
  });
  showEnd();

  const what = `${kinds.map((k) => KIND_HINT[k]).join(', ')}${subject ? `, only for ${UUID_RE.test(subject) ? `install ${subject.slice(0, 8)}` : `@${subject}`}` : ''}`;
  return [
    head('Activity', 'Everything that the server recorded, newest first.'),
    form,
    note(`Showing ${what}.`),
    items.length === 0 ? h('p', { class: 'empty-state' }, subject ? `Nothing recorded for this filter. Try more kinds, or remove the subject.` : 'Nothing recorded for these kinds yet.') : days,
    h('div', { class: 'more-row' }, more, end),
  ];
}
