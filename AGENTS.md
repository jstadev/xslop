# xslop

xslop hides AI reply slop on X. Users install a browser extension (Chromium browsers, Firefox desktop and Android, Safari through a Mac conversion). Each post and reply on x.com gets an xslop button; a click marks the author as slop, hides the account and mutes it on X at once. The server publishes a global list. An account goes on it automatically only when installs with earned standing on separate networks vote for it and the server itself checked the account and its posts on X (SPEC 13); everything else waits for an admin in the review queue. The extension hides that list, and an opt-in mute sync mutes the accounts by X id on the user's own X account, so the X phone app hides them too. No X API key and no user tokens: the server reads public facts from `cdn.syndication.twimg.com` and `api.fxtwitter.com`. The seed standard is the public X list "ai slop posters" (`seed/`). Live at https://x-slop.com.

## Read first

- `SPEC.md`: the contract for API, data model, scoring, extension and site.
- `PLAN.md`: the current version, the goal and the next release.
- `CONTRIBUTING.md`: the rules that every change meets.
- `docs/threat-model.md`: before a change of the list rules, the scoring, the X facts job or the admin API.
- `deploy/project.json`: the manifest of the maintainer's deployment.
- On the maintainer's host: `docs/operations.md`. It names the host paths, the channels and the release steps.

## Run and test

- Node 24 and npm.
- Install: `npm run ci:install`. Build: `npm run build`.
- Test (the release gate): `npm test`. Server integration tests run on PGlite without a database.
- Real database run of the server suite: `TEST_DATABASE_URL=<URL of a throwaway schema named *_test> npm --prefix server test` (`README.md` shows one; on the maintainer's host, `docs/operations.md`).
- Browser tests: `npm run test:e2e` (Playwright Chromium; install it once with `npm --prefix extension exec -- playwright install chromium`).
- System test (Docker, real Postgres, built release): `test/system/README.md`.

## Release

Versions are git tags `vMAJOR.MINOR.PATCH` on `main`. Releases belong to the maintainer; `docs/operations.md` has every step.
1. Merge to `main` and push.
2. Run `proj release xslop staging`. It builds, tests, migrates the staging schema and switches staging.
3. The maintainer approves that version. Then run `proj release xslop prod`. It promotes the same build.
4. Load https://x-slop.com and `/api/health`.

The extension zips in a release always call https://x-slop.com, also when staging serves them.

Never edit the release folders by hand.

## Secrets

The variable names live in `.env.example`.
The values live only in the env files of the deployment (`docs/operations.md`).
Never write a value into the repo, a log, a test or a client bundle.
The admin password lives only as a scrypt hash in `XSLOP_ADMIN_HASH`.

## Rules

- Keep the main clone clean. Edit in a branch or a worktree.
- `server`, `extension` and `site` are separate npm packages. Never use npm workspaces.
- Nothing that costs nothing decides anything: a vote of an install without standing never changes the published list by itself (SPEC 13.1).
- Sightings never store an install id. Do not add one.
- The x.com selectors and the mute settings live in `server/config/extension-config.json`. Repair X markup changes there first.
- Code and text rules: `CONTRIBUTING.md`. Known attacks and the risks that stay: `docs/threat-model.md`.

## Where things are

- `server/`: Fastify API, migrations, score job, X facts job, static serving, admin API.
- `server/src/scoring/`: the pure scoring engine (standing, anchors, gates, the one-camp veto, reputation, strikes) and its README with the rules.
- `extension/`: the MV3 extension for Chromium browsers, Firefox and Safari.
- `site/`: the landing page, the footer pages (`/how-it-works`, `/rules`, `/download`, `/check`, `/privacy`, `/questions`), the `/sloppers` page, the admin console and the 404 page. Shared head, mark and footer: `site/partials/`.
- `brand/`: logo, icons, fonts and design tokens.
- `seed/`: the seed list and its source.
- `docs/`: the list flow in plain words, the threat model, and the maintainer's operations.
- `deploy/`: the manifest and the unit templates.
- `scripts/safari/`: the Safari conversion on a Mac.
- `test/system/`: the system test of the built release.
- `.github/`: issue and pull request templates, the test workflow.
