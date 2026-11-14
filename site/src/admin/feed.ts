// The activity items of SPEC 14.2 as one plain sentence each, grouped by local day. An admin item shows its changed fields
// and keeps the raw state behind a toggle.

import { h } from '../lib/dom.ts';
import { activityDetail, activitySentence, changedFields } from './explain.ts';
import type { Activity, ActivityKind } from './model.ts';
import { sentence, time } from './ui.ts';

export const KIND_LABEL: Record<ActivityKind, string> = {
  admin: 'You',
  status: 'Status',
  identity: 'Identity',
  standing: 'Standing',
  list: 'List',
  appeal: 'Appeal',
  run: 'Job failed',
  vote: 'Vote',
  install: 'New install',
};

function item(a: Activity): HTMLElement {
  const li = h('li', { class: 'act', 'data-kind': a.kind, 'data-key': a.key }, h('span', { class: 'act-time' }, time(a.at)), h('span', { class: 'act-kind' }, KIND_LABEL[a.kind]));
  const body = h('div', { class: 'act-body' }, sentence(activitySentence(a), 'act-text'));
  const detail = activityDetail(a);
  if (detail) body.append(h('p', { class: 'act-detail' }, detail));
  if (a.kind === 'admin') {
    const changes = changedFields(a.data.before, a.data.after);
    if (changes.length) {
      body.append(
        h(
          'dl',
          { class: 'changes' },
          ...changes.map((c) => h('div', null, h('dt', null, c.field), h('dd', null, h('span', { class: 'was' }, c.before), h('span', { class: 'arrow', role: 'img', 'aria-label': 'changed to' }, ' → '), h('span', { class: 'now' }, c.after)))),
        ),
      );
    }
    const before = a.data.before ?? null;
    const after = a.data.after ?? null;
    if (before !== null || after !== null) body.append(h('details', { class: 'raw' }, h('summary', null, 'Raw state'), h('pre', null, JSON.stringify({ before, after }, null, 2))));
  }
  li.append(body);
  return li;
}

/** A flat list, newest first (the home page and the timelines). */
export function feed(items: Activity[], empty: string): HTMLElement {
  if (items.length === 0) return h('p', { class: 'empty-state' }, empty);
  return h('ol', { class: 'feed' }, ...items.map(item));
}

const dayKey = (iso: string): string => new Date(iso).toDateString();
const dayFormat = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

export function dayLabel(iso: string, now = new Date()): string {
  const key = dayKey(iso);
  if (key === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === yesterday.toDateString()) return 'Yesterday';
  return dayFormat.format(new Date(iso));
}

/** Appends items to a feed grouped by day; a day that continues from the page before keeps its heading. */
export function appendByDay(root: HTMLElement, items: Activity[]): void {
  for (const a of items) {
    const key = dayKey(a.at);
    let list = root.lastElementChild?.getAttribute('data-day') === key ? root.lastElementChild.querySelector('ol') : null;
    if (!list) {
      list = h('ol', { class: 'feed' });
      root.append(h('section', { class: 'day', 'data-day': key }, h('h2', { class: 'day-title' }, dayLabel(a.at)), list));
    }
    list.append(item(a));
  }
}
