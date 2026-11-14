# Plan
Current version: v1.0.9 (prod, x-slop.com; extension 1.1.2), v1.0.122 (staging; extension 1.1.3)
Goal: Hide AI reply slop on X for every user, from a crowd-confirmed list, with no X API (maintainer, 2026-11-07).
## Next release: judging system v2 (SPEC 13), extension 1.2.0
- [ ] Standing: an install earns it (7 days, 3 good marks, reputation 0.6) or an admin trusts it. Automatic flags and confirms need anchors with standing; everything else waits in the review queue (SPEC 13.2, 13.3) (source: the maintainer's order, 2026-11-12)
- [ ] "Not slop" counts only with standing; the one-camp veto replaces the bridging tests (SPEC 13.4) (source: the same order)
- [ ] Server facts: the X facts job checks identity, evidence and reply timing with two public sources; a rename moves the state by X id; the list carries X ids (SPEC 13.6, 13.8) (source: the same order)
- [ ] Strikes from the votes stored at clear time, protected accounts, the daily brakes on automatic confirms and flags (SPEC 13.2, 13.5, 13.10) (source: the same order)
- [ ] Admin: review queue, one-time codes at login, idle end of a session, admin log with the state before, ban the voters of an account, trust an install (SPEC 13.8) (source: the same order)
- [ ] Extension 1.2.0: the list with X ids, mutes by X id, signals with post ids only (SPEC 13.8) (source: the same order)
- [x] Threat model (`docs/threat-model.md`) and the list flow for v2 (`docs/list-flow-explained.md`) (source: the same order)
- [ ] The maintainer approves the staging version; then prod (source: release rule)
## Later
- Chrome Web Store listing (needs the maintainer's developer account) (source: maintainer notes)
- addons.mozilla.org listing, which also enables Firefox for Android (needs an AMO API key) (source: maintainer notes)
- Open source: the repository goes public, after the maintainer's checklist of the open source review (source: the maintainer's order of 2026-11-11)
- A separate Unix user for staging and prod in the deploy tool (SPEC 12.13, known and open) (source: maintainer notes)
## Done
- Unreleased (2026-11-13, staging next): a dark and light switch on every landing page; dark is the default with a black page, light only by the visitor's choice (SPEC 12.11c) (source: the maintainer's order, 2026-11-13).
- v1.0.122 (2026-11-12, staging): the new logo, a bubble with three drips and the drip lettering, in every place.
- v1.0.99 (2026-11-12, staging): round 3: security fixes in server, extension and site; phones; a vote carries no text; the seed list without bios; the repository written for a public reader; the scene runs in every browser with WebGL2.
- v1.0.13 (2026-11-10, staging): security round (SPEC 12.12): code audit of server, extension and site; attack audit of the list rules; live-system test.
- v1.0.9 (2026-11-10): production moves to x-slop.com; the old host becomes the staging copy; extension 1.1.2 calls x-slop.com.
- v1.0.7 (2026-11-10): extension 1.1.1 with the button on posts and replies, instant mute on click and the build for all browsers; functional list criteria; the Sloppers page; the new landing page; own pages for How it works, The rules, Download, Check a handle, Privacy and Questions.
- v1.0.0 (2026-11-07): extension for Chrome and Firefox with the slop button, hiding and opt-in mute sync; API with signed installs, bridged scoring and the global list seeded with the 793 "ai slop posters" accounts; one-page landing page, logo and admin console; first live version. Two security reviews, 16 findings fixed.
