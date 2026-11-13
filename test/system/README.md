# xslop system test

One command runs the real parts of xslop together and proves the judging flow of `SPEC.md` section 13:

```
node --test --test-concurrency=1 test/system/system.test.mjs
```

The run needs Node 24, Docker with the image `postgres:15-alpine`, Playwright Chromium, and `npm run ci:install` done once. It takes about four minutes. It builds into `/tmp/xslop-r-system/run-<pid>/` and removes that folder, the container and the browsers at the end. It never writes into a package's `dist` folder.

If a run dies before its cleanup, remove the leftovers with `docker rm -f $(docker ps -aq --filter name=xslop-r-system)` and `rm -rf /tmp/xslop-r-system`.

## The story of one run

1. A fresh release: migrations 001 to 005, the seed import and the first score run. The list holds every starter account with its X id.
2. Five new users on five networks install the built extension and mark one account. Each sees it hidden and muted at once. After the score run the account is `pending` with gate `identity` (rule 5 checks the identity gate before the standing gate), and no public answer shows it. A sixth user's browser does not hide it.
3. The X facts job checks every pending account (work order (3)): the account and its marked posts; then the gate is `standing`. A day later the crowd test of a confirm passes. The admin signs in to the console with a TOTP code and confirms it from the Pending queue. The list has it in the same minute without a score run, the sixth user's open tab hides it, the Log view shows the change, and mute sync mutes it by X id.
4. Two more admin confirms and a week give the five installs standing. Four of them mark a second account with two checked posts: it is confirmed with no admin action. A third account with one checked post is flagged with gate `evidence`.
5. Attacks through the signed protocol: 30 new networks mark an account; 30 new installs say "not slop" on a starter account; installs without standing on the address of a user with standing vote against that user; one network sends 60 votes in a day. Nothing public changes, and 50 of the 60 votes count. One first-day install that marks an account starts no request of the X facts job; the account of two is checked through work order (3) and stays pending.
6. A listed account renames. Its state follows its X id to the new handle; the old handle leaves the list; mute sync moves its mute record by id and makes no X call.
7. An appeal from `/check` with real proof of work; the admin accepts it with penalty in the console; the account leaves the list in the same minute. Its voters lose their standing; a second clear with penalty silences their networks.
8. The public pages render from the build with the real content security policy and no console error. `/rules` shows every sentence of the criteria that the server publishes.

The run also keeps the older checks that still hold: the signature path refuses replayed, tampered, unknown and malformed requests; the release zips match their hashes; a v1.0.1 database upgrades with nothing lost; every request of the real extensions succeeds; and the server log holds no vote text, address or secret, and one line per admin change.

## What is real

- The server from a real `tsc` build, started as the unit starts it, with only the documented environment, the admin TOTP secret included.
- The migrate command from `deploy/project.json`: all migrations, the seed import, the score job.
- Postgres 15 with a role whose `search_path` selects the schema, as in production.
- The built extension, one build and one Chromium profile per network, with real proof of work and real P-256 signatures. The popup turns on mute sync.
- The built site pages and the admin console in Chromium, with the real content security policy, the real session cookie and a real RFC 6238 code.
- The score job and the X facts job from the build. Their writes, the rename move and the list publish run on the real database.
- A v1.0.1 database that the v1.0.1 code filled (see below).

## What is a stand-in

- x.com is a fixture page from `extension/test/fixtures`, and X's web API is answered in the browser. X answers a mute with the id and the current handle of the account.
- The two fact sources and the image host (`cdn.syndication.twimg.com`, `api.fxtwitter.com`, `pbs.twimg.com`) are one HTTP server on this machine (`XWorld` in `x-fixture.mjs`). The X facts job gets a `fetch` that sends each real URL there; the job's pause of 2 seconds is recorded, not waited.
- A reverse proxy per network acts like Caddy: it writes `X-Forwarded-For` and forwards from loopback. The server's trust settings do not change.
- `Bot` clients in `harness.mjs` speak the signed protocol where a step needs volume: the attacks and the votes of step 5.
- Time: the test moves `installs.created_at` (a day, then a week), and `identity_at` and `profiles.fetched_at` of one account (a week), in SQL. The job's own clock stays real.
- The extension build uses `--test`: open shadow roots and a 1 s mute floor. The list sync fires through the real `list` alarm, because the popup path allows one sync per minute.

## What this run cannot prove

- That the real X accepts these mute calls, or that the X markup still matches the fixture.
- That the real embed answer of X and fxtwitter answer as the stand-in does, or that X keeps the time in its post ids.
- That real Caddy behaves like the proxy here.
- Behaviour in Firefox or Safari, and on a phone.
- The timers: the test runs each job by hand, in the order that the story needs.
- A brake or a protected account: the engine and server suites prove those.

## The v1.0.1 fixture

`fixtures/v1.0.1/database.sql.gz` is a `pg_dump` of a database that the deployed v1.0.1 code filled through its own migrations, seed import, score job and web server. `make-dump.mjs` wrote it. To write it again, run:

```
node test/system/fixtures/v1.0.1/make-dump.mjs <folder of the v1.0.1 release>
```

The test moves the dump's clock to today, so retention treats the rows as recent on every future run. Its stored deltas have no X ids, so a delta from a v1.0.1 version answers 410 and the extension fetches the full list once.
