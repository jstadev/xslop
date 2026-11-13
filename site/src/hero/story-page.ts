// The DOM half of the scroll story: the bridge steps, the verdict on the account, the real accounts going down the drain, the last line.

import { req } from '../lib/dom.ts';
import { pageEnding, storyState, type StoryLayout } from './story.ts';

const STEP_THRESHOLDS = [0.1, 0.46, 0.86] as const;
const GOLDEN_ANGLE = 2.399963;
/** Share of the drain in which the accounts fade in before the first one starts to fall. */
const DRAIN_APPEAR = 0.08;
const RING_FILL_X = 0.42;
const RING_FILL_Y = 0.22;
const RING_MIN_Y = 0.12;
const RING_CLEARANCE_PX = 12;
/** Below this an account cannot be seen, so it also leaves the tab order and the accessibility tree. */
const SEEN_FROM_OPACITY = 0.01;

/** Which caption the bridge shows for this progress: 0 the two camps, 1 one side, 2 the other side, 3 the bridge. */
export function bridgeStep(progress: number): number {
  return STEP_THRESHOLDS.filter((threshold) => progress >= threshold).length;
}

export interface DrainPlacement {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Where one account sits at this drain progress: on a ring around the mark first, then spiralling into its centre. */
export function drainPlacement(index: number, count: number, progress: number, radiusX: number, radiusY: number): DrainPlacement {
  const start = DRAIN_APPEAR + (index / Math.max(1, count)) * 0.5;
  const pulled = smooth(clamp01((progress - start) / 0.4));
  const angle = index * GOLDEN_ANGLE + pulled * pulled * 5;
  const reach = 1 - pulled;
  return {
    x: Math.cos(angle) * radiusX * reach,
    y: Math.sin(angle) * radiusY * reach,
    scale: 1 - pulled * 0.8,
    opacity: smooth(clamp01(progress / DRAIN_APPEAR)) * (1 - smooth(clamp01((pulled - 0.72) / 0.28))),
  };
}

function placeAccounts(list: HTMLElement, copy: HTMLElement, progress: number): void {
  const items = [...list.children] as HTMLElement[];
  const box = list.getBoundingClientRect();
  const roomAbove = box.top + box.height / 2 - copy.getBoundingClientRect().bottom - RING_CLEARANCE_PX;
  items.forEach((item, index) => {
    const focused = item.contains(document.activeElement);
    const radiusX = box.width * RING_FILL_X - item.offsetWidth / 2;
    const radiusY = Math.max(box.height * RING_MIN_Y, Math.min(box.height * RING_FILL_Y, roomAbove - item.offsetHeight / 2));
    const placed = drainPlacement(index, items.length, focused ? DRAIN_APPEAR : progress, radiusX, radiusY);
    item.style.transform = `translate3d(${placed.x.toFixed(1)}px, ${placed.y.toFixed(1)}px, 0) scale(${placed.scale.toFixed(3)})`;
    item.style.opacity = placed.opacity.toFixed(3);
    item.style.visibility = placed.opacity < SEEN_FROM_OPACITY ? 'hidden' : 'visible';
  });
}

export function startStoryPage(layout: () => StoryLayout): void {
  const steps = [...document.querySelectorAll<HTMLElement>('[data-step-text]')];
  const account = req('#bridge-account');
  const accountState = req('.bridge-account-state', account);
  const accounts = req('#drain-accounts');
  const drainCopy = req('.drain-copy');
  const statement = req('#end-statement');
  let frame = 0;
  let shownStep = -1;
  let current = layout();

  function showStep(step: number): void {
    if (step === shownStep) return;
    shownStep = step;
    steps.forEach((el, index) => el.classList.toggle('is-active', index === step));
    account.dataset.confirmed = String(step === 3);
    accountState.textContent = step === 3 ? 'Confirmed' : 'Not on the list';
  }

  function update(): void {
    frame = 0;
    const state = storyState(window.scrollY, current);
    showStep(bridgeStep(state.bridge));
    if (!accounts.hidden) placeAccounts(accounts, drainCopy, state.drain);
    drainCopy.style.opacity = (1 - smooth(clamp01((state.drain - 0.42) / 0.2))).toFixed(3);
    // The last line shows at the end of the page, where the screen is inside the mark.
    statement.style.opacity = pageEnding(document.documentElement.scrollHeight - window.innerHeight - window.scrollY, current.vh).toFixed(3);
  }

  const request = (): void => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  const remeasure = (): void => {
    current = layout();
    request();
  };

  new ResizeObserver(remeasure).observe(req('main'));
  window.addEventListener('scroll', request, { passive: true });
  document.addEventListener('focusin', request);
  document.addEventListener('xslop:accounts', request);
  request();
}
