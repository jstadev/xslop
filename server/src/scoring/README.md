# xslop scoring engine (judging system v2)

`computeScores(input)` turns votes, installs, accounts, verified sightings and the rows of
admin clears into one status, tier and score per account, and one reputation, good-mark count
and standing per install. It is pure and deterministic: it reads no clock (`now` comes in the
input), does no I/O and uses no randomness. The same rows in any order give the same output.

The principle (SPEC.md 13.1 and 13.10): an identity costs nothing, so nothing that costs nothing
decides anything. A crowd of any size can only make an account `pending`. An automatic flag needs
a slop network with standing and one network whose vote names a post that the server verified; an
automatic confirm needs two of each. Standing starts at the maintainer: only an admin decision
gives good marks, and a wrong vote takes the standing away. Everything else waits for a person.

Steps, in order (`index.ts`):

1. `input.ts` validates the input and sorts it into a canonical order.
2. `weight.ts`: trust, weight and the standing that counts in this run.
3. `network.ts`: the struck networks (from the rows of admin clears), the daily budget of each
   network, then one voice per network on each account.
4. `factorize.ts`: the one-camp veto.
5. `rules.ts`: the rules 0 to 6, the score; `index.ts` applies the daily brake; `needed.ts`.
6. `reputation.ts`: reputation and good marks; `weight.ts`: the standing for the next run.
7. `behaviour.ts`: reply timing, information only.

`criteria.ts` is the public text of these rules (`GET /api/v1/criteria`, version 2). It builds
every number from the constants below.

## 1. Input

- Installs carry `trusted` (only an admin sets it) and `standing` (stored by the previous run).
  Accounts carry `overrideAt`, `listedAt`, the stored `status`, `identity` (`unknown`, `ok`,
  `gone`, `moved`), `evidence` (networks whose counted slop vote names a post that the X facts job
  found written by the account) and `protected` (`accounts.protected` or followers ≥
  `PROTECTED_MIN_FOLLOWERS`). `clearedVotes` are the rows that an admin clear with the penalty
  stored, each with the `standing` of its install at the clear, and the "not slop" rows that an
  admin confirm stored (round 2 H1). `autoConfirmsToday` and `autoFlagsToday` count the automatic
  confirms and flags of the last 24 hours. The engine does not read `clearPenalty`: rows exist only
  for a clear with the penalty.
- A bad field throws a `TypeError` that names the row and the field (for example
  `ScoringInput.accounts[3].identity must be one of unknown, ok, gone, moved`). The job then
  writes nothing and keeps the previous scores: fail closed. Every field has an explicit type,
  length or pattern; duplicates of install ids, handles, tweet ids, (install, handle) votes and
  (install, handle) cleared rows are rejected.
- A handle that only votes, sightings or cleared rows name gets an output row with no state and
  identity `unknown`, so it can never pass a gate.
- Sightings: verified only (the X facts job checked the post, its author and its parent).
  `replyAt` in `[now − 30 days, now + 10 min]`, newest 50 per account.

## 2. Trust, weight and standing (`weight.ts`)

`trust = reputation × age factor`. `weight = trust ÷ √(installs that are not banned on the network)`.
Weight decides the majority inside a network; everything after that uses the voice and its trust.

**Standing** in this run: not banned, and (`trusted`, or the stored standing with an age of at least
7 days and a reputation of at least 0.6, and, for an install with a penalty, at least 3 slop votes
set after the newest penalty on accounts that an admin confirmed). The checks repeat the rule, so a
loader fault never gives standing to a new install and a penalty takes the standing away in the
first run that sees it. **Standing for the next run**: not banned, and (`trusted`, or age ≥ 7 days,
good marks ≥ 3 and the new reputation ≥ 0.6).

| Constant | Value | Reason |
|---|---|---|
| `AGE_FACTOR_FIRST_DAY`, `AGE_FACTOR_FIRST_WEEK` | 0.3, 0.7 | A new install is cheap. Its trust counts less in the trust floor of a confirm. |
| `REPUTATION_MIN`, `REPUTATION_MAX`, `REPUTATION_PRIOR` | 0.05, 1, 0.5 | Beta(1,1) mean, clamped. |
| `NEW_INSTALL_TRUST` | 0.15 | Prior × first-day factor: the weakest ordinary voter (`needed` counts with it). |
| `STANDING_MIN_AGE_DAYS` | 7 | Standing cannot be bought in a day: a ring must keep its installs for a week. |
| `STANDING_MIN_GOOD_MARKS` | 3 | Three marks that a trusted decision approved, before the answer was public. |
| `STANDING_MIN_REPUTATION` | 0.6 | Above the prior: wrong marks (an admin clear with a penalty) or "not slop" on an admin confirm push an install below it. 3 good marks and 0 wrong ones give 0.8; 3 good and 6 wrong give 0.36. |
| `STANDING_DAILY` | 5 | Votes of one network that carry standing in 24 hours; a vote past that never carries standing (network.ts). |

## 3. Networks (`network.ts`)

**Strikes.** From the rows of `cleared_votes` only, so a vote that is deleted or flipped after the
clear keeps its strike. Per cleared account, the rows of each network count by majority; a slop
majority is one strike at the time of the clear. The strike has standing when a slop row of the
network had standing at the clear. When more than `STRIKE_MAX_CROWD` slop networks with standing
marked the account, those networks get no strike (the admin overruled a real crowd); a network
without standing gets its strike at any crowd size (13.10 item 5). Rows of a starter account, of an
account that an admin now confirms and of a clear in the future give none. The rows of a banned
install count: a ban does not lift a strike. A network with 2 strikes with standing in the window is
silenced whole (trust 0); a network with 2 strikes of any kind silences only its installs without
standing, so installs on a shared address cannot silence the install with standing there (round 2 H4).

| Constant | Value | Reason |
|---|---|---|
| `STRIKE_LIMIT` | 2 | One strike can be an honest mistake. Two inside the window are a pattern. |
| `STRIKE_WINDOW_DAYS` | 30 | Struck while its 2 newest strikes are less than 30 days apart and the newest is less than 30 days old. |
| `STRIKE_MAX_CROWD` | 10 | An account that more than 10 networks with standing marked gives them no strike: there the admin overruled a real crowd (measured in v1: 2 such clears silenced 100 of 100 networks). A ring of networks without standing gets its strikes at any size. |

**Standing budget** (13.12, replaces the waiting rule of 13.10 item 4). A vote of an install with
standing carries standing when fewer than `STANDING_DAILY` = 5 votes of its network, slop and "not
slop" together, carried standing in the 24 hours before it. A vote past that never carries standing,
also not in a later run: a slop vote stays a plain network, a "not slop" vote stays `dissent`. So any
24 hours hold at most 5 votes with standing per network, and there is no waiting list. All installs
with standing on one network share it. A vote after `now` carries none. Measured: an install with
standing that marks 20 accounts a day for 7 days anchors the first 5 marks of each day (35), and its
new mark the next day carries standing (flagged). With the waiting rule of round 2 the same mark
still had no standing 14 days later (round 2 H6).

**Budget.** `NETWORK_DAILY_VOTES` = 50 counted votes per network in any 24 hours. The queue of a
network holds the votes that carry standing first, in time order, then the slop votes without
standing. A vote is released at its own time, at the release of the vote before it, or one day
after the vote 50 places earlier, whichever is latest. Releases never go back in time, so any 24 hours release at most 50 votes. A vote counts when it
is released by `now`. Votes without weight and "not slop" without standing use no place.

**Voice.** One voice per network on each account. If votes that carry standing on the network count,
only they make the voice (weighted majority; a tie has no voice), and the voice has
standing. Else a slop vote of the other installs makes a slop voice without standing. "Not slop"
without standing makes no voice: the network counts in `parts.dissent` only. The trust of a voice
is the trust of its most trusted voter on its side.

- `networks`, `trust`: slop voices. `anchors`, `anchorTrust`: slop voices with standing.
- `notSlop`, `notSlopTrust`: not-slop voices (always with standing). `dissent`: networks with only
  "not slop" without standing.

## 4. Rules (`rules.ts`)

The share test: with no not-slop voice, the Wilson lower bound of an undisputed crowd,
`wilson(1, networks)`. With one or more, standing voices only on both sides:
`wilson(anchorTrust ÷ (anchorTrust + notSlopTrust), anchors + notSlop)`. A crowd test passes
when the crowd passes before any dispute (networks, trust, `wilson(1, networks)`), and then the
share test and the one-camp veto. A crowd that passes before the dispute and fails after it is
held with gate `dispute`.

The first rule that matches wins:

0. `identity` is `moved`: `none`, reason `moved`. A `gone` account keeps a tier that it holds in the
   stored status and fails the `identity` gate of a tier that it does not hold (13.10 item 10).
1. `override`: `confirm` is confirmed (score 1), `clear` is cleared.
2. `clearedAt` without an override (an admin reset): only votes after it count. The crowd confirm
   test with at least `CLEARED_RETURN_MIN_NETWORKS` slop networks: `pending`, gate `review`. Else cleared.
3. A starter account: confirmed, reason `seed`, score at least `SEED_SCORE_MIN`. `parts.disputed`
   when at least 5 not-slop networks with trust ≥ 1 pass a not-slop bound of 0.6 (standing voices
   on both sides).
4. The crowd confirm test. Gates in order: `protected`, `identity`, `standing` (anchors < 2),
   `evidence` (< 2), `brake`. All met: confirmed, `votes_confirmed`. Else `want = 'confirmed'`,
   `gate` = the first gate not met, and on to rule 5.
5. The crowd flag test. Gates: `protected`, `identity`, `standing` (anchors < 1), `evidence` (< 1),
   the flag brake. All met: flagged, `votes_flagged` (rule 4 may have set `want` and `gate`). Else
   `pending`.
6. `none`.

**The brakes.** The accounts that would become confirmed and were not confirmed in the stored state
are ordered by anchors (most first), then the share bound of the voices with standing, then the
handle. The first `MAX_AUTO_CONFIRMS_PER_DAY − autoConfirmsToday` are confirmed; the others get gate
`brake` and go on to rule 5. Then the accounts that would become flagged and were not flagged or
confirmed in the stored state are ordered the same way; the first `MAX_AUTO_FLAGS_PER_DAY −
autoFlagsToday` are flagged, the others are `pending` with gate `brake`. The order reads standing
voices only, so new installs that add networks never move an account up (round 2 H2).

| Constant | Value | Reason |
|---|---|---|
| `FLAG_MIN_NETWORKS`, `FLAG_SHARE_BOUND` | 2, 0.5 | An undisputed crowd of 2 gives a bound of 0.549 and passes. With a dissent of standing, 2 anchors against 1 give 0.321: a person decides (gate `dispute`). |
| `CONFIRM_MIN_NETWORKS`, `CONFIRM_SHARE_BOUND` | 4, 0.6 | An undisputed crowd of 4 gives 0.709 and passes. With one dissent of standing: 6 anchors give 0.622 and pass, 5 give 0.575 and 3 give 0.433 and wait. An even split never passes (10 voices: 0.312, 100 voices: 0.436). |
| `CONFIRM_MIN_TRUST` | 1 | 7 first-day installs or 4 older ones. Kept from v1; standing now does the real work. |
| `WILSON_Z` | 1.2816 | One-sided 90%. |
| `ANCHORS_FLAG`, `ANCHORS_CONFIRM` | 1, 2 | A network with standing vouches. Two for a confirm, so one network with standing never confirms alone. |
| `EVIDENCE_FLAG`, `EVIDENCE_CONFIRM` | 1, 2 | Networks whose vote names a post that the server found written by the account. A vote names a post, but only the server says who wrote it. |
| `PROTECTED_MIN_FOLLOWERS` | 50,000 | A large account is the best target for a brigade and the worst error. A person decides. |
| `MAX_AUTO_CONFIRMS_PER_DAY`, `MAX_AUTO_FLAGS_PER_DAY` | 30, 60 | A ring that earned standing still cannot fill the list in a day. |
| `SEED_DISPUTE_MIN_NETWORKS` | 5 | A starter account had a curator; a dispute needs more than a confirm. It only marks the account for the admin. |
| `CLEARED_RETURN_MIN_NETWORKS` | 6 | A cleared account had a person look at it. It returns only to the review queue. |
| `SEED_SCORE_MIN` | 0.8 | A starter account publishes at least this score. |

## 5. The one-camp veto (`factorize.ts`)

The factor model `r ≈ μ + i_u + i_a + f_u·f_a` (one factor, weighted ridge, alternating exact
block steps, μ = 0.5 fixed, rater factor centered) is fitted on the voices: every slop voice and
the not-slop voices with standing. It decides nothing but the veto:

- A **contested** account has a slop voice and a not-slop voice.
- A network is **two-sided** with at least `TWO_SIDED_MIN_VOICES` (3) voices on contested accounts,
  slop and not slop among them. A rater that only marks, or only says "not slop", has no stance.
- An account is **fitted** with at least `FITTED_MIN_VOICES` (4) slop voices from two-sided networks.
- The side fit of each account uses only its slop voices, with the rater parameters of the full
  fit and `f_u = 0` for every network that is not two-sided.
- **Veto**: a fitted account with `|f_a| ≥ VETO_FACTOR` (0.5) in the side fit fails both crowd tests
  (gate `dispute`). `parts.factor` is that `f_a`, 0 when not fitted. When no network is two-sided,
  the model does not run (`model.epochs` is 0).

Why the v1 level test is gone (measured 2026-11-12 on v1): a crowd that only clicks slop could not
reach `i_a ≥ 0.40` at reputation 0.5 (166 networks: 0.386), so one new install with 50 "not slop"
votes took 117 crowd confirms to 0, and 5 honest clicks took them to 60. In v2 an install without
standing has no not-slop voice, a network that only marks is never two-sided, and the veto reads
only `|f_a|` of the slop side (measured on v2: 166 networks with standing and 1 not-slop voice with standing on each of 5 accounts confirm all 5, `factor` 0, and the model does not run (`factorize.test.ts`)).

| Constant | Value | Reason |
|---|---|---|
| `LAMBDA_INTERCEPT`, `LAMBDA_FACTOR` | 0.15, 0.03 | Intercepts cost 5 times more than factors, so a split between groups goes into the factor. |
| `MAX_EPOCHS`, `MAX_EPOCH_VOTES` | 2000, 200 000 000 | Bound the run time at any size. |
| `CONVERGENCE_TOLERANCE`, `FACTOR_INIT_SCALE` | 1e-7, 0.1 | Stop rule; a hash of the network name starts `f_u`, independent of row order. |

## 6. Score and `needed`

`score`: cleared and none 0; pending, flagged and confirmed by votes: the bound of the share test
(the review queue sorts by it); a starter account at least 0.8; an admin confirm 1. Published floats
keep 3 decimals. Every public route publishes 0 for an account that is not flagged or confirmed.

`needed`: more slop networks of brand-new installs (trust 0.15, no standing) until the crowd test of
the next tier passes (flag, then confirm); 0 when it passes, at the top, for a cleared account and
for `moved`. It is a promise about the head count only: the gates still decide.
`NEEDED_MAX` is 20.

## 7. Reputation, good marks and penalties (`reputation.ts`)

Beta(1,1) mean over scored votes, clamped to [0.05, 1]. Only an admin decision is a trusted decision
(13.10 item 1): a confirm by votes, also with anchors, scores nothing. A vote is scored only when it
counted (budget, weight, after a clear) and was set before the answer was public:

- **Admin confirm** (`override = 'confirm'` with `overrideAt`): the first `GOOD_MARKS_PER_ACCOUNT`
  (5) networks by the time of their slop vote set before the account was public
  (`min(listedAt, overrideAt)`), in each network the install with the earliest such vote, get a
  **good mark** (13.10 item 2). Other slop votes score nothing. A not-slop vote before `overrideAt`
  disagrees, also from an install without standing and when the account was already public.
- **Admin clear with the penalty**: the stored `clearedVotes` rows only. A slop row disagrees, a
  not-slop row agrees. Live votes on the account are not scored.
- A starter account, a vote that agrees with a public answer and a vote past the budget score nothing.

**Penalties** (13.10 item 3): a slop row of an admin clear with the penalty (at the clear), and a
"not slop" vote set before an admin confirm (at the confirm), live or in the row that the confirm
stored (round 2 H1: without the row, deleting or flipping the vote after the confirm removed the
penalty). `goodMarks` counts only good marks of slop votes set after the newest penalty (round 2 H3:
marks placed before a penalty and confirmed after it gave the standing straight back). `trusted`
installs keep their standing.

So standing in the whole system is at most 5 good marks for each admin confirm (the attack search
asserts it on every run), a crowd with standing makes no good mark, and a wrong vote that an admin
catches takes the standing away until 3 new marks pass 3 new admin confirms.

## 8. Behaviour (`behaviour.ts`): information only

Reply timing never changes a status. `parts.behaviour` (0 below `BEHAVIOUR_MIN_SIGHTINGS` = 10
verified sightings) and `parts.fastReplyShare` help the review queue and the public page of a listed
account. Fixed weights, no fit: `score = σ(−3 + Σ weight·(x − center) ÷ scale)`.

| Feature | Center | Scale | Weight | Reason |
|---|---|---|---|---|
| fastReplyShare (≤ 60 s) | 0.2 | 0.25 | +1.0 | People rarely reply within a minute. Reply bots do it all the time. |
| veryFastReplyShare (≤ 20 s) | 0.05 | 0.2 | +1.0 | Under 20 s is too fast to read a post. |
| logMedianLatency | 6.0 (≈ 400 s) | 1.5 | −0.8 | A long typical delay is human. |
| logMaxRepliesPerHour | 1.1 (≈ 2) | 0.7 | +0.6 | Bursts of replies are a sign of automation. |
| logDistinctParents | 1.8 (≈ 5) | 1.0 | +0.3 | Many threads in 30 days: a weak sign. |

Measured: 30 verified sightings of a reply-bot pattern (a reply every 4 minutes, 5 to 45 s after the post) score 0.998; a human pattern (a reply every 9 hours, 10 minutes to 6 hours after the post) scores 0.004. Neither changes a status (`engine.test.ts`).

## 9. Launch and attacker numbers

Measured with `computeScores` on 2026-11-12 (`test/scoring/launch.ts`, `simulation.test.ts`,
`abuse.test.ts` assert them).

**Launch.** 200 users install on day 0. Each day each marks 3 accounts (Zipf over 300 accounts).
The engine runs at noon; the X facts job has checked every marked account (identity ok, evidence =
min(slop networks, 3)); an admin approves every pending account with `want = 'confirmed'` once a day.

| Day | Admin confirms | Automatic confirms | Flagged | Pending | Installs with standing |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 81 | 0 |
| 2 | 17 | 0 | 0 | 123 | 0 |
| 3 | 63 | 0 | 0 | 119 | 0 |
| 4 | 93 | 0 | 0 | 121 | 0 |
| 5 | 120 | 0 | 0 | 116 | 0 |
| 6 | 143 | 0 | 0 | 111 | 0 |
| 7 | 169 | 0 | 0 | 98 | 0 |
| 8 | 190 | 0 | 0 | 89 | 165 |
| 9 | 210 | 12 | 57 | 2 | 173 |
| 10 | 210 | 21 | 55 | 1 | 173 |
| 11 | 210 | 32 | 46 | 1 | 173 |
| 12 | 210 | 43 | 42 | 1 | 173 |
| 13 | 210 | 53 | 33 | 0 | 173 |
| 14 | 210 | 59 | 27 | 0 | 173 |

The first automatic confirm happens on day 9: the users are 7 days old on day 8, their marks on the accounts that the admin approved are good marks (5 for each admin confirm), and the run of day 8 stores their standing. 173 of 200 users reach standing; the others were never among the first 5 networks of 3 confirmed accounts. The brakes never bind here (at most 12 new automatic confirms in a day). Without the admin, day 14 has 0 confirmed, 0 flagged, 296 pending and 0 installs with standing: standing starts at a person, so the review queue must be worked at launch.

**Attacks.** Measured with the populations of `abuse.test.ts`, `strikes.test.ts`,
`reputation.test.ts`, `factorize.test.ts` and `attack.test.ts`; the tests assert each outcome.

| Attack | Result |
|---|---|
| 2, 7, 100, 1000 brand-new networks mark an account | pending (gate standing), anchors 0 |
| 30 installs with standing on one network | none, networks 1, anchors 1 |
| 1000 "not slop" votes without standing against 2 anchors and 2 new networks | confirmed, notSlop 0, dissent 1000 |
| 1 "not slop" with standing against 2 anchors and 2 new networks | pending (gate dispute) |
| 1 "not slop" with standing against 6 anchors | confirmed |
| Probes 1 to 3 of 2026-11-12 (200 users with standing) | no account that they did not touch changes |
| 1, 2, 3, 20 installs without standing join the address of an anchor and say "not slop" | confirmed, anchors 2, notSlop 0 |
| 50 junk votes on the address of an anchor earlier that day | confirmed, networks 4 |
| 2 installs without standing on the address of an anchor make 2 marks that an admin clears | the network gets 2 strikes without standing; the anchor keeps its voice (anchors 4 of 4) |
| A ring of 12 month-old networks marks 4 accounts | all pending; reputation 0.5, 0 good marks, no standing |
| 2 anchors confirm 3 accounts of their ring | confirmed by votes; 10 ring installs: reputation 0.5, 0 good marks, no standing |
| 8 networks mark an account before the admin confirms it | good marks for the first 5 networks only |
| An install with standing marks 20 accounts in an hour (1 other network each) | 5 flagged, 15 pending (gate standing); the same 1 and 7 days later |
| An install with standing marks 20 accounts a day for 7 days | the first 5 marks of each day anchor; a new mark the next day carries standing (flagged) |
| An install with standing says "not slop" on 20 accounts | 5 held (gate dispute), 15 confirmed with dissent 1 |
| Two camps of 8 with standing | one camp marks: pending (gate dispute); both camps mark: confirmed |
| 4 to 20 attacker networks that are two-sided add slop votes to accounts that 2 to 100 honest anchors confirm | 0 vetoed; largest \|factor\| 0.286 (probe) |
| 3 anchors and 500 new networks on a protected account | pending (gate protected) |
| 40 accounts pass every gate in one run (brake 30) | confirmed 30, flagged with gate brake 10 |
| 10 new installs add networks to the 31st account of a full brake day | the same account waits (gate brake) |
| 2 accounts with 6 anchors each, one with 1 "not slop" voice with standing, 1 place left in the day | the account without the dissent is confirmed; the other waits (gate brake) |
| 61 accounts pass every flag gate in one run (flag brake 60) | 60 flagged, 1 pending (gate brake) |
| Strikes after the voters delete or flip their votes | hold (rows stored at the clear) |
| 6 networks mark an account after an admin reset | pending (gate review) |
| A penalty, then 3 marks placed before it are confirmed | goodMarks 0, no standing, no anchor in that run |
| "Not slop" before an admin confirm, then the vote is deleted or flipped | the stored row keeps the penalty: goodMarks 0, no standing |

**Attack search** (`attack.test.ts`, `attack.ts`): 30 honest users, 2 marks a day each on new real
slop accounts; a ring of N installs that marks real slop 4 times a day for 9 days to earn standing,
then attacks from day 10 to day 24; 6 new installs on new networks join each victim every day; an
admin who confirms real slop in the review queue and the automatic queue once a day, rejects every
pending account that is not slop and accepts every appeal of a listed victim (both clears with the
penalty), and stores the "not slop" votes at each confirm. Each run asserts: no listing without the
anchors and the evidence of its tier; "not slop" without standing changes no public state; at most 5
good marks for each admin confirm and standing only with 3 good marks; the votes that one ring network
cast in the last 24 hours change at most 50 public states; every number finite; any row order.
Measured again on 2026-11-12 with the standing budget of 13.12 (smear with 5: 22, was 24; farm with
20: 12, was 11; the other cells did not change).

| Goal (days 10 to 24) | N = 0 | 1 | 2 | 5 | 20 |
|---|---|---|---|---|---|
| Smear: victims listed (each for one run, until the admin pass) | 0 | 5 | 10 | 22 | 39 of 40 |
| Shield: runs a real slop account with 6 anchors or more was held | 0 | 0 | 0 | 1 | 0 |
| Ring installs with standing at the end (smear, shield) | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| Farm (random marks, deletes, flips on victims): victims listed, ring standing at the end | 0, 0 | 0, 1 | 2, 0 | 3, 0 | 12, 0 |

The farm ring of 1 keeps its standing because one network alone never reaches a crowd test, so the
admin never sees its votes; it changes nothing.

**What this does not stop (the risks that stay).**

- **Smear with earned standing.** Each install with standing lists at most `STANDING_DAILY` (5)
  victims a day as flagged (one network more and a real post of the victim as evidence), and two
  installs with standing confirm. Marks set before the install had standing count by their own
  times: an install that marked 10 victims a day for 7 days flags 35 of them in its first run with
  standing (measured; 40 with the waiting rule of round 2), inside the flag brake of 60 a day. The victims stay listed until the admin works the appeals or the
  queue; then every ring install that marked them gets a penalty and loses its standing at once. To
  list 1 victim the attacker needs 1 install with standing: 7 days and 3 good marks, each a place
  among the first 5 networks on a real slop account that the admin then confirmed. To list 500 he
  needs 100 installs with standing (300 good marks, so 60 or more admin confirms of real slop in
  which his networks voted first) and 9 days of flag places (60 a day), and the 500 listings last
  until the next admin pass. The admin decides nothing wrong in this model.
- **Shield.** One "not slop" voice with standing holds an account with 5 anchors or fewer in the
  review queue (gate dispute), 5 accounts a day per network, until the admin confirms them; then the
  install loses its standing (only with the "not slop" rows that the confirm stores).
- **Brake.** An attacker with standing can take flag places of a day: the order puts more anchors
  first, so honest accounts with more anchors than his victims keep their places; ties go by handle.
- **Bait.** An attacker who owns an X account can let honest users mark it, clean it and appeal. If
  the admin accepts with the penalty, every network that marked it gets a strike (networks with
  standing only up to 10) and a penalty. Two such clears in 30 days silence those networks. Accept an
  appeal of an account with real slop history without the penalty.
- The launch depends on the admin: without reviews nothing is listed (296 pending on day 14).

## 10. Deviations from SPEC.md 13

1. "Not slop" without standing counts nowhere but `dissent` and the voter's own reputation: no
   voice, no tie inside a network, no budget place (13.2 says such votes make a voice when no
   install with standing voted). Without this, a "not slop" install on a shared address tied or
   turned the slop voice of an install without standing there, and its votes used that network's
   budget, so a not-slop vote without standing could change a status.
2. The budget queue keeps releases in time order (a release is never earlier than the release
   before it), so the cap of 50 in 24 hours holds exactly with the standing-first order.
3. Round 2 (SPEC text in the round 2 report of lane red-engine): good marks need votes set after the
   newest penalty (H3); an admin confirm stores its "not slop" votes as rows (H1); the brakes order
   by the bound of the voices with standing (H2); a strike without standing silences only the
   installs without standing of its network (H4); stored standing also needs the good marks that
   the input can still give after a penalty.
4. Stored standing is checked again against age and reputation in the run that uses it.
5. `parts.disputed` of a starter account uses standing voices on both sides, as the dispute rule.

## 11. Performance

Measured on the shared host with the input of `perf.test.ts` (50,000 votes, 20,000 accounts, 500,000 verified sightings, 5,000 installs, 30% with stored standing, cleared rows): 2.02 and 2.17 CPU seconds per `computeScores` run on 2026-11-12 with the standing budget of 13.12 (2.30 after round 2, 1.80 to 1.90 before), 417 epochs of the factor model. The test limit is 10 CPU seconds. The factor model runs only when a network is two-sided, so at launch it does not run at all. The whole job (load and write) is measured by the score job tests.

Published floats keep 3 decimals, so a tiny change does not rewrite every row.
