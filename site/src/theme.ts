// Reads the theme that site/public/theme.js sets on <html>. Dark is the default.

export type Theme = 'dark' | 'light';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Calls `listener` after each switch of the theme, from the button on this page or from another tab. */
export function onThemeChange(listener: (theme: Theme) => void): void {
  document.addEventListener('xslop:theme', () => listener(currentTheme()));
}
