# xslop

xslop hides AI reply slop on X.

- Install the extension. Every post and reply on x.com gets an xslop button.
- Click it on a slop reply. That account disappears for you at once, and xslop mutes it on your X account.
- Your click is also one vote. An account goes on the global list when voters with earned standing on different networks agree, and the server itself has checked the account and its posts. Anything else waits for a person in a review queue.
- The extension hides the global list for you. Turn on mute sync, and the accounts are muted on your X account, so the X app on your phone hides them too.

xslop uses no X API key, no X login and no token. The server reads public facts from two public sources: the embed answer of X (`cdn.syndication.twimg.com`) and FxTwitter (`api.fxtwitter.com`). Profile pictures come from `pbs.twimg.com`. The live service is https://x-slop.com.

xslop is independent and has no relation with X Corp.

## How the parts fit

| Folder | What it is | What goes in | What comes out |
|---|---|---|---|
| `extension/` | MV3 browser extension for Chromium browsers, Firefox (desktop and Android) and Safari | your clicks on x.com, the global list | hidden replies, mutes on your X account, signed votes |
| `server/` | Node API, Postgres, a score job every 5 minutes and an X facts job every 2 minutes | signed votes, post ids of replies (only with signal sharing on), public facts from the two sources | the global list, account lookups, appeals, the review queue of the admin |
| `site/` | the web pages and the admin console | the public API | https://x-slop.com |

`SPEC.md` is the contract between the three parts: API, data model, scoring, extension and site.
`seed/` holds the starter list (see `seed/README.md`).

## Run it on your computer

You need Node 24 and npm. Clone the repository, then:

```sh
npm run ci:install   # installs the three packages from their lockfiles
npm run build        # builds the extension, the site and the server
```

**The pages only, no database.** This serves the built site with a mocked API:

```sh
node site/test/e2e/server.ts   # prints the local URL
```

**The full service.** The server needs Postgres 15. With Docker:

```sh
docker run -d --name xslop-pg -e POSTGRES_PASSWORD=xslop -p 127.0.0.1:5432:5432 postgres:15-alpine
until docker exec xslop-pg pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
export DATABASE_URL=postgres://postgres:xslop@127.0.0.1:5432/postgres
export XSLOP_SECRET=$(openssl rand -hex 32) XSLOP_IP_SALT=$(openssl rand -hex 32)
export XSLOP_SITE_ORIGIN=http://127.0.0.1:3995
node server/dist/scripts/migrate.js && node server/dist/scripts/import-seed.js && node server/dist/jobs/score.js
node server/dist/main.js       # http://127.0.0.1:3995
```

The score job runs once here. Run `node server/dist/jobs/score.js` again to score new votes. The X facts job, `node server/dist/jobs/profiles.js`, sends requests to the two public sources and to `pbs.twimg.com`. `.env.example` lists every variable that the code reads.

**The extension against your server.** Build it with your API origin, then load `extension/dist/chrome` as an unpacked extension (`chrome://extensions`, Developer mode):

```sh
XSLOP_API=http://127.0.0.1:3995 npm --prefix extension run build
```

## Test

```sh
npm test   # typecheck and tests of the server, the extension and the site
```

`npm test` needs no database. The server tests run on PGlite (Postgres in WebAssembly). To run them against real Postgres too, point `TEST_DATABASE_URL` at a throwaway schema whose name ends in `_test` (the tests drop its tables). With the Docker database above:

```sh
docker exec xslop-pg psql -U postgres -c 'create schema xslop_test'
TEST_DATABASE_URL='postgres://postgres:xslop@127.0.0.1:5432/postgres?options=-c%20search_path%3Dxslop_test' npm --prefix server test
```

The browser tests need Playwright Chromium:

```sh
npm --prefix extension exec -- playwright install chromium
npm run test:e2e
```

`test/system/README.md` describes the system test: the built release, real Postgres in Docker and the extension in Chromium.

## Build the extension zips

```sh
npm --prefix extension run build
```

The build writes `extension/dist/xslop-chrome-v<version>.zip`, `xslop-firefox-v<version>.zip` and `xslop-safari-v<version>.zip`. The zips are deterministic: the same commit gives the same bytes. To make a Safari app from the Safari folder, run `sh scripts/safari/convert.sh` on a Mac with Xcode.

## How an account gets on the list

- In plain words: `docs/list-flow-explained.md` and the page https://x-slop.com/rules.
- Who attacks the list, the rule that stops each attack, and the risks that stay: `docs/threat-model.md`.
- The rules, the numbers and the tests: `SPEC.md` section 13 and `server/src/scoring/README.md`.

## Report a listing

- **Your own account is on the list.** Appeal at https://x-slop.com/check. You put a code in your X bio, and an admin checks it by hand.
- **Another account is on the list and should not be.** Click "Not slop" on its hidden reply in the extension. The account shows again for you at once. Your vote counts against the listing when your install has standing (`docs/list-flow-explained.md`).
- **A security weakness.** Do not open an issue. Follow `SECURITY.md`.

## Contribute

Read `CONTRIBUTING.md`. The code is under the MIT licence (`LICENSE`). Fonts, libraries and marks of others are listed in `THIRD_PARTY.md`.
