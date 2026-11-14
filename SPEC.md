# xslop specification

This file is the contract for the API, the data model, the scoring, the
extension and the site. A change of the contract changes this file in the same
pull request. Later sections win over earlier ones where they differ.

## 1. Product

xslop hides AI reply slop on X (x.com). You install a browser extension. Each
reply on X gets a small xslop button. One click marks the reply author as slop:
the extension hides that account's replies for you at once and records your
vote. The server combines the votes of all users and the behaviour signals that
the extensions observe, and it publishes a global list of confirmed slop
accounts. The extension hides those accounts for every user who wants it.
Optional mute sync mutes the confirmed accounts on your own X account, so they
also disappear in the X app on your phone.

- No X API, no tokens, no X login for users. The extension works in the X web
  page only.
- The starting standard: the 793 accounts of the public X list "ai slop
  posters" (`seed/ai-slop-list.json`) and the 1,430 accounts of the public
  Clankwall list (`seed/clankwall.json`, 1,046 of them not on the first list).
  They are seed accounts, confirmed from day one, and still open to appeal.
- Domain: `https://x-slop.com`. Brand name: `xslop` (lower case). The x
  means "crossed out", not the X company. Never imply a relation with X Corp.
- Runtime: Node 24, Postgres 15 (schema `xslop`), one web process on port
  3995 behind a reverse proxy (Caddy), one scoring job every 5 minutes.

## 2. Repo layout

Independent npm packages, each with its own `package.json`, lockfile and
`node_modules`. No npm workspaces.

| Path | What |
|---|---|
| `server/` except `server/src/scoring/`, `server/test/scoring/` | API, DB, migrations, jobs, static serving, admin API, seed import |
| `server/src/scoring/`, `server/test/scoring/` | Pure scoring engine, no I/O |
| `extension/` | MV3 extension for Chrome and Firefox (desktop and Android) |
| `site/`, `brand/` | Landing page, admin page, logo and icons |
| root files, `deploy/`, `seed/`, `SPEC.md` | Docs, the deployment manifest, the seed list, this contract |

`server/package.json` pins exact versions: fastify 5.12.8, pg 8.23.1, typescript 7.0.2,
vitest 5.1.0, @electric-sql/pglite 0.5.15, @types/node 24, @types/pg.
The scoring engine has no dependency. The server adds a dependency only when the
Node standard library cannot do the job.

Root scripts: `npm run build` builds extension, site, then server.
`npm test` runs `server`, `extension`, `site` tests. The release gate runs
`npm run ci:install && npm run build` and then `npm test`, in a sandbox **without
network to the database and without env files**. So every `npm test` must pass
without `DATABASE_URL`: server integration tests use PGlite (real Postgres in
WASM). When `TEST_DATABASE_URL` is set, the same suite also runs against that
real Postgres (the maintainer does this before each release, on a throwaway
schema).

## 3. Security rules

- Validate every input with explicit types, lengths and patterns. Reject
  unknown fields. Body limit 64 KB. Return the error shape
  `{"error":{"code":"snake_case","message":"Plain text"}}`.
- Parameterized SQL only. No string-built SQL with input.
- No secret in the repo, a test, a log or a client bundle. Server reads secrets
  only from env vars (names in section 9).
- Log no request bodies, no reply texts, no IPs. Hash IPs (section 5.1).
- Every route has its rate limit (section 5.8).
- Extension: no remote code, no `eval`, no `innerHTML` with data (use
  `textContent` and DOM APIs), minimal permissions, strict CSP.
- Site: `default-src 'self'`; no CDN, no third-party script or font; self-host
  fonts.

## 4. Data model (Postgres)

Migrations live in `server/migrations/NNN_name.sql`, run in order by
`server/dist/scripts/migrate.js`, recorded in `schema_migrations`, each in one
transaction, under `pg_advisory_lock`. Unqualified table names; the role's
`search_path` selects the schema.

```
installs(id uuid pk, public_key jsonb not null, created_at timestamptz, ip_hash text not null,
         reputation real not null default 0.5, banned_at timestamptz, last_seen_at timestamptz,
         ext_version text)
accounts(handle text pk  -- lower case, ^[a-z0-9_]{1,15}$
         x_user_id text, display_handle text, first_seen_at timestamptz,
         status text not null default 'none' check (status in ('none','flagged','confirmed','cleared')),
         score real not null default 0, tier smallint not null default 0 check (tier in (0,1,2)),
         seed boolean not null default false, seed_source text, profile jsonb,
         cleared_at timestamptz, override text check (override in ('confirm','clear')),
         parts jsonb, updated_at timestamptz)
votes(install_id uuid references installs on delete cascade, handle text references accounts,
      value smallint not null check (value in (0,1)),   -- 1 = slop, 0 = not slop
      tweet_id text, parent_tweet_id text, text text, posted_at timestamptz,
      created_at timestamptz, updated_at timestamptz, primary key (install_id, handle))
sightings(tweet_id text pk, handle text not null, parent_tweet_id text, parent_handle text,
          reply_at timestamptz not null, parent_at timestamptz, latency_sec integer,
          text_len integer, simhash text,  -- 16 lower-case hex chars
          generic_score real, overlap_score real, has_media boolean, verified boolean,
          created_at timestamptz)          -- NO install id here, by design (privacy)
          index (handle, reply_at desc)
list_snapshots(version bigserial pk, generated_at timestamptz, count integer,
               body_gzip bytea, body_br bytea, delta jsonb, etag text)
appeals(id uuid pk, handle text, email text, message text, code text, status text
        check (status in ('open','accepted','rejected')), created_at, decided_at, note text, ip_hash text)
admin_sessions(token_hash text pk, csrf text, created_at, expires_at, ip_hash text)
used_challenges(challenge_hash text pk, expires_at timestamptz)
jobs(name text pk, last_run_at timestamptz, last_ok_at timestamptz, detail jsonb)
```

Retention, done by the scoring job: sightings older than 30 days, used
challenges past expiry, expired admin sessions, list snapshots beyond the
newest 60.

## 5. HTTP API

Base `https://x-slop.com`. JSON in and out. Times are ISO 8601 UTC.
Tweet ids match `^[0-9]{1,20}$`. Handles: input is trimmed, a leading `@` is
removed, then lower-cased, then must match `^[a-z0-9_]{1,15}$`.

### 5.1 Client identity: installs, proof of work, signatures

- IP hash: `HMAC-SHA256(XSLOP_IP_SALT, prefix)` hex, first 32 chars, where
  prefix is the IPv4 /24 or IPv6 /48 of the client. The client IP is the
  `X-Forwarded-For` value that Caddy appends (only trust it when the socket
  peer is 127.0.0.1 or ::1).
- `GET /api/v1/challenge` → `{"challenge": "<token>", "difficulty": 18}`.
  The token is `base64url(json{"n":nonce16,"exp":unixSec,"p":purpose})` + `.` +
  `base64url(HMAC-SHA256(XSLOP_SECRET, payload))`. `purpose` is `install` or
  `appeal` (query `?purpose=`). Expires in 10 minutes. Difficulty is
  configurable (env `XSLOP_POW_BITS`, default 18).
- Proof: find a string `nonce` (≤ 32 chars) so that
  `SHA-256(utf8(challenge + ":" + nonce))` starts with `difficulty` zero bits.
  A challenge is single use (`used_challenges`).
- `POST /api/v1/installs` body
  `{"publicKey": {"kty":"EC","crv":"P-256","x":"..","y":".."}, "challenge": "..", "nonce": "..", "extVersion": "1.0.0"}`
  → `201 {"installId": "<uuid>", "createdAt": ".."}`. Only `kty, crv, x, y`
  are accepted in the JWK (reject `d`).
- Signed requests carry headers:
  - `x-xslop-install`: install uuid
  - `x-xslop-ts`: unix milliseconds; reject if more than 300 s from server time
  - `x-xslop-nonce`: 16 random bytes, base64url (22 chars); reject a nonce
    seen for this install in the last 10 minutes (in-memory TTL map is fine;
    every signed write is idempotent, so a replay after a restart does no harm)
  - `x-xslop-sig`: base64url ECDSA P-256 SHA-256 signature in IEEE P1363 form
    (64 bytes r||s, the WebCrypto output) over the UTF-8 string
    `"XSLOP1\n" + METHOD + "\n" + pathWithQuery + "\n" + ts + "\n" + nonce + "\n" + base64url(SHA-256(rawBody))`
    (rawBody is the exact request bytes; empty body hashes the empty string).
  - Node verify: `crypto.verify('sha256', data, {key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363'}, sig)`.
  - Unknown install → 401 `unknown_install`. Banned → 403 `banned`. Bad
    signature → 401 `bad_signature`. Update `last_seen_at` at most once per hour.

### 5.2 Votes (signed)

- `POST /api/v1/votes` body
  `{"handle":"..","value":"slop"|"not_slop","tweetId":"..","parentTweetId":".."|null,"postedAt":"ISO"|null,"context":"reply"|"post"}`
  → `200 {"handle":"..","value":"..","account":{"status":"..","tier":0}}`.
  `account` is the public state of the account, as `GET /api/v1/accounts/:handle` answers it:
  `flagged` or `confirmed` with its tier when the account is on the list, else `none` with tier 0 (13.3, 13.11).
  Upsert on (install, handle). Creates the account row when missing.
  The route also accepts `"text"` (a string of at most 560 characters, or null), because installed
  extensions of older builds send it. The server never stores it: the insert and the update write
  `votes.text = null`.
- `DELETE /api/v1/votes/:handle` → `204`.
- `GET /api/v1/me` → `{"installId","createdAt","reputation","votes":[{"handle","value","at"}]}`
  (newest 5000).

### 5.3 Observations (signed)

`POST /api/v1/observations` body `{"items":[...]}`, 1 to 100 items:

```
{"handle","tweetId","parentTweetId"|null,"parentHandle"|null,
 "replyAt":"ISO","parentAt":"ISO"|null,"textLen":0..2000,"simhash":"16 hex",
 "genericScore":0..1,"overlapScore":0..1,"hasMedia":bool,"verified":bool}
```

Insert into `sightings` with `on conflict (tweet_id) do nothing`;
`latency_sec = replyAt - parentAt` when both exist and ≥ 0, else null.
Reject `replyAt` more than 10 minutes in the future or older than 30 days.
→ `202 {"accepted": n}`. Never store the install id with a sighting.

### 5.4 Global list (public, unsigned)

- `GET /api/v1/list` → the newest snapshot:
  `{"v":1,"version":123,"generatedAt":"..","accounts":[["handle",score0to100,tier],...]}`
  sorted by handle. Only tier 1 and 2 accounts. `ETag: "<version>"`;
  `If-None-Match` → 304. `Cache-Control: public, max-age=60`. Serve the stored
  `body_br` or `body_gzip` with `Content-Encoding` when `Accept-Encoding`
  allows, else gunzip once and cache in memory.
- `GET /api/v1/list/delta?since=<version>` →
  `{"v":1,"from":since,"version":newest,"add":[[h,s,t],...],"remove":["h",...]}`
  composed from stored deltas. `since` equal to newest → 304. `since` older
  than the oldest kept delta, or unknown → 410 `delta_gone` (the client then
  fetches the full list). `add` also carries accounts whose score or tier changed.
- The web process caches the newest snapshot in memory and checks
  `max(version)` at most every 15 s.

### 5.5 Accounts, appeals, stats, config (public)

- `GET /api/v1/accounts/:handle` →
  `{"handle","status","tier","score":0..100,"seed":bool,"votes":{"slop":n,"notSlop":n},"sightings":n,`
  `"signals":{"fastReplyShare":0..1,"duplicateShare":0..1,"genericShare":0..1}|null,`
  `"evidence":[{"text","tweetId","at"}] (≤3), "appealOpen":bool}`. Evidence comes only from
  installs older than 7 days with reputation ≥ 0.7, not banned, one per network, newest
  first by vote creation time, and only for listed accounts.
  Unknown handle → 200 with `status:"none"`. Exact handle only; no search, no listing.
- `POST /api/v1/appeals` body `{"handle","email"|null,"message":20..2000 chars,"challenge","nonce"}`
  (proof of work, purpose `appeal`) → `201 {"appealId","code":"xslop-XXXXXX","status":"open"}`.
  The person proves ownership by putting the code in the X bio; an admin checks it by hand.
  One open appeal per handle and network, at most 5 open appeals per handle (409 `appeal_open`).
- `GET /api/v1/appeals/:id` → `{"appealId","handle","status","createdAt","decidedAt"}`.
- `GET /api/v1/stats` → `{"confirmed","flagged","votes","installs","sightings","generatedAt"}`, cached 60 s.
- `GET /api/v1/config` → the file `server/config/extension-config.json`
  (section 7.6), `Cache-Control: public, max-age=600`.
- `GET /api/health` → `200 {"ok":true,"db":true,"scoredAt":".."}` only when
  `select 1` works and `jobs.score.last_ok_at` is younger than 20 minutes;
  else `503`.

### 5.6 Admin API (cookie session)

- Credentials from env: `XSLOP_ADMIN_USER`, `XSLOP_ADMIN_HASH` in the form
  `scrypt$N$r$p$saltB64$hashB64` (Node `crypto.scrypt`, N=32768, r=8, p=1,
  keylen 64; compare with `timingSafeEqual`). Server ships a script
  `server/dist/scripts/hash-password.js` that reads a password on stdin and
  prints the hash.
- `POST /api/admin/login {"username","password"}` → sets cookie `__Host-xs_admin`
  (32 random bytes base64url; DB keeps only its SHA-256), `HttpOnly; Secure;
  SameSite=Strict; Path=/; Max-Age=43200`, returns `{"csrf"}`. 5 failures per
  15 minutes per IP hash → 429. Same response time for a bad user and a bad
  password.
- Every admin route checks the session. Every non-GET admin route also checks
  header `x-csrf` equals the session csrf, and `Origin` equals the site origin.
- `GET /api/admin/session` → `{"user","csrf"}` or 401.
- `POST /api/admin/logout`.
- `GET /api/admin/appeals?status=open|accepted|rejected` (newest 200),
  `POST /api/admin/appeals/:id/decide {"decision":"accept"|"reject","note"}`.
  Accept sets the account `status='cleared'`, `cleared_at=now()`, `override='clear'`.
- `GET /api/admin/accounts?status=&handle=&limit=` and
  `POST /api/admin/accounts/:handle {"action":"confirm"|"clear"|"reset"}` (reset removes the override).
- `GET /api/admin/installs?sort=reputation|created&limit=` and
  `POST /api/admin/installs/:id/ban`, `.../unban`.
- `GET /api/admin/overview` → counts, last score run, newest list version.

### 5.7 Static files (served by the web process)

- `/` → `site/dist/index.html`; `/assets/*` from `site/dist/assets` with
  `Cache-Control: public, max-age=31536000, immutable`; other root files
  (`favicon.svg`, `og.png`, `robots.txt`) with max-age 3600.
- `/admin` → `site/dist/admin/index.html` with `X-Robots-Tag: noindex` and
  `Cache-Control: no-store`.
- `/downloads/<file>.zip` → from `extension/dist/` (only names matching
  `^xslop-(chrome|firefox)-v[0-9]+\.[0-9]+\.[0-9]+\.zip$`),
  `Content-Disposition: attachment`. `/downloads/latest.json` →
  `{"version","chrome":{"file","sha256","bytes"},"firefox":{...}}` built from
  the files at boot, plus `"chromeStoreUrl"` and `"firefoxUrl"` when
  `XSLOP_CHROME_STORE_URL` and `XSLOP_FIREFOX_STORE_URL` hold a listing URL
  (`https://chromewebstore.google.com/detail/<slug>/<id of 32 letters a-p>`,
  `https://addons.mozilla.org/[<locale>/]firefox/addon/<slug>/`). An unset
  variable leaves its field out. A bad value leaves its field out too, and boot
  logs one warning with the variable name, never the value; it never stops the
  server.
- Load all static files into memory at boot, with precomputed gzip and br and
  strong ETags. Unknown path → 404 page from `site/dist/404.html` if present.
- Headers on HTML: `Content-Security-Policy: default-src 'self'; img-src 'self' data:;
  connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`. API responses:
  `Cache-Control: no-store` unless stated, `X-Content-Type-Options: nosniff`.
- CORS: only `GET /api/v1/list`, `/list/delta`, `/config`, `/stats`,
  `/accounts/:handle` send `Access-Control-Allow-Origin: *`. Signed routes send
  no CORS headers (extensions call them through host permissions).

### 5.8 Rate limits (in-memory token buckets, single process)

| Route | Key | Limit |
|---|---|---|
| challenge | ip | 30/hour |
| installs | ip | 5/hour |
| votes | install | 120/hour, 600/day |
| observations | install | 1500 items/hour, 3 sightings per handle per 24 h (extra dropped) |
| observations | network | 3000 items/hour |
| all signed routes | network | 600/min, before body parse and DB |
| installs | network | 25 per 30 days (DB count) |
| me | install | 30/hour |
| accounts/:handle | ip | 60/min |
| appeals POST | ip | 3/hour |
| list, delta, config, stats | ip | 120/min |
| admin login | ip | 5 failures/15 min |

Answer 429 `rate_limited` with `Retry-After`.

## 6. Scoring

Module `server/src/scoring/index.ts`, pure and deterministic (seeded, no
`Math.random`, no I/O, no clock reads: `now` comes in the input).

```ts
export interface ScoringInput {
  now: Date;
  installs: { id: string; createdAt: Date; ipHash: string; banned: boolean; reputation: number }[];
  votes: { install: string; handle: string; value: 0 | 1; at: Date }[];
  accounts: { handle: string; seed: boolean; clearedAt: Date | null; override: 'confirm' | 'clear' | null;
              profile: SeedProfile | null }[];
  sightings: { handle: string; tweetId: string; parentTweetId: string | null; replyAt: Date;
               latencySec: number | null; simhash: string; genericScore: number;
               overlapScore: number; verified: boolean }[];   // newest 50 per account, last 30 days
}
export interface SeedProfile { createdAt: string; followers: number; following: number; posts: number;
                               verifiedType: string }
export interface AccountScore { handle: string; score: number /*0..1*/; tier: 0 | 1 | 2;
  status: 'none' | 'flagged' | 'confirmed' | 'cleared';
  parts: { bridged: number; factor: number; behaviour: number; raters: number; slopRaters: number;
           notSlopRaters: number; sightings: number; fastReplyShare: number; duplicateShare: number;
           genericShare: number; reason: string } }
export interface ScoringOutput { accounts: AccountScore[]; installs: { id: string; reputation: number }[];
  model: { mu: number; epochs: number; behaviourWeights: Record<string, number>; behaviourFitted: boolean;
           positives: number; negatives: number } }
export function computeScores(input: ScoringInput): ScoringOutput;
```

Required behaviour (the engine refines the constants and documents them in
`server/src/scoring/README.md`):

1. **Bridged consensus (Community Notes style).** Fit
   `r ≈ μ + i_u + i_a + f_u·f_a` over votes (r = 1 slop, 0 not slop), one
   factor dimension, weighted least squares, L2 regularization λ_intercept =
   0.15, λ_factor = 0.03, deterministic alternating updates. `i_a` is the
   bridged slop intercept: it is high only when raters on both sides of the
   factor agree. Brigades along one factor go into `f`, not into `i_a`.
2. **Rater weight.** weight = reputation × age factor (install younger than
   24 h: 0.3, younger than 7 days: 0.7, else 1) ÷ √(installs sharing the same
   ipHash). Banned installs: excluded.
3. **Reputation.** Beta(1,1) agreement of an install's votes with the final
   status of accounts that are settled (seed confirmed, admin override,
   confirmed or cleared with at least 5 raters), leaving out that install's
   own vote when it decides the account. Output in [0.05, 1].
4. **Behaviour score.** Features from sightings: share of replies with latency
   ≤ 60 s, share ≤ 20 s, median latency, max replies in a rolling hour,
   distinct parents, near-duplicate share (simhash Hamming distance ≤ 3 to
   another reply of the same account under a different parent), mean generic
   score, mean (1 − overlap), verified share. Logistic regression, standardized
   features, L2, fitted on positives = seed accounts with ≥ 5 sightings and
   negatives = accounts with ≥ 5 sightings that are cleared or bridged
   `i_a ≤ −0.15` with ≥ 3 raters, plus unlabeled sighted accounts down-weighted
   to 0.1 as negatives. Fit only with ≥ 30 positives and ≥ 30 negatives; else
   use documented default weights. Behaviour needs ≥ 10 sightings to count.
5. **Status rules.** Admin override wins (`confirm` → confirmed tier 2,
   `clear` → cleared tier 0). Seed accounts are confirmed unless cleared or
   bridged `i_a ≤ −0.15` with ≥ 5 raters. Others: confirmed (tier 2) if
   (`i_a ≥ 0.40`, `|f_a| < 0.5`, ≥ 3 raters) or (behaviour ≥ 0.92, ≥ 15
   sightings, ≥ 3 weighted slop raters); flagged (tier 1) if (`i_a ≥ 0.20`, ≥ 2
   raters) or (behaviour ≥ 0.80, ≥ 10 sightings, ≥ 2 weighted slop raters).
   Behaviour never lists an account alone, because sightings carry no install id.
   Rater counts are weighted. A vote counts toward reputation only when it was
   cast before the account was first listed (`accounts.listed_at`). A cleared account counts only
   votes after `clearedAt` and needs ≥ 6 raters to return.
6. Output the score for every input account and every handle that appears in
   votes or sightings. Performance: 50k votes, 20k accounts, 500k sightings in
   under 10 s on one core.

The job `server/src/jobs/score.ts`: advisory lock (keyed by the job and the schema, so staging and
prod on one database never skip each other's runs; the X facts job locks the same way), load input with
SQL, call `computeScores`, write accounts (status, score, tier, parts),
installs (reputation), build a new `list_snapshots` row only when the list
changed (gzip + brotli, delta against the previous version), update
`jobs.score`, run retention. Exit 0 on success.

## 7. Extension

### 7.1 Targets

- Chrome MV3 (`background.service_worker`, module) and Firefox MV3
  (`background.scripts`, `browser_specific_settings.gecko.id` =
  `xslop@koglabs.com`, Firefox for Android support, the current required
  `data_collection_permissions` field). Version from `extension/package.json`.
- Permissions: `storage`, `alarms`. Host permissions: `https://x.com/*`,
  `https://twitter.com/*`, `https://mobile.x.com/*`,
  `https://x-slop.com/*`. Nothing else.
- Build: TypeScript + esbuild, no UI framework. Output `extension/dist/chrome/`,
  `extension/dist/firefox/` and the zips
  `extension/dist/xslop-chrome-v<version>.zip`,
  `extension/dist/xslop-firefox-v<version>.zip` (pure-JS zip, deterministic
  timestamps). Icons come from `brand/icon-{16,32,48,128}.png`. If
  they are missing, the build renders them from `brand/mark.svg` with
  `rsvg-convert`, and if that is missing too, the build fails with a clear
  message.
- API base: build-time constant `XSLOP_API` (default
  `https://x-slop.com`), so tests can point at a local server.

### 7.2 Identity

On first run the background generates a non-extractable ECDSA P-256 key pair
(WebCrypto), stores the CryptoKey in IndexedDB, solves the proof of work
(`purpose=install`), registers, and stores the install id. Every write is
signed per section 5.1. Proof of work must not freeze the UI (chunked loop in
the background).

### 7.3 Content script on X

- Find tweets: `article[data-testid="tweet"]`. Author handle from the
  `[data-testid="User-Name"]` link `a[href^="/"]` whose path is one segment.
  Tweet id from the `a[href*="/status/"]` that wraps the `time` element. Text
  from `[data-testid="tweetText"]`. Time from `time[datetime]`. Keep all
  selectors in one module, overridable by the remote config (data only).
- A reply is: every tweet after the focal tweet on a `/<user>/status/<id>`
  page, or any tweet that shows a "Replying to" line. The focal tweet is the
  one whose id equals the URL id.
- Inject one button per reply into the action bar (`[role="group"]`), inside a
  shadow root, with the xslop mark, `aria-label="Mark @handle as slop"`, a
  tooltip, keyboard focus and a 44 px touch target on narrow screens. Never on
  the user's own tweets (logged-in handle read from the
  `[data-testid="AppTabBar_Profile_Link"]` href) and never on the focal tweet.
- Click: mark slop. The reply collapses at once to one line:
  `Hidden reply from @handle · Show · Undo`. The vote goes to the outbox. Other
  replies of the same account on the page collapse too.
- Global list accounts collapse to:
  `Hidden by xslop (score 87) · Show · Not slop`. "Not slop" sends a
  `not_slop` vote and puts the handle on your personal allow list.
- Hidden set = personal slop votes ∪ (global tier 2, plus tier 1 when
  strictness is Strict) − personal not-slop votes. Strictness: Off, Balanced
  (default), Strict. Display: collapse (default) or remove fully.
- Work with a single `MutationObserver`, process each article once (WeakSet),
  batch in `requestAnimationFrame` or idle callbacks, no layout thrash, no
  polling loops. Do not break X's virtual list; collapse the content of
  `[data-testid="cellInnerDiv"]` instead of removing nodes.
- Observations (only after consent, section 7.5): for each reply seen on a
  status page, compute `textLen`, a 64-bit simhash over word 3-shingles of the
  normalized text, `genericScore` (template phrases, emoji-only, praise
  without content, length), `overlapScore` (content-word overlap with the
  focal tweet text), `hasMedia`, `verified` (the verified badge icon), the
  parent id, handle and time (focal tweet). Deduplicate tweet ids locally (LRU
  5000). Send batches of up to 100 every 30 s through the background. Never
  send the text itself in an observation.

### 7.4 Background

- Outbox in `chrome.storage.local` (votes, deletes, observations), flushed
  with exponential backoff and jitter; survives service worker restarts.
- List sync: `chrome.alarms` every 10 minutes and at startup. Full list with
  ETag, then deltas; on 410 fetch the full list. Keep the list in storage as a
  compact structure; content scripts get it once and then diffs by message.
- Config sync every 6 hours from `/api/v1/config`; validate its shape; keep
  the last good one; fall back to built-in defaults.
- Messages between content script, popup and background: typed, validated,
  only from the extension's own contexts (`sender.id === chrome.runtime.id`).

### 7.5 Popup, onboarding, consent

- Popup: status (list version, accounts on the global list, replies hidden
  today), strictness control, display mode, signal sharing toggle, mute sync
  toggle with progress, your list (search, remove, undo), link to
  `https://x-slop.com/check`. Brand from `brand/`.
- Onboarding tab on install: what xslop does, what it sends, a clear opt-in
  for anonymous signal sharing (off until you turn it on), and the mute sync
  explanation. Text rules: second person, no "we/our/us", no em-dashes.

### 7.6 Remote config (data only, `server/config/extension-config.json`)

```
{"v":1,"minVersion":"1.0.0",
 "selectors":{...all selectors of 7.3, plus protected...},
 "observe":{"enabled":true,"batchMax":100,"flushSec":30},
 "mute":{"enabled":true,"maxPerDay":40,"minIntervalSec":90,"jitter":0.3,
         "webBearer":"<the public bearer that the x.com web app itself sends>"}}
```

The config is data only. It never chooses an X endpoint: the extension hard-codes
`/i/api/1.1/mutes/users/create.json`, `destroy.json` and `ids.json`. The extension
clamps pacing to at most 40 a day, at least 90 s apart, jitter at most 0.5,
whatever the config says.

### 7.7 Mute sync (mobile)

Opt-in, off by default, in the popup. When on, the background picks the next
handle (personal slop list first, then global tier 2 by score), skipping
handles already muted by xslop and handles on your allow list. Right before
each mute it reads your own muted ids again. A page of that read with more
than 5000 ids, or with an id that is not a string of digits, fails the read. It asks an open x.com tab's
content script to call the mute endpoint of the X web app in your own session
(`screen_name=<handle>`, form encoded, headers `authorization: Bearer <webBearer>`,
`x-csrf-token: <ct0 cookie>`, `x-twitter-auth-type: OAuth2Session`,
`x-twitter-active-user: yes`, `credentials: 'include'`). It records the user id
that X returns, unless that id was already muted by you. It unmutes only its
own records, by `user_id`, when the account leaves the list or you mark it not
slop, and on "Undo all xslop mutes". Stop for 24 h on 401, on 429, on a 403
or 404 that does not name this one account (X codes 50, 63, 271, 272), or on
three 5xx in a row, and show why. A 403 or 404 with one of these codes
concerns only that account: xslop skips the mute, or drops the record of the
unmute. Mutes apply to your X account, so the X app on
your phone hides them too.

### 7.8 Tests

- `npm test`: typecheck + vitest with happy-dom: selector parsing on fixture
  HTML copies of X markup (status page with focal tweet and replies, home
  timeline with "Replying to", own tweet, promoted tweet, quote tweet), button
  injection idempotence, hide/show/undo, strictness logic, simhash and
  features, outbox retry, list delta apply, signature format (verify with Node
  crypto), proof of work, config validation, mute pacing and stop rules.
- `npm run test:e2e`: Playwright Chromium loads the unpacked extension,
  routes `https://x.com/**` to fixture pages, points `XSLOP_API` at a local
  test server, and proves: button appears, click collapses, vote reaches the
  server with a valid signature, global list hides an account, popup toggles
  work, mute sync calls the mute endpoint with the right headers at the right
  pace.

## 8. Site and brand

- One landing page `site/index.html` (Vite build to `site/dist/`), plus
  `site/admin/index.html` (admin console) and `site/404.html`.
- Landing sections: hero (what goes in, what comes out, what you do), a live
  animated demo of a thread where slop replies collapse, how it works (click,
  the crowd confirms, hidden here and muted on your phone), how the list stays
  fair (bridging, behaviour signals, appeals, in plain words), live numbers
  from `/api/v1/stats`, install (Chrome zip download with steps from
  `/downloads/latest.json`, Firefox desktop and Android), appeal (handle
  lookup through `/api/v1/accounts/:handle`, appeal form with proof of work in
  a Web Worker), privacy (what is sent, what is never sent), FAQ, footer
  (statement, independence line, links; the seed list credit is on `/rules`).
- Copy rules: second person, no "we/our/us", no em-dashes, the reader can say
  what the tool does after the hero.
- Brand in `brand/`: `mark.svg` (the logo mark: a blue reply bubble that
  melts into three drips, with an x cut through it; 32 unit box),
  `mark-mono.svg` (the same in `currentColor`: the button on x.com),
  `favicon.svg` and `icon-16.png` (a 16 unit variant on the pixel grid),
  `wordmark.svg` (the lockup: the mark as the x, then the lettering "slop"
  with drips, traced from the logo image), `icon-32.png`, `icon-48.png`,
  `icon-128.png`, `og.png` (1200×630), and `tokens.css` (colors, type, radius)
  that the extension popup also imports. `brand/src/build-brand.mjs` writes
  every one of these files except `tokens.css`.
- The mark is `#007bff` (`--xs-logo`) in every logo file and wherever a page
  draws the logo; it is never a button or text fill (white on it is 3.98:1).
  The interface accent stays `--xs-brand`. The lettering takes the text colour
  of its ground. The header of every page shows the lockup as one SVG from the
  page sprite (`#xs-mark`, `#xs-word`) with the accessible name "xslop", the
  404 page too; the admin console and the extension popup show `wordmark.svg`.
- Admin console: login, appeals queue with decide buttons, account lookup with
  override actions, installs with ban, overview. Uses section 5.6 with the
  `x-csrf` header. No inline scripts or styles (CSP).
- Tests: `npm test` = typecheck/lint of site scripts + a build check that no
  em-dash, no "we/our/us" appears in visible copy and no external URL appears
  in `src`/`href` except links to x.com profiles, the Chrome Web Store,
  addons.mozilla.org, the home page of Clankwall (`https://clankwall.vogel.dev/`) and the repository
  `https://github.com/jstadev/xslop`, its `/issues` and its `/releases/latest`. `npm run test:e2e`: Playwright renders the built page at
  390 px and 1440 px, checks no horizontal scroll, runs the design gate.

## 9. Environment variables (server)

`DATABASE_URL`, `PORT` (3995), `XSLOP_SECRET` (64 hex), `XSLOP_IP_SALT` (64 hex),
`XSLOP_ADMIN_USER`, `XSLOP_ADMIN_HASH`, `XSLOP_POW_BITS` (optional),
`XSLOP_SITE_ORIGIN` (default `https://x-slop.com`), `XSLOP_STATIC_ROOT`
(default: the release root, so `site/dist` and `extension/dist` resolve),
`XSLOP_CHROME_STORE_URL` and `XSLOP_FIREFOX_STORE_URL` (optional, section 5.7),
`TEST_DATABASE_URL` (tests only). Names go in `.env.example` with no values.

## 10. Release

`deploy/project.json`: engine `standard`, build
`npm run ci:install && npm run build`, test `npm test`, migrate
`node server/dist/scripts/migrate.js && node server/dist/scripts/import-seed.js && node server/dist/jobs/score.js`,
units `xslop-web`, timer `xslop-score` (every 5 minutes). First version
v1.0.0. `server/src/scripts/import-seed.ts` upserts
every account of every `seed/*.json` with `seed=true`, `seed_source`
(`x_list:<source.id>` or `site:<source.id>`), `x_user_id`, `display_handle` and
`profile`, idempotent, never touching `override`, `cleared_at` or votes.
Two file kinds. `x_list`: `source.id` is the numeric id of a public X list; each
account has `id`, `handle`, `createdAt`, `verifiedType`, `followers`,
`following` and `posts`. `site`: `source.id` is a lower-case host name (at least
one dot, labels of a-z, 0-9 and inner `-`, at most 253 characters); each account
has exactly `id` and `handle`, and its `profile` is SQL NULL. The first file in
name order is `seed/ai-slop-list.json` (`x_list:2116659176894071283`); the second
is `seed/clankwall.json` (`site:clankwall.vogel.dev`, the accounts of
`https://clankwall.vogel.dev/api/accounts.ndjson` with at least 2 flagged replies
where flagged replies are at least half of the sampled replies, filtered at copy
time on 2026-11-13). The engine never reads `profile`.

## 12. v1.1 contract (wins over every earlier section)

Goal: posts and replies get the button, a click mutes on X at once, the list really grows from real use, a public `/sloppers` page, every browser, and a landing page that makes a visitor say wow. Product line: Community Notes, for AI slop.

### 12.1 Rules for every change

Real code only, no stubs, no TODO, no dead code, no commented-out code, no speculative options. Reuse what exists. Delete what the new work replaces. Every route has its neighbours' guards and validation. Secrets never enter the repo, logs, tests or bundles. Tests cover the core path, the guard, bad input and one real round trip.

Text that a customer reads: direct second person, say what goes in, what comes out, what the reader does. No first person (we, our, us). No em-dash, zero. No aphorism in place of information. Never state a number that the code does not produce.

### 12.2 Button and hiding

- The button appears on every tweet that xslop can read, on every surface: home, status page (the focal post, its ancestors and the replies), profile, search, lists, bookmarks, communities, notifications. Exceptions: your own tweets, ads, and a quoted tweet inside another tweet.
- `context` in the vote is `reply` or `post`, as today.
- Your marks and the global list hide posts and replies alike, on every surface. One exception: the focal post of a status page is never collapsed, because you opened it on purpose. It still gets the button and shows the marked state.

### 12.3 Instant mute

- `Settings` gets `muteOnMark: boolean`, default **true**. `Settings.mute` stays: it is the opt-in bulk sync of the global list, paced at the limits in 7.7.
- A trusted click on the button does three things in the same task: the tweet collapses, the content script itself calls X (no hop through the background, no pacing), and the vote is sent to the background as today.
- The content script sends the X result to the background with a new `ContentMsg`: `{ t: 'muted'; handle: string; id: string | null; status: number; code: number | null; via: 'rest' | 'menu'; op: 'create' | 'destroy' }`. The background records it in `MuteState.muted` (by X user id) or, when X refused, leaves the handle in the paced queue so a later retry can land it. `Settings.muteOnMark = false` turns all of this off.
- Undo (a click on a marked button, or Undo in the bar or the toast) calls `destroy` at once by the recorded user id. The content script asks for the id with a new `ContentMsg` `{ t: 'muteRecord'; handle: string }`, answered with `{ id: string | null }`. No id: no unmute.
- Your own earlier mutes stay yours. The background keeps a snapshot of `ids` (read when an x.com tab appears, at most once every 6 hours, never blocking a click; stored in `MuteState.own: string[]`, `MuteState.ownAt: number`). A handle whose id is in the snapshot is recorded as `skipped: own`, and undo leaves it muted.
- X may require the `x-client-transaction-id` header on REST calls. So the content script has a second path. If `create` or `destroy` answers 404 or a 403 that is not "user missing or suspended", it runs X's own control on that tweet: it clicks `[data-testid="caret"]`, finds the `[role="menuitem"]` whose text contains `@handle`, clicks it, and hides the menu during the run with a style element so nothing flashes. Then `via: 'menu'`, `id: null` for create. Several menu items contain `@handle` (Follow, Mute, Block). The content script clicks only an item whose text contains `@handle`, contains a word from the built-in list `muteWords` (or `unmuteWords` for destroy), and, for create, contains no word from `unmuteWords`. If no item matches, it closes the menu and clicks nothing: a wrong click could block or unfollow someone. The selectors live in the remote config (new `selectors` keys `caret`, `menu`, `menuItem`). The word lists `muteWords` and `unmuteWords` (at least en, es, pt, fr, de, it, el, nl, tr, ru, ja, ko, zh) are compiled into the extension: the remote config can never choose which action a click takes.
- A client-side limit stops a runaway: at most 30 instant mutes per minute. Past it, the click still hides and votes and the mute goes to the paced queue. A 401 or 429 stops instant mutes for 15 minutes and says so.
- The result is visible: a toast at the bottom of the page in a shadow root: "Muted @handle on X" with Undo for 6 seconds; or "Hidden here. X did not accept the mute." It respects `prefers-reduced-motion`, reads out with `role="status"`, and never covers X's composer.
- X calls must work on `x.com`, and on `twitter.com` / `mobile.x.com` when these serve the app: call the current origin, allow only those three.

### 12.4 Criteria that work

v1 cannot list anything in real use. A new install counts 0.3, a first-week install 0.7, and reputation stays at the 0.5 prior, because votes on already listed accounts earn nothing. So a real early user has weight 0.15 to 0.5, and `CONFIRM_MIN_RATERS = 3` weighted needs 6 to 20 people who all overlap with each other. The factor model also has no signal on sparse, one-sided data. Fix this at the root.

Requirements:
- A realistic early community lists accounts within minutes of the votes. Listing does not wait for a week of account age.
- It still resists these attacks: one network, many cheap installs, two-camp brigades, reputation farming, behaviour alone.
- Distinct networks (`ipHash`) are the unit of independence. Use them in the rules. Add a Wilson lower bound on the weighted slop share, or an equivalent, so opposition blocks a listing.
- Bridging stays the headline rule, but it counts only when the rater graph has enough overlap to fit the factor. Below that, the rules fall back to distinct-network consensus. State the switch rule in code and in the README.
- Reputation gets a working bootstrap, without reopening the farming hole.
- `parts` gains `networks` (distinct networks among counted slop votes) and `needed` (how many more distinct networks the account needs for its next tier; 0 at the top). Keep all existing `parts` fields and `reason` codes; new codes are allowed.
- `server/src/scoring/criteria.ts` exports `CRITERIA`, built from the constants, so the numbers can never drift from the code:
  `{ version: number, tiers: { status: 'flagged' | 'confirmed', title: string, summary: string, rules: string[] }[], weights: string[], protections: string[], appeal: string }`. All strings are customer text (12.1).
- Prove it with a simulation test file, `server/test/scoring/simulation.test.ts`, that runs `computeScores` on named launch populations and asserts the exact outcome: small honest community confirms; day-one installs on many networks at least flag; 30 installs on one network list nothing; an even split lists nothing; a two-camp brigade does not confirm; seed accounts stay and can be cleared; a banned install counts for nothing.
- `server/src/jobs/score-job.ts` stays the loader and writer. Keep the job under its time budget.

### 12.5 Sloppers API

- `GET /api/v1/sloppers?q=&status=all|confirmed|flagged&sort=score|recent|votes|handle&cursor=&limit=` (public, rate limited, `additionalProperties: false`, no coercion, `limit` 1..100, default 60). `q` matches handle or display name, case-insensitive, trimmed, at most 40 chars.
  Response: `{ total: number, generatedAt: string, next: string | null, items: Slopper[] }`, where
  `Slopper = { handle: string, name: string | null, avatar: string | null, followers: number | null, status: 'flagged' | 'confirmed', tier: 1 | 2, score: number /* 0..100 */, seed: boolean, votes: { slop: number, notSlop: number }, networks: number, needed: number, listedAt: string | null, reason: string, seedSource: string | null }`. `seedSource` is `accounts.seed_source` of a seed account (`x_list:<digits>` or `site:<host>`), else null; the view interns it like `reason`.
  `avatar` is a same-origin path or null. `next` is opaque. Serve from an in-memory view rebuilt when the list version changes: no per-request table scan. Never leak install ids, ip hashes or vote text.
- `GET /api/v1/criteria` serves `CRITERIA` from `server/src/scoring/criteria.ts`.
- `GET /api/v1/avatars/:handle` serves stored bytes with the right type, a strong ETag, long cache, `x-content-type-options: nosniff`.
- Profiles: migration `003_*.sql` adds table `profiles (handle pk, x_id, name, followers, avatar bytea, avatar_type, gone boolean, fetched_at)`. A new oneshot job `server/src/jobs/profiles.ts` with `deploy/units/xslop-profiles.{service,timer}` (manifest `timers` gets it) fills it for listed accounts that have no fresh row (refresh after 30 days), paced at most one account per 2 s, at most 120 per run. Source: `https://api.fxtwitter.com/<handle>` (public, no token), then the avatar from `pbs.twimg.com` only, at the 96 px or nearest size. Hard rules: fixed hosts, `redirect: 'error'`, timeout, byte cap 256 KiB, magic-byte check (JPEG, PNG, WebP), handle validated before use, bad data leaves nulls. The job never fails the release: `migrate` must not depend on it. Add `X-Profiles` tests with a stubbed fetch and a real bytea round trip on PGlite.
- `/sloppers` and `/sloppers/` serve `site/dist/sloppers/index.html` with `no-cache` and the HTML headers.
- `latest.json` and the download route also cover `safari` (`xslop-safari-v*.zip`), with the same shape as `chrome` and `firefox`.
- An admin confirm sets `listed_at` at once; an admin clear empties it and sets `cleared_at`. A vote cast after either earns no reputation.

### 12.6 Browsers

Targets: `chrome` zip (Chrome, Edge, Brave, Opera, Vivaldi, Arc and every other Chromium browser), `firefox` zip (desktop and Android), `safari` zip (the web extension folder for macOS and iOS, plus `scripts/safari/convert.sh`, which runs Apple's `safari-web-extension-converter` on a Mac). Check every API, manifest key and CSP against each engine's real support; handle Firefox MV3 host permissions (the user can decline them: detect it, ask with a real button). `extension/package.json` goes to `1.1.0`; `server/config/extension-config.json` `minVersion` stays `1.0.0`. New config keys: see 12.3; a v1.0.x client must ignore them.

### 12.7 Extension experience

The best UX on X, easy from the first minute. The button sits in X's action row and looks native on all three X themes and at phone width. Popup: state at a glance, your marked accounts with search and one-tap undo, the mute and hide settings in plain words. Onboarding: three short steps, the first one says what a click does (hides, mutes on X, adds one vote). Keyboard and screen reader complete.

Minimal popup (2026-11-14, wins over 7.5 and 12.13 where they differ):
- With 4 marks and no notice, the popup fits Chrome's popup height of 600 px at 360 px wide.
- Three numbers (hidden today, shared list, you marked). Your list with one-tap Undo; the search field shows from 7 marks, or while it holds text.
- Settings are compact rows: `Hide` (Off, Balanced, Strict) with one hint line, `Hidden posts` (One line, Remove), and three switches with one hint line each.
- Standing: a tag `Counts for the shared list` shows only when `/me` says `standing: true`. Without standing the popup says nothing about it.
- Short sentences in every popup, onboarding and toast text. Step 3 still names every field that a vote and a signal carry.

### 12.8 Pages

- Both pass the maintainer's design gate (`site/test/e2e/gate.test.ts`). X lights-out black, blue as the only glow, Mona Sans variable at 125% width for display type. Never a floating pill navbar, never a big left-aligned hero title over a 3D scene, never dark rounded boxes around content.
- CSP stays strict: every asset same-origin, no inline script or style.
- `/sloppers`: title "Sloppers". Every listed account, searchable, filterable by status, sortable, loaded in pages as you scroll, deep-linkable with `?q=` (read once on load, written with `replaceState`, never read back). Each entry shows avatar (monogram only when there is none), name, handle, status, score, votes, networks, how it got here in plain words, a link to the profile on X, and an appeal link. The page also shows the criteria from `/api/v1/criteria`.
- Fake accounts in demos keep handles longer than 15 characters.

### 12.9 Limits added by the v1.1 review

- One network stores at most 1,500 votes per day (`server/src/http/client.ts`). This adds to the rates in 5.8.
- A handle with only sightings gets a score inside the engine, but the job writes no `accounts` row for it (this overrides section 6, item 6). At most 10,000 such handles train the behaviour model.
- The `muteRecord` reply is `{ id, stays }`: `stays` says that the account stays muted because you muted it before xslop did. `unvote` goes out before the X call, so a closed tab cannot lose an undo.
- Onboarding opens once on an update from below 1.1.0, because instant mute is a new default.

### 12.10 Site pages (2026-11-10)

- The landing page ends with the footer. It has no section nav and no long text sections.
- The moved sections are pages, linked from the footer of every page: `/how-it-works`, `/rules`, `/download` (the extension downloads and install steps), `/check` (handle lookup and appeal, `?appeal=<handle>` is kept in the link), `/privacy`, `/questions`. `/sloppers` stays. Source: `site/<name>/index.html`; the shared head, mark and footer are `site/partials/*.html`, included with `<!--include:name-->` by the Vite plugin in `site/vite.config.ts`.
- The server serves each page at `/<name>` and `/<name>/` (`SITE_PAGES` in `server/src/http/static.ts`), `no-cache`, with the HTML headers.
- Every Install link on the landing page points to `/download`, in every browser, also when `/downloads/latest.json` names a store listing (2026-11-14). The landing page has no store badge and does not read latest.json. An old link with a moved anchor (`/#appeal`, `/#install`, `/#how`, `/#rules`, `/#privacy`, `/#faq`) is redirected by `site/src/main.ts`, with its query string. The extension 1.1.0 popup and onboarding still use `/#appeal` and rely on this.
- `/download` (2026-11-14), top to bottom: a hero with the mark, the title, the version from latest.json, one line on what the extension does and the visitor's browser (`site/src/hero/detect.ts`) with its main action, its zip file line with the SHA-256 and its steps; then "Supported browsers", one card each for Chrome, Brave, Vivaldi, Arc, Edge and Opera (the official Chrome Web Store badge for the first four only when latest.json has `chromeStoreUrl`, else the Chrome zip with the developer-mode steps, which stays the second way under the badge); then "Coming soon" in quieter cards: Firefox (the temporary zip under "Try it now"), Firefox for Android (install on a computer and turn on mute sync) and Safari (the Xcode build under "Build it yourself on a Mac"); then "Open source": the MIT licence and the buttons "Star on GitHub", "Read the code" and "Report a bug" (the GitHub mark is Octicons `mark-github`, in the page). When latest.json has `firefoxUrl`, both Firefox cards move to the supported browsers with the store button, from the data alone. The card of the visitor's browser says "Your browser". The page draws the same blocks while latest.json loads, so the answer moves nothing; a failed list keeps the cards and steps and says to reload. `site/src/install.ts` holds the browser data and steps.
- The hero switch (`#hero-switch`) flips every 4 seconds while the hero is on screen, until the visitor presses a key or a pointer. The landing page has no Pause button; the scene always plays.

### 12.11 Landing page and /sloppers polish (2026-11-10)

- The tagline reads "Think Community Notes, but for slop." The hero has no status line, no "You do / You get / Everyone gets" list and no "Hide one account" button. The intro paragraph, the head card of the thread and the account on the bridge are rounded cards with a low-opacity edge (`--edge-soft`, `--radius-card` in `site/src/styles/site.css`). The profiles in the drain are pills with the same edge.
- The strip is sticky from 1400 px wide, where it is one line (64 px). Below that it scrolls away, because a strip of two lines would cover the pinned scenes. It has a glass fill. The strip shows text only when the live numbers fail (`#stats-updated`); it says nothing while they load or when they are fine.
- The head card of the thread (`.river-head`) is a glass card. From 1000 px wide it sticks beside the column. When the middle of the screen is inside the thread, xslop turns on by itself, once, unless the visitor already pressed a switch. While the middle is in the thread the hero demo loop does not flip the switch.
- The account on the bridge shows a default picture (a head and shoulders, `#default-pfp`), not a letter.
- After the drain the landing page ends in one low band (`#clean`): the footer. There is no rail with accounts.
- The statement "X is for the people, not bots" is the last line of the landing page (`#end-statement`). With the scene it stands in the centre of the last screen, between the strip and the footer: it fades in over the last eighth of a screen of the page (`pageEnding` in `site/src/hero/story.ts`), and the last points of the scene finish their fall at the same time. Without the scene it is a centred block on top of the band. It breaks only after the comma. No footer has the statement (`site/partials/footer.html`).
- `/sloppers`: the rail beside the list is an accordion of two `details` that share one `name`: "What this list means" (open at first) and "How an account gets on this list". One open item closes the other.
- `/sloppers`, the account thread (2026-11-11; replaces the entry sentence of 12.8). One row is one account, laid out like a reply on X. It has the picture (the X default picture, a head and shoulders, when the account has none), one primary line, one line of facts and a quiet action row. The primary line links to the profile on X: the display name is strong and the `@handle` is quiet; the handle leads when there is no name. The facts are the status (a filled dot for confirmed, a ring for flagged), `Score N`, the source unless the source is votes, and `N votes from M networks` only when there are votes. A count of zero and a missing fact give no text. The actions are "How it got here" (a chevron shows the state, the label does not change, `aria-expanded` holds the state) and "Appeal". A hairline separates two rows; no line joins them and no box sits inside a row. "How it got here" opens the record, a list of labels and values: Source, Votes, Networks, Score, Status, Followers, Listed, Profile, Appeal. A label with no value is left out. Above the rows: the search field and the status tabs (sticky from 768 px), then one line with the result count and the sort menu.

### 12.11a Glass boxes (2026-11-11). Wins over 12.11 where they differ.

- Every box on the landing page is a pane of glass: the intro paragraph, both switches, the head card of the thread, the X column, the account on the bridge, the toggle of the static diagram, the button of the drain and the sticky strip. One rule in `site/src/styles/site.css` gives them the fill `--glass` (translucent, a little blue), the blur `--glass-blur`, the edge `--edge-soft` (the accent blue at low opacity) and the shadow `--shadow-soft` (small, blurred, no offset to the side). The drain pills take the same fill, edge and shadow without the blur. No box has an opaque fill or a hard shadow. The tagline has no box; a soft glow of the page colour keeps it readable.
- The scene cuts the flood only along the letters of the headline. Behind a pane (`[data-flood-avoid]` other than the headline, `[data-river-avoid]`, `.column`, the X logo) it cuts nothing: the field marks these blocks in its alpha channel, and the shader draws the people cards, their halos and a card that burns away at 20% there. That holds the text on the glass at 4.5:1 or more when a bright card passes behind it.

### 12.11b The scene always runs (2026-11-12). Wins over 12.8 to 12.11a where they differ.

- The landing page shows the scene in every browser that gives a WebGL2 context. The static page (`no-scene`) shows only while the browser gives no WebGL2 context. `site/src/hero/boot.ts` asks again after 1, 2, 4 and 8 seconds and then every 8 seconds; when a context comes, the page changes to the scene. This is the only layout change of a visit.
- Reduced motion changes nothing on the landing page: the scene, the scroll story, the word change, the 4 second switch demo and the CSS motion all run. The reduced motion rule of `base.css` applies only to a page without the scene. The landing page has no pause, stop or play control.
- The core count, the device memory, the data saver and the frame rate never decide anything. No code reads `navigator.webdriver`: the page behaves the same in an automated browser.
- One GL context. `boot.ts` makes the canvas and its context before it loads the scene file and gives both to `startScene`. A scene that ends, and a start that fails, release the context at once.
- A slow device gets a cheaper picture; the scene does not stop. The watchdog (`site/src/hero/watchdog.ts`) reads the median frame time of a window of 60 frames or 2 seconds. A median over 34 ms lowers the pixel ratio by a factor of 0.5 to 0.75, down to 0.5. A cap of 30 frames per second (energy saver, low power mode) is not slow. A GL on the CPU (`isSoftwareRenderer`) starts at pixel ratio 0.5, at load and after a lost context.
- A scene file that fails to load, a scene that fails to start and a lost GL context all take the same path: the page waits (1, 2, 4, 8, 8... seconds) and starts again on a new canvas, with no limit of tries. A failed file is imported again with `?retry=N`, because a second `import()` of one URL makes no request in any browser. The page never reloads itself. The switch state carries over.
- No step on scroll: the camera (`site/src/hero/camera.ts` `cameraPose`) and each drawn value (`site/src/hero/story.ts` `storyPicture`) are continuous functions of the stage and the drain. No code switches a value at a fixed stage. A scene that starts in the middle of the page starts at the scroll position.
- The post of the thread has the ordered handle `@i_am_original`. It is the one demo handle with fewer than 16 characters (12.8).

### 12.11c Dark and light (2026-11-13). Wins over 12.8 to 12.11b where they differ.

- The landing page, the six footer pages, `/sloppers` and the 404 page have a dark theme and a light theme. Dark is the default for every visitor, also when the system is set to light. Dark has a pure black page (`oklch(0 0 0)`).
- A switch changes the theme (`site/partials/theme-toggle.html`). It is in the footer of every page with a footer, and in the header of each of these pages except the landing page (pin 354). It is a round button with a sun in dark and a moon in light; its label is "Switch to light theme" or "Switch to dark theme". Without JavaScript it does not show and the page stays dark.
- The choice stays in this browser only: `localStorage` key `xslop-theme`. The server never sees it. Another open tab of the site follows the switch.
- `site/public/theme.js` is a classic script in `<head>` (the CSP allows no inline script). It sets `data-theme` on `<html>` before the first paint, keeps the `color-scheme` and `theme-color` meta tags in step, wires every `[data-theme-toggle]` button and fires `xslop:theme` on `document` after a switch. Each page also has `data-theme="dark"` in its markup. TypeScript reads the theme with `site/src/theme.ts`; the 3D scene repaints in the new palette at once.
- `brand/tokens.css` applies the light tokens under `:root[data-theme="light"]`. A page without `data-theme` (the admin console, the extension popup) still follows the system setting. No landing page reads `prefers-color-scheme`.

### 12.12 Security round (2026-11-10). Wins over every earlier section.

Sources: a code audit (server, extension, site), an attack audit of the list rules and a test of the live system. Each rule below has a regression test that failed before the change.

List rules (replaces the matching lines of sections 6 and 12.4; `server/src/scoring/README.md` has the numbers and the reasons):
- One network is one rater in the factor model too. The bridging test of a confirm reads the fit of the networks that say slop; the "not slop" test reads the fit of the networks that say not slop. "Not slop" also needs the share bound of a confirm.
- Behaviour confirms and flags need the share bound of their tier (0.6 and 0.5). Behaviour never wins against people who say "not slop".
- The engine uses a fitted behaviour model only when it keeps its direction (a person-like pattern scores below 0.5 and below a bot-like pattern). If not, it uses the default weights and `model.behaviourFitted` is false.
- Starter (seed) accounts: votes never remove one. It leaves the list only by an admin clear or an accepted appeal. `parts.disputed` is true when the "not slop" votes pass the old clear test (5 networks with a trust sum of 1 and the share bound).
- Strikes: when an admin clears an account that 10 networks or fewer marked, each network whose voice was slop before the clear gets one strike. Two strikes less than 30 days apart silence the network on every account, until 30 days after its newest strike. Starter accounts and admin-confirmed accounts give no strike. `jobs.detail.struckNetworks` holds the count.
- The score job loads only votes that can count now (the rest stay in the table; `jobs.detail.votesHeld`), only accounts with a state or a loaded vote, and only installs with a loaded vote.

Limits (replaces the matching rows of 5.8 and 12.9):

| Route | Key | Limit |
|---|---|---|
| votes | install | 120/hour |
| votes | network of registration | 200 stored/day |
| observations | install | 1500 items/hour, 3 sightings per handle per 24 h |
| observations | network of registration | 10,000 stored/day, 9 sightings per handle per 24 h (extra dropped, answer 202 with `accepted: 0`) |
| observations | all networks together | 10,000 stored/hour (extra dropped, answer 202 with `accepted: 0`) |
| installs | network | 1000 per 30 days (DB count, one registration per network at a time under an advisory lock) |

API (replaces the matching lines of 3, 5.5, 5.6, 5.7 and 12.5):
- Every response that states no cache rule gets `Cache-Control: no-store`. A path that the router cannot decode gets 400 `bad_request` in the error shape.
- `evidence` items are `{"tweetId","at"}`. The server never serves the text of a vote. The site links to `https://x.com/i/status/<tweetId>`.
- `votes.slop` and `votes.notSlop` on `/api/v1/accounts/:handle` and in `Slopper` count networks, not installs.
- Appeals: one open appeal per handle and network. There is no total per handle. An appeal for an account that is not listed gets 404 `not_listed`. An admin accept clears the account and closes every other open appeal of that handle as accepted in the same transaction.
- Observation scores are stored as the nearest float4.

Extension 1.1.3 (adds to 7.1 and 7.7):
- An unmute keeps the pace (90 s or more) and the stop rules. It does not count toward the daily cap of 40 and does not wait for it. Unmutes run before mutes.
- The Safari build also asks for `unlimitedStorage`. It gives no access to data.

Deploy and live system:
- The unit templates add `PrivateDevices`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RemoveIPC`, `KeyringMode=private`, `UMask=0077`, `SystemCallArchitectures=native` and `SystemCallFilter=@system-service` without `@privileged` and `@resources`.
- The reverse proxy (Caddy) drops a client-sent `X-Forwarded-For` (no `trusted_proxies`). Never widen `trustProxy` in `server/src/app.ts`. If a CDN ever sits in front of the proxy, set `trusted_proxies` in the proxy first.
- The DNS and mail rules of the maintainer's domain are in `docs/operations.md`.

Known and open after this round (the list rules need a product decision):
- A network is the /24 of the address at registration, and such an address costs nothing. Seven new installs on seven addresses confirm an account in one score run. Two installs flag one.
- Strikes do not hold against a ring that deletes or flips its votes after the clear, or that uses new installs for each account.
- The hourly install bucket (5 per network) counts requests. Five empty requests an hour from one /24 stop every registration there.

### 12.13 Round 3: security, phones, cleanup, public repository (2026-11-12). Wins over every earlier section.

Server:
- The server ends a request that is not complete after 30 seconds (408).
- Admin: at most 2 password checks run at a time; another login gets 429 `rate_limited` with `Retry-After: 1` and uses no attempt. Each admin change writes one log line `admin action` with the action and its target (handle, appeal id or install id), and no cookie, token or address. Admin changes (every non-GET route with a session) have their own limit of 30 a minute per address. `decide` locks the account row first. `confirm` sets `cleared_at` to null.
- Signed requests: a nonce seen for this install in the last 10 minutes is refused, the last millisecond included.
- `GET /api/v1/accounts/:handle`: `signals` is null unless the account is flagged or confirmed.
- The `Retry-After` of a full install budget of a network is at most 3600.
- A vote carries no post text (5.2). `votes.text` is no longer written. Rows from before 2026-11-12 keep their value until the maintainer deletes it.
- The engine input has no `textLen`. The seed profile has no bio: `seed/ai-slop-list.json` holds id, handle, createdAt, verifiedType, followers, following and posts for each account, and nothing else. `seed/clankwall.json` (kind `site`) holds id and handle only.

Extension 1.1.3:
- The extension does not store or send the text of a marked post. A vote or an outbox entry that an older build stored is read without its text (`readStored` in `extension/src/shared/storage.ts`).
- The background reads every answer of the xslop server with a byte cap: 16 MiB for the list and a delta, 64 KiB for every other answer. It refuses a longer answer. A `Retry-After` above 1 hour counts as 1 hour.
- An X error code outside 0 to 100000 counts as no code.
- On a phone the popup and the onboarding are pages. They set `viewport-fit=cover` and keep clear of the safe area insets. On a touch device every control is 44 px or more and the search field has 16 px text.
- Onboarding: step 1 shows the three effects of a click as three boxes in one row (one column below 520 px). The switch hints of step 2 and of the popup are one short line. Step 3 names every field that a vote and a signal carry.
- `test:e2e` also runs `phone.spec.ts` (touch, 320 to 430 px, upright and on its side, with a notch) and `hostile-config.spec.ts`.

Site:
- Every control is a 44 px target on every touch screen (`pointer: coarse`), also on a phone held sideways. Fields that take text have 16 px text on touch screens.
- `/sloppers`: the search field and the tabs are sticky from 768 px wide in windows of 640 px height or more; a phone held sideways keeps only the title bar sticky.
- `/admin`: below 48rem each table row shows as label and value lines. The console empties every table, the overview and the user name when the session ends or the admin logs out, and aborts its open requests.
- `site/src/lib/api.ts` refuses an answer above 4,000,000 bytes.
- `site/scripts/check-build.ts` reads attributes with double, single or no quotes, and also fails on an external `srcset`, `action`, `formaction`, `poster` or `data`, on an event handler attribute and on a meta refresh.
- `/privacy` names every field that a vote and a signal carry.
- `site/test/e2e/mobile.test.ts` renders every page and admin view at 320x568, 360x740, 390x844, 430x932, 667x375, 844x390 and 768x1024 and checks no sideways scroll, tap targets of 44 px (links inside a sentence exempt) and fields with 16 px text.

Deploy:
- The unit templates also set `InaccessiblePaths=/etc/<key>` (systemd reads the env file before the sandbox starts) and `TasksMax=64`.

Repository:
- The tree is written for a public reader: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `THIRD_PARTY.md`, `.github/`. The maintainer's own deployment is described only in `docs/operations.md`. The workflow `.github/workflows/test.yml` runs the release gate only when the repository is public.

Known and open after this round:
- Staging and production run as one Unix user. A code execution fault in staging can read the environment of the production process through `/proc`. The fix is a separate user per channel in the deploy tool.
- The list is keyed by handle. A listed account that renames leaves the list, and whoever takes the freed handle is hidden and muted.
- No table keeps the old state of an admin change, and an admin session has no idle limit (12 hours in total).
- Stored and never read: `votes.parent_tweet_id`, `votes.posted_at`, `sightings.parent_handle`, `sightings.has_media`, `sightings.text_len`.

## 13. Judging system v2 (2026-11-12). Wins over every earlier section.

### 13.1 Goal and principle

An identity (an install, an address) costs nothing. So nothing that costs nothing decides anything. Every automatic change of the published list needs both of these:
- **Standing**: networks with earned, loseable standing vouch for it.
- **Server facts**: the server itself checked that the account exists on X and that it wrote the posts that the votes name.

Everything else waits for a person in the review queue. Trust starts at the maintainer and moves outward: marks that a trusted decision approved give standing, wrong marks take it away.

Faults that this section closes (each one has a named regression test, 13.9): a crowd of new installs lists an account; "not slop" votes of new installs shield an account or switch the bridging test on; one honest "not slop" click removes confirms; installs on a shared address turn or starve its voice; a renamed account leaves the list and the next owner of the handle is hidden; invented sightings and unchecked evidence links; strikes that a deleted vote removes; a stopped score job that holds an admin clear back; one admin password with no log.

### 13.2 Words and constants (all constants live in `server/src/scoring/`, and `criteria.ts` builds the public text from them)

| Constant | Value | Meaning |
|---|---|---|
| `STANDING_MIN_AGE_DAYS` | 7 | Age of an install before it can have standing. |
| `STANDING_MIN_GOOD_MARKS` | 3 | Good marks that an install needs. |
| `STANDING_MIN_REPUTATION` | 0.6 | Reputation that an install needs. |
| `ANCHORS_FLAG`, `ANCHORS_CONFIRM` | 1, 2 | Slop networks with standing that an automatic flag and an automatic confirm need. |
| `EVIDENCE_MIN` | 2 | Networks whose slop vote names a post that the server verified as written by the account. |
| `PROTECTED_MIN_FOLLOWERS` | 50,000 | From this size an account changes its public state only by an admin decision. |
| `MAX_AUTO_CONFIRMS_PER_DAY` | 30 | Automatic confirms in 24 hours. The rest wait in the review queue. |

Kept from before: `FLAG_MIN_NETWORKS` 2, `CONFIRM_MIN_NETWORKS` 4, `CONFIRM_MIN_TRUST` 1, `FLAG_SHARE_BOUND` 0.5, `CONFIRM_SHARE_BOUND` 0.6, `SEED_DISPUTE_MIN_NETWORKS` 5, `CLEARED_RETURN_MIN_NETWORKS` 6, `NETWORK_DAILY_VOTES` 50, the three strike constants, the age factors and the reputation range.

- **Trusted install**: `installs.trusted`. Only an admin sets it.
- **Standing of an install** (the engine computes it each run, the job stores it in `installs.standing`, and the next run reads it as input): not banned, and (`trusted`, or age at least 7 days and at least 3 good marks and reputation at least 0.6).
- **Trusted decision** on an account: (a) an admin confirm or an admin clear (`override`, time `override_at`); (b) an anchored confirm: status confirmed by rule 4 below, still confirmed without the network of the voter (leave one network out). A starter account is not a trusted decision: it was public from the first day.
- **Good mark**: a counted slop vote, cast before the account was public (`listed_at`, or `override_at` for an account that went from pending to an admin confirm), on an account with a trusted confirm.
- **Voice of a network on an account**: if one or more installs with standing on that network voted on the account, only their votes make the voice (weighted majority, as before). If none did, the votes of the other installs make it. So an install without standing never turns the voice of an install with standing on a shared address. A voice **has standing** when an install with standing is on its side.
- **Anchors**: the slop networks whose voice has standing.
- **"Not slop" counts only with standing.** A not-slop voice without standing is in no tally, no share, no factor model and no "contested" test. The engine reports the number of such networks as `parts.dissent`.
- **Daily budget of a network**: 50 counted votes in 24 hours, as before. Votes of installs with standing take their places first, in time order; then the other votes.

### 13.3 Statuses and the rules

`accounts.status` is one of `none`, `pending`, `flagged`, `confirmed`, `cleared`. `pending` means: the votes pass a crowd test, a gate is not met, and a person decides. A pending account has tier 0, is not in the list, is not on `/sloppers`, and every public answer shows it as `none` with score 0.

Crowd tests (the numbers of before, with the share from voices that count):
- `share` = slop trust ÷ (slop trust + not-slop trust), `n` = slop networks + not-slop networks. Not-slop voices are standing voices only (13.2).
- **Dispute**: if at least one not-slop voice (with standing) exists, the share test uses standing voices only on both sides: `share` = anchor trust ÷ (anchor trust + not-slop trust), `n` = anchors + not-slop networks. If the bound fails only for that reason, the account is `pending` with gate `dispute`.
- Crowd confirm: slop networks ≥ 4, Wilson bound ≥ 0.6, slop trust ≥ 1.
- Crowd flag: slop networks ≥ 2, Wilson bound ≥ 0.5.
- **One camp** (the bridging test, veto only): see 13.4. A crowd that the veto stops is `pending` with gate `dispute`.

The first rule that matches wins:
0. `identity` is `gone` or `moved`: status `none`, tier 0, reason `gone` or `moved`, whatever the other fields say. The row keeps `seed`, `override` and `cleared_at` (13.6 moves them to the new handle).
1. `override = 'confirm'`: confirmed, tier 2, score 1. `override = 'clear'`: cleared.
2. `cleared_at` set and no override (an admin reset): only votes after `cleared_at` count. If the crowd confirm test passes with at least 6 slop networks: `pending`, gate `review`. Else cleared. A cleared account never returns without a person.
3. Starter account: confirmed, reason `seed`, score at least 0.8. `parts.disputed` is true when at least 5 not-slop networks (standing) with trust ≥ 1 pass a not-slop Wilson bound of 0.6.
4. Crowd confirm passes. Gates, in this order: `protected` (the account is protected) → `identity` (`identity` is not `ok`) → `standing` (anchors < 2) → `evidence` (evidence < 2) → `brake` (the account was not confirmed in the stored state and the day has no automatic confirm left). All gates met: confirmed, tier 2, reason `votes_confirmed`. A gate not met: go on to rule 5 with `parts.want = 'confirmed'` and `parts.gate` = the first gate not met.
5. Crowd flag passes. Gates: `protected` → `identity` → `standing` (anchors < 1). All met: flagged, tier 1, reason `votes_flagged`. A gate not met: `pending`, and `parts.gate` names it if rule 4 did not set one; `parts.want` is `'flagged'` if rule 4 did not set it.
6. `none`.

- Behaviour (reply timing) never changes a status. `parts.behaviour` is information for the review queue and for the public page of a listed account.
- `score` of the engine: cleared and none: 0. Pending, flagged and confirmed by votes: the Wilson bound of the share test that applied (the review queue sorts pending accounts by it). Starter: at least 0.8. Admin confirm: 1. Every public route publishes 0 for an account that is not flagged or confirmed.
- `parts` (all always set): `reason`, `want` (`'flagged' | 'confirmed' | null`), `gate` (`'protected' | 'identity' | 'standing' | 'evidence' | 'brake' | 'dispute' | 'review' | null`), `networks` (slop networks), `anchors`, `notSlop` (not-slop networks with standing), `dissent`, `trust` (slop trust), `needed` (more slop networks until the crowd test of the next tier passes; 0 when it passes or at the top), `disputed`, `evidence`, `factor`, `behaviour`, `sightings`, `fastReplyShare`, `raters`, `slopRaters`, `notSlopRaters`.
- The brake: the job gives the engine `autoConfirmsToday` (accounts with `confirmed_at` in the last 24 hours, no override, not a starter). The engine confirms at most `MAX_AUTO_CONFIRMS_PER_DAY − autoConfirmsToday` accounts that were not `confirmed` in the stored state, ordered by anchors (most first), then Wilson bound, then handle. The others get gate `brake`.

### 13.4 The one-camp veto (replaces the bridging tests of sections 6 and 12.4)

Measured on 2026-11-12: with the old test (`i_a ≥ 0.40` on a "fitted" account) one new install with 50 "not slop" votes took 117 crowd confirms to 0, and 5 honest "not slop" clicks took them to 60. A crowd that only clicks slop cannot reach `i_a ≥ 0.40` at reputation 0.5 (166 networks: 0.386). So the level test is gone, and the factor is a veto with a strict switch:
- The factor model is fitted on all slop voices and the not-slop voices with standing.
- A **contested** account has at least one slop voice and one not-slop voice.
- A network is **two-sided** when it has at least 3 voices on contested accounts, at least one of them slop and one not slop. A rater that only marks, or only says "not slop", has no stance.
- An account is **fitted** when at least 4 of its slop voices come from two-sided networks.
- The side fit of a fitted account uses `f_u = 0` for every network that is not two-sided.
- Veto: a fitted account with `|f_a| ≥ 0.5` in the fit of its slop voices fails both crowd tests (gate `dispute`). Nothing else reads `i_a` or `f_a` for a decision. `parts.factor` is the `f_a` of the side fit, 0 when not fitted.

### 13.5 Reputation, good marks, strikes

- Reputation is the Beta(1,1) mean over scored votes, clamped to [0.05, 1], as before. A vote is scored only against a trusted decision, and only if its value was set before that decision:
  - Admin confirm at `override_at`: a slop vote set before the account was public agrees (a good mark). A not-slop vote set before `override_at` disagrees, also when the account was already public: it disputed a listing that the admin upheld.
  - Anchored confirm: a slop vote set before `listed_at` agrees (a good mark), with leave one network out. Not-slop votes are not scored.
  - Admin clear with `clear_penalty`: scored from the stored rows of `cleared_votes` only (13.7): a slop row disagrees, a not-slop row agrees. Live votes on that account are not scored. A clear without penalty scores nothing.
  - A vote on a starter account, a vote that agrees with an answer that was already public, and a vote past the budget score nothing.
- The engine returns `reputation`, `goodMarks` and `standing` for each loaded install. The job stores all three.
- Strikes come from `cleared_votes` rows (engine input `clearedVotes`), never from the live votes: one strike per network and cleared account when the rows of that network for the account say slop (majority of its rows), the account had at most `STRIKE_MAX_CROWD` slop networks in its rows, and the clear had the penalty. Limits and window as before. A deleted or changed vote changes no strike.

### 13.6 Identity, evidence and renames (the X facts job, `server/src/jobs/profiles.ts`, timer `xslop-profiles`, every 2 minutes)

Sources, both public, no key, fixed hosts, `redirect: 'error'`, timeout, byte cap, strict parsing: `https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>` (the embed answer of X: `user.id_str`, `user.screen_name`, `in_reply_to_status_id_str`) and `https://api.fxtwitter.com/` (profile: id, name, followers, avatar; post: author id, `replying_to_status`). One source failing uses the other. Pace: at most one request per 2 seconds, one run at most 9 minutes.

- `accounts.identity`: `unknown` (never checked), `ok` (the handle exists and `x_user_id` is its X id), `gone` (5 runs in a row without the account), `moved` (the handle now has another X id than the stored one). `identity_at` is the time of the last check.
- **Work order of a run**: (1) accounts with `parts.gate` `identity` or `evidence`, anchors first; (2) accounts with a slop vote of an install with standing and `identity = 'unknown'`; (3) pending accounts with `want = 'confirmed'`, most networks first, at most 20 a run; (4) listed accounts and starter accounts whose `identity_at` is empty or older than 7 days. Votes of installs without standing alone start no request, except through (3).
- **Evidence**: for an account in (1) or (3), up to 3 posts that its slop votes name (installs with standing first, one per network, newest first) and that have no `evidence` row. A post is `ok` when its author id equals `accounts.x_user_id`. The loader counts `evidence` = networks with a counted slop vote that names an `ok` post.
- **Reply timing**: for a pending or listed account, up to 15 of its newest sightings without `verified_at`. A sighting is verified when the post exists, its author id is the account's and its `in_reply_to` is the stored parent. The job then writes `reply_at`, `parent_at` and `latency_sec` from the two post ids (the time is in the id: `(id >> 22) + 1288834974657` ms) and sets `verified_at`. It deletes a sighting that fails. The engine reads only verified sightings.
- **A rename** (`moved`): when a check finds that handle B has the X id that another row A holds: in one transaction B takes `seed`, `seed_source`, `override`, `override_at`, `clear_penalty`, `cleared_at` and `protected` of A; the votes, `cleared_votes`, evidence, sightings and open appeals of A move to B (a vote of an install that already voted on B stays with B); A gets `identity = 'moved'`, `moved_to = B` and loses those fields. When a check finds that handle A no longer has its stored X id and no row B has it yet, A gets `identity = 'moved'` and keeps its fields until a row B claims them.
- A row with `identity` `gone` or `moved` is not listed (rule 0), so the new owner of a handle is never hidden.
- The published list carries the X ids (13.8), so mute sync mutes by id and a rename does not undo a mute.

### 13.7 Data model (migration `004_judging_v2.sql`)

```
installs  + trusted boolean not null default false, standing boolean not null default false, good_marks integer not null default 0
accounts  status check gains 'pending'
          + override_at timestamptz, clear_penalty boolean not null default true, confirmed_at timestamptz,
            identity text not null default 'unknown' check (identity in ('unknown','ok','gone','moved')),
            identity_at timestamptz, moved_to text, protected boolean not null default false
sightings + verified_at timestamptz        -- the old metric columns stay, nothing writes them
evidence(tweet_id text pk, handle text not null references accounts, x_user_id text, ok boolean not null, checked_at timestamptz not null default now())
cleared_votes(handle text not null references accounts, install_id uuid not null, ip_hash text not null, value smallint not null check (value in (0,1)),
              at timestamptz not null, cleared_at timestamptz not null, primary key (handle, install_id))
admin_log(id bigserial pk, at timestamptz not null default now(), session text not null, action text not null, target text not null, before jsonb)
admin_sessions + seen_at timestamptz not null default now()
```

Who writes what: the score job writes `installs.reputation/standing/good_marks` and `accounts.status/score/tier/parts/listed_at/confirmed_at`. The X facts job writes `accounts.x_user_id/identity/identity_at/moved_to`, `profiles`, `evidence`, `sightings.verified_at` and the rename. The admin API writes `accounts.override/override_at/clear_penalty/cleared_at/listed_at/protected`, `installs.trusted/banned_at`, `cleared_votes`, `admin_log`.

Engine input (`ScoringInput`): `now`, `installs[{id, createdAt, ipHash, banned, reputation, trusted, standing}]`, `votes[{install, handle, value, at}]`, `accounts[{handle, seed, clearedAt, override, overrideAt, clearPenalty, listedAt, status, identity, evidence, protected}]`, `sightings[{handle, tweetId, parentTweetId, replyAt, latencySec}]` (verified only, newest 50 per account), `clearedVotes[{install, ipHash, handle, value, at, clearedAt}]`, `autoConfirmsToday`. Output: `accounts[{handle, status, tier, score, parts}]`, `installs[{id, reputation, goodMarks, standing}]`, `struckNetworks`, `model{epochs}`.

`protected` of the input = `accounts.protected` or `profiles.followers ≥ PROTECTED_MIN_FOLLOWERS`.

Retention (score job): votes older than 180 days on accounts with status `none` and no `seed`, `override` or `cleared_at`; `accounts` rows with status `none`, no vote, no state and no appeal, older than 30 days; installs with no vote and no activity for 90 days; `evidence` of accounts that are not pending or listed, older than 30 days; `cleared_votes` older than 400 days; `admin_log` older than 400 days.

Every admin confirm and clear publishes the list in its own transaction (`publishList` in `server/src/list.ts`, also used by the score job), so a removal never waits for the job.

### 13.8 HTTP contract changes

- List: `GET /api/v1/list` → `{"v":1,"version","generatedAt","accounts":[[handle,score,tier],...],"ids":["<x id>"|null,...]}`; `ids[i]` belongs to `accounts[i]`. Delta: `{"v":1,"from","version","add":[...],"addIds":[...],"remove":[...]}`. An id change counts as a change of the entry. Rows keep 3 elements, so an extension 1.1.x reads the answer as before.
- `GET /api/v1/me` adds `"standing": boolean, "goodMarks": number, "trusted": boolean`.
- `POST /api/v1/observations` items: `{"handle","tweetId","parentTweetId"|null}`. The route still accepts the fields of older builds (`parentHandle`, `replyAt`, `parentAt`, `textLen`, `simhash`, `genericScore`, `overlapScore`, `hasMedia`, `verified`) and stores none of them. A stored sighting has `reply_at` from the post id, and no `verified_at`. A post id from before 2010-11-04 (no time in the id) is dropped.
- `GET /api/v1/accounts/:handle`: an account that is not flagged or confirmed answers `status:"none"`, `score:0`, `votes:{slop:0,notSlop:0}`, `sightings:0`, `signals:null`, `evidence:[]` (no numbers for an account that is not listed). `signals` of a listed account is `{"fastReplyShare":0..1,"replies":n}` from verified sightings, or null when it has none. `evidence` holds only posts with an `ok` evidence row.
- `Slopper` (12.5) loses nothing and gains `"waits": boolean` (the crowd test for confirmed passes and a gate holds it) and `"xUserId": string|null`.
- Installs: the hourly limit of a network counts registrations that succeeded, so empty requests cannot close registration for an address.
- Votes: each install with standing has its own stored-vote limit of 120 a day; it does not use the 200 a day of its network.
- Admin (all under the session, CSRF and Origin guards of 5.6; every change writes one `admin_log` row with the state before, in the same transaction):
  - `POST /api/admin/login {"username","password","code"?}`. With `XSLOP_ADMIN_TOTP` set (a base32 secret), `code` is the 6-digit RFC 6238 code (SHA-1, 30 s, one step of drift), and one code works once. A wrong code answers like a wrong password.
  - A session ends after 30 minutes without a request (`seen_at`) and after 12 hours.
  - `GET /api/admin/review?queue=pending|disputed|auto&limit=` → `{"items":[ReviewItem]}`. `pending`: status `pending`, anchors first, then networks. `disputed`: starter accounts with `parts.disputed`, and listed accounts with `parts.dissent ≥ 3`. `auto`: accounts with `confirmed_at` in the last 7 days and no override, newest first. `ReviewItem = {handle, name, followers, xUserId, identity, status, want, gate, networks, anchors, notSlop, dissent, trust, score, seed, protected, behaviour, sightings, fastReplyShare, evidence:[{tweetId,at}], firstVoteAt, lastVoteAt}`.
  - `POST /api/admin/accounts/:handle {"action":"confirm"|"clear"|"reset"|"protect"|"unprotect","penalty"?:boolean}`. `confirm` and `clear` set `override_at`. `clear` with `penalty` (default true; always false for a starter account) copies every vote of the handle into `cleared_votes`; `confirm` deletes those rows. Both publish the list.
  - `POST /api/admin/accounts/:handle/ban-voters` bans every install with a slop vote on the handle. 409 `crowd_too_large` when more than 10 networks marked it. → `{"banned": n}`.
  - `POST /api/admin/installs/:id/trust|untrust|ban|unban`. `GET /api/admin/installs?sort=reputation|created|votes` adds `trusted`, `standing`, `goodMarks`, `slopVotes`, `notSlopVotes`.
  - `GET /api/admin/appeals` items add `"marks":{"networks":n,"strikes":n}` (the networks that an accept with penalty would strike). `decide` takes `"penalty"?: boolean` and acts like `clear`.
  - `GET /api/admin/log?limit=` → `{"entries":[{"id","at","session","action","target","before"}]}`; `session` is the first 16 hex characters of the session hash.
  - `GET /api/admin/overview` adds `pending`, `standingInstalls`, `trustedInstalls` and the detail of the X facts job.

### 13.9 Named regression tests (engine: `server/test/scoring/abuse.test.ts`, `simulation.test.ts`; job and HTTP: the server suite; full flow: `test/system/`)

Each asserts the exact outcome through the real code path:
1. 2, 7 and 1000 brand-new networks mark an account: `pending`, gate `standing`, not in the list, public lookup `none`.
2. 4 networks, 2 with standing, identity ok, evidence 2: confirmed. Evidence 1: flagged with `want confirmed`, gate `evidence`. Identity unknown: pending, gate `identity`.
3. 1000 not-slop votes of installs without standing change no status; `dissent` is 1000.
4. One not-slop voice with standing against 2 anchors and 2 new networks: pending, gate `dispute`. Against 6 anchors: confirmed.
5. The three probes of 2026-11-12 (one new install with 50 "not slop" votes; 5, 10 and 20 honest "not slop" clicks; 10 week-old installs): no account that they did not touch changes.
6. Two real camps with two-sided raters: an account that one camp marks gets gate `dispute`; an account that both camps mark is confirmed.
7. A protected account: pending, gate `protected`, with any crowd.
8. The brake: with 30 automatic confirms in the day, the next one is flagged with gate `brake`; an account that was confirmed before stays confirmed.
9. Shared address: installs without standing do not change the voice of an install with standing there, and their votes do not take its budget.
10. Strikes hold after the voters delete or flip their votes; an admin confirm removes them.
11. A ring that confirms accounts with no trusted decision earns no reputation and no good mark; marks that an admin approves give standing after 7 days and 3 good marks; a not-slop voter loses reputation when the admin confirms.
12. Launch simulation: 200 new users, an admin who approves the pending queue once a day; asserts the day on which the first automatic confirm happens and the counts on days 1, 8 and 14.
13. `gone` and `moved` are never listed, also for a starter account and an admin confirm. A rename moves the state to the new handle (job test on a database).
14. A cleared account with 6 new networks is pending with gate `review`.
15. Speed: 50,000 votes, 20,000 accounts, 500,000 sightings in under 10 CPU seconds; the same rows in any order give the same output.

### 13.10 Round 2 amendments (2026-11-12). Wins over 13.1 to 13.9 where they differ.

Found by a review of 13.2 to 13.5. Each closes a path that gives an attacker more than he paid for.

| Constant | Value | Meaning |
|---|---|---|
| `GOOD_MARKS_PER_ACCOUNT` | 5 | Good marks that one admin confirm gives out. |
| `STANDING_DAILY` | 5 | Votes of one network that carry standing in 24 hours. |
| `EVIDENCE_FLAG`, `EVIDENCE_CONFIRM` | 1, 2 | Checked evidence that a flag and a confirm need (`EVIDENCE_MIN` is gone). |
| `MAX_AUTO_FLAGS_PER_DAY` | 60 | Automatic flags in 24 hours; same brake rule as for confirms. |

1. **Only an admin decision is a trusted decision.** An anchored confirm scores nothing: no reputation, no good mark. Reason: 2 installs with standing confirm accounts of their own ring, and every ring install that marked them first earns standing; standing then grows without limit. The leave-one-network-out test is gone with it. An admin confirm of an account that the votes already confirmed (the Automatic queue) is the way such marks become good marks.
2. **One admin confirm gives at most 5 good marks**: to the first 5 networks, by the time of their slop vote, whose vote was set before the account was public; in each network the install with the earliest such vote. Reason: without a limit, 3 real slop accounts that a ring gives up pay for standing on any number of installs. With it, standing in the whole system is at most 5 for each account that the admin confirmed.
3. **A wrong vote with standing takes the standing away.** A penalty against an install is: its slop row in `cleared_votes` of a clear with penalty (any crowd size), or its not-slop vote set before an admin confirm (`override_at`). Only good marks from admin confirms after the newest penalty of the install count toward `STANDING_MIN_GOOD_MARKS`. `trusted` installs are exempt (only the admin removes `trusted`). The engine input gets what it needs for this from `clearedVotes` and the votes; no new table.
4. **Standing budget.** In 24 hours at most 5 votes of one network carry standing (slop and not-slop together, in time order, the same waiting rule as the vote budget: a later vote gets its standing when its turn comes). A vote that waits counts as a vote without standing: a slop vote is a plain network, a not-slop vote is `dissent`. Reason: one identity with standing must not flag or dispute 50 accounts in a day before a person can react.
5. **Strikes count the crowd in anchors.** An account whose rows in `cleared_votes` hold more than `STRIKE_MAX_CROWD` slop networks WITH standing gives no strike (the admin overruled a real crowd). Networks without standing get the strike at any crowd size. Reason: a ring that floods the review queue with 11 networks per account got no strike. `cleared_votes` gains `standing boolean not null default false` (the standing of the install at the time of the clear; migration 004 is not released, so the column goes into 004).
6. **A flag needs evidence too**: gate `evidence` when the checked evidence is below 1. The flag brake: gate `brake` after 60 automatic flags in the day, same order rule as for confirms; the job gives `autoFlagsToday` (accounts with `listed_at` in the last 24 hours, tier 1, no override, not a starter).
7. **Fair order of the X facts job.** Within each class of the work order (13.6), the job takes accounts round robin by sponsor network (the network of the earliest counted slop vote on the account), so no group of networks can take all requests of a run. A network sponsors at most 3 accounts in one run.
8. **Review queue order.** `pending`: anchors (most first), then checked evidence, then the verified reply timing score, then slop trust, then handle. The queue answer carries `total`. A reject is `clear` with penalty.
9. **The extension** (1.2.0): after a mute by `user_id`, if the answer of X names an account on your allow list, the extension unmutes it at once and records nothing. The stored list keeps the ids as one array beside the rows.
10. **`gone` does not delist.** Rule 0 applies to `moved` only (the handle has another X id: positive proof). An account that the source does not find keeps its state and is checked again each day. Reason: the profile source answers 404 for live accounts (measured on production on 2026-11-12: 3 of 793 starter accounts have 1 to 3 misses in a row, none is gone), and a handle with no account hides nobody. A `gone` account still fails the `identity` gate, so votes list nothing new on it.

### 13.11 Details that the build fixed (2026-11-12). They refine 13.2 to 13.8.

Engine:
- A "not slop" vote of an install without standing is in no voice and uses no budget. It counts only in `parts.dissent`, and in the reputation of its install when an admin confirms the account.
- Budget queue of a network: the votes of installs with standing first, in time order, then the slop votes of the other installs. Vote i is released at the latest of: its time, the release of vote i−1, the release of vote i−50 plus 24 hours. A vote counts when its release is not after `now`.
- Dispute: the crowd test passes without the "not slop" voices, but the share test with them, or the one-camp veto, fails. A flagged account can have `want: confirmed` with a gate; the gate then holds the confirm.
- Standing in a run: `trusted`, or the stored standing with an age of at least 7 days and a reputation of at least 0.6. A loader fault never gives standing to a new install.
- Strikes: the rows of a banned install count. A ban does not lift a strike. The engine reads the penalty from the rows (rows exist only for a clear with the penalty); `clearPenalty` is not an engine input.
- `parts.disputed`: voices with standing on both sides, at least 5 "not slop" networks with a trust of at least 1.
- 13.9 item 14 reads: 6 networks with a total trust of at least 1.

Data:
- Checks: `accounts.x_user_id`, `evidence.tweet_id` and `evidence.x_user_id` are 1 to 20 digits; `moved_to` is a handle; `good_marks >= 0`. Indexes: `evidence (handle)`, `accounts (x_user_id) where x_user_id is not null`, `sightings (handle, reply_at desc, tweet_id desc) where verified_at is not null`.
- Migration 004 backfills: `override_at` = `cleared_at` for a clear and `listed_at` for a confirm; `clear_penalty = false` for starter accounts; one `cleared_votes` row for each vote set before `cleared_at` on a cleared account that is not a starter account and has no confirm; `confirmed_at = listed_at` for accounts that votes confirmed.
- Engine input `installs` = the installs with a loaded vote, and the installs that are not banned with a `cleared_votes` row. The score job sets `standing = false` for every banned install.
- `evidence` of the input = networks with a loaded slop vote (inside the budget, install not banned) that names an `ok` post whose `evidence.x_user_id` equals `accounts.x_user_id`.
- Retention: `accounts` rows with status `none`, no `seed`, `override`, `cleared_at` or `protected`, no vote, appeal, evidence or cleared vote, unchanged for 30 days, with their `profiles` row. Retention runs in its own transaction after the run commits; a failed retention fails the run but keeps the new list and the heartbeat.
- `publishList` runs one at a time (transaction advisory lock `0x7a510004`); each caller calls it after its last row write. Versions can skip a number. A stored delta without `addIds` (written before 004) answers 410.
- Seed import: every `seed/*.json` in name order, `seed_source = <source.kind>:<source.id>` of its file (`x_list` or `site`; a `site` row has `profile` NULL and exactly the keys `id` and `handle`); the first file that names a handle or an X id gives the account; every file is checked before a write. The X id decides: a row whose handle holds another X id, an X id that another row holds, and a row with `moved_to` stay as they are. Idempotent; never touches `override`, `cleared_at`, `status`, `identity`, a stored `x_user_id` or votes.

X facts job:
- A rename moves state only when two sources agree: the embed answer of X for a proven post of the X id (an `evidence` row of that id, or a verified sighting) names handle B, and fxtwitter says B has that id. Then, in one transaction with row locks in handle order: B takes `seed` and `seed_source` (or), the admin decision (`override`, `override_at`, `clear_penalty`, `cleared_at`) when A has one, `protected` (or), and the earliest `listed_at` and `confirmed_at`; the votes, `cleared_votes`, evidence, sightings and open appeals of A move to B (a vote or appeal that B already has from that install or network stays with B); A gets `identity = 'moved'`, `moved_to = B` and loses those fields and its `x_user_id`.
- A row does not take an X id that a row with identity `ok` holds until a rename is confirmed; it stays `unknown`.
- A fxtwitter 404 is no miss when the embed answer of X for a proven post shows the account at its handle. A post is `missing` only when both sources say so. A run in which no post answered deletes no sighting.
- Work order (4) also holds rows with identity `gone` or `moved` that have votes. Any attempt holds the next attempt of that account back for 1 day. A network that already has an `ok` post on the account is not read again. A post first checked under another handle is evidence of the account whose X id wrote it.
- Pace: at most one request per 2 seconds over all hosts, avatars included. No request starts after 8 minutes.

HTTP:
- `GET /api/v1/accounts/:handle`: an account that is not listed (status `flagged` or `confirmed` with tier at least 1, identity not `moved`) answers `status:"none"`, `tier:0`, `score:0`, `seed:false`, `votes:{slop:0,notSlop:0}`, `sightings:0`, `signals:null`, `evidence:[]`, `appealOpen:false`. `status` is `none`, `flagged` or `confirmed` only. An appeal of such an account answers 404 `not_listed`. Evidence: one post per network of a not-banned slop voter, at most 3. The sloppers view leaves out `moved` accounts. `reason` of a listed account is `seed`, `votes_confirmed`, `votes_flagged` or `override_confirm`.
- Limits: installs, 120 requests a minute per network before any work, and 5 registrations that succeeded an hour; votes of an install with standing, 120 stored a day of its own; admin login code, 10 wrong codes in 15 minutes for all networks together (then every login answers 429 until a token comes back). One code works once per web process.
- Admin: `confirm` sets status `confirmed`, tier 2, score 1; a `moved` account keeps this state on its row and stays out of the list. `auto` queue: accounts that are not starter accounts. `ban-voters` counts the networks of not-banned slop voters. Overview: `accounts.pending`, `standingInstalls`, `trustedInstalls`, `facts: {lastRunAt, lastOkAt, detail}`. A second clear keeps the `cleared_votes` rows of the first.
- `/admin` has six views (keys 1 to 6): Overview, Review (Pending, Disputed, Automatic), Appeals, Accounts, Installs, Log. Every write asks once: the first click arms the button for 4 seconds, the second sends.

Extension 1.2.0:
- The instant mute of a click stays by `screen_name`: it acts on the account that you see, and a list answer cannot redirect it. When the list gives the X id of a muted account to a new handle, the extension moves its record to that handle and makes no X call.
- An extension that stored a list without ids fetches the full list once, without its ETag. Each `ids` entry is null or 1 to 20 digits; an `ids` or `addIds` field of another shape or length drops the ids of that answer, never its rows.
- `/me` is read with a cap of 512 KiB, at most every 10 minutes. The popup states no number of the standing rule.
- `verified` stays in the served config for 1.1.x; 1.2.0 ignores it.

The open items 2 and 3 of 12.12 "Known and open" (the list keyed by handle; no admin log and no idle limit) are closed by this section.

### 13.12 Round 2 repairs (2026-11-12). Wins over 13.1 to 13.11 where they differ.

Two attack lanes ran the engine, the routes and the jobs against 13.1 to 13.11. Each rule below has a named test that fails without it.

Engine:
- **Standing budget (replaces 13.10 item 4).** A vote carries standing when fewer than 5 votes of its network carried standing in the 24 hours before it. A vote after `now` carries none. A vote past that never carries standing: a slop vote stays a plain network, a not-slop vote stays `dissent`. There is no waiting list, so a user who marks many accounts keeps standing for the first 5 marks of each day.
- **Penalties hold (adds to 13.10 item 3).** Only good marks of slop votes set after the newest penalty of the install count. An admin confirm stores the "not slop" votes set before `override_at` as rows of `cleared_votes` (value 0, `cleared_at` = `override_at`, the standing of the install); such a row is a penalty like the live vote, so a delete or a flip after the confirm keeps it. It gives no strike. A penalty takes the stored standing away in the run that first sees it.
- **Strikes on a shared address (adds to 13.10 item 5).** A strike has standing when a slop row of the network had standing at the clear. Two strikes with standing in the window silence the network. Two strikes of any kind silence only its installs without standing.
- **Brake order.** Anchors (most first), then the Wilson bound of the voices with standing (anchor trust against not-slop trust), then the handle. Votes without standing never move an account in this order.
- **`gone` (adds to 13.10 item 10).** A `gone` account keeps a tier that it holds in the stored status and fails the `identity` gate of a tier that it does not hold.
- The gates of rules 4 and 5 hold in this order: protected, identity, standing, evidence, brake. The brake applies only to an account that meets every other gate.

Server:
- **`moved` needs proof.** The embed answer of X for a proven post of the stored X id names another handle (at once), or two checks on different days name the same other X id. A check that names another X id stores no name, follower count or avatar of it.
- **Work order of the X facts job.** Class (1) needs at least one anchor. Class (3) holds every pending account with a request left (its identity check is due, or its identity is `ok` and a post of the evidence rule or a sighting without `verified_at` waits), `want = 'confirmed'` first, then most networks, at most 20 a run; a checked account leaves class (3) until new work comes. Each post id is asked once in a run: a post that several networks name takes one of the 3 evidence places of the account, and its `ok` row is the evidence of each of those networks. Class (4) also holds rows with an admin decision, so a decided row with no X id gets its first check at the next run. Classes (1) to (3) take at most 80 of the 120 accounts of a run and start no account after 160 requests of a run, so class (4) always runs. Within a class: round robin by sponsor network, at most 3 accounts per sponsor (13.10 item 7).
- **Admin.** `confirm` deletes the rows of an earlier clear and stores the "not slop" rows (above). The review answer is `{"total","items"}`. Account rows and review items carry `banNetworks`, the exact number of networks that `ban-voters` checks and bans. The overview carries `facts.moved24h`. `marks.strikes` of an appeal counts the slop networks without standing, plus the slop networks with standing when there are at most 10 of them. `marks.networks` counts the slop networks of the account (majority of all its votes, banned installs included, as the rows that an accept with penalty stores). A network has standing when one of its slop votes comes from an install with standing or trust that is not banned.
- **Stats and views.** `/api/v1/stats` counts `confirmed` at tier 2 and `flagged` at tier 1, never a `moved` row. A cursor of the sloppers view before the last rebuild works for 10 minutes.
- **Score job.** It locks the account rows that it changes in handle order before it writes them, the order of the X facts commit. It compares a loaded `override_at` at millisecond precision.

Extension 1.2.0 (replaces the first two bullets of 13.11 "Extension"):
- The instant mute of a click stays by `screen_name`. A paced retry of a failed instant mute goes by the list id, as mute sync does. When the list gives the X id of a muted account to a new handle that xslop mutes, the extension moves its record to that handle and makes no X call.
- The extension stores the ids as one array beside the rows, null for a row without one. At 200,000 rows with 15-character handles and 19-digit ids the stored list is 9,600,123 bytes in Chromium, under the 10,485,760 bytes of `storage.local`.
- After a mute by `user_id`, the extension reads `screen_name` from the answer of X (1 to 15 letters, digits or underscores, compared in lower case). If that handle is on your allow list and the id is not one of your own mutes, the extension unmutes at once by the id that X returned and keeps no record. It does not mute by that list id again while the list gives it to that handle (at most 2000 such pairs, one per handle). If the unmute fails, the record stays under the handle that X named and the next paced run unmutes it first.

Known and open after round 2:
- A starter account that renames has no proven post, so its state does not follow it: the old handle stays as `moved` or `gone` and hides nobody, and the new handle returns to the list only through votes.
- A profile source that names the same wrong X id on two days takes one account off the list. It cannot list an account and cannot move a state.
- Bait: an account owner lets users mark his account, cleans it and appeals. An accept with the penalty strikes the networks that marked it. The admin accepts such an appeal without the penalty.
- With an attacker's installs that earned standing: each lists at most 5 accounts a day until the next review, and every such vote ends the standing of its install. Marks set before the install had standing count by their own times, so 7 days of such marks can flag 35 accounts in its first run with standing (the flag brake allows 60 a day). The engine README has the measured numbers.
- All stored keys of the extension share one quota. With votes and your own mutes at their caps the list fits up to about 136,000 rows; above that the Chrome and Firefox builds need `unlimitedStorage`.
- Each text of `GET /api/v1/criteria` is 1 to 600 characters and each list holds at most 16 items; a test holds both limits, because the site refuses a longer answer.
- The system test (`test/system/`) also holds: votes of installs without standing alone start no request of the X facts job outside work order (3).

## 14. Admin console v3: full history and a console that explains it (2026-11-13). Wins over 5.6, 8 and 13.8 where they differ.

Order of the maintainer: "rebuild the whole admin UI ... everything recorded and nicely displayed ... so i can understand everything". Before this section the server kept only the last run of each job, no history of status, identity or standing changes, and only the state before an admin change.

### 14.1 What the server records (migration `006_history.sql`, additive only)

```
events(id bigserial pk, at timestamptz not null default now(),
       source text not null check (source in ('score','facts')),
       kind text not null check (kind in ('status','identity','standing')),
       subject text not null,            -- a handle, or an install id for 'standing'
       data jsonb not null)
       index (subject, id desc), index (kind, id desc), index (at)
job_runs(id bigserial pk, job text not null check (job in ('score','profiles')),
         started_at timestamptz not null, ended_at timestamptz not null default now(),
         ok boolean not null, detail jsonb not null)
         index (job, id desc)
admin_log + after jsonb                  -- the result of the change; null for login and logout
```

- **status** (score job, in the transaction that writes the account): one row for each account whose `(status, tier, parts.gate, parts.want)` differs from the stored row. `data = {"from":{"status","tier","gate","want"},"to":{"status","tier","gate","want","reason","score","networks","anchors","notSlop","dissent","evidence"}}`; `score` is 0 to 100. A change of the score alone writes no row.
- **standing** (score job): one row for each install whose stored `standing` flips, also by the ban rule of `writeInstalls`. `data = {"standing":bool,"reputation":0..1,"goodMarks":n,"banned":bool}`.
- **identity** (X facts job, in the transaction of the change): one row for each account whose `identity` changes (`unknown`, `ok`, `gone`, `moved`). `data = {"from","to","xUserId","movedTo"}`. A rename also writes a row on the new handle B: `data = {"from","to":"ok","xUserId","tookFrom":"<A>"}`.
- **job_runs**: every score run and every X facts run that did work or failed writes one row: `ok`, `started_at`, `ended_at` and `detail` (the same object as `jobs.detail`, or `{"error"}`). A skipped run (lock held) writes none.
- The admin API writes `admin_log.after` = the answer of the change, without the list body.
- Retention (score job): `events` older than 400 days, `job_runs` older than 30 days.
- Privacy: no row stores an address, an `ip_hash`, a post text or a cookie. The console names a network by `network` = the first 8 hex characters of `sha256(ip_hash)`; no route returns `ip_hash`.

### 14.2 Admin read routes (all GET, under the session guard of 5.6, `additionalProperties:false`, no coercion)

`Activity = {"key":string,"at":iso,"kind","source","subject":string|null,"data":object}`, newest first, `key` unique and stable. Kinds:

| kind | source | subject | data |
|---|---|---|---|
| `admin` | `admin` | admin_log target | `{"action","session","before","after"}` |
| `status` | `score` | handle | 14.1 |
| `identity` | `facts` | handle | 14.1 |
| `standing` | `score` | install id | 14.1 |
| `list` | `list` | version as text | `{"version","count","from","added":[[handle,score,tier]],"addedCount","removed":[handle],"removedCount"}`, each array at most 20 items. `added` holds new entries and entries whose score, tier or X id changed. |
| `appeal` | `public` | handle | `{"appealId","status"}` at `appeals.created_at` (the decision is an `admin` item) |
| `run` | `score` or `profiles` | null | `{"job","ok":false,"error","ms"}`: failed runs only |
| `vote` | `public` | handle | `{"install","network","value","first":bool}` at `votes.updated_at`; `first` when the vote was never changed |
| `install` | `public` | install id | `{"network","extVersion"}` at `installs.created_at` |

- `GET /api/admin/activity?kinds=<csv>&subject=<handle or uuid>&cursor=<opaque>&limit=<1..200, default 100>` → `{"items":[Activity],"next":string|null}`. Without `kinds`: every kind except `vote` and `install`. `subject` = a handle (1 to 15 of `[a-z0-9_]`) or an install id; for an install id the vote items of that install also match. `next` is the cursor of the next page, null at the end; a cursor is at most 120 characters of `[A-Za-z0-9_.:-]`, and a bad cursor is 400 `bad_request`.
- `GET /api/admin/overview` keeps its fields and adds:
  - `queues: {"pending","disputed","auto"}` (the `total` that `/review` gives for each queue),
  - `list: {"version","count","generatedAt"}` (newest snapshot, or null),
  - `last24h: {"votes","slopVotes","notSlopVotes","newInstalls","statusChanges","identityChanges","standingChanges","listVersions","appeals","adminActions"}`,
  - `score.runs24h`, `score.failed24h`, `facts.runs24h`, `facts.failed24h`,
  - `rules`: the constants of 13.2 as numbers: `standingMinAgeDays`, `standingMinGoodMarks`, `standingMinReputation`, `anchorsFlag`, `anchorsConfirm`, `evidenceFlag`, `evidenceConfirm`, `flagMinNetworks`, `confirmMinNetworks`, `confirmMinTrust`, `flagShareBound`, `confirmShareBound`, `protectedMinFollowers`, `maxAutoConfirmsPerDay`, `maxAutoFlagsPerDay`, `strikeMaxCrowd`, `clearedReturnMinNetworks`, `seedDisputeMinNetworks`, `networkDailyVotes`.
- `GET /api/admin/accounts/:handle` → 404 `not_found` without a row, else:
  ```
  {"account": <the row of GET /api/admin/accounts> + firstSeenAt, listedAt, confirmedAt, identityAt, movedTo, seedSource, parts (the whole object), name, followers,
   "profile": {"xId","name","followers","gone","misses","fetchedAt","avatar":bool} | null,
   "list": {"version","inList":bool,"score","tier"} | null,
   "votes": {"slop","notSlop","truncated":bool,
             "networks":[{"network","voice":"slop"|"not_slop"|"split","standing":bool,
                          "installs":[{"id","value","standing","trusted","banned","reputation","votedAt","changedAt","tweetId"}]}]},
   "evidence": [{"tweetId","ok","checkedAt","matchesId":bool}],
   "sightings": {"stored","verified","recent":[{"tweetId","parentTweetId","replyAt","latencySec","verified"}]},
   "clearedVotes": {"rows","networks","slopNetworks","clearedAt"},
   "appeals": [{"appealId","status","createdAt","decidedAt","note","message","email","code"}],
   "timeline": [Activity]}
  ```
  `votes` reads at most 500 vote rows (`truncated` true past that). The `voice` of a network follows 13.2: the votes of its installs with standing when it has one, else all its votes; `split` on a tie. `recent` holds the newest 20 sightings. `timeline` holds the items of kinds `admin`, `status`, `identity`, `appeal`, `list` (the versions that added, changed or removed the handle) for the handle, newest 200.
- `GET /api/admin/installs/:id` → 404 `not_found` without a row, else:
  ```
  {"install": <the row of GET /api/admin/installs> + "network",
   "standing": {"has","trusted","banned","ageDays","goodMarks","reputation","needs":{"ageDays","goodMarks","reputation"}},
   "votes": {"total","items":[{"handle","value","votedAt","changedAt","tweetId","accountStatus"}]},   -- newest 200
   "network": {"network","installs","banned","strikes":[{"handle","clearedAt","standing"}]},
   "timeline": [Activity]}                                                                          -- kinds admin and standing, newest 200
  ```
- `GET /api/admin/lists?limit=<1..60, default 30>` → `{"versions":[{"version","generatedAt","count","from","added":[[handle,score,tier]],"addedCount","removed":[handle],"removedCount"}]}`, newest first; each array at most 200 items.
- `GET /api/admin/jobs?job=score|profiles&limit=<1..500, default 100>` → `{"runs":[{"id","job","startedAt","endedAt","ms","ok","detail"}],"last":{"lastRunAt","lastOkAt","detail"}}`.
- `GET /api/admin/accounts` rows add `name`, `followers` and `listedAt`. `GET /api/admin/installs` rows add `network`. `GET /api/admin/log` entries add `after`.
- The write routes of 5.6 and 13.8 do not change.

### 14.3 The console (`/admin`, `site/admin/index.html`, `site/src/admin/`, `site/src/styles/admin.css`)

Goal: the maintainer reads the state of the whole system and the reason for each state in plain words, and acts from the same screen.

- **Frame**: a header (wordmark, user, log out) and a side navigation (a bar at the top below 48rem) with a live count on Review (pending), Disputed and Appeals (open). Routes are hashes: `#home`, `#review/pending|disputed|auto`, `#appeals/open|accepted|rejected`, `#accounts`, `#account/<handle>`, `#installs`, `#install/<id>`, `#activity`, `#lists`, `#jobs`, `#help`. `#overview` opens `#home`, `#log` opens `#activity` with only `admin` items. The hash stays the only source of the view; a bad handle or id shows a message, never a request.
- **Home**: one health line per job ("The score job ran 3 minutes ago and succeeded", red when the last run failed or the last success is older than 15 minutes for the score job or 10 minutes for the X facts job), the list (version, accounts, time), the queues as cards with their count and the next step in one sentence, the numbers of the last 24 hours, installs (total, with standing, trusted, banned), and the newest 15 activity items.
- **Every state has its reason in words.** The console builds one sentence for each status from `parts` and `rules`, for example: "Pending. The votes pass the test for confirmed, but the standing gate holds it: 1 network with standing marked it, and confirmed needs 2." Each gate, each status, `want`, `identity`, `override`, `seed`, `protected`, `dissent`, `notSlop`, `anchors`, `evidence`, `behaviour`, reputation, standing, good marks, strikes and penalties has a short definition in a glossary (`#help`), and each term on a screen links to it or shows it on focus and hover.
- **Account page** (`#account/<handle>`): name, handle (link to X), avatar from `/api/v1/avatars/:handle` when `profile.avatar`, followers, X id, identity; the status sentence; a checklist of the gates with "has / needs" numbers; whether the newest list holds it; the decisions (the buttons of the review queue); the networks that voted with their voice, standing and installs (each install links to its page); checked posts (link to X, ok or not); reply timing; stored clear rows; appeals; the timeline of the account.
- **Install page** (`#install/<id>`): network, age, version, last seen; standing as a checklist against `needs`; trust and ban buttons; its votes (each handle links to its account page); the network's installs and strikes; its timeline.
- **Activity**: the feed of 14.2 grouped by day, one plain sentence per item ("The score job moved @a from pending to flagged.", "You confirmed @b. The list went to version 412.", "Install 3f2a9c1e gained standing."), each subject a link to its page, filters by kind (with `vote` and `install` off by default) and by subject, and "Show older" with the cursor. An `admin` item shows the state before and after as a readable list of changed fields, never raw JSON by default (a "raw" toggle may show it).
- **Lists**: each version with its time, count, and the handles that joined or left (links).
- **Jobs**: the runs of each job (time, duration, result, the main numbers of `detail`), failed runs in the error colour with the error text.
- **Review, Appeals, Accounts, Installs**: the views of before, with the same writes and the same confirm step, plus: each row opens its account or install page, each column header has its definition, the queue note says what the queue holds and what a decision does.
- Kept from before: the two-click confirm on every write (first click arms for 4 s and names what the second click sends); `x-csrf` and Origin on writes; one live request per view (a newer one aborts the older); on logout and on a session end the console aborts its requests and empties every view, the user name and the counts; keyboard keys (numbers switch views, `/` focuses the filter, `r` reloads); below 48rem each table row shows as label and value lines and nothing scrolls sideways; the CSP of 5.7 (no inline script or style attribute in HTML, no CDN); no new dependency; the text rules of `CONTRIBUTING.md` (you, no we, no em-dash).
- Times show as relative text with the full local time on hover and focus. Numbers use `formatCount`. Empty states say what is empty and why.

## 15. Security round 4 (2026-11-14). Wins over every earlier section.

### 15.1 Networks

- The IP hash prefix of 5.1 is the IPv4 /24 of the client. An IPv6 address uses the embedded IPv4 /24 when it is IPv4-mapped (`::ffff:0:0/96`), IPv4-translated (`::ffff:0:0:0/96`), IPv4-compatible (except `::` and `::1`), 6to4 (`2002::/16`), Teredo (`2001:0::/32`, the client address with the obfuscation removed), or NAT64 (`64:ff9b::/96` or `64:ff9b:1::/48`). Any other IPv6 address uses the /48.
- A zone id is ignored. Upper case, leading zeros, a compressed form, and a dotted quad or a hex spelling of one address are one network. A leading zero in an IPv4 octet is decimal.

### 15.2 Admin login and rate limits

- All networks together share 30 password checks per 15 minutes (`adminLoginGlobal`, one key). The bucket refills with time. A successful login returns the check it took. A 429 from this bucket spends no scrypt and returns the per-network token.
- When `XSLOP_ADMIN_TOTP` is set, a code for the current step that has not been used does not spend this bucket, so a flood of wrong passwords cannot keep the admin out.
- Rate limit table of 5.8, new row: admin login, all networks, 30 password checks/15 min.
- A full limiter drops its oldest key only when that key no longer pays for its limit: a token bucket that has refilled, or a sliding limit under its event limit. A key that is still limited stays. The new key is refused and is not stored.

### 15.3 Admin console text

- The console strips bidi overrides and C0 and C1 control characters from text it shows: names, appeals, job errors, history values and the raw before and after JSON. Newline and tab stay.

### 15.4 Fact source answers

- An avatar URL is fetched only when it is one file under `/profile_images/` on `pbs.twimg.com`, with no `%`, no `..` segment and no `\`.
- The stored display name has control characters, bidi marks and invisible format characters (U+061C, U+200B to U+200D, U+2060 to U+2065, U+FEFF) removed. A name with only those characters is stored as null.

### 15.5 Extension 1.2.1

- Author (replaces the author sentence of 7.3): the one visible link in `[data-testid="User-Name"]` whose text is `@handle` or the handle, and whose path is that same handle. A hidden link does not count (`hidden`, `display:none` or `visibility:hidden`, also on a parent in the header). Two such links that name different accounts, or none, mean no author. The outer avatar link `[data-testid="Tweet-User-Avatar"] a`, when its path is one handle, must name that same account. That test id is fixed in the extension; a remote selector cannot change it. A missing avatar skips this check.
- A content vote or unvote carries `n` (a rising count for that script) and `s` (one id for the life of that script). A resend after a lost answer keeps the same pair. The background applies vote, unvote, restore and the instant-mute record one at a time, stores the last `n` for each `s` in `storage.session` (at most 500 scripts) after the action succeeds, and does not apply a message whose `n` is not higher. The popup sends no stamp. `n` and `s` are not in the vote body sent to the server.
- Storage writes of one key run in order. The later write is the value that storage keeps.
- A stored outbox whose `ops` or `obs` is not an array reads as empty. A non-object entry is skipped.

### 15.6 Advisory locks

- `migrate` takes `pg_advisory_lock($1::int, hashtext(current_schema()))`. One channel does not block the migrations of another channel on the same database.
