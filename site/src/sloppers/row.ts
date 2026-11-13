// One entry of the thread, laid out like a reply on X: who it is, one line of facts, a round button that opens the record.
// The record opens under it as a list of labels and values.
// Values reach the DOM only as text nodes or attribute values, through h().

import { h } from '../lib/dom.ts';
import { formatCount, formatDay } from '../lib/format.ts';
import { profileUrl } from '../lib/handle.ts';
import type { Slopper } from '../lib/schema.ts';
import { lineFacts, neededText, networksText, originStory, sourceName, votesText } from './copy.ts';

const FACE_PX = 40;
const MAX_NETWORK_PIPS = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';
const NBSP = ' ';

export const STAMP: Record<Slopper['status'], string> = { confirmed: 'Confirmed', flagged: 'Flagged' };
/** The status word on the line of a row. A confirmed account reads as a Slopper, next to the pulsing mark. */
const ROW_STAMP: Record<Slopper['status'], string> = { confirmed: 'Slopper', flagged: 'Flagged' };

const appealUrl = (handle: string): string => `/check?appeal=${encodeURIComponent(handle)}`;

/** The default picture of X, a head and shoulders: for an account with no photo, or a photo that did not load. */
export function noPhoto(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sl-nophoto');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '9');
  head.setAttribute('r', '4.2');
  const shoulders = document.createElementNS(SVG_NS, 'path');
  shoulders.setAttribute('d', 'M3.5 24c0-5.2 3.8-8.3 8.5-8.3s8.5 3.1 8.5 8.3z');
  svg.append(head, shoulders);
  return svg;
}

function svgPart(name: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** The brown pile in front of "Slopper". The style sheet gives it a slow, soft pulse. */
function poopMark(): SVGSVGElement {
  const svg = svgPart('svg', { class: 'sl-poop', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }) as SVGSVGElement;
  svg.append(
    svgPart('path', {
      class: 'sl-poop-body',
      d: 'M12 1.5c.9 1.4 3.6 2.2 3.6 4.6 0 .5-.1.9-.3 1.3A3 3 0 0 1 17.6 10a3 3 0 0 1-.4 1.5 3.4 3.4 0 0 1 2.5 3.3c0 .5-.1.9-.3 1.3A3.2 3.2 0 0 1 22 19.2 2.8 2.8 0 0 1 19.2 22H4.8A2.8 2.8 0 0 1 2 19.2a3.2 3.2 0 0 1 2.6-3.1 3.4 3.4 0 0 1-.3-1.3 3.4 3.4 0 0 1 2.5-3.3A3 3 0 0 1 6.4 10a3 3 0 0 1 2.3-2.6 3 3 0 0 1-.3-1.3C8.4 3.6 11.3 3.5 12 1.5z',
    }),
    svgPart('path', { class: 'sl-poop-fold', d: 'M8.2 11.4c2.4.8 5.2.8 7.6 0M6 16.2c3.9 1.1 8.1 1.1 12 0' }),
  );
  return svg;
}

function photo(s: Slopper, eager: boolean): Element {
  if (s.avatar === null) return noPhoto();
  return h('img', { class: 'sl-photo', src: s.avatar, alt: '', width: FACE_PX, height: FACE_PX, decoding: 'async', loading: eager ? null : 'lazy' });
}

function profileLink(s: Slopper, className: string, ...children: (Node | string | null)[]): HTMLAnchorElement {
  return h('a', { class: className, href: profileUrl(s.handle), target: '_blank', rel: 'noopener noreferrer' }, ...children);
}

/** Status, score, then the facts that carry information. The style sheet draws a dot between two facts on one line. */
function factsLine(s: Slopper): HTMLElement {
  const facts: (Node | string)[] = [
    h('span', { class: 'sl-status', 'data-status': s.status }, s.status === 'confirmed' ? poopMark() : null, ROW_STAMP[s.status]),
    h('span', { class: 'sl-score' }, `Score${NBSP}`, h('b', null, String(Math.round(s.score)))),
    ...lineFacts(s),
  ];
  // The space between two facts shows nowhere on screen; it keeps the words apart for a reader that takes the text alone.
  return h('p', { class: 'sl-facts' }, ...facts.flatMap((fact, i) => [i > 0 && ' ', h('span', { class: 'sl-fact' }, fact)]));
}

export function renderRow(s: Slopper, eager: boolean): HTMLLIElement {
  const panelId = `sl-panel-${s.handle}`;
  return h(
    'li',
    { class: 'sl-slop', 'data-handle': s.handle },
    h(
      'div',
      { class: 'sl-row' },
      h('span', { class: 'sl-face' }, photo(s, eager)),
      h(
        'div',
        { class: 'sl-body' },
        h('p', { class: 'sl-head' }, profileLink(s, 'sl-who', s.name ? h('bdi', { class: 'sl-name' }, s.name) : null, s.name ? ' ' : null, h('span', { class: 'sl-handle' }, `@${s.handle}`))),
        factsLine(s),
      ),
      // The record opens from one round button at the right end of the line. The appeal link is in the record.
      h(
        'button',
        { type: 'button', class: 'sl-show', title: 'How it got here', 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-label': `How it got here: @${s.handle}` },
        h('span', { class: 'sl-chevron', 'aria-hidden': 'true' }),
      ),
    ),
    h('div', { class: 'sl-panel', id: panelId, role: 'group', 'aria-label': `How @${s.handle} got here`, hidden: true }),
  );
}

function votesBar(s: Slopper): HTMLElement | null {
  const total = s.votes.slop + s.votes.notSlop;
  if (total === 0) return null;
  const fill = h('span', { class: 'sl-votebar-fill' });
  fill.style.transform = `scaleX(${s.votes.slop / total})`;
  return h('span', { class: 'sl-votebar', 'aria-hidden': 'true' }, fill);
}

/** One pip per network toward confirmed. The sentence next to it carries the exact count. */
function networkPips(s: Slopper): HTMLElement | null {
  const slots = s.networks + s.needed;
  if (slots > MAX_NETWORK_PIPS) return null;
  const pips = h('span', { class: 'sl-pips', 'aria-hidden': 'true' });
  for (let i = 0; i < slots; i++) pips.append(h('span', { class: i < s.networks ? 'sl-pip is-on' : 'sl-pip' }));
  return pips;
}

type Value = Node | string | null;

/** One label and its value. A value with no content gives no line. */
function fact(label: string, ...value: Value[]): Node[] {
  const content = value.filter((part) => part !== null);
  return content.length === 0 ? [] : [h('dt', null, label), h('dd', null, ...content)];
}

/** One number tile: the value large, the label under it. A value of null gives no tile. */
function stat(label: string, value: Value): Node[] {
  return value === null ? [] : [h('div', { class: 'sl-stat' }, h('dt', null, label), h('dd', null, value))];
}

const note = (text: string | null, className = 'sl-aside'): HTMLElement | null => (text === null ? null : h('span', { class: className }, text));

/** The record behind the line, as one card: source and date, the story, the numbers, the votes, then the links. Built on first open, so a closed row stays light. */
export function panelContent(s: Slopper): Node[] {
  const needed = neededText(s);
  return [
    h(
      'div',
      { class: 'sl-card' },
      h(
        'div',
        { class: 'sl-card-head' },
        h('p', { class: 'sl-card-source' }, h('span', { class: 'sl-card-label' }, 'Source'), ' ', h('strong', null, sourceName(s))),
        s.listedAt === null ? null : h('time', { class: 'sl-card-date', datetime: s.listedAt }, `Listed ${formatDay(s.listedAt)}`),
      ),
      h('p', { class: 'sl-card-story' }, originStory(s)),
      h(
        'dl',
        { class: 'sl-stats' },
        ...stat('Score', h('span', null, String(Math.round(s.score)), h('small', null, ' of 100'))),
        ...stat('Status', h('span', { class: 'sl-stat-status', 'data-status': s.status }, STAMP[s.status])),
        ...stat('Followers', s.followers === null ? null : formatCount(s.followers)),
      ),
      h(
        'dl',
        { class: 'sl-record' },
        ...fact('Votes', votesText(s), votesBar(s)),
        ...fact('Networks', networksText(s), note(needed, 'sl-needed'), needed ? networkPips(s) : null),
      ),
      h(
        'div',
        { class: 'sl-card-foot' },
        profileLink(s, 'sl-record-link', `Open @${s.handle} on X`),
        s.xUserId === null ? null : h('span', { class: 'sl-xid' }, `X id ${s.xUserId}`),
        h('a', { class: 'sl-card-appeal', href: appealUrl(s.handle), title: 'Is this account yours? A person reads every appeal.', 'aria-label': `Appeal this listing of @${s.handle}` }, 'Appeal'),
      ),
    ),
  ];
}
