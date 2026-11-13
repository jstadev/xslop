// X's own control as the second path (SPEC 12.3). X may refuse the REST call; its menu on the tweet
// still works. A wrong click here could block or unfollow someone, so every item must pass pickMenuItem.
// The word lists are compiled in: a remote config can never choose which action a click takes.
import type { Selectors } from '../shared/config';
import { caretOf } from './parse';

export type MenuOp = 'create' | 'destroy';

/** Words that name X's Mute item in its own menu, lower case. */
export const MUTE_WORDS: readonly string[] = [
  'mute', 'silenciar', 'masquer', 'stummschalten', 'silenzia', 'σίγαση', 'negeren', 'sessize al', 'игнорировать', 'ミュート', '뮤트',
  '隐藏', '静音', '靜音', '隱藏',
];

/** Words that name X's Unmute item in its own menu, lower case. */
export const UNMUTE_WORDS: readonly string[] = [
  'unmute', 'dejar de silenciar', 'desactivar silencio', 'deixar de silenciar', 'remover silenciamento', 'desfazer silenciamento',
  'desativar silêncio', 'retirar silêncio', 'ne plus masquer', 'réafficher', 'stummschaltung', 'nicht mehr stummschalten', 'riattiva',
  'annulla silenziamento', 'non silenziare', 'κατάργηση σίγασης', 'άρση σίγασης', 'niet meer negeren', 'negeren opheffen', 'negeren ongedaan',
  'sesini aç', 'sessizden çıkar', 'sessize almayı kaldır', 'перестать игнорировать', 'не игнорировать', 'ミュートを解除', 'ミュート解除',
  '뮤트 해제', '뮤트해제', '뮤트 취소', '取消隐藏', '取消静音', '取消靜音', '解除靜音', '的靜音', '取消隱藏',
];

const MENU_WAIT_MS = 2500;
const MENU_CLOSE_MS = 500;
const POLL_MS = 40;

/** The item's text with `@handle` cut out, or null when the item does not name that handle. */
function itemWords(item: Element, handle: string): string | null {
  const text = (item.textContent ?? '').normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '');
  const rest = text.replace(new RegExp(`@${handle}(?![a-z0-9_])`, 'gu'), ' ');
  return rest === text ? null : rest;
}

/**
 * The one item that xslop may click: it names `@handle`, carries a mute word (or an unmute word for
 * destroy) and, for create, no unmute word. The handle is cut out first, because "Block @mute_bot"
 * also contains the word "mute".
 */
export function pickMenuItem(items: Iterable<Element>, handle: string, op: MenuOp): HTMLElement | null {
  const wanted = op === 'create' ? MUTE_WORDS : UNMUTE_WORDS;
  for (const item of items) {
    const rest = itemWords(item, handle);
    if (rest === null || !wanted.some((w) => rest.includes(w))) continue;
    if (op === 'create' && UNMUTE_WORDS.some((w) => rest.includes(w))) continue;
    return item as HTMLElement;
  }
  return null;
}

async function until<T>(read: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== null || Date.now() >= end) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function closeMenu(menu: Element): void {
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

/** One run at a time: X shows one menu, and a run leaves a menu that is open already alone. */
let turn: Promise<unknown> = Promise.resolve();

export function runMenu(article: Element, handle: string, op: MenuOp, sel: Selectors): Promise<boolean> {
  const run = turn.then(() => openAndClick(article, handle, op, sel));
  turn = run.catch(() => undefined);
  return run;
}

/**
 * Opens X's menu on this tweet, clicks the mute item if one passes the rules, and closes the menu if
 * none does. True when xslop clicked an item.
 */
async function openAndClick(article: Element, handle: string, op: MenuOp, sel: Selectors): Promise<boolean> {
  const caret = caretOf(article, sel);
  // A menu that is already open is yours: xslop leaves it alone.
  if (!caret || document.querySelector(sel.menu)) return false;
  const hide = document.createElement('style');
  hide.textContent = `${sel.menu}{opacity:0!important;pointer-events:none!important}`;
  document.documentElement.append(hide);
  try {
    caret.click();
    const menu = await until(() => {
      const open = document.querySelector(sel.menu);
      return open?.querySelector(sel.menuItem) ? open : null;
    }, MENU_WAIT_MS);
    if (!menu) return false;
    const item = pickMenuItem(menu.querySelectorAll(sel.menuItem), handle, op);
    if (item) item.click();
    else closeMenu(menu);
    await until(() => (document.querySelector(sel.menu) ? null : true), MENU_CLOSE_MS);
    return item !== null;
  } finally {
    hide.remove();
  }
}
