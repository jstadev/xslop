# Threat model of the xslop list

This file names who attacks the global list and why, what each attacker can spend, the rule that stops each attack, and the risks that stay, with their price. The rules and their names come from `SPEC.md` section 13 (judging system v2). The numbers come from SPEC 13, the limits of SPEC 12.12 and the measured numbers of `server/src/scoring/README.md` section 9. `docs/list-flow-explained.md` tells the same rules as a flow.

## What the list protects

- A listed account is hidden for every xslop user, and muted on the X account of every user who turned on mute sync. A wrong listing harms a real person. A missed listing leaves slop in view.
- The list never shows who voted. A vote is stored with its install, and an install keeps only a hash of its network. A sighting is stored with no install id.

## The base rule

An identity costs nothing. An install costs one proof of work. A network is the /24 (IPv4) or /48 (IPv6) of the address at registration, and another address costs little. So nothing that costs nothing decides anything (SPEC 13.1). Every automatic change of the published list needs both:

- **Standing**: networks with earned, loseable standing vouch for it.
- **Server facts**: the server itself checked that the account exists on X and that it wrote the posts that the votes name.

Everything else waits in the review queue for a person.

## What an attacker can spend

| Resource | Price | What it buys |
|---|---|---|
| An install | Free: one proof of work | One vote per account. No standing. |
| A network | An address in another /24: a phone, a VPN, a cloud host | One more voice. No standing. |
| Install age | 7 days of waiting | One part of standing. |
| Good marks | 3 slop votes, each cast before the account was public, among the first 5 networks on an account that an admin then confirmed | One part of standing. Each good mark is useful work for the list. |
| Reputation | Votes that agree with admin decisions | Standing needs 0.6 or more. A wrong vote is a penalty: it ends the standing. |
| Admin access | The admin password, the TOTP code, or the cookie of a live session | Every admin action. |
| A fact source | Control of the answers of `cdn.syndication.twimg.com` or `api.fxtwitter.com` | The identity, evidence and reply timing that the server reads. |

## 1. Smear: list an account that is not slop

**Why.** Hide and mute a rival or a critic for every user.

**Spends.** Installs, networks and time. Good marks, if the attacker wants standing.

**Rules that stop it.**
- A crowd of new installs, on any number of networks, makes at most a `pending` account with gate `standing` (13.3, rules 4 and 5). A pending account is not in the list, and every public answer shows it as `none` with score 0. Test 13.9.1 runs this with 2, 7 and 1000 new networks.
- An automatic flag needs 1 slop network with standing (an anchor). An automatic confirm needs 2 (13.2, `ANCHORS_FLAG`, `ANCHORS_CONFIRM`).
- Standing needs an install age of 7 days, 3 good marks and a reputation of 0.6, or an admin sets `trusted` (13.2). Only an admin confirm gives good marks, at most 5 for each confirm: to the first 5 networks by vote time (13.10 items 1 and 2). A confirm by votes gives none. So a ring with standing cannot give itself good marks, and standing in the whole system is at most 5 for each account that the admin confirmed (test 13.9.11 and the attack search of the engine).
- The standing budget: a vote carries standing only when fewer than 5 votes of its network carried standing in the 24 hours before it. A vote past that never carries standing, and there is no waiting list (13.12). The count goes by the time of each vote, so marks set before the install had standing count by their own times.
- A vote that agrees with an answer that was already public scores nothing (13.5). Marks on the public list do not build reputation.
- A listing needs server facts: identity `ok`, and evidence, that is posts that the server read and found written by that account. A flag needs evidence from 1 network, a confirm from 2 (13.6, 13.10 item 6).
- An account with 50,000 followers or more, or an account that an admin protects, changes its public state only by an admin decision (gate `protected`).
- The brakes: at most 30 automatic confirms and 60 automatic flags in 24 hours. The rest wait in the review queue (gate `brake`). The order puts the accounts with the most anchors first, then the share of the voices with standing, so votes without standing never move an account up (13.10 item 6, 13.12). The admin queue `auto` lists the recent automatic confirms.
- An admin clear with penalty stores the votes of the account in `cleared_votes` (13.5). Each slop mark there is a penalty: it ends the standing of its install at the next run, and only good marks of slop votes set after it count again (13.10 item 3, 13.12). Each slop network without standing gets a strike; the slop networks with standing get one when at most 10 of them marked the account (13.10 item 5). 2 strikes with standing in 30 days silence a network on every account. A deleted or changed vote changes no strike and no penalty (test 13.9.10).
- Every admin clear publishes the list in its own transaction (13.7). The removal does not wait for the score job.

**Risks that stay, with their price.**
- Each install with standing lists at most 5 victims a day as flagged, with one more network and one real post of the victim as evidence. Two installs with standing confirm. Marks set before the install had standing count by their own times: an install that marked 10 victims a day for 7 days flags 35 of them in its first run with standing (measured), inside the flag brake of 60 a day. The victims stay listed until the admin works the appeals or the queues; then each ring install that marked them gets a penalty and loses its standing at once. Price of 1 listing: 1 install with standing, that is 7 days and 3 good marks, each a place among the first 5 networks on a real slop account that the admin then confirmed. Price of 500 listings: 100 installs with standing (300 good marks, so 60 or more admin confirms of real slop in which the ring voted first) and 9 days of flag places (60 a day).
- Measured in the attack search of the engine (README section 9: 30 honest users, a ring that earns standing for 9 days and then attacks for 15 days, an admin pass once a day): a ring of 1, 2, 5 and 20 installs with standing listed 5, 10, 22 and 39 of 40 victims, each for one run until the admin pass. Every smear ring ended with 0 installs with standing. One install with standing that marks 20 accounts in an hour, with 1 other network each, flags 5; the other 15 stay pending (gate `standing`), also 1 and 7 days later.
- A flagged account is hidden only for users who chose Strict, and it is not muted by mute sync.

## 2. Shield: keep a slop account off the list, or take it off

**Why.** Protect an own account or the account of a client.

**Spends.** Installs, networks, "not slop" clicks, appeals, a rename on X.

**Rules that stop it.**
- "Not slop" counts only with standing (13.2). A not-slop voice without standing is in no tally, no share, no factor model and no "contested" test. The engine only counts it in `parts.dissent`. Test 13.9.3: 1000 such votes change no status. Test 13.9.5: one install with 50 "not slop" votes changes no account that it did not touch.
- One not-slop voice with standing makes the share test use standing voices on both sides. If the bound fails only for that reason, the account waits as `pending` with gate `dispute`, and a person decides (13.3, test 13.9.4).
- A not-slop vote that was set before an admin confirm is a penalty: it ends the standing of its install at the next run (13.10 item 3). The confirm stores a copy of the vote, so a delete or a flip after the confirm keeps the penalty (13.12).
- The standing budget holds for "not slop" too: at most 5 votes of a network in any 24 hours carry standing (13.12).
- Votes never remove a starter account (13.3, rule 3). Disputes only put it in the `disputed` queue of the admin.
- An appeal needs a code in the X bio of the account, and an admin decides.
- The one-camp veto switches on only through two-sided networks, and a not-slop voice counts only with standing (13.4). New installs cannot make a second camp.
- The list follows the X id. A rename moves the state of the old handle to the new one in one transaction, when both sources agree (13.11, test 13.9.13).

**Risks that stay, with their price.**
- One "not slop" voice with standing holds an account with 5 anchors or fewer in the review queue (gate `dispute`), at most 5 accounts a day per network, until the admin confirms them. Each such confirm is a penalty that ends the standing of the shield. Measured in the attack search (README section 9): a real slop account with 6 anchors or more was held in 1 run, by the ring of 5, and in no run by the rings of 1, 2 and 20.
- Two-sided networks with standing can switch on the one-camp veto. Price: standing on each of them. The account waits for a person; it is not cleared.
- An account that the source cannot find gets identity `gone` and keeps its state (13.10 item 10), so a false 404 takes nothing off the list. A handle that X gives to another X id is `moved` and leaves the list.
- A listed account without a proven post (for example a starter account) can rename on X. Its state stays on the old handle, where it hides nobody, and the new handle returns to the list only through votes (13.12). Price: a rename on X.

## 3. Vandal: make the service or the list useless

**Why.** Noise, a full review queue, lost admin time, limits that block real users.

**Spends.** Installs, networks, requests.

**Rules that stop it.**
- Votes of installs without standing alone change no published status (13.1). A flood ends in the review queue.
- The `pending` queue sorts by anchors first, then checked evidence, reply timing and slop trust (13.10 item 8). A flood without standing sorts below every account with an anchor.
- A network counts 50 votes in 24 hours. Votes of installs with standing take their places first (13.2).
- The hourly install limit of a network counts registrations that succeeded, so empty requests cannot close registration for an address (13.8).
- Behaviour (reply timing) never changes a status (13.3), and the engine reads only sightings that the server verified (13.6). Invented sightings change nothing.
- Votes of installs without standing alone start no request to the fact sources, except through step 3 of the work order, which takes at most 20 pending accounts a run that have a request left, and asks each post once in a run (13.6, 13.12). Step 1 needs an anchor. In each step, the job takes accounts round robin by sponsor network, at most 3 per sponsor. Steps 1 to 3 take at most 80 of the 120 accounts of a run and start no account after 160 requests, so the weekly check of listed accounts always runs (13.10 item 7, 13.12).
- The limits per install, per network and for all networks of SPEC 12.12.

**Risks that stay, with their price.**
- Free installs on many networks can fill the `pending` queue with any number of accounts. Price: one proof of work per install. The cost falls on the time of the admin, not on the list.
- Step 3 of the work order takes every pending account with a request left, those that the crowd would confirm first, then the most networks, at most 3 per sponsor network (13.10 item 7). Two free networks put an account there, so a flood can take up to 160 requests of a run; a checked account leaves step 3, so the flood must keep buying new votes or sightings to hold it. Accounts with an anchor come first (step 1).
- An attacker with standing can take flag places of a day. The order puts more anchors first, so honest accounts with more anchors than the victims keep their places; ties go by handle.
- Bait: an attacker who owns an X account lets honest users mark it, cleans the account and appeals. An accept with the penalty strikes every network that marked it (networks with standing only up to 10) and gives each install a penalty. 2 such clears in 30 days silence those networks. The admin accepts such an appeal without the penalty (13.12).

## 4. A stolen admin session

**Why.** Use the power of the admin: confirm, clear, protect, trust, ban.

**Spends.** A phished password, a stolen cookie, or malware in the browser of the admin.

**Rules that stop it.**
- With `XSLOP_ADMIN_TOTP` set, a login needs the 6-digit code, and one code works once (13.8). A wrong code answers like a wrong password.
- The cookie `__Host-xs_admin` is `HttpOnly`, `Secure` and `SameSite=Strict`. The database keeps only its SHA-256. Every change needs the `x-csrf` value and the `Origin` of the site (5.6).
- A session ends after 30 minutes without a request and after 12 hours (13.8).
- Admin changes have a limit of 30 a minute per address. At most 2 password checks run at a time (12.13).
- Every change writes one `admin_log` row with the state before, in the same transaction (13.8). The maintainer sees each change and the state to restore.
- `ban-voters` refuses an account whose slop voters that are not banned are on more than 10 networks (409 `crowd_too_large`). The console shows that count on the button and turns the button off above 10 (13.12).
- A stolen session reads no address (14.1, 14.2). No admin answer holds an `ip_hash`, an address, a post text or a cookie. A network shows only as its label: the first 8 hex characters of SHA-256 of the salted `ip_hash`. Without the salt, the label gives no address back. The `events` and `job_runs` tables keep no `ip_hash`. The score job deletes events after 400 days and job runs after 30 days. Each `admin_log` row of a change also keeps the answer in `after`, so the maintainer sees the result of each change of a thief.

**Risks that stay, with their price.**
- Inside a live session, the thief can do every admin action, 30 a minute. A trust gives an install standing, so it also acts after the session ends. Price: the browser of the admin, or the password and a fresh code. Recovery: read `GET /api/admin/log`, restore each state from `before`, remove every trust that the log shows, end every session, and change the password hash and the TOTP secret.
- Without `XSLOP_ADMIN_TOTP`, the password alone opens a session.
- `admin_log` records actions through the API. Access to the database is outside its view.

## 5. A hostile co-tenant on a shared address

**Why.** Turn or starve the voice of a network that many people share: an office, a school, a phone carrier, a VPN exit.

**Spends.** Installs on the same /24.

**Rules that stop it.**
- When installs with standing on a network voted on an account, only their votes make the voice of that network (13.2). An install without standing never turns the voice of an install with standing (test 13.9.9).
- Votes of installs with standing take the 50 daily places of the network first (13.2).
- A strike has standing only when a slop voter of the network had standing at the clear. 2 strikes without standing silence only the installs without standing of the network, so co-tenants without standing cannot silence the install with standing there (13.12). Measured (README section 9): 2 installs without standing on the address of an anchor make 2 marks that an admin clears; the network gets 2 strikes without standing, and the anchor keeps its voice.
- Installs with standing have their own stored-vote limit of 120 a day (13.8). They do not use the 200 a day of their network.

**Risks that stay, with their price.**
- Two installs with standing on one network share one voice (weighted majority) and the 5 votes with standing of each day. Price: standing on that network.
- Installs without standing on one network share one voice and the 200 stored votes a day among themselves. One of them can turn that voice or use up the day, and the others get 429 until the next day. Price: one install. Votes without standing decide nothing automatic.
- The install budget of a network (1000 in 30 days) is shared. Price: one proof of work per install.

## 6. A lying fact source

**Why.** Make the server believe false facts: a post that the target did not write, an account that is gone, a handle that moved, a follower count.

**Spends.** Control of the answers of `cdn.syndication.twimg.com` (the embed answer of X) or `api.fxtwitter.com`, or of the path to them.

**Rules that stop it.**
- Fixed hosts, HTTPS, `redirect: 'error'`, a timeout, a byte cap and strict parsing of each field. No value from an answer reaches a URL without a check. One request per 2 seconds, one run at most 9 minutes (13.6).
- Evidence is a gate, not a vote. A false author on a post cannot list an account: the anchors of standing are still needed (13.3).
- Behaviour never changes a status (13.3). A false reply time changes no status.
- A false follower count can only hold an account for a person (gate `protected`). It never lists one.
- `gone` takes no account off the list (13.10 item 10). `moved` needs the embed answer of X for a proven post of the stored X id, or two checks on different days that name the same other X id. A check that names another X id stores no name, follower count or avatar of it.

**Risks that stay, with their price.**
- Profile facts (the X id of a handle, the follower count, a missing account) come from FxTwitter alone. Post facts come from the embed answer of X, and from FxTwitter when the embed answer fails. A rename needs both sources (13.11); the other profile facts have no second opinion.
- The same false X id for a handle with a stored id, on two checks on different days, takes a listed account off the list at the next score run (rule 0). A false "missing" takes nothing off the list. Such a source cannot list an account and cannot move a state (13.12).
- A rename moves the state of row A to handle B when both sources say that B now has the X id of A (13.11). False answers of both sources list B with the state of A, with no standing involved.
- The first check of an account with no stored X id stores the id that the source gives. The list carries that id, and mute sync mutes by id (13.8). A false id makes mute sync mute the wrong account.
- Price: control of the answers that the job reads for one handle or one post. The embed source belongs to X. FxTwitter is a public service of a third party, so a fault or a change there is the cheaper path. A rename already needs both sources. A rule that both sources must agree before `moved` or a new X id would raise the price to both sources.

## Out of scope

X itself, X markup changes, denial of service by volume, and the host of a deployment. `SECURITY.md` has the full scope and how to report.
