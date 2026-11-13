// The bridge rule. The static diagram switches between its two cases.

import { req } from './lib/dom.ts';

const VERDICT = {
  both: 'Both sides call it slop. The account is confirmed.',
  one: 'Only one side votes. The account stays off the list.',
} as const;

type Mode = keyof typeof VERDICT;

export function initBridge(): void {
  const figure = req('#bridge-figure');
  const verdict = req('#bridge-verdict');
  const buttons = [...figure.querySelectorAll<HTMLButtonElement>('.seg')];

  function setMode(mode: Mode): void {
    figure.dataset.mode = mode;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    verdict.textContent = VERDICT[mode];
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      if (mode === 'both' || mode === 'one') setMode(mode);
    });
  }
}
