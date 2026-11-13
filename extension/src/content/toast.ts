// The one toast xslop shows: what happened to your last click on X, with Undo. Its own shadow root.
import { makeHost, shown, trusted } from './ui';

const VISIBLE_MS = 6000;
/** Height of the band at the top and bottom of the screen that the toast may take. */
const BAND_PX = 120;
/** X's post, reply and message composers. A toast never covers one. */
const COMPOSERS = '[data-testid^="tweetTextarea_"], [data-testid="dmComposerTextInput"]';

// The host keeps a size while the toast is closed, so it takes no pointer events: it must not catch a click meant for X.
const CSS = `
:host { all: initial; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483000; pointer-events: none;
  font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
:host([data-place="top"]) { top: 12px; bottom: auto; }
:host([data-place="none"]) { opacity: 0; }
.toast { display: flex; align-items: center; gap: 12px; box-sizing: border-box; max-width: min(480px, calc(100vw - 24px));
  padding: 10px 14px; border-radius: 4px; background: #3368fe; color: #fff; font-size: 14px; line-height: 20px; font-weight: 600;
  opacity: 0; transform: translateY(8px); transition: opacity .15s, transform .15s; }
.toast[data-open] { opacity: 1; pointer-events: auto; transform: none; }
:host([data-place="none"]) .toast { pointer-events: none; }
button { font: inherit; color: #fff; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; text-decoration: underline; }
button[hidden] { display: none; }
button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 2px; }
@media (max-width: 700px) {
  :host { left: 12px; bottom: calc(64px + env(safe-area-inset-bottom)); transform: none; max-width: calc(100vw - 96px); }
  button { min-width: 44px; min-height: 44px; padding: 0 4px; }
}
@media (prefers-reduced-motion: reduce) { .toast { transition: none; transform: none; } }
`;

interface View {
  host: HTMLElement;
  box: HTMLElement;
  text: HTMLElement;
  undo: HTMLButtonElement;
}

let view: View | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let onUndo: (() => void) | null = null;

function build(): View {
  const { el: host, root } = makeHost('div', 'xslop-toast', CSS);
  const box = document.createElement('div');
  box.className = 'toast';
  box.setAttribute('role', 'status');
  const text = document.createElement('span');
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.addEventListener('click', trusted(() => {
    if (!onUndo || !shown(undo)) return;
    const run = onUndo;
    hideToast();
    run();
  }));
  box.append(text, undo);
  root.append(box);
  // A composer can open while the toast is up.
  document.addEventListener('focusin', () => {
    if (view?.box.hasAttribute('data-open')) reposition(view);
  });
  return { host, box, text, undo };
}

/** Bottom, then top; none when X's composer takes both bands. */
function place(): 'bottom' | 'top' | 'none' {
  const rects = [...document.querySelectorAll(COMPOSERS)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
  const free = (from: number, to: number): boolean => !rects.some((r) => r.bottom > from && r.top < to);
  if (free(innerHeight - BAND_PX, innerHeight)) return 'bottom';
  return free(0, BAND_PX) ? 'top' : 'none';
}

/** With no free band the toast is invisible but stays in the accessibility tree: the message is still read out. Undo is then not offered. */
function reposition(v: View): void {
  const where = place();
  v.host.dataset.place = where;
  v.undo.hidden = !onUndo || where === 'none';
}

function mounted(): View {
  view ??= build();
  if (!view.host.isConnected) document.body.append(view.host);
  return view;
}

/** Call once at start: a screen reader announces a live region only when its text changes after the region exists. */
export function mountToast(): void {
  mounted();
}

export function hideToast(): void {
  clearTimeout(timer);
  onUndo = null;
  if (!view) return;
  view.box.removeAttribute('data-open');
  view.undo.hidden = true;
  view.text.textContent = '';
}

/** Show `message`, with an Undo button when `undo` is given, for six seconds. A newer toast replaces it. */
export function showToast(message: string, undo?: () => void): void {
  const v = mounted();
  clearTimeout(timer);
  onUndo = undo ?? null;
  reposition(v);
  v.text.textContent = message;
  v.box.setAttribute('data-open', '');
  timer = setTimeout(hideToast, VISIBLE_MS);
}
