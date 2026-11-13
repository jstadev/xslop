# Contributing to xslop

## Set up

You need Node 24 and npm. `server`, `extension` and `site` are separate npm packages with their own lockfiles. Do not add npm workspaces.

```sh
npm run ci:install
npm run build
npm test
```

`README.md` shows how to run the service and the extension on your computer.

## Before you open a pull request

- `npm run build` and `npm test` pass. They need no database and no network.
- If you change the extension or the site, `npm run test:e2e` passes too.
- A change of behaviour comes with a test that fails without the change.
- A change of the API, the data model, the list rules or the extension contract also changes `SPEC.md` in the same pull request.
- A change of a list rule also changes the constants in `server/src/scoring/`, `server/src/scoring/README.md`, `docs/list-flow-explained.md` and `docs/threat-model.md`. The public criteria text is built from those constants (`server/src/scoring/criteria.ts`).
- X changed its markup? Repair the selectors in `server/config/extension-config.json` first. The remote config is data only: it never chooses an X endpoint or a menu action.

## Rules for the code

- Write the least code that solves the problem. Reuse what exists. No dead code, no commented-out code, no placeholder.
- Validate every input with explicit types, lengths and patterns. Use parameterized SQL only.
- Nothing that costs nothing decides anything. A vote of an install without standing never changes the published list by itself (`SPEC.md` section 13.1).
- No secret in the repository, a test, a log or a client bundle. Tests generate their own keys.
- Log no request body, no post text and no IP address.
- Sightings (behaviour signals) never store an install id. Do not add one.
- The site keeps its strict content security policy: every asset from the same origin, no inline script or style, no CDN.
- Do not add a dependency when the Node standard library can do the job. Pin exact versions and commit the lockfile.

## Rules for text that users read

Pages, extension text, error messages:

- Speak to the reader: "you". No "we", "our" or "us".
- No em-dashes.
- Say what goes in, what comes out and what the reader does.
- State no number that the code does not produce.
- Never imply a relation with X Corp.
- Example handles in demos are longer than 15 characters, so they cannot be real X accounts.

## Licence

By contributing, you agree that your contribution is under the MIT licence of this repository (`LICENSE`).

## Conduct

`CODE_OF_CONDUCT.md` applies to every issue, pull request and discussion.
