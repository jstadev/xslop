## What changes and why

<!-- The problem first, then the change. -->

## Checks

- [ ] `npm run build` and `npm test` pass.
- [ ] `npm run test:e2e` passes, if the extension or the site changed.
- [ ] Each change of behaviour has a test that fails without it.
- [ ] `SPEC.md` changes in this pull request, if the API, the data model, the list rules or the extension contract changed.
- [ ] A change of a list rule also changes the constants in `server/src/scoring/`, `server/src/scoring/README.md`, `docs/list-flow-explained.md` and `docs/threat-model.md`.
- [ ] Every new input has an explicit type, length and pattern. SQL is parameterized.
- [ ] No new dependency, or the reason why the Node standard library cannot do the job, an exact version and the lockfile.
- [ ] No secret, no real person's data, no post text and no IP address in code, tests or logs.
- [ ] Text that users read: "you", no "we", "our" or "us", no em-dashes, no number that the code does not produce. Demo handles are longer than 15 characters.
