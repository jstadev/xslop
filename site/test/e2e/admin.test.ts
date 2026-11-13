// Admin console end to end (SPEC 5.6, 13.8): login with a code, the review queues, appeals, accounts, installs, the log,
// x-csrf and Origin on every write, one confirm step before each write, the idle end of a session, logout.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { horizontalOverflow, launch, open, serve } from './helpers.ts';
import type { MockState } from './server.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const USER = 'operator';
const PASSWORD = 'correct horse battery staple 42';

type Server = Awaited<ReturnType<typeof serve>>;

async function login(page: Page, code = ''): Promise<void> {
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', PASSWORD);
  await page.fill('#login-code', code);
  await page.click('#login-submit');
  await page.locator('#user-name', { hasText: USER }).waitFor();
}

/** The writes after the login, each with the session csrf and the site origin. */
function writes(server: Server): { path: string; body: unknown }[] {
  const csrf = [...server.state.sessions.values()].at(-1);
  const list = server.state.log.filter((l) => l.method === 'POST' && l.path !== '/api/admin/login');
  for (const w of list) {
    assert.equal(w.csrf, csrf, `${w.path} sends x-csrf`);
    assert.equal(w.origin, server.url, `${w.path} sends Origin`);
  }
  return list.map(({ path, body }) => ({ path, body }));
}

/** Clicks once, checks that nothing was sent, then clicks the armed button. */
async function twice(page: Page, server: Server, scope: string, label: string, armed = `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`): Promise<void> {
  const sent = server.state.log.length;
  await page.locator(scope).getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(scope).getByRole('button', { name: armed, exact: true }).waitFor();
  assert.equal(server.state.log.length, sent, `the first click on ${label} sends nothing`);
  await page.locator(scope).getByRole('button', { name: armed, exact: true }).click();
}

async function withConsole(fn: (page: Page, server: Server, errors: string[]) => Promise<void>, overrides: Partial<MockState['scenario']> = {}): Promise<void> {
  const server = await serve(overrides);
  try {
    const { page, errors } = await open(browser, `${server.url}/admin`, {}, [/401/, /409/]);
    try {
      await fn(page, server, errors);
    } finally {
      await page.context().close();
    }
  } finally {
    await server.close();
  }
}

test('login: no first probe, a code of 6 digits, a wrong or used code like a wrong password', async () => {
  await withConsole(
    async (page, server, errors) => {
      await page.locator('#login-view').waitFor();
      assert.equal(server.state.log.filter((l) => l.path === '/api/admin/session').length, 0, 'a first visit does not probe the session');
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
      assert.equal(await page.locator('#user-name').textContent(), USER);

      // The same code works once.
      await page.click('#logout');
      await page.locator('#status', { hasText: 'You are logged out.' }).waitFor();
      await page.fill('#login-user', USER);
      await page.fill('#login-pass', PASSWORD);
      await page.fill('#login-code', '123456');
      await page.click('#login-submit');
      await page.locator('#login-error', { hasText: 'Wrong username, password or code.' }).waitFor();
      assert.deepEqual(errors, []);
    },
    { adminCode: '123456' },
  );
});

test('overview leads with pending, standing, trusted, struck networks, the X facts job and the owner changes', async () => {
  await withConsole(async (page) => {
    await login(page);
    await page.locator('#overview-data dt').first().waitFor();
    const labels = await page.locator('#overview-data dt').allTextContents();
    assert.deepEqual(labels.slice(0, 7), [
      'Pending accounts',
      'Installs with standing',
      'Trusted installs',
      'Struck networks',
      'X facts job, last run',
      'X facts job, last success',
      'Accounts that changed owner in 24 hours',
    ]);
    assert.ok(labels.includes('Facts detail evidence'), labels.join(', '));
    const values = await page.locator('#overview-data dd').allTextContents();
    assert.deepEqual([...values.slice(0, 4), values[6]], ['1', '1', '0', '2', '3']);
    assert.match(values[4] ?? '', /^1 minute ago \(/);
  });
});

test('review: three queues, every field of a row, each decision asks once and sends its request', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('2');
    const table = '#review-table';
    await page.locator(`${table} td`, { hasText: '@xs_pending_demo' }).waitFor();
    assert.equal(await page.title(), 'Review: xslop admin');
    assert.equal(
      await page.locator('#review-note').textContent(),
      'The votes pass a crowd test, and a gate holds the account back. Your decision publishes it or clears it. The table shows 2 of 2 accounts in this queue.',
    );
    assert.ok(server.state.log.some((l) => l.path === '/api/admin/review?queue=pending&limit=100'));

    const row = page.locator(`${table} tbody tr`, { hasText: '@xs_pending_demo' });
    const cell = async (label: string) => ((await row.locator(`td[data-label="${label}"]`).textContent()) ?? '').trim();
    assert.equal(await cell('Account'), 'Pending Demo <b>Account</b> @xs_pending_demo', 'the name is text, never markup');
    assert.equal(await row.locator('td[data-label="Account"] a').getAttribute('href'), 'https://x.com/xs_pending_demo');
    assert.equal(await cell('Followers'), '1,234');
    assert.equal(await cell('Status'), 'pending');
    assert.equal(await cell('Votes support'), 'Confirm');
    assert.equal(await cell('Gate'), 'Too few marked posts that the server checked.');
    assert.equal(await cell('Networks'), '9');
    assert.equal(await cell('Anchors'), '2');
    assert.equal(await cell('Not slop, standing'), '1');
    assert.equal(await cell('Dissent'), '4');
    assert.equal(await cell('Reply timing'), '90% within a minute, of 12 checked replies. Behaviour 0.77');
    const post = row.locator('td[data-label="Checked posts"] a');
    assert.equal(await post.getAttribute('href'), 'https://x.com/i/status/1850000000000000003');
    assert.equal(await post.getAttribute('rel'), 'noopener noreferrer');
    const other = page.locator(`${table} tbody tr`, { hasText: '@xs_unknown_demo' });
    assert.equal((await other.locator('td[data-label="Gate"]').textContent())?.trim(), 'The server has not matched the handle to its X account. State: unknown.');
    assert.equal((await other.locator('td[data-label="Votes support"]').textContent())?.trim(), 'Flag');
    assert.equal(await other.locator('td[data-label="Checked posts"] a').getAttribute('title'), null, 'a post with a broken date keeps its link and drops the date');

    // The ban names banNetworks (8), not the networks of the engine (9): the count that ban-voters bans.
    assert.equal(await row.getByRole('button', { name: 'Ban the installs that marked it (8 networks)', exact: true }).count(), 1);
    await twice(page, server, `${table} tbody tr:has-text("@xs_unknown_demo")`, 'Ban the installs that marked it (2 networks)', 'Yes, ban the installs of 2 networks');
    await page.locator('#status', { hasText: '@xs_unknown_demo: 2 installs are banned.' }).waitFor();
    await page.locator(`${table} tbody tr:has-text("@xs_unknown_demo")`).getByRole('button', { name: /^Ban the installs/ }).waitFor({ state: 'detached' });

    // Each decision: the first click arms, the second sends.
    await twice(page, server, `${table} tbody tr:has-text("@xs_unknown_demo")`, 'Protect');
    await page.locator('#status', { hasText: '@xs_unknown_demo is protected.' }).waitFor();
    await page.locator(`${table} tbody tr:has-text("@xs_unknown_demo")`).getByRole('button', { name: 'Unprotect' }).waitFor();
    await twice(page, server, `${table} tbody tr:has-text("@xs_pending_demo")`, 'Clear with penalty');
    await page.locator('#status', { hasText: '@xs_pending_demo is cleared with a penalty for its slop voters. The shared list follows at once.' }).waitFor();
    await twice(page, server, `${table} tbody tr:has-text("@xs_unknown_demo")`, 'Confirm');
    await page.locator('#status', { hasText: '@xs_unknown_demo is confirmed.' }).waitFor();
    await page.locator(`${table} td.empty`, { hasText: 'No accounts in the pending queue.' }).waitFor();

    // A starter account is never cleared with a penalty (13.8), so its row does not offer one.
    await page.selectOption('#review-queue', 'disputed');
    await page.locator('#review-filter button[type="submit"]').click();
    const seed = page.locator(`${table} tbody tr`, { hasText: '@growthhacker42' });
    await seed.waitFor();
    assert.equal(await seed.getByRole('button', { name: 'Clear with penalty' }).count(), 0);
    // Above 10 networks ban-voters refuses (409), so the button is off and a click sends nothing.
    const off = seed.getByRole('button', { name: 'Ban the installs that marked it (41 networks, limit 10)', exact: true });
    assert.equal(await off.isDisabled(), true);
    const logged = server.state.log.length;
    await off.click({ force: true });
    assert.equal(server.state.log.length, logged, 'a ban that is off sends nothing');
    await twice(page, server, `${table} tbody tr:has-text("@growthhacker42")`, 'Clear without penalty');
    await page.locator('#status', { hasText: '@growthhacker42 is cleared without a penalty.' }).waitFor();

    await page.selectOption('#review-queue', 'auto');
    await page.locator('#review-filter button[type="submit"]').click();
    const auto = page.locator(`${table} tbody tr`, { hasText: '@xs_auto_confirm' });
    await auto.waitFor();
    assert.equal(await auto.locator('td[data-label="Checked posts"] a').count(), 2);
    assert.equal((await auto.locator('td[data-label="Votes support"]').textContent())?.trim(), 'Nothing');
    await twice(page, server, `${table} tbody tr:has-text("@xs_auto_confirm")`, 'Confirm');
    await page.locator(`${table} td.empty`, { hasText: 'No accounts in the automatic queue.' }).waitFor();

    assert.deepEqual(writes(server), [
      { path: '/api/admin/accounts/xs_unknown_demo/ban-voters', body: {} },
      { path: '/api/admin/accounts/xs_unknown_demo', body: { action: 'protect' } },
      { path: '/api/admin/accounts/xs_pending_demo', body: { action: 'clear', penalty: true } },
      { path: '/api/admin/accounts/xs_unknown_demo', body: { action: 'confirm' } },
      { path: '/api/admin/accounts/growthhacker42', body: { action: 'clear', penalty: false } },
      { path: '/api/admin/accounts/xs_auto_confirm', body: { action: 'confirm' } },
    ]);
  });
});

test('review: the note counts the whole queue, also past the row limit', async () => {
  await withConsole(async (page, server) => {
    const filler = server.state.review[0]!;
    for (let i = 0; i < 60; i++) server.state.review.push({ ...structuredClone(filler), handle: `xs_queue_filler_${i}` });
    await login(page);
    await page.keyboard.press('2');
    await page.locator('#review-note', { hasText: 'The table shows 62 of 62 accounts in this queue.' }).waitFor();
    await page.selectOption('#review-limit', '50');
    await page.locator('#review-filter button[type="submit"]').click();
    await page.locator('#review-note', { hasText: 'The table shows 50 of 62 accounts in this queue.' }).waitFor();
    assert.equal(await page.locator('#review-table tbody tr').count(), 50);
    assert.ok(server.state.log.some((l) => l.path === '/api/admin/review?queue=pending&limit=50'));
    await page.selectOption('#review-queue', 'auto');
    await page.locator('#review-filter button[type="submit"]').click();
    await page.locator('#review-note', { hasText: 'The table shows 1 of 1 account in this queue.' }).waitFor();
  });
});

test('appeals: the networks an accept strikes, accept with and without penalty, reject', async () => {
  await withConsole(async (page, server) => {
    server.state.appeals.push({ ...structuredClone(server.state.appeals[0]!), id: '0f8fad5b-d9cb-469f-a165-70867728950e', handle: 'xs_pending_demo', marks: { networks: 1, strikes: 0 } });
    server.state.appeals.push({ ...structuredClone(server.state.appeals[0]!), id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', handle: 'xs_cleared_demo' });
    await login(page);
    await page.keyboard.press('3');
    await page.locator('#appeals-table td', { hasText: '@pendingperson' }).waitFor();
    const row = (handle: string) => `#appeals-table tbody tr:has-text("@${handle}")`;
    assert.equal((await page.locator(`${row('pendingperson')} td[data-label="Marks"]`).textContent())?.trim(), '4 networks marked it. An accept with penalty strikes 3.');
    assert.equal((await page.locator(`${row('xs_pending_demo')} td[data-label="Marks"]`).textContent())?.trim(), '1 network marked it. An accept with penalty strikes 0.');

    await page.getByRole('textbox', { name: 'Note for @pendingperson' }).fill('Bio code checked.');
    await twice(page, server, row('pendingperson'), 'Accept with penalty');
    await page.locator('#status', { hasText: 'Appeal for @pendingperson accepted with a penalty. The account is cleared.' }).waitFor();
    await twice(page, server, row('xs_pending_demo'), 'Accept without penalty');
    await page.locator('#status', { hasText: 'Appeal for @xs_pending_demo accepted without a penalty.' }).waitFor();
    await twice(page, server, row('xs_cleared_demo'), 'Reject');
    await page.locator('#status', { hasText: 'Appeal for @xs_cleared_demo rejected.' }).waitFor();
    await page.locator('#appeals-table td.empty', { hasText: 'No open appeals.' }).waitFor();

    const [first, second, third] = server.state.appeals;
    assert.deepEqual([first?.status, first?.penalty, first?.note], ['accepted', true, 'Bio code checked.']);
    assert.deepEqual([second?.status, second?.penalty], ['accepted', false]);
    assert.deepEqual([third?.status, third?.penalty], ['rejected', null]);
    assert.deepEqual(
      writes(server).map((w) => w.body),
      [
        { decision: 'accept', note: 'Bio code checked.', penalty: true },
        { decision: 'accept', note: '', penalty: false },
        { decision: 'reject', note: '' },
      ],
    );
  });
});

test('accounts: protect, reset, and the ban of the installs that marked a cleared account', async () => {
  await withConsole(async (page, server, errors) => {
    await login(page);
    await page.keyboard.press('4');
    await page.locator('#accounts-table tbody tr').first().waitFor();
    // A bad handle is refused before any request.
    const sent = server.state.log.length;
    await page.fill('#accounts-handle', 'bad handle!');
    await page.press('#accounts-handle', 'Enter');
    await page.locator('#status', { hasText: 'Type a handle of 1 to 15 letters' }).waitFor();
    assert.equal(server.state.log.length, sent);

    await page.fill('#accounts-handle', '@XS_Cleared');
    await page.press('#accounts-handle', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#accounts-table tbody tr').length === 2);
    const small = '#accounts-table tbody tr:has-text("@xs_cleared_demo")';
    const crowd = '#accounts-table tbody tr:has-text("@xs_cleared_many")';
    assert.equal(await page.locator(small).getByRole('button', { name: 'Clear with penalty' }).count(), 0, 'a cleared account offers no second clear');
    // banNetworks (3), not parts.networks (4): the count that ban-voters checks and bans.
    await twice(page, server, small, 'Ban the installs that marked it (3 networks)', 'Yes, ban the installs of 3 networks');
    await page.locator('#status', { hasText: '@xs_cleared_demo: 3 installs are banned.' }).waitFor();
    await page.locator(small).getByRole('button', { name: /^Ban the installs/ }).waitFor({ state: 'detached' });

    // 10 networks: the ban is on. A vote that lands before the second click makes 11: the server answers 409.
    await page.locator(crowd).getByRole('button', { name: 'Ban the installs that marked it (10 networks)', exact: true }).click();
    server.state.accounts.get('xs_cleared_many')!.banNetworks = 11;
    await page.locator(crowd).getByRole('button', { name: 'Yes, ban the installs of 10 networks', exact: true }).click();
    await page.locator('#status', { hasText: 'More than 10 networks marked this account.' }).waitFor();
    assert.equal(await page.getAttribute('#status', 'data-kind'), 'error');
    // After a reload the row shows 11, and the ban is off.
    await page.locator('body').press('r');
    const off = page.locator(crowd).getByRole('button', { name: 'Ban the installs that marked it (11 networks, limit 10)', exact: true });
    await off.waitFor();
    assert.equal(await off.isDisabled(), true);
    await twice(page, server, small, 'Reset');
    await page.locator('#status', { hasText: '@xs_cleared_demo: the admin decision is removed.' }).waitFor();
    await twice(page, server, small, 'Protect');
    await page.locator(small).getByRole('button', { name: 'Unprotect' }).waitFor();
    assert.equal((await page.locator(`${small} td[data-label="Protected"]`).textContent())?.trim(), 'yes');
    assert.deepEqual(writes(server), [
      { path: '/api/admin/accounts/xs_cleared_demo/ban-voters', body: {} },
      { path: '/api/admin/accounts/xs_cleared_many/ban-voters', body: {} },
      { path: '/api/admin/accounts/xs_cleared_demo', body: { action: 'reset' } },
      { path: '/api/admin/accounts/xs_cleared_demo', body: { action: 'protect' } },
    ]);
    errors.length = 0;
  });
});

test('installs: standing, trust and votes of each side; trust, untrust, ban and unban ask once', async () => {
  await withConsole(async (page, server) => {
    await login(page);
    await page.keyboard.press('5');
    const first = '#installs-table tbody tr:nth-child(1)';
    await page.locator(first).waitFor();
    const cell = async (label: string) => ((await page.locator(`${first} td[data-label="${label}"]`).textContent()) ?? '').trim();
    assert.deepEqual([await cell('Standing'), await cell('Trusted'), await cell('Good marks'), await cell('Slop votes'), await cell('Not slop votes')], ['yes', 'no', '4', '31', '2']);
    await page.selectOption('#installs-sort', 'votes');
    await page.locator('#installs-filter button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#view-installs')?.getAttribute('aria-busy') === null);
    assert.ok(server.state.log.some((l) => l.path === '/api/admin/installs?sort=votes&limit=100'));

    await twice(page, server, first, 'Trust');
    await page.locator(first).getByRole('button', { name: 'Untrust' }).waitFor();
    await twice(page, server, first, 'Untrust');
    await page.locator(first).getByRole('button', { name: 'Trust', exact: true }).waitFor();
    await twice(page, server, first, 'Ban');
    await page.locator(first).getByRole('button', { name: 'Unban' }).waitFor();
    await twice(page, server, first, 'Unban');
    await page.locator('#status', { hasText: 'is unbanned.' }).waitFor();
    const id = server.state.installs[0]?.id;
    assert.deepEqual(
      writes(server).map((w) => w.path),
      ['trust', 'untrust', 'ban', 'unban'].map((a) => `/api/admin/installs/${id}/${a}`),
    );
    assert.equal(server.state.installs[0]?.trusted, false);
    assert.equal(server.state.installs[0]?.bannedAt, null);
  });
});

test('log: the newest changes with the state before, and the session ends after idle time', async () => {
  await withConsole(async (page, server, errors) => {
    await login(page);
    await page.keyboard.press('5');
    await page.locator('#installs-table tbody tr').first().waitFor();
    await twice(page, server, '#installs-table tbody tr:nth-child(1)', 'Trust');
    await page.locator('#status', { hasText: 'is trusted.' }).waitFor();
    await page.keyboard.press('6');
    const newest = page.locator('#log-table tbody tr').first();
    await newest.waitFor();
    assert.equal((await newest.locator('td[data-label="Action"]').textContent())?.trim(), 'trust');
    assert.equal((await newest.locator('td[data-label="Target"]').textContent())?.trim(), server.state.installs[0]?.id);
    assert.match((await newest.locator('td[data-label="Session"]').textContent()) ?? '', /^[0-9a-f]{16}$/);
    assert.equal((await newest.locator('td[data-label="State before"]').textContent())?.trim(), '{"trusted":false,"bannedAt":null}');
    assert.equal(await page.locator('#log-table tbody tr').count(), 2);

    // At 390 px a row stacks as label and value lines, and the page does not scroll sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await horizontalOverflow(page), 0);
    assert.equal(await newest.locator('td[data-label="State before"]').evaluate((td) => getComputedStyle(td).display), 'grid');

    // A reload keeps the session.
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#log-table tbody tr').first().waitFor();
    assert.equal(await page.locator('#login-view').isVisible(), false);

    // 30 minutes without a request: the server answers 401, and the console returns to the login form with nothing left.
    server.state.sessions.clear();
    await page.locator('body').press('r');
    await page.locator('#status', { hasText: 'Your session ended. Log in again.' }).waitFor();
    assert.equal(await page.locator('#login-view').isVisible(), true);
    assert.equal(await page.locator('#app-view td, #overview-data > div').count(), 0, 'no data of the ended session stays in the page');
    assert.equal(await page.locator('#user-name').textContent(), '');
    errors.length = 0;

    await login(page);
    await page.click('#logout');
    await page.locator('#status', { hasText: 'You are logged out.' }).waitFor();
    assert.equal(server.state.sessions.size, 0);
    assert.equal(await page.locator('#app-view td, #overview-data > div').count(), 0, 'no data stays in the page after logout');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#login-view').waitFor();
    assert.deepEqual(errors, []);
  });
});
