// Phone and tablet sizes: every page, every state with its own layout, no sideways scroll, 44 px tap targets and 16 px fields.
// The landing page counts only for its strip and footer; its scene has its own tests.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launch, serve } from './helpers.ts';

const SIZES = [
  [320, 568],
  [360, 740],
  [390, 844],
  [430, 932],
  [667, 375],
  [844, 390],
  [768, 1024],
] as const;

/** Each view: a path, the steps that bring it on screen, and the part of the page that the checks read. */
const VIEWS: { name: string; path: string; scope?: string; show?: (page: Page) => Promise<void> }[] = [
  { name: 'landing strip and footer', path: '/', scope: '.strip, .site-foot' },
  { name: 'how it works', path: '/how-it-works' },
  { name: 'rules', path: '/rules' },
  { name: 'download', path: '/download', show: (page) => page.locator('#install-now a').first().waitFor() },
  { name: 'check', path: '/check' },
  {
    name: 'check result',
    path: '/check',
    show: async (page) => {
      await page.fill('#lookup-handle', 'growthhacker42');
      await page.press('#lookup-handle', 'Enter');
      await page.locator('#appeal-form').waitFor();
    },
  },
  { name: 'privacy', path: '/privacy' },
  { name: 'questions', path: '/questions' },
  {
    name: 'sloppers with an open record',
    path: '/sloppers',
    show: async (page) => {
      await page.locator('#sl-list .sl-slop:not(.is-skeleton)').first().waitFor();
      await page.getByRole('button', { name: 'How it got here' }).first().click();
      await page.locator('.sl-record-link').first().waitFor();
    },
  },
  { name: 'admin login', path: '/admin', show: (page) => page.locator('#login-view').waitFor() },
  {
    name: 'admin overview',
    path: '/admin',
    show: async (page) => {
      await page.fill('#login-user', 'operator');
      await page.fill('#login-pass', 'correct horse battery staple 42');
      await page.press('#login-pass', 'Enter');
      await page.locator('#overview-data dt').first().waitFor();
    },
  },
  { name: 'admin review', path: '', show: (page) => switchAdmin(page, '2', '#review-table') },
  { name: 'admin appeals', path: '', show: (page) => switchAdmin(page, '3', '#appeals-table') },
  { name: 'admin accounts', path: '', show: (page) => switchAdmin(page, '4', '#accounts-table') },
  { name: 'admin installs', path: '', show: (page) => switchAdmin(page, '5', '#installs-table') },
  { name: 'admin log', path: '', show: (page) => switchAdmin(page, '6', '#log-table') },
  { name: '404', path: '/no-such-page' },
];

async function switchAdmin(page: Page, key: string, table: string): Promise<void> {
  await page.keyboard.press(key);
  await page.locator(`${table} td`).first().waitFor();
}

/** Sideways scroll of the page, every tap target under 44 px and every field under 16 px, inside `scope`. */
function problems(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    const over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 0) out.push(`the page scrolls ${over} px sideways`);
    const targets = [...document.querySelectorAll(selector)].flatMap((root) => [
      ...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [role="tab"]'),
    ]);
    for (const el of targets) {
      if (!el.checkVisibility({ visibilityProperty: true }) || el.classList.contains('skip')) continue;
      const box = el.getBoundingClientRect();
      const label = `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || el.id).trim().slice(0, 30)}"`;
      // A link inside a sentence is exempt (WCAG 2.5.8): the sentence around it is the target.
      const block = el.closest('p, li, dd, td');
      const inSentence = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && (block?.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 2;
      if (!inSentence && (box.width < 43.5 || box.height < 43.5)) out.push(`${label} is ${Math.round(box.width)} x ${Math.round(box.height)} px`);
      if (el.matches('input, select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`${label} has ${getComputedStyle(el).fontSize} text`);
    }
    return out;
  }, scope);
}

let browser: Browser;
let server: Awaited<ReturnType<typeof serve>>;
before(async () => {
  browser = await launch();
  server = await serve();
});
after(async () => {
  await browser.close();
  await server.close();
});

for (const [width, height] of SIZES) {
  test(`every page fits ${width} x ${height}`, async () => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const found: string[] = [];
    try {
      for (const view of VIEWS) {
        if (view.path) await page.goto(`${server.url}${view.path}`, { waitUntil: 'networkidle' });
        await view.show?.(page);
        for (const problem of await problems(page, view.scope ?? 'body')) found.push(`${view.name}: ${problem}`);
      }
    } finally {
      await context.close();
    }
    assert.deepEqual(found, []);
  });
}
