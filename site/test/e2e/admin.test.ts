// Admin console v3 end to end (SPEC 5.6, 13.8, 14.3): login with and without a code, every view with its data, the
// account sentence and gate checklist, the install standing checklist, activity filters and paging, x-csrf and Origin
// on every write behind two clicks, the wipe on logout and on a session end, bad hash params, keys, 390 px, no errors.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { horizontalOverflow, launch, open, serve } from './helpers.ts';
import { uuidOf, type MockState } from './server.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const USER = 'operator';
const PASSWORD = 'correct horse battery staple 42';
// Failed requests that a test causes on purpose: the session end (401), an unknown handle (404), a crowd ban (409).
const EXPECTED = [/status of 401/, /status of 404/, /status of 409/];

type Server = Awaited<ReturnType<typeof serve>>;

async function login(page: Page, code = ''): Promise<void> {
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', PASSWORD);
  await page.fill('#login-code', code);
  await page.click('#login-submit');
  await page.locator('#user-name', { hasText: USER }).waitFor();
  await page.locator('#view-title').waitFor();
}

/** Opens a hash and waits until its view has rendered. */
async function show(page: Page, hash: string, title: string | RegExp): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.locator('#view-title', { hasText: title }).waitFor();
  await page.locator('#view .loading').waitFor({ state: 'detached' });
}

/** The writes after the login, each checked for the session csrf and the site origin. */
function writes(server: Server): { path: string; body: unknown }[] {
  const csrf = [...server.state.sessions.values()].at(-1);
  const list = server.state.log.filter((l) => l.method === 'POST' && l.path !== '/api/admin/login' && l.path !== '/api/admin/logout');
  for (const w of list) {
    assert.equal(w.csrf, csrf, `${w.path} sends x-csrf`);
    assert.equal(w.origin, server.url, `${w.path} sends Origin`);
  }
  return list.map(({ path, body }) => ({ path, body }));
}

/** Clicks once, checks that nothing was sent and that the button names the action, then clicks the armed button. */
async function twice(page: Page, server: Server, scope: string, label: string, armed = `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`): Promise<void> {
  const sent = server.state.log.length;
  await page.locator(scope).getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(scope).getByRole('button', { name: armed, exact: true }).waitFor();
  assert.equal(server.state.log.length, sent, `the first click on ${label} sends nothing`);
  await page.locator(scope).getByRole('button', { name: armed, exact: true }).click();
}

const requests = (server: Server, prefix: string): string[] => server.state.log.filter((l) => l.method === 'GET' && decodeURIComponent(l.path).startsWith(prefix)).map((l) => decodeURIComponent(l.path));
/** The rendered text of an element, as a reader sees it, with each run of white space as one space. */
const text = async (page: Page, selector: string): Promise<string> => (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim();

async function withConsole(fn: (page: Page, server: Server, errors: string[]) => Promise<void>, overrides: Partial<MockState['scenario']> = {}, viewport = { width: 1440, height: 900 }): Promise<void> {
  const server = await serve(overrides);
  try {
    const { page, errors } = await open(browser, `${server.url}/admin`, { viewport }, EXPECTED);
    try {
      await fn(page, server, errors);
      assert.deepEqual(errors, [], 'no console errors');
    } finally {
      await page.context().close();
    }
  } finally {
    await server.close();
  }
}

test('login: no first probe, a code of 6 digits, a wrong or used code like a wrong password', async () => {
  await withConsole(
    async (page, server) => {
      await page.locator('#login-view').waitFor();
      assert.equal(requests(server, '/api/admin/session').length, 0, 'a first visit does not probe the session');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'login-user');
      assert.equal(await page.locator('label[for="login-code"]').textContent(), 'Code from your app (only if your login has one)');

      await page.click('#login-submit');
      assert.equal(await page.locator('#login-error').textContent(), 'Type the username and the password.');
      await page.fill('#login-user', USER);
      await page.fill('#login-pass', PASSWORD);
      await page.fill('#login-code', '12a4');
      await page.click('#login-submit');
      assert.equal(await page.locator('#login-error').textContent(), 'Type the 6 digits of the code, or leave the field empty.');
      assert.equal(await page.getAttribute('#login-code', 'aria-invalid'), 'true');
      assert.equal(server.state.log.filter((l) => l.path === '/api/admin/login').length, 0, 'a bad code never leaves the page');

      await page.fill('#login-code', '');
      await page.click('#login-submit');
      await page.locator('#login-error', { hasText: 'Wrong username, password or code.' }).waitFor();
      assert.deepEqual(server.state.log.at(-1)?.body, { username: USER, password: PASSWORD }, 'an empty code field sends no code');
      await page.fill('#login-code', '654321');
      await page.click('#login-submit');
      await page.locator('#login-error', { hasText: 'Wrong username, password or code.' }).waitFor();

      await login(page, '123456');
      assert.deepEqual(server.state.log.filter((l) => l.path === '/api/admin/login').at(-1)?.body, { username: USER, password: PASSWORD, code: '123456' });
      assert.equal(await page.inputValue('#login-pass'), '', 'the password leaves the form');
      assert.equal(await page.inputValue('#login-code'), '', 'the code leaves the form');

      // The same code works once.
      await page.click('#logout');
      await page.locator('#status', { hasText: 'You are logged out.' }).waitFor();
      await page.fill('#login-user', USER);
      await page.fill('#login-pass', PASSWORD);
      await page.fill('#login-code', '123456');
      await page.click('#login-submit');
      await page.locator('#login-error', { hasText: 'Wrong username, password or code.' }).waitFor();
    },
    { adminCode: '123456' },
  );
});

test('home: job health, the list, the queues, the last 24 hours, installs, newest activity and live counts', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    assert.equal(await page.title(), 'Home: xslop admin');
    assert.equal(await page.getAttribute('[data-nav="home"]', 'aria-current'), 'page');
    assert.deepEqual(await page.$$eval('[data-count]', (els) => els.map((e) => [e.getAttribute('data-count'), e.firstChild?.textContent])), [
      ['pending', '7'],
      ['disputed', '1'],
      ['appeals', '1'],
    ]);
    // Each counted menu link says what the number means.
    assert.deepEqual(await page.$$eval('[data-count]', (els) => els.map((e) => e.closest('a')?.getAttribute('aria-describedby'))), ['count-hint', 'count-hint', 'count-hint']);
    assert.equal(await page.locator('#count-hint').textContent(), 'waiting for you');
    // A tile with a glossary word links its number, never a link inside a link.
    assert.equal(await page.locator('#view a a').count(), 0);
    const confirmedTile = page.locator('#view .tile', { has: page.locator('.term[data-term="confirmed"]') });
    assert.match((await confirmedTile.locator('.tile-link').getAttribute('aria-label')) ?? '', /^[\d,]+ confirmed$/);
    const health = await page.$$eval('#view .health', (els) => els.map((e) => [e.getAttribute('data-health'), e.textContent?.replace(/\s+/g, ' ').trim()]));
    assert.deepEqual(health.slice(0, 3), [
      ['ok', 'The score job ran 3 minutes ago and succeeded. 120 runs in 24 hours, 1 failed.'],
      ['ok', 'The X facts job ran 1 minute ago and succeeded. 160 runs with work in 24 hours, 2 failed.'],
      ['ok', 'The list is at version 118 with 873 accounts, published 2 hours ago.'],
    ]);
    assert.deepEqual(await page.$$eval('#view .queue-count', (els) => els.map((e) => e.textContent)), ['7', '1', '1', '1']);
    assert.deepEqual(await page.$$eval('#view .queue-link', (els) => els.map((e) => e.getAttribute('href'))), ['#review/pending', '#review/disputed', '#review/auto', '#appeals/open']);
    assert.equal(await page.locator('#view .feed .act').count(), 15, 'the newest 15 activity items');
    assert.ok(requests(server, '/api/admin/activity?limit=15').length === 1);

    // A time shows the full local time on focus; a term shows its definition on hover.
    const when = page.locator('#view .feed time').first();
    await when.focus();
    await page.locator('#tip:not([hidden])').waitFor();
    assert.equal(await page.locator('#tip').textContent(), await when.getAttribute('data-tip'));
    assert.equal(await when.getAttribute('aria-describedby'), 'tip');
    await page.locator('#view .health .term').first().hover();
    await page.locator('#tip', { hasText: 'score job' }).waitFor();

    // A failed last run turns its line red and names the last success.
    const newest = server.state.jobRuns.find((r) => r.job === 'score');
    assert.ok(newest);
    newest.ok = false;
    newest.detail = { error: 'boom' };
    await page.locator('body').press('r');
    await page.locator('#view .health[data-health="bad"]', { hasText: 'The score job ran 3 minutes ago and failed. The last success was 8 minutes ago.' }).waitFor();
  });
});

test('review: three queues, the reason of each row in words, each decision asks once and sends its request', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('2');
    const table = '#review-table';
    await page.locator(`${table} td`, { hasText: '@xs_pending_demo' }).waitFor();
    assert.equal(await page.title(), 'Review: xslop admin');
    assert.equal(await page.locator(`${table} tbody tr`).count(), 7);
    assert.equal(
      await text(page, '#review-note'),
      'Accounts that pass the crowd test of the votes while a gate holds them back. Confirm lists one now; clear takes it off for good. Either way your decision wins over the votes until you reset it. The table shows 7 of 7 accounts in this queue.',
    );
    assert.equal(requests(server, '/api/admin/review?queue=pending&limit=100').length, 1);
    // Each column header has its definition.
    assert.deepEqual(await page.$$eval(`${table} th a.term`, (els) => els.map((e) => e.getAttribute('href'))), ['#help/gate', '#help/network', '#help/behaviour']);

    const row = (handle: string) => `${table} tbody tr:has-text("@${handle}")`;
    const cell = (handle: string, label: string) => text(page, `${row(handle)} td[data-label="${label}"]`);
    assert.equal(await cell('xs_pending_demo', 'Account'), '@xs_pending_demo Pending Demo <b>Account</b> 1,234 followers pending votes support confirmed', 'the name is text, never markup');
    assert.equal(await page.locator(`${row('xs_pending_demo')} td[data-label="Account"] a`).first().getAttribute('href'), '#account/xs_pending_demo');
    assert.equal(await cell('xs_pending_demo', 'Why'), 'Pending. The votes pass the test for confirmed, but the evidence gate holds it: the server checked posts of too few networks, and confirmed needs 2.');
    assert.equal(await cell('xs_pending_demo', 'Votes'), 'Slop networks 9 Anchors 2 Not slop, standing 0 Dissent 4 Checked posts none yet');
    assert.match(await cell('xs_pending_demo', 'Timing'), /^90% within a minute, of 12 checked replies first vote .+ ago last vote .+ ago$/);
    assert.equal(await cell('xs_big_account', 'Why'), 'Pending. The votes pass the test for confirmed, but the protected gate holds it: it has 120,000 followers, and from 50,000 followers only an admin decision changes its public state.');
    const post = page.locator(`${row('xs_big_account')} td[data-label="Votes"] a[href^="https://x.com/"]`).first();
    assert.equal(await post.getAttribute('href'), 'https://x.com/i/status/1850000000000000050');
    assert.equal(await post.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await cell('xs_unknown_demo', 'Why'), 'Pending. The votes pass the test for flagged, but the identity gate holds it: the X facts job has not matched the handle to an X account yet.');

    // The ban names the networks that ban-voters bans.
    assert.equal(await page.locator(row('xs_pending_demo')).getByRole('button', { name: 'Ban the installs that marked it (9 networks)', exact: true }).count(), 1);
    await twice(page, server, row('xs_unknown_demo'), 'Ban the installs that marked it (2 networks)', 'Yes, ban the installs of 2 networks');
    await page.locator('#status', { hasText: '@xs_unknown_demo: 2 installs are banned.' }).waitFor();
    await page.locator(row('xs_unknown_demo')).getByRole('button', { name: /^Ban the installs/ }).waitFor({ state: 'detached' });

    await twice(page, server, row('xs_unknown_demo'), 'Protect');
    await page.locator('#status', { hasText: '@xs_unknown_demo is protected.' }).waitFor();
    await page.locator(row('xs_unknown_demo')).getByRole('button', { name: 'Unprotect' }).waitFor();
    await twice(page, server, row('xs_pending_demo'), 'Clear with penalty');
    await page.locator('#status', { hasText: '@xs_pending_demo is cleared with a penalty for its slop voters. The shared list follows at once.' }).waitFor();
    await page.locator(row('xs_pending_demo')).waitFor({ state: 'detached' });
    await twice(page, server, row('xs_unknown_demo'), 'Confirm');
    await page.locator('#status', { hasText: '@xs_unknown_demo is confirmed.' }).waitFor();
    await page.locator(row('xs_unknown_demo')).waitFor({ state: 'detached' });
    await page.locator('[data-count="pending"]', { hasText: '5' }).waitFor();

    // A starter account is never cleared with a penalty (13.8), and above 10 networks the ban is off.
    await page.getByRole('navigation', { name: 'Review queues' }).getByRole('link', { name: /Disputed/ }).click();
    const seed = page.locator(row('growthhacker42'));
    await seed.waitFor();
    assert.equal(await page.getAttribute('[data-nav="disputed"]', 'aria-current'), 'page');
    assert.match(await cell('growthhacker42', 'Why'), /^Confirmed as a starter account: .* 5 networks with standing say it is not slop\.$/);
    assert.equal(await seed.getByRole('button', { name: 'Clear with penalty' }).count(), 0);
    // The ban above on @xs_unknown_demo can hit an install that marked this account too, so the count is read, not fixed.
    const off = seed.getByRole('button', { name: /^Ban the installs that marked it \(\d+ networks, limit 10\)$/ });
    assert.equal(await off.isDisabled(), true);
    const logged = server.state.log.length;
    await off.click({ force: true });
    assert.equal(server.state.log.length, logged, 'a ban that is off sends nothing');
    await twice(page, server, row('growthhacker42'), 'Clear without penalty');
    await page.locator('#status', { hasText: '@growthhacker42 is cleared without a penalty.' }).waitFor();
    await page.locator(`${table} td.empty`, { hasText: 'No accounts in the disputed queue.' }).waitFor();

    await show(page, '#review/auto', 'Review');
    await page.locator(row('xs_auto_confirm')).waitFor();
    assert.equal(await cell('xs_auto_confirm', 'Why'), 'Confirmed by votes. 5 slop networks marked it, 3 of them with standing (anchors).', 'a review item names no evidence count that it does not carry');
    await twice(page, server, row('xs_auto_confirm'), 'Confirm');
    await page.locator(`${table} td.empty`, { hasText: 'No accounts in the automatic queue.' }).waitFor();

    assert.deepEqual(writes(server), [
      { path: '/api/admin/accounts/xs_unknown_demo/ban-voters', body: {} },
      { path: '/api/admin/accounts/xs_unknown_demo', body: { action: 'protect' } },
      { path: '/api/admin/accounts/xs_pending_demo', body: { action: 'clear', penalty: true } },
      { path: '/api/admin/accounts/xs_unknown_demo', body: { action: 'confirm' } },
      { path: '/api/admin/accounts/growthhacker42', body: { action: 'clear', penalty: false } },
      { path: '/api/admin/accounts/xs_auto_confirm', body: { action: 'confirm' } },
    ]);

    // Each row opens its account page.
    await show(page, '#review/pending', 'Review');
    await page.locator(`${row('xs_big_account')} td[data-label="Account"] a`).first().click();
    await page.locator('#view-title', { hasText: '@xs_big_account' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#account/xs_big_account');
  });
});

test('review: the note counts the whole queue, also past the row limit', async () => {
  await withConsole(async (page, server) => {
    const filler = server.state.accounts.get('xs_no_anchor');
    assert.ok(filler);
    for (let i = 0; i < 60; i++) server.state.accounts.set(`xs_fill_${i}`, { ...structuredClone(filler), handle: `xs_fill_${i}` });
    await login(page);
    await page.keyboard.press('2');
    await page.locator('#review-note', { hasText: 'The table shows 67 of 67 accounts in this queue.' }).waitFor();
    await page.selectOption('#review-limit', '50');
    await page.locator('#review-filter button[type="submit"]').click();
    await page.locator('#review-note', { hasText: 'The table shows 50 of 67 accounts in this queue.' }).waitFor();
    assert.equal(await page.locator('#review-table tbody tr').count(), 50);
    assert.equal(requests(server, '/api/admin/review?queue=pending&limit=50').length, 1);
    await show(page, '#review/auto', 'Review');
    await page.locator('#review-note', { hasText: 'The table shows 1 of 1 account in this queue.' }).waitFor();
  });
});

test('account page: the status sentence, the gate checklist, the networks, the timeline and the decisions', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await show(page, '#account/pendingperson', '@pendingperson');
    assert.equal(await page.title(), '@pendingperson: xslop admin');
    assert.equal(await page.getAttribute('[data-nav="accounts"]', 'aria-current'), 'page');
    assert.equal(requests(server, '/api/admin/accounts/pendingperson').length, 1);
    assert.equal(await text(page, '#view .view-head .lede'), 'Flagged by votes; standing gate holds confirmed');
    assert.equal(
      await text(page, '#view .verdict-text'),
      'Flagged by votes. 4 slop networks marked it, 1 of them with standing (anchor), and the server checked posts of 2 networks. 1 network without standing said not slop; that counts in no test (dissent). The votes also pass the test for confirmed, but the standing gate holds it: 1 network with standing marked it, and confirmed needs 2.',
    );
    assert.match(await text(page, '#view .verdict'), /The newest list \(version 118\) holds it at tier 1, score 61\.$/);
    assert.deepEqual(await page.$$eval('#view .verdict a.term', (els) => els.map((e) => e.getAttribute('href'))), ['#help/anchor', '#help/dissent', '#help/gate-standing', '#help/standing']);
    const avatar = page.locator('#view img[src="/api/v1/avatars/pendingperson"]');
    await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('#view img[src="/api/v1/avatars/pendingperson"]')?.naturalWidth ?? 0) > 0);
    assert.equal(await avatar.getAttribute('alt'), '');
    assert.equal(await page.locator('#view a[href="https://x.com/pendingperson"]').count(), 1);

    // The checklist: has and needs for both tiers, the check that holds it now, and the next step.
    const checks = '#checks-table tbody tr';
    const marks = await page.$$eval(checks, (trs) =>
      trs.map((tr) => [
        tr.querySelector('td:nth-child(1) a')?.textContent,
        tr.querySelector('td:nth-child(2)')?.textContent,
        tr.querySelector('td:nth-child(3) .mark')?.getAttribute('data-mark'),
        tr.querySelector('td:nth-child(4) .mark')?.getAttribute('data-mark'),
        Boolean(tr.querySelector('.holds')),
      ]),
    );
    assert.deepEqual(marks, [
      ['Slop networks', '4', 'met', 'met', false],
      ['Trust of the slop networks', '1.60', 'none', 'met', false],
      ['No dispute', '0 networks with standing say not slop', 'met', 'open', false],
      ['Not protected', '3,100 followers', 'met', 'met', false],
      ['Identity checked', 'ok', 'met', 'met', false],
      ['Anchors (slop networks with standing)', '1', 'met', 'unmet', true],
      ['Networks with a checked post', '2', 'met', 'met', false],
      ['Daily limit not used up', 'no hold', 'met', 'open', false],
    ]);
    await page.locator('#view', { hasText: 'For confirmed by votes it needs 1 more anchor.' }).waitFor();

    // The networks that voted, with each install linked to its page.
    assert.equal(await page.locator('#networks-table tbody tr').count(), 5);
    const installLinks = await page.$$eval('#networks-table a[href^="#install/"]', (els) => els.map((e) => e.getAttribute('href') ?? ''));
    assert.ok(installLinks.length >= 5 && installLinks.every((href) => /^#install\/[0-9a-f-]{36}$/.test(href)), installLinks.join(' '));
    await page.locator('#view .feed .act[data-kind="appeal"]', { hasText: 'An appeal for @pendingperson arrived.' }).waitFor();
    await page.locator('#view .feed .act[data-kind="status"]', { hasText: 'The score job moved @pendingperson from not listed to flagged.' }).waitFor();

    // A term shows its definition on hover.
    await page.locator('#view .verdict a.term[href="#help/anchor"]').hover();
    await page.locator('#tip:not([hidden])').waitFor();
    assert.ok(((await page.locator('#tip').textContent()) ?? '').length > 20);

    await twice(page, server, '#view .decide-list', 'Protect');
    await page.locator('#status', { hasText: '@pendingperson is protected.' }).waitFor();
    await page.locator('#view .decide-list').getByRole('button', { name: 'Unprotect', exact: true }).waitFor();
    assert.deepEqual(writes(server), [{ path: '/api/admin/accounts/pendingperson', body: { action: 'protect' } }]);

    // A moved handle points to its new handle; an unknown handle says so.
    await show(page, '#account/xs_moved_handle', '@xs_moved_handle');
    assert.equal(await text(page, '#view .verdict-text'), 'Not listed. The handle now belongs to another X account, so xslop never hides it. Its state moved to @xs_new_handle.');
    assert.equal(await page.locator('#view .verdict-text a[href="#account/xs_new_handle"]').count(), 1);
    await show(page, '#account/nobody_here_1', '@nobody_here_1');
    await page.locator('#view', { hasText: 'The server has no row for this handle' }).waitFor();
  });
});

test('install page: standing as a checklist against the needs, its votes, its network and trust', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    const standing = uuidOf('install:s5');
    await show(page, `#install/${standing}`, `Install ${standing.slice(0, 8)}`);
    assert.equal(await text(page, '#view .verdict'), 'Has standing: it is 19 days old, has 3 good marks and a reputation of 0.77.');
    assert.equal(await page.getAttribute('[data-nav="installs"]', 'aria-current'), 'page');
    const votes = await page.$$eval('#view a[href^="#account/"]', (els) => els.map((e) => e.getAttribute('href') ?? ''));
    assert.ok(votes.length > 0 && votes.every((href) => /^#account\/[a-z0-9_]{1,15}$/.test(href)), 'each vote links its account page');

    const ready = uuidOf('install:p0:0');
    await show(page, `#install/${ready}`, `Install ${ready.slice(0, 8)}`);
    assert.equal(await text(page, '#view .verdict'), 'No standing yet. Every check passes (it is 12 days old, has 3 good marks and a reputation of 0.65), so the next score run gives it standing.');

    const fresh = uuidOf('install:p49:0');
    await show(page, `#install/${fresh}`, `Install ${fresh.slice(0, 8)}`);
    assert.equal(await text(page, '#view .verdict'), 'No standing. It needs 7 more days, 3 more good marks and a reputation of at least 0.60 (it has 0.05).');
    const rows = await page.$$eval('#standing-table tbody tr', (trs) => trs.map((tr) => [tr.querySelector('td:nth-child(1)')?.textContent?.trim(), tr.querySelector('td:nth-child(2)')?.textContent?.trim(), tr.querySelector('.mark')?.getAttribute('data-mark')]));
    assert.deepEqual(rows, [
      ['Not banned', 'not banned', 'met'],
      ['Trusted by you', 'no', 'none'],
      ['Age', '0 days', 'unmet'],
      ['Good marks', '0', 'unmet'],
      ['Reputation', '0.05', 'unmet'],
    ]);
    await twice(page, server, '#view .decide-list', 'Trust');
    await page.locator('#status', { hasText: `Install ${fresh.slice(0, 8)} is trusted.` }).waitFor();
    await page.locator('#view .verdict', { hasText: 'You trusted it, so the next score run gives it standing.' }).waitFor();
    await page.locator('#view .feed .act[data-kind="admin"]', { hasText: `You trusted install ${fresh.slice(0, 8)}.` }).waitFor();
    assert.deepEqual(writes(server), [{ path: `/api/admin/installs/${fresh}/trust`, body: {} }]);
  });
});

test('accounts: filters, scores 0 to 100, each row opens its page, reset, protect and the ban of a cleared account', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('4');
    await page.locator('#accounts-table tbody tr').first().waitFor();
    assert.equal(await page.locator('#accounts-table tbody tr').count(), server.state.accounts.size);
    assert.equal(requests(server, '/api/admin/accounts?limit=100').length, 1);
    const scores = await page.$$eval('#accounts-table tbody tr', (rows) => rows.map((row) => row.querySelector('td:nth-child(4)')?.textContent));
    assert.deepEqual(new Set(scores), new Set([...server.state.accounts.values()].map((a) => String(a.score))));

    // A bad handle is refused before any request.
    const sent = server.state.log.length;
    await page.fill('#accounts-handle', 'bad handle!');
    await page.press('#accounts-handle', 'Enter');
    await page.locator('#status', { hasText: 'Type a handle of 1 to 15 letters' }).waitFor();
    assert.equal(server.state.log.length, sent);

    await page.fill('#accounts-handle', '');
    await page.selectOption('#accounts-status', 'cleared');
    await page.locator('#accounts-filter button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#accounts-table tbody tr').length === 2);
    assert.equal(requests(server, '/api/admin/accounts?status=cleared&limit=100').length, 1);
    const small = '#accounts-table tbody tr:has-text("@xs_cleared_demo")';
    const crowd = '#accounts-table tbody tr:has-text("@xs_cleared_many")';
    assert.equal(await text(page, `${small} td[data-label="Why"]`), 'You cleared it, with penalty');
    assert.equal(await page.locator(small).getByRole('button', { name: 'Clear with penalty' }).count(), 0, 'a cleared account offers no second clear');
    assert.equal(await page.locator(crowd).getByRole('button', { name: 'Ban the installs that marked it (14 networks, limit 10)', exact: true }).isDisabled(), true);

    // 4 networks: the ban is on. Votes of 7 more networks land before the second click: the server answers 409.
    await page.locator(small).getByRole('button', { name: 'Ban the installs that marked it (4 networks)', exact: true }).click();
    const st = server.state;
    const networkOf = new Map(st.installs.map((i) => [i.id, i.network]));
    const voted = new Set(st.votes.filter((v) => v.handle === 'xs_cleared_demo').map((v) => networkOf.get(v.install)));
    const extra = [...new Map(st.installs.filter((i) => !i.bannedAt && !voted.has(i.network)).map((i) => [i.network, i])).values()].slice(0, 7);
    for (const i of extra) st.votes.push({ install: i.id, handle: 'xs_cleared_demo', value: 1, votedAt: new Date().toISOString(), changedAt: new Date().toISOString(), tweetId: null });
    await page.locator(small).getByRole('button', { name: 'Yes, ban the installs of 4 networks', exact: true }).click();
    await page.locator('#status', { hasText: 'More than 10 networks marked this account.' }).waitFor();
    assert.equal(await page.getAttribute('#status', 'data-kind'), 'error');
    await page.locator('body').press('r');
    const off = page.locator(small).getByRole('button', { name: 'Ban the installs that marked it (11 networks, limit 10)', exact: true });
    await off.waitFor();
    assert.equal(await off.isDisabled(), true);

    await twice(page, server, small, 'Reset');
    await page.locator('#status', { hasText: '@xs_cleared_demo: the admin decision is removed.' }).waitFor();
    await twice(page, server, small, 'Protect');
    await page.locator(small).getByRole('button', { name: 'Unprotect' }).waitFor();
    assert.deepEqual(writes(server), [
      { path: '/api/admin/accounts/xs_cleared_demo/ban-voters', body: {} },
      { path: '/api/admin/accounts/xs_cleared_demo', body: { action: 'reset' } },
      { path: '/api/admin/accounts/xs_cleared_demo', body: { action: 'protect' } },
    ]);
    await page.locator(`${small} td[data-label="Account"] a`).first().click();
    await page.locator('#view-title', { hasText: '@xs_cleared_demo' }).waitFor();
  });
});

test('installs: standing, trust and votes of each side; trust, untrust, ban and unban ask once', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('5');
    const first = '#installs-table tbody tr:nth-child(1)';
    await page.locator(first).waitFor();
    const cell = (label: string) => text(page, `${first} td[data-label="${label}"]`);
    assert.deepEqual([await cell('Standing'), await cell('Trusted'), await cell('Reputation')], ['no', 'no', '0.05'], 'lowest reputation first');
    await page.selectOption('#installs-sort', 'votes');
    await page.locator('#installs-filter button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#installs-table tbody tr td[data-label="Reputation"]')?.textContent !== '0.05');
    assert.equal(requests(server, '/api/admin/installs?sort=votes&limit=100').length, 1);
    const href = (await page.locator(`${first} td[data-label="Install"] a`).getAttribute('href')) ?? '';
    const id = href.replace('#install/', '');
    assert.match(id, /^[0-9a-f-]{36}$/);

    await twice(page, server, first, 'Trust');
    await page.locator(first).getByRole('button', { name: 'Untrust' }).waitFor();
    await twice(page, server, first, 'Untrust');
    await page.locator(first).getByRole('button', { name: 'Trust', exact: true }).waitFor();
    await twice(page, server, first, 'Ban');
    await page.locator(first).getByRole('button', { name: 'Unban' }).waitFor();
    await twice(page, server, first, 'Unban');
    await page.locator('#status', { hasText: 'is unbanned.' }).waitFor();
    assert.deepEqual(
      writes(server).map((w) => w.path),
      ['trust', 'untrust', 'ban', 'unban'].map((a) => `/api/admin/installs/${id}/${a}`),
    );
    await page.locator(`${first} td[data-label="Install"] a`).click();
    await page.locator('#view-title', { hasText: `Install ${id.slice(0, 8)}` }).waitFor();
  });
});

test('appeals: the networks an accept strikes, accept with and without penalty, reject, and the decided tabs', async () => {
  await withConsole(async (page, server) => {
    const base = server.state.appeals[0];
    assert.ok(base);
    server.state.appeals.push({ ...structuredClone(base), id: '0f8fad5b-d9cb-469f-a165-70867728950e', handle: 'xs_pending_demo', marks: { networks: 1, strikes: 0 } });
    server.state.appeals.push({ ...structuredClone(base), id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', handle: 'xs_brake_demo' });
    await login(page);
    await page.keyboard.press('3');
    await page.locator('#appeals-table td', { hasText: '@pendingperson' }).waitFor();
    const row = (handle: string) => `#appeals-table tbody tr:has-text("@${handle}")`;
    assert.equal(await text(page, `${row('pendingperson')} td[data-label="Marks"]`), '4 networks marked it. An accept with penalty strikes 3.');
    assert.equal(await text(page, `${row('xs_pending_demo')} td[data-label="Marks"]`), '1 network marked it. An accept with penalty strikes 0.');
    assert.equal(await page.locator(`${row('pendingperson')} a[href="#account/pendingperson"]`).count(), 1);

    await page.getByRole('textbox', { name: 'Note for @pendingperson' }).fill('Bio code checked.');
    await twice(page, server, row('pendingperson'), 'Accept with penalty');
    await page.locator('#status', { hasText: 'Appeal for @pendingperson accepted with a penalty. The account is cleared.' }).waitFor();
    await twice(page, server, row('xs_pending_demo'), 'Accept without penalty');
    await page.locator('#status', { hasText: 'Appeal for @xs_pending_demo accepted without a penalty.' }).waitFor();
    await twice(page, server, row('xs_brake_demo'), 'Reject');
    await page.locator('#status', { hasText: 'Appeal for @xs_brake_demo rejected.' }).waitFor();
    await page.locator('#appeals-table td.empty', { hasText: 'No open appeals.' }).waitFor();
    await page.locator('[data-count="appeals"][data-zero="true"]').waitFor({ state: 'attached' });

    assert.deepEqual(
      writes(server).map((w) => w.body),
      [
        { decision: 'accept', note: 'Bio code checked.', penalty: true },
        { decision: 'accept', note: '', penalty: false },
        { decision: 'reject', note: '' },
      ],
    );
    await show(page, '#appeals/accepted', 'Appeals');
    await page.locator('#appeals-table td', { hasText: '@xs_cleared_many' }).waitFor();
    assert.equal(await page.locator('#appeals-table tbody tr').count(), 3);
    await page.locator('#appeals-table', { hasText: 'Bio code found. Replies after the date look human.' }).waitFor();
    await show(page, '#appeals/rejected', 'Appeals');
    assert.equal(await page.locator('#appeals-table tbody tr').count(), 2);
  });
});

test('activity: days, one sentence per item, changed fields, kind and subject filters, and "Show older"', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('6');
    await page.locator('#activity-feed .act').first().waitFor();
    assert.deepEqual(requests(server, '/api/admin/activity?kinds='), ['/api/admin/activity?kinds=admin,status,identity,standing,list,appeal,run&limit=50']);
    assert.equal(await page.locator('#activity-feed .act').count(), 50);
    assert.equal(await text(page, '#activity-feed .day-title'), 'Today');
    assert.ok((await page.locator('#activity-feed .day').count()) >= 3);
    assert.deepEqual(await page.$$eval('#activity-filter input[name="kind"]:checked', (els) => els.map((e) => (e as HTMLInputElement).value)), ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run']);

    // An admin item shows its changed fields; the raw state stays behind a toggle.
    const clear = page.locator('#activity-feed .act', { hasText: 'You cleared @xs_cleared_demo with a penalty. The list went to version 118.' });
    const changes = (await clear.locator('.changes > div').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    assert.ok(changes.includes('Account status flagged → cleared'), changes.join(' | '));
    // The arrow is an image named "changed to", so a screen reader says the change in words.
    assert.equal(await clear.locator('.changes .arrow').first().getAttribute('aria-label'), 'changed to');
    assert.equal(await clear.locator('.raw pre').isVisible(), false);
    await clear.locator('.raw summary').click();
    assert.match((await clear.locator('.raw pre').textContent()) ?? '', /"before"/);
    assert.equal(await page.locator('#activity-feed .act', { hasText: 'You logged in' }).first().locator('.raw').count(), 0, 'a login has no state to show');
    await page.locator('#activity-feed a[href="#account/xs_auto_confirm"]').first().waitFor();

    await page.click('#activity-more');
    await page.locator('#activity-end', { hasText: 'This is the oldest recorded item for this filter.' }).waitFor();
    assert.equal(await page.locator('#activity-feed .act').count(), 61, '60 fixture items and your login');
    assert.equal(await page.locator('#activity-more').isVisible(), false);
    assert.equal(requests(server, '/api/admin/activity?kinds=admin,status,identity,standing,list,appeal,run&cursor=o.50&limit=50').length, 1);

    // Only votes.
    for (const kind of ['admin', 'status', 'identity', 'standing', 'list', 'appeal', 'run']) await page.uncheck(`#activity-filter input[value="${kind}"]`);
    await page.check('#activity-filter input[value="vote"]');
    await page.click('#activity-filter button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#activity?kinds=vote');
    await page.locator('#activity-feed .act[data-kind="vote"]').first().waitFor();
    assert.equal(await page.locator('#activity-feed .act:not([data-kind="vote"])').count(), 0);
    assert.match(await text(page, '#activity-feed .act .act-text'), /^Install [0-9a-f]{8} (marked|said not slop on|changed its vote to (slop|not slop) on) @[a-z0-9_]+( as slop)?\.$/);

    // One subject, with the default kinds.
    await show(page, '#activity', 'Activity');
    await page.fill('#activity-subject', '@XS_Pending_Demo');
    await page.click('#activity-filter button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#activity?subject=xs_pending_demo');
    await page.locator('#activity-feed .act').first().waitFor();
    const subjects = await page.$$eval('#activity-feed .act', (els) => els.map((e) => e.textContent ?? ''));
    assert.ok(subjects.length >= 3 && subjects.every((t) => t.includes('@xs_pending_demo')), subjects.join(' | '));

    // A bad subject never leaves the page.
    const sent = server.state.log.length;
    await page.fill('#activity-subject', 'Bad Handle!');
    await page.click('#activity-filter button[type="submit"]');
    await page.locator('#status', { hasText: 'Type a handle of 1 to 15 letters, digits or underscores, or a full install id.' }).waitFor();
    assert.equal(server.state.log.length, sent);

    // The old #log opens the activity of your actions.
    await page.evaluate(() => {
      location.hash = '#log';
    });
    await page.waitForFunction(() => location.hash === '#activity?kinds=admin');
    await page.locator('#activity-feed .act').first().waitFor();
    assert.equal(await page.locator('#activity-feed .act:not([data-kind="admin"])').count(), 0);
  });
});

test('lists, jobs and help: versions with joined and left handles, every run with its numbers, the glossary', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('7');
    await page.locator('#view ol.versions > li').first().waitFor();
    assert.equal(await page.locator('#view ol.versions > li').count(), 7);
    const newest = page.locator('#version-118');
    assert.equal(await newest.locator('a[href="#account/xs_auto_confirm"]').count(), 1);
    assert.equal(await newest.locator('a[href="#account/xs_cleared_demo"]').count(), 1);
    await page.locator('#version-112', { hasText: 'and 61 more' }).waitFor();

    await page.keyboard.press('8');
    await page.locator('#jobs-score tbody tr').first().waitFor();
    assert.deepEqual(requests(server, '/api/admin/jobs'), ['/api/admin/jobs?job=score&limit=50', '/api/admin/jobs?job=profiles&limit=50']);
    assert.equal(await page.locator('#jobs-score tbody tr').count(), 50);
    const failed = page.locator('#jobs-score tbody tr:has(.result[data-ok="false"])');
    assert.equal(await failed.count(), 1);
    assert.equal(await text(page, '#jobs-score tbody tr:has(.result[data-ok="false"]) td[data-label="What it did"]'), 'canceling statement due to statement timeout');
    assert.match(await text(page, '#jobs-score tbody tr:nth-child(1) td[data-label="What it did"]'), /^1,180 accounts scored, 0 changed, 876 listed, list unchanged, 7 pending, 12 installs with standing, 2 networks silenced by strikes, 3 votes past the daily budget\.$/);
    assert.equal(await page.locator('#jobs-profiles tbody tr:has(.result[data-ok="false"])').count(), 1);

    await page.keyboard.press('9');
    await page.locator('#term-gate-standing').waitFor();
    await show(page, '#help/gate-standing', 'Help');
    assert.equal(await page.getAttribute('#term-gate-standing', 'data-current'), 'true');
    await page.waitForFunction(() => {
      const box = document.getElementById('term-gate-standing')?.getBoundingClientRect();
      return box !== undefined && box.top >= 0 && box.bottom <= innerHeight;
    });
    await page.locator('#term-gate-protected', { hasText: '50,000 followers' }).waitFor();
  });
});

test('security: two clicks with a 4 s window, bad hashes make no request, one live request per view, keys', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    // The armed button falls back after 4 s and sends nothing.
    await show(page, '#accounts', 'Accounts');
    const row = '#accounts-table tbody tr:has-text("@xs_auto_confirm")';
    const before = server.state.log.length;
    await page.locator(row).getByRole('button', { name: 'Protect', exact: true }).click();
    await page.locator(row).getByRole('button', { name: 'Yes, protect', exact: true }).waitFor();
    await page.waitForTimeout(4300);
    await page.locator(row).getByRole('button', { name: 'Protect', exact: true }).waitFor();
    assert.equal(server.state.log.length, before);

    // Every bad param shows a message and sends nothing.
    for (const hash of ['#account/GrowthHacker42', '#account/..%2Fadmin', '#account/a_handle_too_long', `#install/${uuidOf('x').toUpperCase()}`, '#install/123', '#review/everything', '#activity?kinds=admin,nope', '#activity?subject=..%2F', '#settings']) {
      await show(page, '#help', 'Help');
      await page.waitForLoadState('networkidle');
      const sent = server.state.log.length;
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await page.locator('#view-title', { hasText: 'Not found' }).waitFor();
      await page.waitForTimeout(150);
      assert.equal(server.state.log.length, sent, `${hash} makes no request`);
      assert.equal(await page.title(), 'Not found: xslop admin');
    }

    // A newer view aborts the older request: a late accounts answer never replaces the installs view.
    await show(page, '#home', 'Home');
    await page.route('**/api/admin/accounts?*', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue().catch(() => undefined);
    });
    await page.keyboard.press('4');
    await page.keyboard.press('5');
    await page.locator('#installs-table tbody tr').first().waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#accounts-table').count(), 0);
    assert.equal(await page.locator('#status[data-kind="error"]').count(), 0, 'the abort is not reported as an error');
    await page.unroute('**/api/admin/accounts?*');

    // Keys: numbers switch views, "/" focuses the filter, "r" reloads, and typing in a field is never a key.
    const keys: [string, string][] = [
      ['1', '#home'],
      ['2', '#review/pending'],
      ['3', '#appeals/open'],
      ['4', '#accounts'],
      ['5', '#installs'],
      ['6', '#activity'],
      ['7', '#lists'],
      ['8', '#jobs'],
      ['9', '#help'],
    ];
    for (const [key, hash] of keys) {
      await page.locator('body').press(key);
      await page.waitForFunction((h) => location.hash === h, hash);
      await page.locator('#view .loading').waitFor({ state: 'detached' });
    }
    await page.locator('body').press('4');
    await page.locator('#accounts-table').waitFor();
    await page.locator('body').press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'accounts-handle');
    await page.keyboard.type('5');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => location.hash), '#accounts');
    await page.fill('#accounts-handle', '');
    await page.locator('#view-title').focus();
    const loads = requests(server, '/api/admin/accounts?').length;
    await page.locator('body').press('r');
    await page.waitForTimeout(400);
    assert.equal(requests(server, '/api/admin/accounts?').length, loads + 1);
  });
});

test('session: a reload keeps it, its end and a logout wipe every view, count and name', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await show(page, '#account/pendingperson', '@pendingperson');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#view-title', { hasText: '@pendingperson' }).waitFor();
    assert.equal(await page.locator('#login-view').isVisible(), false);
    assert.equal(requests(server, '/api/admin/session').length, 1, 'a reload probes the session once');

    const empty = () =>
      page.evaluate(() => ({
        view: document.getElementById('view')?.childElementCount,
        counts: [...document.querySelectorAll('[data-count]')].map((e) => e.textContent + (e.closest('a')?.getAttribute('aria-describedby') ?? '')),
        user: document.getElementById('user-name')?.textContent,
        app: (document.getElementById('app-view') as HTMLElement | null)?.hidden,
      }));
    // 30 minutes without a request: the server answers 401, and the console returns to the login form with nothing left.
    server.state.sessions.clear();
    await page.locator('body').press('r');
    await page.locator('#status', { hasText: 'Your session ended. Log in again.' }).waitFor();
    assert.equal(await page.locator('#login-view').isVisible(), true);
    assert.deepEqual(await empty(), { view: 0, counts: ['', '', ''], user: '', app: true });

    await login(page);
    await show(page, '#activity', 'Activity');
    await page.click('#logout');
    await page.locator('#status', { hasText: 'You are logged out.' }).waitFor();
    assert.equal(server.state.sessions.size, 0);
    assert.deepEqual(await empty(), { view: 0, counts: ['', '', ''], user: '', app: true });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#login-view').waitFor();
  });
});

test('390 px: every view fits without sideways scroll, and table rows show as label and value lines', async () => {
  await withConsole(
    async (page) => {
      await login(page);
      const views: [string, string | RegExp][] = [
        ['#home', 'Home'],
        ['#review/pending', 'Review'],
        ['#review/disputed', 'Review'],
        ['#appeals/open', 'Appeals'],
        ['#accounts', 'Accounts'],
        ['#account/pendingperson', '@pendingperson'],
        ['#account/growthhacker42', '@growthhacker42'],
        ['#installs', 'Installs'],
        [`#install/${uuidOf('install:s5')}`, /^Install /],
        ['#activity', 'Activity'],
        ['#lists', 'Lists'],
        ['#jobs', 'Jobs'],
        ['#help', 'Help'],
      ];
      for (const [hash, title] of views) {
        await show(page, hash, title);
        assert.equal(await horizontalOverflow(page), 0, `${hash} does not scroll sideways`);
        const display = await page.$$eval('#view table.grid tbody td:not(.empty)', (tds) => [...new Set(tds.map((td) => getComputedStyle(td).display))]);
        if (display.length) assert.deepEqual(display, ['grid'], `${hash} rows stack`);
      }
    },
    {},
    { width: 390, height: 844 },
  );
});
