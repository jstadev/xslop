// Build check (SPEC 8): scans site/dist and the site sources. Fails on
// - any em-dash (U+2014) in built files or sources,
// - first-person company words (we, our, us, ours, ourselves) in visible copy, accessible labels and script strings
//   (the quoted X replies in p.rcard-text are other people's words and are exempt, and so is ORDERED_NOTE),
// - external URLs in src/href other than x.com profiles, the Chrome Web Store, addons.mozilla.org and the Clankwall home page,
//   read the way the browser reads them (tabs and newlines dropped, a backslash as a slash), and character references in URL
//   attributes,
// - an external link without rel="noopener noreferrer",
// - any other external URL in built JS or CSS, inline scripts, inline style attributes, style elements, event handler
//   attributes or a meta refresh, with any quoting,
// - missing required outputs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const site = join(import.meta.dirname, '..');
const dist = join(site, 'dist');
const problems: string[] = [];
const fail = (file: string, message: string) => problems.push(`${relative(site, file)}: ${message}`);

const EM_DASH = '—';
export const FIRST_PERSON = /\b(we|we'll|we're|we've|we'd|our|ours|ourselves|us)\b/i;
/** The maintainer wrote this note on /check in the first person. It is the one exception to FIRST_PERSON. */
export const ORDERED_NOTE = '(we will never ask for your password)';
const SELF = 'https://x-slop.com';
/** The pages that the footer of every page links to. */
const PAGES = ['how-it-works', 'rules', 'download', 'check', 'privacy', 'questions'];
/** XML namespaces are identifiers that a browser never fetches. Three.js also creates its canvas in the XHTML namespace. */
const XML_NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml'];

const isSelf = (url: string): boolean => url === SELF || url.startsWith(`${SELF}/`);

/** Allowed external link targets for src/href attributes. */
export function allowedLink(url: string): boolean {
  if (isSelf(url)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.hostname === 'x.com') return /^\/[A-Za-z0-9_]{1,15}$/.test(u.pathname) && !u.search && !u.hash;
  if (u.hostname === 'clankwall.vogel.dev') return u.pathname === '/' && !u.search && !u.hash;
  return u.hostname === 'chromewebstore.google.com' || u.hostname === 'addons.mozilla.org';
}

/** Visible text and accessible strings of an HTML document, with scripts, styles and SVG paths removed. */
export function visibleText(html: string): string[] {
  const out: string[] = [];
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of body.matchAll(/\b(?:aria-label|title|alt|placeholder|content)="([^"]*)"/gi)) out.push(m[1] ?? '');
  for (const m of body.matchAll(/<title>([\s\S]*?)<\/title>/gi)) out.push(m[1] ?? '');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  out.push(...text.split(/\s{2,}|\n/).map((t) => t.trim()).filter(Boolean));
  return out;
}

/** String literals in a TS source file (quotes and template literals, without the ${} parts). */
export function stringLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of source.matchAll(re)) out.push((m[2] ?? '').replace(/\$\{[^}]*\}/g, ' '));
  return out;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Removes the quoted X replies of the demo thread: they are not company voice. */
export function withoutQuotedReplies(html: string): string {
  return html.replace(/<p class="rcard-text">[^<]*<\/p>/g, ' ');
}

/** Every API that parses a string as HTML or code. Page scripts build the DOM with h() and text nodes only. */
export const HTML_SINK = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\bsetHTMLUnsafe\b|\bparseHTMLUnsafe\b|createContextualFragment|\beval\(|new Function\(/;

const URL_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'srcset', 'action', 'formaction', 'poster', 'data']);

/** A URL as the browser reads it: `&amp;` decoded, tabs and newlines dropped, a backslash read as a slash, controls and spaces trimmed. */
const browserUrl = (value: string): string =>
  value.replace(/&amp;/gi, '&').replace(/[\t\n\r]/g, '').replace(/\\/g, '/').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

const isExternal = (url: string): boolean => /^https?:\/\//i.test(url) || url.startsWith('//');

function urlProblem(url: string): string | null {
  if (isExternal(url)) return allowedLink(url) ? null : `external URL not allowed: ${url}`;
  return /^(javascript|data|vbscript):/i.test(url) ? `unsafe URL scheme: ${url.slice(0, 40)}` : null;
}

/** Problems of one HTML document. Attributes are read with double, single or no quotes. */
export function htmlProblems(html: string): string[] {
  const out: string[] = [];
  if (html.includes(EM_DASH)) out.push('contains an em-dash');
  for (const text of visibleText(withoutQuotedReplies(html))) {
    if (text === ORDERED_NOTE) continue;
    const m = FIRST_PERSON.exec(text);
    if (m) out.push(`first-person word "${m[0]}" in: ${text.slice(0, 80)}`);
  }
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of (tag[2] ?? '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs.set((a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    for (const [name, value] of attrs) {
      if (name === 'style') out.push('inline style attribute (CSP style-src self)');
      else if (name.startsWith('on')) out.push(`inline event handler attribute ${name}`);
      else if (URL_ATTRIBUTES.has(name)) {
        // A character reference hides a scheme or a host from this check, and a page URL never needs one.
        if (/&(?!amp;)(#|[a-z][a-z0-9]*;)/i.test(value)) out.push(`character reference in a URL attribute: ${value.slice(0, 40)}`);
        const urls = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value];
        for (const url of urls) {
          const problem = urlProblem(browserUrl(url));
          if (problem) out.push(problem);
        }
      }
    }
    const href = browserUrl(attrs.get('href') ?? '');
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (/^(a|area)$/i.test(tag[1] ?? '') && isExternal(href) && !isSelf(href) && !(rel.includes('noopener') && rel.includes('noreferrer'))) {
      out.push(`external link without rel="noopener noreferrer": ${href}`);
    }
    if (tag[1]?.toLowerCase() === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh') out.push('meta refresh');
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(m[1] ?? '') || (m[2] ?? '').trim()) out.push('inline script');
  }
  if (/<style\b/i.test(html)) out.push('style element (CSP style-src self)');
  return out;
}

function checkAsset(file: string): void {
  const text = readFileSync(file, 'utf8');
  if (text.includes(EM_DASH)) fail(file, 'contains an em-dash');
  for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/gi)) {
    const url = m[0];
    if (XML_NAMESPACES.some((ns) => url.startsWith(ns)) || url.startsWith('https://x.com/')) continue;
    fail(file, `external URL in asset: ${url.slice(0, 80)}`);
  }
}

function checkSource(file: string): void {
  const text = readFileSync(file, 'utf8');
  if (text.includes(EM_DASH)) fail(file, 'contains an em-dash');
  if (!file.endsWith('.ts')) return;
  if (HTML_SINK.test(text)) fail(file, 'HTML string sink or eval');
  if (/setAttribute\(\s*['"]style['"]/.test(text)) fail(file, 'style attribute set from script');
  for (const literal of stringLiterals(text)) {
    if (/^[./@a-z0-9_-]+$/i.test(literal)) continue; // identifiers, paths, selectors
    const m = FIRST_PERSON.exec(literal);
    if (m) fail(file, `first-person word "${m[0]}" in string: ${literal.slice(0, 80)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const required of ['index.html', 'admin/index.html', 'sloppers/index.html', ...PAGES.map((page) => `${page}/index.html`), '404.html', 'favicon.svg', 'og.png', 'robots.txt']) {
    if (!existsSync(join(dist, required))) fail(join(dist, required), 'missing build output');
  }
  const built = walk(dist);
  for (const file of built) {
    if (file.endsWith('.html')) for (const problem of htmlProblems(readFileSync(file, 'utf8'))) fail(file, problem);
    else if (/\.(js|css|svg|txt)$/.test(file)) checkAsset(file);
  }
  const sources = [...walk(join(site, 'src')), join(site, 'index.html'), join(site, 'admin/index.html'), join(site, 'sloppers/index.html'), ...PAGES.map((page) => join(site, page, 'index.html')), ...walk(join(site, 'partials')), join(site, '404.html'), ...walk(join(site, '../brand')).filter((f) => /\.(css|svg)$/.test(f))];
  for (const file of sources) checkSource(file);

  if (problems.length > 0) {
    console.error(`check-build: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`check-build: ok (${built.length} built files, ${sources.length} source files)`);
}
