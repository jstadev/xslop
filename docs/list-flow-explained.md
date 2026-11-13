# How an X account gets on the xslop list

This page tells the rules of `SPEC.md` section 13 (judging system v2) in plain words. Every number is a constant of SPEC section 13. The code keeps the constants of the rules in `server/src/scoring/`, and those of the server checks in the X facts job (`server/src/jobs/profiles.ts`). The intervals of the timers are in SPEC sections 1, 7.4 and 13.6. `docs/threat-model.md` names the attack that each rule stops.

## 1. The flow, from your click to another user's browser

1. **You** click the xslop button on a post. At once, your extension hides the account for you and mutes it on your X account. This part needs nobody else.
2. **Your extension** sends one signed vote to the server. The vote names the account and the post that you marked. One install has one vote for each account. A second click changes that vote. It never adds one.
3. **The X facts job** of the server checks the account with two public sources: the embed answer of X and FxTwitter. It finds out if the handle exists and which X id it has. It reads the posts that the votes name and checks that the account wrote them.
4. **The score job** counts the votes and decides for each account: nothing, pending, flagged or confirmed.
5. **A pending account** waits in the review queue. An admin confirms it or clears it.
6. **The server** publishes a new list version when the list changed. The list carries the X id of each account.
7. **The other user's extension** gets the new list at its next sync and hides the account in the open X tabs.
8. **With mute sync on**, that extension also mutes the confirmed accounts on the X account of its user, by X id, at a slow pace with a daily cap.

## 2. Three words first

- **Network**: one internet connection, for example a home, an office or a phone carrier. xslop records it when you install. Many installs on one connection are one voice.
- **Trust**: how much one network counts. It is the reputation of the install times an age factor: 0.3 on the first day, 0.7 in the first week, 1 after that. Reputation starts at 0.5 and stays between 0.05 and 1.
- **Cautious share**: the share of "slop" votes, lowered when few networks voted (a Wilson lower bound). In a small group, one "not slop" voice that counts weighs a lot.

## 3. Standing

An install has **standing** when it is not banned and one of these is true:
- an admin marked it as trusted, or
- it is at least 7 days old, it has at least 3 good marks, and its reputation is at least 0.6.

A **good mark** is a slop vote that you cast before the account was public, on an account that an admin then confirmed. One admin confirm gives at most 5 good marks: to the first 5 networks by the time of their slop vote, and in each network to the install with the earliest such vote. A confirm by votes gives no good mark, so standing always starts at a person.

Standing can go away. A wrong vote is a **penalty**, and it ends the standing of its install at the next run of the score job:
- your slop mark on an account that an admin clears with penalty;
- your "not slop" vote, set before an admin confirms the account.

The server keeps a copy of the vote from the time of the decision, so a vote that you delete or change later keeps its penalty. After a penalty, only good marks of slop votes that you set after it count, so your install needs 3 new good marks. Each wrong vote also lowers your reputation. An install that an admin marked as trusted keeps its standing.

What standing changes:
- A network's voice **has standing** when an install with standing is on its side. The slop networks whose voice has standing are the **anchors** of the account.
- On a shared address, only the installs with standing make the voice of that network. A new install on the same address cannot turn it.
- **"Not slop" counts only with standing.** A "not slop" vote of an install without standing shows the account again for you, and counts nowhere else. The engine reports these networks as dissent for the admin.
- **Standing budget**: a vote carries standing when fewer than 5 votes of its network carried standing in the 24 hours before it, slop and "not slop" together. A vote past that never carries standing: a slop vote counts like the vote of an install without standing, and a "not slop" vote counts only as dissent. There is no waiting list. The count goes by the time of each vote, also for the votes that you set before your install had standing. All installs with standing on one network share these 5.
- Each network counts at most 50 votes in 24 hours. The votes of installs with standing take their places first.

## 4. The checks of the server

- **Identity**: the handle exists on X, and its X id is the one on record. A handle that the source does not find in 5 runs in a row is `gone`: the account keeps its state, the server checks it again each day, and votes list nothing new on it. A handle that now has another X id is `moved`: it is never listed, so the next owner of a handle is never hidden. `moved` needs the embed answer of X, or two checks on different days that name the same other X id.
- **Renames**: when an account renames, the server moves its state and its votes to the new handle. Both sources must agree: the embed answer of X for a post that the account wrote names the new handle, and FxTwitter gives the new handle the same X id. An account without such a post, for example a starter account, keeps its state on the old handle, where it hides nobody. The new handle returns to the list only through votes.
- **Evidence**: posts that a slop vote names and that the server found written by the account. A flag needs evidence from 1 network, a confirm from 2 networks.
- **Reply timing**: the server checks the post ids of replies that extensions report, only from users who turned on signal sharing. Reply timing is information for the admin and for the public page of a listed account. It never changes a status.

## 5. The rules

The first rule that matches wins.

0. `moved`: not listed, whatever else is true. A `gone` account keeps its state, and votes list nothing new on it.
1. An admin confirm: confirmed. An admin clear: off the list.
2. An account that an admin cleared and then reset: only votes after the clear count. If the confirm test passes again with at least 6 slop networks, the account goes to the review queue. Else it stays off the list. It never returns without a person.
3. **Starter list**: the accounts of the public X list "ai slop posters" and of the public Clankwall list (`seed/`). Confirmed from the first day.
4. **Confirmed** (hidden for every user, except users who chose Off), when all of these hold:
   - at least 4 slop networks, a cautious share of 60% or more, and trust of 1 or more;
   - at least 2 anchors;
   - evidence from at least 2 networks;
   - identity checked;
   - fewer than 50,000 followers, and not protected by an admin;
   - an automatic confirm left in the last 24 hours: at most 30 accounts get one.
5. **Flagged** (hidden only for users who chose Strict), when all of these hold:
   - at least 2 slop networks and a cautious share of 50% or more;
   - at least 1 anchor;
   - evidence from at least 1 network;
   - identity checked;
   - fewer than 50,000 followers, and not protected by an admin;
   - an automatic flag left in the last 24 hours: at most 60 accounts get one.
6. Else: nothing.

**Pending**: the votes pass the crowd test of rule 4 or 5, but a check is missing (anchors, evidence, identity, protected, a daily cap) or a dispute holds the account. A pending account waits in the review queue. It is not in the list, and every public page shows it as not listed.

**The daily caps**: when more accounts pass than a cap allows, the accounts with the most anchors go first, then the accounts whose voices with standing agree most, then the handle. Votes without standing never move an account up.

**Disputes**:
- If a "not slop" voice with standing exists, the cautious share counts only voices with standing, on both sides. If the account fails only for that reason, it waits for a person.
- **Two camps**: some voters have a record on both sides of disputed accounts. If those voters split into two camps, an account that only one camp marks waits for a person. An account that both camps mark goes on.

## 6. The ways out

- **"Not slop" with standing** lowers the cautious share. One such voice can send the account to the review queue. Enough of them take it off at the next run of the score job.
- **Starter accounts**: votes never remove one. Only an accepted appeal or an admin clear does. If at least 5 "not slop" networks with standing and trust of 1 or more pass a cautious share of 60%, the account shows as disputed to the admin.
- **Appeal**: the owner fills the form on https://x-slop.com/check and puts a code in the X bio. An admin reads it. If the admin accepts, the account leaves the list at once.
- **Admin clear**: the same result, without an appeal. A clear with penalty keeps a copy of the votes on the account, and each slop mark is a penalty for its install. Each slop network without standing also gets a strike. The slop networks with standing get a strike only when at most 10 of them marked the account: more than 10 means that the admin overruled a real crowd. A clear of a starter account has no penalty. A strike has standing when a slop voter of that network had standing at the clear. A network with 2 strikes with standing in 30 days is silent on every account until 30 days after its newest strike. 2 strikes of any kind silence only the installs without standing of that network, so installs on a shared address cannot silence the install with standing there. A vote that is later deleted or changed keeps its strike.
- **The handle gets a new owner**: `moved`, off the list at the next run. An account that the server cannot find (`gone`) stays on the list.

## 7. What one person alone can and cannot do

- Can: hide and mute an account for yourself, at once. Can: add one vote for each account.
- Cannot: put an account on the list with new installs, also on many networks. At most, the account waits for a person.
- Cannot: keep an account off the list with new installs. "Not slop" without standing counts nowhere.
- Cannot: flood the list. Each network counts 50 votes a day.
- With standing: at most 5 of your marks in any 24 hours carry standing, by the time of each mark. Marks that you set before your install had standing count by their own times: an install that marked 10 accounts a day for 7 days flags 35 of them in its first run with standing (measured in `server/src/scoring/README.md` section 9). The flag cap of 60 a day still holds. Each listing that an admin then clears with penalty ends that standing.
- Cannot: earn standing without a person. Only an admin confirm gives good marks, at most 5 for each confirm.
- Cannot: earn standing from the public list. A vote on an account that is already listed earns nothing.
- Cannot: list an account with 50,000 followers or more. Only an admin can.

## 8. Diagram

```
you click ──> hidden and muted for you (at once)
   │ signed vote
   ▼
server ──> X facts job: identity, evidence, reply timing (two public sources)
   │
   ▼
score job
   │ a check missing, or a dispute ............... PENDING   (review queue, not listed)
   │ 2+ networks, 1+ anchor, evidence from 1 ..... FLAGGED   (Strict users; 60 a day by votes)
   │ 4+ networks, 2+ anchors, evidence from 2 .... CONFIRMED (all users; 30 a day by votes)
   ▼
new list version, with X ids ──> other extensions ──> hidden for them
                                      └─ mute sync, if on ──> muted on their X account, by X id
out: "not slop" with standing | accepted appeal | admin clear | moved
```

The full rules, their numbers and the tests that hold them: `SPEC.md` section 13 and `server/src/scoring/README.md`.
