# The maintainer's deployment

This file describes the maintainer's own deployment of xslop at https://x-slop.com, on one Linux host with the maintainer's project tool `proj`. You need none of it to build, test or run xslop elsewhere: `README.md` covers that.

## The host

- Manifest: `deploy/project.json`, read by `proj`.
- Node 24: `export PATH=/opt/node24/bin:$PATH`.
- The canonical clone `/srv/projects/xslop` stays clean. Edit only in a worktree under `/srv/work/xslop-<task>`.
- Release folders: `/srv/apps/xslop/releases/<version>`, switched by `proj`. Never edit `/srv/apps/xslop` by hand.

## Channels

| Channel | Domains | Port | Schema | Env file |
|---|---|---|---|---|
| prod | https://x-slop.com, https://www.x-slop.com | 3995 | `xslop` | `/etc/xslop/app.env` |
| staging | https://xslop.koglabs.com | 13995 | `xslop_staging` | `/etc/xslop/staging.env` |

Each channel has its own units (`xslop-web`, the timers `xslop-score` every 5 minutes and `xslop-profiles`, the X facts job, every 2 minutes), data folder and schema. The unit templates are in `deploy/units/`.

## Release

1. Merge to `main` and push.
2. Run `proj release xslop staging`. It builds, tests, migrates the staging schema and switches staging. It deploys `origin/main`, so check `git log origin/main` first.
3. Load https://xslop.koglabs.com and `/api/health`, and give the maintainer the staging link.
4. The maintainer approves that version. Then run `proj release xslop prod`. It promotes the same build.
5. Load https://x-slop.com and `/api/health`.

## Secrets

- Values live only in `/etc/xslop/app.env` (prod), `/etc/xslop/staging.env` (staging) and `/etc/xslop/test.env` (the test role, schema `xslop_test`).
- Set `XSLOP_ADMIN_TOTP` (a base32 secret) in both channel env files. Without it, the admin password alone opens a session.
- After a change of `XSLOP_ADMIN_HASH` or `XSLOP_ADMIN_TOTP`, run `delete from admin_sessions` in that schema. Sessions do not depend on either value.

## Store listings

- When a store lists xslop, put its listing URL into `XSLOP_CHROME_STORE_URL` or `XSLOP_FIREFOX_STORE_URL` in both channel env files and restart `xslop-web`. The server reads them at start. Then `/downloads/latest.json` names the listing, and the pages show the store button within 5 minutes (the cache time of that file).
- If the log of `xslop-web` shows `ignored a bad optional variable`, the value is not a listing URL (section 5.7 of `SPEC.md`). The page then keeps the zip path.

## Tests on the host

- Real Postgres: `set -a; . /etc/xslop/test.env; set +a; npm --prefix server test`. Run it alone: two runs on `xslop_test` at once fail with a statement timeout.
- The design gate (`site/test/e2e/gate.test.ts`) needs the design kit of the host and skips without it.

## Edge and DNS

- Caddy serves both channels, adds `Strict-Transport-Security` and drops a client-sent `X-Forwarded-For` (no `trusted_proxies`). If a CDN ever sits in front of Caddy, set `trusted_proxies` in Caddy first.
- The zone x-slop.com has CAA records (letsencrypt.org, sectigo.com) and a DMARC record with `p=reject`. Before any mail goes out as @x-slop.com, set up DKIM and an aligned SPF. Before another CA issues a certificate, add its CAA record.
- The extension ids carry the maintainer's domain: Firefox `xslop@koglabs.com`, Safari bundle `com.koglabs.xslop`. Once a store lists the extension, a new id means a new listing and installed copies do not update to it.
