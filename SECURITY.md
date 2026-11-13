# Security

## Report a weakness in private

Use "Report a vulnerability" on the Security tab of this repository (GitHub private vulnerability reporting). Do not open a public issue, pull request or discussion for a weakness.

Send:

- what an attacker can do, and what it costs the attacker (installs, networks, standing, time);
- the steps to reproduce, best as a test against a local copy (`README.md` shows how to run one);
- the version or commit that you tested.

## What to expect

- An answer within 7 days.
- A fix, a test that fails without the fix, and a note in the advisory when the fix is live.
- Credit in the advisory, if you want it.

## The security model in short

- An install or an address costs nothing, so nothing that costs nothing decides anything. An automatic change of the list needs installs with earned standing on separate networks, and facts that the server itself checked on X. Everything else waits for a person in the review queue.
- Each install has its own P-256 key and registers with a proof of work. Every vote is signed.
- A vote is stored with its install, and an install keeps only a keyed hash (HMAC) of its network. A sighting is stored with no install id. A vote carries no post text.
- The server reads X facts only from two fixed public hosts, and profile pictures only from `pbs.twimg.com`, with no key and no redirect.
- The admin console needs a password and, when the maintainer sets it, a one-time code. Sessions end after 30 minutes idle. Every admin change writes a log row with the state before.
- The pages load every asset from their own origin under a strict content security policy.

`docs/threat-model.md` names each attacker, the rule that stops each attack, and the risks that stay, with their price.

## In scope

- The code in this repository: the API, the score job and the X facts job (`server/`), the extension (`extension/`), the pages and the admin console (`site/`).
- The live service at https://x-slop.com.
- Attacks on the list: a way to list or unlist an account at a lower price than `docs/threat-model.md` states.
- Privacy: a way to link a vote or a behaviour signal to a person, an install or an address.

## Out of scope

- The risks that `docs/threat-model.md` lists as risks that stay, at the price that it states. A way to make one cheaper is in scope.
- Denial of service by volume, spam and social engineering.
- X itself, the two public fact sources, and any host other than x-slop.com and www.x-slop.com.

## How to test

- Test against a local copy. On the live service, do not vote with more than one install, do not change the list for other users, and do not read data that is not yours.
- Do not send automated traffic to x.com from the extension at a rate that a person cannot reach.
