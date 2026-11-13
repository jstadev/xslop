// The X column under the hero: one post and its replies. Each reply has the xslop x. The switch folds the template replies.
// Folding moves rows with transforms only (FLIP through the Web Animations API).
// Without JS the switches stay hidden and every reply stays readable.
// While the hero is on screen the switch flips by itself every 4 seconds, until the visitor presses a key or a pointer.
// When the middle of the screen reaches the thread, xslop turns on by itself, unless the visitor already used a switch.

import { h, markIcon, req } from '../lib/dom.ts';
import { xslop } from './state.ts';

const DEMO_MS = 4000;
const MOVE_MS = 360;
const FADE_MS = 220;
const STAGGER_MS = 24;
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

interface Row {
  li: HTMLLIElement;
  card: HTMLElement;
  handle: string;
  slop: boolean;
  /** Hidden by a click on this row's x, independent of the global switch. */
  hiddenByYou: boolean;
  revealed: boolean;
  bar: HTMLElement;
  barLabel: HTMLElement;
  show: HTMLButtonElement;
  undo: HTMLButtonElement;
  x: HTMLButtonElement;
}

function createRow(li: HTMLLIElement): Row {
  const handle = li.dataset.handle ?? '';
  const card = req('.rcard', li);
  const x = h('button', { type: 'button', class: 'xbtn', 'aria-label': `Mark @${handle} as slop`, title: 'Mark as slop' });
  x.append(markIcon());
  card.append(x);

  const barLabel = h('span', { class: 'bar-label' });
  const show = h('button', { type: 'button', class: 'btn-text', 'aria-expanded': 'false' }, 'Show');
  const undo = h('button', { type: 'button', class: 'btn-text', 'data-role': 'undo' }, 'Undo');
  const actions = h('span', { class: 'bar-actions' }, show, h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), undo);
  const bar = h('div', { class: 'hidden-bar' }, barLabel, actions);
  bar.prepend(markIcon());
  bar.hidden = true;
  li.prepend(bar);
  return { li, card, handle, slop: li.dataset.slop !== undefined, hiddenByYou: false, revealed: false, bar, barLabel, show, undo, x };
}

/** Flips the page switch while the hero is on screen, but not while the screen middle is in the thread. A real key or pointer press ends it for good. */
function startDemo(hero: Element, paused: () => boolean): void {
  let timer = 0;
  const onScreen = new IntersectionObserver(([entry]) => {
    window.clearInterval(timer);
    timer = entry?.isIntersecting
      ? window.setInterval(() => {
          if (!paused()) xslop.set(!xslop.on);
        }, DEMO_MS)
      : 0;
  });
  const takeOver = (event: Event): void => {
    if (!event.isTrusted) return;
    onScreen.disconnect();
    window.clearInterval(timer);
    document.removeEventListener('pointerdown', takeOver, true);
    document.removeEventListener('keydown', takeOver, true);
  };
  onScreen.observe(hero);
  document.addEventListener('pointerdown', takeOver, true);
  document.addEventListener('keydown', takeOver, true);
}

/** True while the middle of the screen is inside the section. The root is shrunk to a line at the screen middle. */
function watchScreenMiddle(section: Element, changed: (inside: boolean) => void): void {
  new IntersectionObserver(([entry]) => changed(entry?.isIntersecting === true), { rootMargin: '-50% 0px -50% 0px' }).observe(section);
}

export function initThread(): void {
  const section = req('#thread');
  const control = req('#thread-control', section);
  const status = req('#thread-status', section);
  const list = req('#thread-replies', section);
  const more = req('#thread-more', section);
  const moreText = req('#thread-more-text', more);
  const moreMark = req<SVGSVGElement>('.column-more-mark', more);
  const moreFaces = req('.column-more-faces', more);
  const switches = [req<HTMLButtonElement>('#hero-switch'), req<HTMLButtonElement>('#thread-switch', section)];

  const rows = [...list.querySelectorAll<HTMLLIElement>('li.reply')].map(createRow);
  const moreCount = Number(more.dataset.count ?? 0);
  const moving: Element[] = [...list.children, more];

  function isFolded(row: Row): boolean {
    return row.hiddenByYou || (row.slop && xslop.on);
  }

  function renderRow(row: Row): void {
    const folded = isFolded(row);
    row.card.hidden = folded && !row.revealed;
    row.bar.hidden = !folded;
    row.barLabel.replaceChildren('Hidden reply from ', h('strong', null, `@${row.handle}`));
    row.show.textContent = row.revealed ? 'Hide' : 'Show';
    row.show.setAttribute('aria-expanded', String(row.revealed));
    row.undo.textContent = row.hiddenByYou ? 'Undo' : 'Not slop';
  }

  function render(): void {
    for (const row of rows) renderRow(row);
    for (const button of switches) {
      button.setAttribute('aria-checked', String(xslop.on));
      req('.xs-switch-state', button).textContent = xslop.on ? 'On' : 'Off';
    }
    document.documentElement.classList.toggle('is-clean', xslop.on);
    moreMark.toggleAttribute('hidden', !xslop.on);
    moreFaces.hidden = xslop.on;
    moreText.textContent = xslop.on ? `${moreCount} more template replies, hidden` : `+ ${moreCount} more template replies`;
    const template = rows.filter((row) => row.slop).length + moreCount;
    const people = rows.filter((row) => !row.slop).length;
    status.textContent = xslop.on
      ? `xslop is on. ${template} template replies fold to one line each. The ${people} replies from people stay open.`
      : 'xslop is off. Turn it on to fold the template replies.';
  }

  /** Measures where each row is, applies the change, then plays each row from its old place. */
  function animated(change: () => void): void {
    const before = moving.map((el) => el.getBoundingClientRect().top);
    const foldParts = rows.flatMap((row) => [row.card, row.bar]);
    for (const el of [...moving, ...foldParts]) for (const a of el.getAnimations()) a.cancel();
    const wasShown = new Set(foldParts.filter((el) => !el.hidden));
    change();
    moving.forEach((el, i) => {
      const dy = (before[i] ?? 0) - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, delay: i * STAGGER_MS, easing: EASE_IN_OUT, fill: 'backwards' });
      }
    });
    foldParts.forEach((el, i) => {
      if (!el.hidden && !wasShown.has(el)) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay: i * (STAGGER_MS / 2), easing: EASE_OUT, fill: 'backwards' });
    });
  }

  let chosen = false;
  let middleInThread = false;
  for (const button of switches) {
    button.addEventListener('click', (event) => {
      if (event.isTrusted) chosen = true;
      xslop.set(!xslop.on);
    });
  }
  watchScreenMiddle(section, (inside) => {
    middleInThread = inside;
    if (inside && !chosen) xslop.set(true);
  });

  xslop.subscribe(() => {
    for (const row of rows) row.revealed = false;
    animated(render);
  });

  for (const row of rows) {
    row.x.addEventListener('click', () => {
      animated(() => {
        row.hiddenByYou = true;
        row.revealed = false;
        renderRow(row);
      });
      document.dispatchEvent(new CustomEvent('xslop:hit', { detail: row.handle }));
      status.textContent = `Hidden: @${row.handle}`;
      row.undo.focus();
    });
    row.show.addEventListener('click', () => {
      animated(() => {
        row.revealed = !row.revealed;
        renderRow(row);
      });
    });
    row.undo.addEventListener('click', () => {
      animated(() => {
        row.hiddenByYou = false;
        row.revealed = false;
        if (row.slop) row.li.removeAttribute('data-slop');
        row.slop = false;
        renderRow(row);
      });
      status.textContent = `Shown again: @${row.handle}`;
      row.x.focus();
    });
  }

  render();
  control.hidden = false;
  for (const button of switches) button.hidden = false;
  startDemo(req('#flood'), () => middleInThread);
}
