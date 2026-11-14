// The dark and light theme of the landing pages. Dark is the default; light shows only when the visitor picks it.
// This classic script loads in <head> before the first paint, because the CSP allows no inline script.
// It sets data-theme on <html> (brand/tokens.css reads it), wires every [data-theme-toggle] button,
// and fires "xslop:theme" on document after each switch (site/src/theme.ts).
// The choice stays in this browser only, in localStorage under "xslop-theme".
(() => {
  const KEY = 'xslop-theme';
  const root = document.documentElement;
  const saved = () => {
    try {
      return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  };
  const apply = (theme) => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#000000');
    const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    for (const button of document.querySelectorAll('[data-theme-toggle]')) button.setAttribute('aria-label', label);
  };
  const changed = (theme) => {
    apply(theme);
    document.dispatchEvent(new Event('xslop:theme'));
  };

  apply(saved());
  // The buttons come after this script in the page, so they get their label once the page is parsed.
  document.addEventListener('DOMContentLoaded', () => apply(root.dataset.theme === 'light' ? 'light' : 'dark'));
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-theme-toggle]')) return;
    const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage is off: the switch holds until the page closes.
    }
    changed(theme);
  });
  // Another tab of this site switched the theme.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) changed(saved());
  });
})();
