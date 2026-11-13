import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedLink, FIRST_PERSON, HTML_SINK, htmlProblems, stringLiterals, visibleText, withoutQuotedReplies } from '../../scripts/check-build.ts';

const page = (body: string) => `<!doctype html><html><head><script type="module" src="/assets/a.js"></script></head><body>${body}</body></html>`;

test('allowedLink permits only x.com profiles, the two stores, the Clankwall home page and the site itself', () => {
  for (const ok of ['https://x.com/dillon_mulroy', 'https://chromewebstore.google.com/detail/x', 'https://addons.mozilla.org/firefox/addon/xslop/', 'https://x-slop.com/og.png', 'https://clankwall.vogel.dev/']) {
    assert.equal(allowedLink(ok), true, ok);
  }
  for (const bad of ['https://x.com/i/lists/2116659176894071283', 'https://x.com/a?b=1', 'http://x.com/abc', 'https://evil.example/', 'https://fonts.googleapis.com/css', 'https://user:pw@x.com/abc', 'https://x.com.evil.example/abc', 'https://clankwall.vogel.dev/api/accounts.ndjson', 'https://clankwall.vogel.dev.evil.example/']) {
    assert.equal(allowedLink(bad), false, bad);
  }
});

test('visibleText exposes copy and labels but not scripts or styles', () => {
  const texts = visibleText('<title>T</title><style>.we{}</style><script>let us=1</script><p>Hello there</p><button aria-label="Ask us">x</button>');
  assert.ok(texts.includes('Hello there'));
  assert.ok(texts.includes('Ask us'));
  assert.ok(!texts.some((t) => t.includes('let us')));
  assert.ok(!texts.some((t) => t.includes('.we')));
});

test('stringLiterals reads quotes and templates', () => {
  assert.deepEqual(stringLiterals("const a = 'one'; const b = \"two\"; const c = `t ${x} end`;"), ['one', 'two', 't   end']);
});

test('the first-person pattern catches company voice and spares look-alikes', () => {
  for (const bad of ['We hide slop', 'Contact us', 'our list', "we'll check"]) assert.ok(FIRST_PERSON.test(bad), bad);
  for (const good of ['status', 'focus', 'business', 'your', 'weekly', 'trust']) assert.ok(!FIRST_PERSON.test(good), good);
});

test('htmlProblems finds every way past the CSP, with any quoting', () => {
  assert.deepEqual(htmlProblems(page('<a href="https://x.com/abc" rel="noopener noreferrer">Profile</a><img src="/og.png" alt="">')), []);
  for (const [body, problem] of [
    ["<p style='color:red'>x</p>", 'inline style attribute'],
    ['<p style=color:red>x</p>', 'inline style attribute'],
    ["<img src=/a.png onerror='go()'>", 'inline event handler'],
    ['<button ONCLICK=go()>x</button>', 'inline event handler'],
    ["<img srcset='/a.png 1x, https://evil.example/b.png 2x'>", 'external URL not allowed'],
    ['<link rel=stylesheet href=https://fonts.example/a.css>', 'external URL not allowed'],
    ['<form action="https://evil.example/collect"></form>', 'external URL not allowed'],
    ["<a href=' javascript:go()'>x</a>", 'unsafe URL scheme'],
    ['<meta http-equiv="Refresh" content="0;url=https://evil.example/">', 'meta refresh'],
    ['<script>go()</script>', 'inline script'],
    ['<style>p{}</style>', 'style element'],
  ] as const) {
    assert.ok(htmlProblems(page(body)).some((p) => p.startsWith(problem)), `${body} gives ${problem}`);
  }
});

test('withoutQuotedReplies drops only plain quoted reply text', () => {
  const texts = visibleText(withoutQuotedReplies('<p class="rcard-text">a model we can use</p><p class="lede">We hide slop</p><p class="rcard-text">x <b>our</b> y</p>'));
  assert.ok(!texts.some((t) => t.includes('a model we can use')));
  assert.ok(texts.includes('We hide slop'));
  assert.ok(texts.includes('our'), 'markup inside a reply keeps the check');
});

test('htmlProblems reads a URL the way the browser does', () => {
  for (const body of [
    '<a href="&#106;avascript:go()">x</a>',
    '<a href="&#x6A;avascript:go()">x</a>',
    '<a href="https&colon;//evil.example/" rel="noopener noreferrer">x</a>',
    '<a href="/\\evil.example/" rel="noopener noreferrer">x</a>',
    '<a href=" https://evil.example/" rel="noopener noreferrer">x</a>',
    '<a href="java\tscript:go()">x</a>',
    '<img src="/\t/evil.example/a.png" alt="">',
  ]) {
    assert.notDeepEqual(htmlProblems(page(body)), [], body);
  }
  assert.deepEqual(htmlProblems(page('<a href="/sloppers?q=a&amp;status=flagged">x</a>')), []);
});

test('an external link needs rel="noopener noreferrer"', () => {
  for (const body of ['<a href="https://x.com/abc">x</a>', '<a href="https://x.com/abc" rel="noopener">x</a>', "<a href='https://x.com/abc' rel=noreferrer>x</a>"]) {
    assert.ok(htmlProblems(page(body)).some((p) => p.startsWith('external link without rel')), body);
  }
  for (const body of ['<a href="https://x.com/abc" rel="noreferrer noopener">x</a>', '<a href="/rules">x</a>', '<link rel="canonical" href="https://x-slop.com/rules">']) {
    assert.deepEqual(htmlProblems(page(body)), [], body);
  }
});

test('HTML_SINK names every API that parses a string as HTML', () => {
  for (const code of ['el.innerHTML = s', 'el.outerHTML = s', "el.insertAdjacentHTML('beforeend', s)", 'document.write(s)', 'el.setHTMLUnsafe(s)', 'Document.parseHTMLUnsafe(s)', 'range.createContextualFragment(s)', 'eval(s)', 'new Function(s)']) {
    assert.ok(HTML_SINK.test(code), code);
  }
  assert.ok(!HTML_SINK.test('el.textContent = s'));
});
