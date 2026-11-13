// /sloppers against the mocked API (SPEC 12.5, 12.8).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { horizontalOverflow, launch, open, serve, type Watched } from './helpers.ts';
import type { MockState, Scenario } from './server.ts';

const ROW = '#sl-list .sl-slop:not(.is-skeleton)';
const TOTAL = 876;
const FLAGGED = 64;
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true };

let browser: Browser;

before(async () => {
  browser = await launch();
});

after(async () => {
  await browser.close();
});

interface Run extends Watched {
  url: string;
  state: MockState;
}

async function withPage(path: string, run: (r: Run) => Promise<void>, overrides: Partial<Scenario> = {}, options: BrowserContextOptions = {}): Promise<void> {
  const server = await serve(overrides);
  try {
    const watched = await open(browser, `${server.url}${path}`, options);
    try {
      await run({ ...watched, url: server.url, state: server.state });
    } finally {
      await watched.page.context().close();
    }
  } finally {
    await server.close();
  }
}

describe('/sloppers', () => {
  const rowCount = (page: Page): Promise<number> => page.locator(ROW).count();

  async function waitForRows(page: Page, count: number): Promise<void> {
    await page.waitForFunction(([selector, n]) => document.querySelectorAll(selector as string).length === n, [ROW, count] as const);
  }

  async function waitForResult(page: Page, text: string): Promise<void> {
    await page.waitForFunction((t) => document.querySelector('#sl-result')?.textContent === t, text);
  }

  const handles = (page: Page): Promise<string[]> => page.$$eval(ROW, (rows) => rows.map((row) => (row as HTMLElement).dataset.handle ?? ''));

  /** Records the list requests of the thread. The overview request of the count uses limit=100 and is left out. */
  function watchList(page: Page): URL[] {
    const seen: URL[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/v1/sloppers' && url.searchParams.get('limit') !== '100') seen.push(url);
    });
    return seen;
  }

  test('shows the count, the first page, the stats and the criteria', async () => {
    await withPage('/sloppers', async ({ page, errors, outside }) => {
      assert.equal(await page.title(), 'Sloppers');
      assert.equal(await page.locator('h1').textContent(), 'Sloppers');
      await page.waitForFunction((n) => document.querySelector('#sl-count')?.textContent === n, String(TOTAL));
      assert.equal(await page.locator('#sl-bar-count').textContent(), `${TOTAL} accounts`);
      assert.equal(await page.locator('#sl-count-unit').textContent(), 'sloppers spotted on X');
      assert.equal(await page.locator('#sl-count-unit .x-logo svg').isVisible(), true);
      assert.equal(await rowCount(page), 60);
      assert.equal(await page.locator('#sl-result').textContent(), `${TOTAL} accounts`);
      assert.equal(await page.locator('dd[data-stat="confirmed"]').textContent(), '812');
      assert.equal(await page.locator('dd[data-stat="flagged"]').textContent(), String(FLAGGED));
      assert.match((await page.locator('#sl-updated').textContent()) ?? '', /^Updated /);
      assert.ok((await page.locator('#sl-mosaic img').count()) >= 8, 'the wall has real faces');
      const criteria = (await page.locator('#sl-criteria-body').textContent()) ?? '';
      assert.match(criteria, /Which votes count more/);
      assert.match(criteria, /What protects the list/);
      assert.equal(await page.locator('#sl-criteria > summary').textContent(), 'How an account gets on this list');
      assert.deepEqual(errors, []);
      assert.deepEqual(outside, []);
    });
  });

  test('the wall is darker, and under the mouse a spotlight gives the faces their color back', async () => {
    await withPage('/sloppers', async ({ page, errors }) => {
      const wall = page.locator('#sl-mosaic');
      const lit = page.locator('#sl-mosaic .sl-lit');
      await page.locator('#sl-mosaic .sl-lit img').first().waitFor({ state: 'attached' });
      assert.equal(await page.locator('#sl-mosaic .sl-lit img').count(), await page.locator('#sl-mosaic .sl-tile').count(), 'one color face for each gray face');
      // After the load animation each gray face carries the extra dark.
      await page.waitForFunction(() => /brightness\(0\.63\)$/.test(getComputedStyle(document.querySelector('#sl-mosaic .sl-tile')!).filter));
      assert.equal(await wall.evaluate((el) => getComputedStyle(el).cursor), 'none', 'the cursor is the light');
      const opacity = (): Promise<number> => lit.evaluate((el) => Number(getComputedStyle(el).opacity));
      assert.equal(await opacity(), 0);
      const box = await wall.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 120, box.y + 60);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#sl-mosaic .sl-lit')!).opacity) === 1);
      assert.match(await lit.evaluate((el) => getComputedStyle(el).maskImage), /at 120px 60px/, 'the light sits at the mouse');
      assert.equal(await wall.evaluate((el) => getComputedStyle(el).getPropertyValue('--sl-spot').trim()), '4.55rem', 'the light is 30% smaller than the first 6.5rem');
      await page.mouse.move(box.x + 300, box.y + 30);
      assert.match(await lit.evaluate((el) => getComputedStyle(el).maskImage), /at 300px 30px/, 'the light follows the mouse');
      await page.mouse.move(box.x + 300, box.y + box.height + 200);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#sl-mosaic .sl-lit')!).opacity) === 0);
      assert.deepEqual(errors, []);
    });
  });

  test('every entry carries its facts, its profile link and the button to its record', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const entries = await page.$$eval(ROW, (rows) =>
        rows.map((row) => ({
          handle: (row as HTMLElement).dataset.handle,
          profile: row.querySelector('a.sl-who')?.getAttribute('href'),
          rel: row.querySelector('a.sl-who')?.getAttribute('rel'),
          record: row.querySelector('.sl-row > button.sl-show')?.getAttribute('aria-controls'),
          who: row.querySelector('.sl-who')?.textContent ?? '',
          facts: [...row.querySelectorAll('.sl-fact')].map((fact) => fact.textContent ?? ''),
          status: row.querySelector('.sl-status')?.textContent,
          score: row.querySelector('.sl-score')?.textContent,
          image: row.querySelector('.sl-face img') !== null,
          noPhoto: row.querySelector('.sl-face svg') !== null,
        })),
      );
      assert.equal(entries.length, 60);
      for (const e of entries) {
        assert.equal(e.profile, `https://x.com/${e.handle}`);
        assert.equal(e.rel, 'noopener noreferrer');
        assert.equal(e.record, `sl-panel-${e.handle}`);
        assert.ok(e.who.endsWith(`@${e.handle}`), `${e.who} ends with the handle`);
        assert.match(e.status ?? '', /^(Slopper|Flagged)$/);
        assert.match(e.score ?? '', /^Score\s\d{1,3}$/);
        assert.deepEqual(e.facts.slice(0, 2), [e.status, e.score], 'the status and the score lead the facts');
        assert.match(e.facts.at(-1) ?? '', /^\d+\svotes?\sfrom\s\d+\snetworks?$/u);
        assert.notEqual(e.image, e.noPhoto, `${e.handle} has one face`);
      }
      assert.ok(entries.some((e) => e.noPhoto), 'an account without an avatar shows the default picture');
      assert.ok(entries.every((e) => e.facts.length === 3), 'status, score and votes; the source is only in the record');
    });
  });

  test('a row reads like one reply: the name leads, the facts are quiet, a hairline closes it', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const ink = await page.evaluate(() => getComputedStyle(document.body).color);
      const rows = await page.$$eval(ROW, (els) =>
        els.map((row) => {
          const el = (selector: string): Element => {
            const found = row.querySelector(selector);
            if (!found) throw new Error(`missing ${selector}`);
            return found;
          };
          const lead = el('.sl-name, .sl-handle:first-child');
          const leadStyle = getComputedStyle(lead);
          const factsStyle = getComputedStyle(el('.sl-facts'));
          const statusStyle = getComputedStyle(el('.sl-status'));
          const show = el('.sl-show');
          const body = el('.sl-body').getBoundingClientRect();
          const button = show.getBoundingClientRect();
          return {
            named: row.querySelector('.sl-name') !== null,
            tops: ['.sl-head', '.sl-facts'].map((selector) => el(selector).getBoundingClientRect().top),
            lefts: [lead.getBoundingClientRect().left, el('.sl-status').getBoundingClientRect().left],
            height: el('.sl-row').getBoundingClientRect().height,
            button: [button.left - body.right, button.top + button.height / 2 - (body.top + body.height / 2), button.right - row.getBoundingClientRect().right],
            lead: [leadStyle.color, Number(leadStyle.fontWeight), parseFloat(leadStyle.fontSize)] as const,
            handle: getComputedStyle(el('.sl-handle')).color,
            facts: [factsStyle.color, parseFloat(factsStyle.fontSize)] as const,
            status: [statusStyle.color, Number(statusStyle.fontWeight), statusStyle.borderTopWidth, statusStyle.backgroundColor, statusStyle.textTransform, statusStyle.transform],
            show: getComputedStyle(show).color,
            rule: [getComputedStyle(row).borderBottomWidth, getComputedStyle(row).borderBottomStyle],
            connector: getComputedStyle(row, '::before').content,
            boxes: [...row.querySelectorAll('.sl-row *')].filter((node) => !node.closest('.sl-face') && (getComputedStyle(node).borderTopWidth !== '0px' || getComputedStyle(node).boxShadow !== 'none')).length,
          };
        }),
      );
      assert.equal(rows.length, 60);
      for (const r of rows) {
        assert.ok(r.tops[0]! < r.tops[1]!, 'who, then the facts');
        assert.ok(r.height <= 70, `a compact row, 30% lower than the old 98 px: ${r.height}`);
        assert.ok(r.button[0]! >= 0 && Math.abs(r.button[1]!) <= 1 && r.button[2]! >= -16, `the button sits at the right end, on the middle of the row: ${r.button.join(', ')}`);
        for (const left of r.lefts) assert.ok(Math.abs(left - r.lefts[0]!) <= 1, `one text column: ${r.lefts.join(', ')}`);
        assert.equal(r.lead[0], ink, 'the lead of the head has the text color');
        assert.ok(r.lead[1] >= 600 && r.lead[1] > (r.status[1] as number), 'only the lead is strong');
        assert.ok(r.lead[2] > r.facts[1], 'the facts are one size down');
        assert.notEqual(r.facts[0], ink, 'the facts are quiet');
        if (r.named) assert.equal(r.handle, r.facts[0], 'beside a name the handle is quiet');
        assert.equal(r.show, r.facts[0], 'the button is quiet');
        assert.deepEqual(r.status.slice(2), ['0px', 'rgba(0, 0, 0, 0)', 'none', 'none'], 'the status is a word, not a stamp');
        assert.equal(r.status[0], ink, 'the status reads at a glance');
        assert.deepEqual(r.rule, ['1px', 'solid'], 'a hairline closes the row');
        assert.equal(r.connector, 'none', 'no line joins two accounts');
        assert.equal(r.boxes, 0, 'no box inside the row');
      }
      assert.ok(rows.some((r) => r.named) && rows.some((r) => !r.named), 'the sample holds rows with and without a name');
    });
  });

  test('a fact with no information gives no text', async () => {
    await withPage('/sloppers', async ({ page, url }) => {
      await page.route(/\/api\/v1\/sloppers\?/, async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { items: Record<string, unknown>[] };
        Object.assign(body.items[0] ?? {}, { reason: 'seed', seed: true, status: 'confirmed', tier: 2, score: 80, votes: { slop: 0, notSlop: 0 }, networks: 0, needed: 0, followers: null, listedAt: null, xUserId: null, waits: false });
        await route.fulfill({ response, json: body });
      });
      await page.goto(`${url}/sloppers`, { waitUntil: 'networkidle' });
      const row = page.locator(ROW).first();
      assert.deepEqual(await row.locator('.sl-fact').allTextContents(), ['Slopper', 'Score 80'], 'the source is only in the record');
      assert.doesNotMatch((await row.textContent()) ?? '', /\b0\s(votes?|networks?)/u);
      await row.locator('.sl-show').click();
      assert.deepEqual(await row.locator('.sl-panel dt').allTextContents(), ['Score', 'Status', 'Votes']);
      assert.equal(await row.locator('.sl-card-source strong').textContent(), 'Seed list');
      assert.equal(await row.locator('.sl-record dd').first().textContent(), 'No votes yet.');
      assert.equal(await row.locator('.sl-card-date, .sl-xid').count(), 0, 'an unknown date or X id shows nothing');
      assert.equal(await row.locator('.sl-votebar, .sl-pips').count(), 0);
    });
  });

  test('a row opens to the record and closes again, by button and by tap on the line', async () => {
    await withPage('/sloppers', async ({ page, state }) => {
      const row = page.locator(ROW).first();
      const handle = await row.getAttribute('data-handle');
      const data = state.sloppers.find((s) => s.handle === handle);
      assert.ok(data);
      const show = row.locator('.sl-show');
      assert.equal(await show.getAttribute('aria-label'), `How it got here: @${handle}`);
      await show.click();
      assert.equal(await show.getAttribute('aria-expanded'), 'true');
      assert.equal(await show.getAttribute('title'), 'How it got here', 'the tooltip says what opens; the state is in aria-expanded');
      const panel = row.locator('.sl-panel');
      assert.equal(await panel.getAttribute('id'), await show.getAttribute('aria-controls'));
      await panel.locator('.sl-card').waitFor();
      assert.deepEqual(await panel.locator('dt').allTextContents(), ['Score', 'Status', ...(data.followers === null ? [] : ['Followers']), 'Votes', 'Networks']);
      if (data.listedAt !== null) assert.match((await panel.locator('.sl-card-date').textContent()) ?? '', /^Listed /u);
      assert.equal(await panel.locator('dt').count(), await panel.locator('dd').count(), 'every label has its value');
      const text = (await panel.textContent()) ?? '';
      assert.match(text, /votes? says? slop/);
      assert.match(text, /\d+ of 100/);
      assert.equal(await panel.locator('a[target="_blank"]').getAttribute('href'), `https://x.com/${handle}`);
      assert.equal(await panel.locator('a[target="_blank"]').getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await panel.locator('.sl-card-appeal').getAttribute('href'), `/check?appeal=${handle}`);
      assert.equal(await panel.locator('.sl-card-appeal').getAttribute('aria-label'), `Appeal this listing of @${handle}`);
      await panel.locator('dt').first().click();
      assert.equal(await panel.isVisible(), true, 'a tap inside the record keeps it open');
      await show.click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(await show.getAttribute('aria-expanded'), 'false');
      await row.locator('.sl-status').click();
      assert.equal(await panel.isVisible(), true, 'a tap on the line opens it');
    });
  });

  test('the record button works from the keyboard, in reading order', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const row = page.locator(ROW).first();
      await row.locator('.sl-who').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'sl-show');
      await page.keyboard.press('Enter');
      assert.equal(await row.locator('.sl-panel').isVisible(), true);
      await page.keyboard.press('Space');
      assert.equal(await row.locator('.sl-panel').isVisible(), false);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'sl-who', 'the closed record holds no stop; the next account follows');
    });
  });

  test('a flagged account shows how far it is from confirmed', async () => {
    await withPage('/sloppers?status=flagged', async ({ page, state }) => {
      const row = page.locator(ROW).first();
      const handle = await row.getAttribute('data-handle');
      const data = state.sloppers.find((s) => s.handle === handle);
      assert.ok(data && data.status === 'flagged' && data.needed > 0);
      await row.locator('.sl-show').click();
      const panel = row.locator('.sl-panel');
      const words = data.needed === 1 ? '1 more network' : `${data.needed} more networks`;
      assert.match((await panel.locator('.sl-needed').textContent()) ?? '', new RegExp(`needs marks from at least ${words} to be confirmed`));
      assert.equal(await panel.locator('.sl-pip').count(), data.networks + data.needed);
      assert.equal(await panel.locator('.sl-pip.is-on').count(), data.networks);
    });
  });

  test('an account that waits for a check says so last on its line, and its record shows the X id', async () => {
    await withPage('/sloppers?status=flagged', async ({ page, state }) => {
      const waiting = state.sloppers.find((s) => s.status === 'flagged' && s.waits && s.xUserId !== null);
      assert.ok(waiting);
      await page.locator('#sl-q').fill(waiting.handle);
      // The search draws the list again; a row opened before that closes with it.
      await waitForRows(page, 1);
      const row = page.locator(`${ROW}[data-handle="${waiting.handle}"]`);
      assert.equal((await row.locator('.sl-fact').allTextContents()).at(-1)?.replaceAll('\u00a0', ' '), 'Waits for a check');
      await row.locator('.sl-show').click();
      assert.equal(await row.locator('.sl-needed').count(), 0, 'the crowd test passed: no network is missing');
      assert.equal(await row.locator('.sl-xid').textContent(), `X id ${waiting.xUserId}`);
      // A row that does not wait has no such fact.
      const plain = state.sloppers.find((s) => s.status === 'flagged' && !s.waits);
      assert.ok(plain);
      await page.locator('#sl-q').fill(plain.handle);
      const other = page.locator(`${ROW}[data-handle="${plain.handle}"]`);
      await other.waitFor();
      assert.doesNotMatch((await other.locator('.sl-facts').textContent()) ?? '', /Waits\sfor/u);
    });
  });

  test('search waits for a pause, drops a leading @ and sends one request', async () => {
    await withPage('/sloppers', async ({ page, state }) => {
      const list = watchList(page);
      await page.locator('#sl-q').pressSequentially('@ava', { delay: 30 });
      const expected = state.sloppers.filter((s) => s.handle.includes('ava') || (s.name ?? '').toLowerCase().includes('ava')).length;
      await waitForResult(page, `${expected} accounts match “ava”`);
      assert.equal(list.length, 1, 'one request for the whole burst of typing');
      assert.equal(list[0]?.searchParams.get('q'), 'ava');
      assert.ok(page.url().endsWith('/sloppers?q=ava'));
    });
  });

  test('Enter searches at once', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const sent = page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === 'ben');
      await page.locator('#sl-q').fill('ben');
      await page.locator('#sl-q').press('Enter');
      await sent;
    });
  });

  test('a slow answer for an old search cannot replace the new one', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const failed: string[] = [];
      page.on('requestfailed', (r) => failed.push(r.url()));
      await page.route(/\/api\/v1\/sloppers\?.*q=zzzno/, async (route) => {
        await new Promise((r) => setTimeout(r, 900));
        await route.continue().catch(() => undefined);
      });
      await page.locator('#sl-q').fill('zzzno');
      await page.waitForRequest((r) => r.url().includes('q=zzzno'));
      await page.locator('#sl-q').fill('ava');
      await page.waitForFunction(() => /match “ava”/.test(document.querySelector('#sl-result')?.textContent ?? ''));
      await page.waitForTimeout(1300);
      assert.match((await page.locator('#sl-result').textContent()) ?? '', /match “ava”/);
      assert.equal(await page.locator('#sl-note[data-state="empty"]').count(), 0, 'the empty answer of the old search never shows');
      assert.ok(failed.some((u) => u.includes('q=zzzno')), 'the stale request was aborted');
    });
  });

  test('the status filter narrows the list and the address', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const list = watchList(page);
      await page.locator('.sl-tab[data-status="flagged"]').click();
      await waitForResult(page, `${FLAGGED} flagged accounts`);
      assert.equal(await page.locator('.sl-tab[data-status="flagged"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.sl-tab[data-status="all"]').getAttribute('aria-pressed'), 'false');
      assert.deepEqual([...new Set(await page.locator(`${ROW} .sl-status`).allTextContents())], ['Flagged']);
      assert.equal(list.at(-1)?.searchParams.get('status'), 'flagged');
      assert.ok(page.url().endsWith('?status=flagged'));
      await page.locator('.sl-tab[data-status="flagged"]').click();
      assert.equal(list.length, 1, 'the active tab sends no second request');
    });
  });

  test('sort changes the order of the list', async () => {
    await withPage('/sloppers', async ({ page, state }) => {
      await page.locator('#sl-sort').selectOption('handle');
      await page.waitForURL(/\?sort=handle$/);
      const smallest = [...state.sloppers].map((s) => s.handle).sort()[0];
      await page.waitForFunction((h) => document.querySelector<HTMLElement>('#sl-list .sl-slop')?.dataset.handle === h, smallest);
      const order = await handles(page);
      assert.deepEqual(order, [...order].sort());

      await page.locator('#sl-sort').selectOption('votes');
      const topVotes = [...state.sloppers].sort((a, b) => b.votes.slop - a.votes.slop)[0]?.votes.slop;
      await page.waitForFunction((n) => new RegExp(`\\b${n}\\u00a0votes?\\b`).test(document.querySelector('#sl-list .sl-facts')?.textContent ?? ''), topVotes);
    });
  });

  test('scrolling loads every page to the end with no duplicate', async () => {
    await withPage('/sloppers', async ({ page, state }) => {
      assert.equal(new Set(state.sloppers.map((s) => s.handle)).size, TOTAL, 'the mock itself has unique handles');
      const end = page.locator('#sl-note[data-state="end"]');
      for (let i = 0; i < 60 && !(await end.isVisible()); i++) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(120);
      }
      const seen = await handles(page);
      assert.equal(seen.length, TOTAL);
      assert.equal(new Set(seen).size, TOTAL);
      assert.equal(await end.textContent(), `End of the list: ${TOTAL} accounts.`);
      assert.equal(await page.locator('#sl-more').isVisible(), false);
    });
  });

  test('without IntersectionObserver the button pages, and focus stays on the page', async () => {
    await withPage('/sloppers?status=flagged', async ({ page }) => {
      await page.addInitScript(() => {
        delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
      });
      await page.reload({ waitUntil: 'networkidle' });
      await waitForRows(page, 60);
      await page.locator('#sl-more-button').focus();
      await page.keyboard.press('Enter');
      await waitForRows(page, FLAGGED);
      assert.equal(await page.locator('#sl-more').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), `End of the list: ${FLAGGED} accounts.`);
    });
  });

  test('a deep link is read once and the address is never read back', async () => {
    await withPage('/sloppers', async ({ page, url }) => {
      const list = watchList(page);
      await page.goto(`${url}/sloppers?q=ava&status=confirmed&sort=votes`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('#sl-q').inputValue(), 'ava');
      assert.equal(await page.locator('#sl-sort').inputValue(), 'votes');
      assert.equal(await page.locator('.sl-tab[data-status="confirmed"]').getAttribute('aria-pressed'), 'true');
      const first = list[0];
      assert.ok(first);
      assert.deepEqual([first.searchParams.get('q'), first.searchParams.get('status'), first.searchParams.get('sort')], ['ava', 'confirmed', 'votes']);

      await page.evaluate(() => history.replaceState(null, '', '?q=zzz&status=flagged'));
      await page.locator('#sl-sort').selectOption('handle');
      await page.waitForURL(/sort=handle/);
      const last = list.at(-1);
      assert.deepEqual([last?.searchParams.get('q'), last?.searchParams.get('status'), last?.searchParams.get('sort')], ['ava', 'confirmed', 'handle']);
      assert.ok(page.url().endsWith('?q=ava&status=confirmed&sort=handle'));
    });
  });

  test('bad deep link values fall back to defaults and a long search is capped', async () => {
    await withPage('/sloppers', async ({ page, url }) => {
      const list = watchList(page);
      await page.goto(`${url}/sloppers?status=banned&sort=%3Cscript%3E&q=${'a'.repeat(100)}`, { waitUntil: 'networkidle' });
      const first = list[0];
      assert.ok(first);
      assert.equal(first.searchParams.get('q')?.length, 40);
      assert.equal(first.searchParams.has('status'), false);
      assert.equal(first.searchParams.has('sort'), false);
      assert.equal(await page.locator('#sl-note[data-state="error"]').count(), 0);
    });
  });

  test('an empty list says so and offers no filter reset', async () => {
    await withPage(
      '/sloppers',
      async ({ page }) => {
        await page.locator('#sl-note[data-state="empty"]').waitFor();
        assert.equal(await page.locator('#sl-note p').textContent(), 'The list is empty right now.');
        assert.equal(await page.locator('#sl-note button').count(), 0);
        assert.equal(await page.locator('#sl-count').textContent(), '0');
        assert.equal(await page.locator('#sl-mosaic').isVisible(), false);
      },
      { sloppers: 'empty' },
    );
  });

  test('a search with no match explains it and the reset brings the list back', async () => {
    await withPage('/sloppers?q=nobodyhere&status=flagged', async ({ page }) => {
      await page.locator('#sl-note[data-state="empty"]').waitFor();
      assert.match((await page.locator('#sl-note p').textContent()) ?? '', /No account on the list matches “nobodyhere”/);
      await page.locator('#sl-note button').click();
      await waitForRows(page, 60);
      assert.equal(await page.locator('#sl-q').inputValue(), '');
      assert.equal(await page.locator('.sl-tab[data-status="all"]').getAttribute('aria-pressed'), 'true');
      assert.ok(page.url().endsWith('/sloppers'));
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'sl-q');
    });
  });

  test('a failed load explains itself and Try again recovers', async () => {
    await withPage(
      '/sloppers',
      async ({ page, state }) => {
        await page.locator('#sl-note[data-state="error"]').waitFor();
        assert.match((await page.locator('#sl-note p').textContent()) ?? '', /The list did not load\. The xslop server has a problem right now\./);
        assert.equal(await rowCount(page), 0);
        await page.locator('#sl-focal-error').waitFor();
        state.scenario.sloppers = 'ok';
        await page.locator('#sl-note button').click();
        await waitForRows(page, 60);
        assert.equal(await page.locator('#sl-note').isVisible(), false);
        await page.locator('#sl-focal-error button').click();
        await page.waitForFunction((n) => document.querySelector('#sl-count')?.textContent === n, String(TOTAL));
        assert.equal(await page.locator('#sl-focal-error').isVisible(), false);
      },
      { sloppers: 'down' },
    );
  });

  test('rate limiting tells the reader when to come back', async () => {
    await withPage(
      '/sloppers',
      async ({ page }) => {
        await page.locator('#sl-note[data-state="error"]').waitFor();
        assert.match((await page.locator('#sl-note p').textContent()) ?? '', /Too many requests from your network\. Try again in \d+ minutes?\./);
      },
      { sloppers: 'limited' },
    );
  });

  test('a failed page keeps the rows and retries from the same place', async () => {
    await withPage('/sloppers', async ({ page }) => {
      let failing = true;
      await page.route(/\/api\/v1\/sloppers\?.*cursor=/, async (route) => {
        if (failing) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
        else await route.continue();
      });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator('#sl-note[data-state="error"]').waitFor();
      assert.match((await page.locator('#sl-note p').textContent()) ?? '', /The next accounts did not load\./);
      assert.equal(await rowCount(page), 60, 'the rows on screen stay');
      failing = false;
      await page.locator('#sl-note button').click();
      await waitForRows(page, 120);
      const seen = await handles(page);
      assert.equal(new Set(seen).size, 120);
    });
  });

  test('a search that replaces a loading page leaves no busy button behind', async () => {
    await withPage('/sloppers', async ({ page }) => {
      let held = false;
      await page.route(/\/api\/v1\/sloppers\?.*cursor=/, async (route) => {
        if (!held) {
          held = true;
          await new Promise((r) => setTimeout(r, 1500));
        }
        await route.continue().catch(() => undefined);
      });
      const pageRequest = page.waitForRequest((r) => r.url().includes('cursor='));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await pageRequest;
      assert.equal(await page.locator('#sl-more-button').getAttribute('aria-busy'), 'true');

      await page.locator('#sl-q').fill('xss_probe_name');
      await page.locator('#sl-q').press('Enter');
      await waitForResult(page, '1 account matches “xss_probe_name”');
      await page.locator('#sl-q').fill('');
      await page.locator('#sl-q').press('Enter');
      await waitForResult(page, `${TOTAL} accounts`);
      assert.equal(await page.locator('#sl-more').isVisible(), true);
      assert.equal(await page.locator('#sl-more-button').getAttribute('aria-busy'), null);
    });
  });

  test('an expired cursor offers a walk from the top instead of a retry that cannot work', async () => {
    await withPage('/sloppers', async ({ page }) => {
      await page.route(/\/api\/v1\/sloppers\?.*cursor=/, (route) =>
        route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'stale_cursor', message: 'The list changed. Start again from the top.' } }) }),
      );
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const restart = page.getByRole('button', { name: 'Start from the top' });
      await restart.waitFor();
      assert.match((await page.locator('#sl-note').innerText()).trim(), /^The list changed while you were reading\./);
      assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 0);
      assert.equal(await rowCount(page), 60);

      await page.unroute(/\/api\/v1\/sloppers\?.*cursor=/);
      await page.evaluate(() => {
        const realFetch = window.fetch;
        window.fetch = (input, init) => {
          (window as { __firstCache?: RequestCache | undefined }).__firstCache = init?.cache;
          return realFetch(input, init);
        };
      });
      const firstPage = page.waitForRequest((r) => r.url().includes('/api/v1/sloppers?limit=60'));
      await restart.click();
      await firstPage;
      assert.equal(await page.evaluate(() => (window as { __firstCache?: RequestCache }).__firstCache), 'no-cache', 'a cached first page would carry the expired cursor');
      await page.waitForFunction(() => document.querySelector('#sl-note')?.childElementCount === 0);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      const seen = await handles(page);
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(await page.locator('#sl-more').isVisible(), true);
    });
  });

  test('a broken row is dropped and the rest of the page renders', async () => {
    await withPage('/sloppers', async ({ page, url }) => {
      await page.route(/\/api\/v1\/sloppers\?/, async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { items: Record<string, unknown>[] };
        const first = body.items[0];
        if (first) first.handle = '<b>broken</b>';
        await route.fulfill({ response, json: body });
      });
      await page.goto(`${url}/sloppers`, { waitUntil: 'networkidle' });
      await waitForRows(page, 59);
      assert.equal(await page.locator('#sl-note[data-state="error"]').count(), 0);
    });
  });

  test('names and search text render as inert text', async () => {
    await withPage('/sloppers?q=xss_probe_name', async ({ page, url, state }) => {
      const fixture = state.sloppers.find((s) => s.handle === 'xss_probe_name');
      assert.ok(fixture);
      const { name } = fixture;
      assert.ok(name?.includes('<img'));
      await waitForRows(page, 1);
      const row = page.locator(ROW).first();
      assert.equal(await row.locator('.sl-name').textContent(), name);
      await row.locator('.sl-show').click();
      await row.locator('.sl-panel .sl-card').waitFor();
      assert.equal(await page.locator(`${ROW} b:not(.sl-score b), ${ROW} script, ${ROW} [onerror]`).count(), 0);
      assert.equal(await page.evaluate(() => (window as { __xss?: number }).__xss), undefined);

      const probe = '<img src=x onerror=window.__xss=3>';
      await page.goto(`${url}/sloppers?q=${encodeURIComponent(probe)}`, { waitUntil: 'networkidle' });
      await page.locator('#sl-note[data-state="empty"]').waitFor();
      assert.ok(((await page.locator('#sl-note p').textContent()) ?? '').includes(probe));
      assert.equal(await page.locator('#sl-note img').count(), 0);
      assert.equal(await page.evaluate(() => (window as { __xss?: number }).__xss), undefined);
    });
  });

  test('bidi overrides never reach the page', async () => {
    await withPage('/sloppers?q=bidi_name_case', async ({ page }) => {
      await waitForRows(page, 1);
      assert.equal(await page.locator(`${ROW} .sl-name`).textContent(), 'admingnp.exe');
    });
  });

  test('a row without a name or avatar still reads well, and a dead avatar becomes the default picture', async () => {
    await withPage('/sloppers?q=no_name_at_all', async ({ page, url }) => {
      await waitForRows(page, 1);
      const row = page.locator(ROW).first();
      assert.equal(await row.locator('.sl-face svg[aria-hidden="true"]').count(), 1);
      assert.equal(await row.locator('.sl-name').count(), 0);
      assert.equal(await row.locator('.sl-who').textContent(), '@no_name_at_all', 'the handle leads the line');
      assert.equal(await row.locator('.sl-handle').evaluate((el) => getComputedStyle(el).color), await page.evaluate(() => getComputedStyle(document.body).color));

      await page.route(/\/api\/v1\/avatars\//, (route) => route.fulfill({ status: 404, body: '' }));
      await page.goto(`${url}/sloppers`, { waitUntil: 'networkidle' });
      await page.waitForFunction((row) => document.querySelector(row)?.querySelector('.sl-face svg') !== null, ROW);
      assert.equal(await page.locator(ROW).first().locator('.sl-face img').count(), 0);
    });
  });

  test('the rail is an accordion: one item open at a time', async () => {
    await withPage('/sloppers', async ({ page }) => {
      const meaning = page.locator('.sl-about details').first();
      const criteria = page.locator('#sl-criteria');
      assert.equal(await page.locator('.sl-about details').evaluateAll((els) => new Set(els.map((el) => el.getAttribute('name'))).size), 1, 'the items share a name, so one open item closes the other');
      assert.equal(await meaning.evaluate((el) => (el as HTMLDetailsElement).open), true, 'the first item starts open');
      assert.equal(await criteria.evaluate((el) => (el as HTMLDetailsElement).open), false);
      assert.equal(await meaning.locator('summary').textContent(), 'What this list means');
      await criteria.locator('summary').click();
      assert.equal(await criteria.evaluate((el) => (el as HTMLDetailsElement).open), true);
      assert.equal(await meaning.evaluate((el) => (el as HTMLDetailsElement).open), false, 'the first item closed');
      await meaning.locator('summary').click();
      assert.equal(await meaning.locator('p').first().isVisible(), true);
      assert.equal(await criteria.evaluate((el) => (el as HTMLDetailsElement).open), false);
    });
  });

  test('without JavaScript the page explains itself and links to the data', async () => {
    await withPage(
      '/sloppers',
      async ({ page }) => {
        assert.equal(await page.locator('h1').textContent(), 'Sloppers');
        assert.equal(await page.locator('.sl-nojs').isVisible(), true);
        assert.equal(await page.locator('.sl-nojs a').getAttribute('href'), '/api/v1/sloppers');
        assert.equal(await page.locator('.sl-about').isVisible(), true);
        for (const hidden of ['#sl-controls', '#sl-count-line', '#sl-mosaic', '#sl-metrics']) {
          assert.equal(await page.locator(hidden).isVisible(), false, hidden);
        }
      },
      {},
      { javaScriptEnabled: false },
    );
  });

  for (const [label, options] of [
    ['375 px', PHONE],
    ['768 px', { viewport: { width: 768, height: 1024 } }],
    ['1440 px', { viewport: { width: 1440, height: 900 } }],
  ] as const) {
    test(`${label}: no overflow, 44 px controls, fixed image boxes`, async () => {
      await withPage(
        '/sloppers',
        async ({ page }) => {
          assert.ok((await horizontalOverflow(page)) <= 0, 'no sideways scroll on the first page');
          const controls = await page.$$eval('#sl-q, .sl-tab, #sl-sort, .sl-show', (els) => els.slice(0, 40).map((el) => el.getBoundingClientRect().height));
          for (const height of controls) assert.ok(height >= 44, `control height ${height}`);
          const tabs = await page.$$eval('.sl-tab', (els) => els.map((el) => el.getBoundingClientRect().width));
          for (const width of tabs) assert.ok(width >= 44, `tab width ${width}`);
          const siteLinks = await page.getByRole('navigation', { name: 'Site' }).getByRole('link').allInnerTexts();
          assert.ok(siteLinks.includes('Home') && siteLinks.includes('Check a handle'), `site links: ${siteLinks.join(', ')}`);
          const images = await page.$$eval('#sl-list .sl-face img', (els) => els.map((el) => [el.getAttribute('width'), el.getAttribute('height'), el.getAttribute('loading')]));
          for (const [width, height] of images) assert.deepEqual([width, height], ['40', '40']);
          assert.equal(images[0]?.[2], null, 'the first faces are not lazy');
          assert.equal(images.at(-1)?.[2], 'lazy');
          const row = await page.$eval('#sl-list', (el) => getComputedStyle(el.firstElementChild as Element).contentVisibility);
          assert.equal(row, 'auto');
        },
        {},
        options,
      );
    });
  }

  test('a very long name wraps at phone width', async () => {
    await withPage(
      '/sloppers?q=long_name_case',
      async ({ page }) => {
        await waitForRows(page, 1);
        await page.locator(`${ROW} .sl-show`).click();
        assert.ok((await horizontalOverflow(page)) <= 0);
        const fits = await page.$eval(ROW, (row) => row.scrollWidth <= row.clientWidth);
        assert.equal(fits, true);
      },
      {},
      PHONE,
    );
  });

  test('on a touch screen the row at the middle of the screen lights up', async () => {
    await withPage(
      '/sloppers',
      async ({ page }) => {
        const third = page.locator(ROW).nth(2);
        await third.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + el.getBoundingClientRect().height / 2 - window.innerHeight / 2));
        await page.waitForFunction(() => document.querySelectorAll('#sl-list .sl-slop.is-lit').length === 1);
        assert.equal(await third.evaluate((el) => el.classList.contains('is-lit')), true);
      },
      {},
      PHONE,
    );
  });
});

describe('admin console and 404 page', () => {
  async function logIn(page: Page): Promise<void> {
    await page.fill('#login-user', 'operator');
    await page.fill('#login-pass', 'correct horse battery staple 42');
    await page.click('#login-submit');
    await page.locator('#user-box').waitFor();
  }

  test('a failed logout keeps the console open and says why', async () => {
    await withPage('/admin', async ({ page, state }) => {
      await page.locator('#login-view').waitFor();
      await logIn(page);
      await page.route('**/api/admin/logout', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
      await page.click('#logout');
      await page.locator('#status', { hasText: 'The xslop server has a problem' }).waitFor();
      assert.equal(await page.locator('#app-view').isVisible(), true);
      assert.equal(await page.locator('#login-view').isVisible(), false);
      assert.equal(state.sessions.size, 1);

      await page.unroute('**/api/admin/logout');
      await page.click('#logout');
      await page.locator('#status', { hasText: 'You are logged out.' }).waitFor();
      assert.equal(await page.locator('#status').getAttribute('data-kind'), 'ok');
      assert.equal(state.sessions.size, 0);
    });
  });

  test('login errors are tied to the fields that caused them', async () => {
    await withPage('/admin', async ({ page }) => {
      await page.locator('#login-view').waitFor();
      const invalid = async (): Promise<(string | null)[]> => [await page.getAttribute('#login-user', 'aria-invalid'), await page.getAttribute('#login-pass', 'aria-invalid')];
      assert.equal(await page.getAttribute('#login-user', 'aria-describedby'), 'login-error');
      assert.equal(await page.getAttribute('#login-pass', 'aria-describedby'), 'login-error');
      assert.equal(await page.getAttribute('#login-code', 'aria-describedby'), 'login-error');
      await page.click('#login-submit');
      assert.deepEqual(await invalid(), ['true', 'true']);
      await page.fill('#login-user', 'operator');
      await page.click('#login-submit');
      assert.deepEqual(await invalid(), [null, 'true']);
      await page.fill('#login-pass', 'wrong password');
      await page.click('#login-submit');
      await page.locator('#login-error', { hasText: 'Wrong username, password or code.' }).waitFor();
      assert.deepEqual(await invalid(), ['true', 'true']);
      assert.equal(await page.getAttribute('#login-code', 'aria-invalid'), 'true');
    });
  });

  test('an older accounts answer cannot replace a newer filter, and scores read 0 to 100', async () => {
    await withPage('/admin#accounts', async ({ page, state }) => {
      await page.locator('#login-view').waitFor();
      await logIn(page);
      await page.locator('#accounts-table tbody tr').first().waitFor();
      const all = state.accounts.size;
      assert.ok(all > 1);
      const scores = await page.$$eval('#accounts-table tbody tr', (rows) => rows.map((row) => row.querySelector('td:nth-child(4)')?.textContent));
      assert.deepEqual(new Set(scores), new Set([...state.accounts.values()].map((a) => String(a.score))));

      await page.route(/\/api\/admin\/accounts\?handle=growthhacker42/, async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        await route.continue().catch(() => undefined);
      });
      await page.fill('#accounts-handle', 'growthhacker42');
      const slowRequest = page.waitForRequest((r) => r.url().includes('handle=growthhacker42'));
      await page.press('#accounts-handle', 'Enter');
      await slowRequest;
      await page.fill('#accounts-handle', '');
      await page.press('#accounts-handle', 'Enter');
      await page.waitForTimeout(1000);
      assert.equal(await page.locator('#accounts-table tbody tr').count(), all);
      assert.equal(await page.locator('#status[data-kind="error"]').count(), 0, 'the abort is not reported as an error');
    });
  });

  test('the 404 page links to the list', async () => {
    await withPage('/404.html', async ({ page }) => {
      assert.equal(await page.locator('a[href="/sloppers"]').isVisible(), true);
    });
  });
});
