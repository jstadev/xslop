# Third-party code, fonts, data and marks

The xslop code is under the MIT licence (`LICENSE`). The items below belong to others and keep their own terms.

## What ships

| Item | Where it ships | Licence | Notes |
|---|---|---|---|
| three.js 0.187.0 | the landing page bundle (`site/dist/assets`) | MIT | The only library in the site bundle. |
| Mona Sans (variable, latin and latin-ext subsets) | `brand/fonts/*.woff2`, the site | SIL Open Font License 1.1, `brand/fonts/OFL.txt` | Copyright The Mona Sans Project Authors, https://github.com/github/mona-sans. The web subsets come from the Fontsource package `@fontsource-variable/mona-sans`. The licence reserves the font name "Mona"; the subsets keep the original name. |
| Octicons `mark-github-16` 19.42.0 (the GitHub mark) | `site/download/index.html`, the open source part of `/download` | MIT, Copyright (c) 2026 GitHub Inc. | One SVG path, unchanged, from the `@primer/octicons` package (https://github.com/primer/octicons). It only names GitHub, where the code is. |
| fastify 5.12.8, pg 8.23.1 and their dependencies | the server at run time (`server/node_modules`, not in any zip) | MIT, ISC, BSD-3-Clause | The run time table below lists each package. |

The extension zips contain only code from this repository and the icons in `brand/`. No npm package goes into them.

## Licences that do not fit MIT

- **None ships.** Every package in the site bundle and in the server at run time is under MIT, ISC or BSD-3-Clause.
- **MPL-2.0**: `lightningcss` and its platform builds, a CSS tool inside Vite and Vitest. MPL-2.0 is a weak copyleft licence per file. The package runs only during builds and tests and never goes into a zip, the site bundle or the server code. A copy of xslop that ships it, changed or not, must keep its files under MPL-2.0.
- **Apache-2.0**: TypeScript, Playwright, PGlite and others, build and test only. Apache-2.0 fits MIT. A copy that ships one of them keeps its licence and NOTICE file.
- Every package comes from `registry.npmjs.org` with an integrity hash. Only two packages have an install script: `esbuild` (a binary check) and `fsevents` (macOS only), both build and test only.

## Data

- `seed/ai-slop-list.json`: the members of a public X list, with public profile numbers. `seed/README.md` says where it comes from.
- At run time the server reads public facts about accounts and posts from the embed answer of X (`cdn.syndication.twimg.com`) and from FxTwitter (`api.fxtwitter.com`), with no key. These facts belong to their owners and are not in this repository.
- The server stores the public profile picture of each listed account from `pbs.twimg.com` and serves it on the `/sloppers` page. These pictures belong to their owners. They are not in this repository.

## Marks

- **X** and the X logo are trademarks of X Corp. xslop uses the name X and the X logo only to name the service that the extension works on, without change to the logo. xslop is independent and has no relation with X Corp. The X logo is not under the MIT licence of this repository.
- The xslop mark and wordmark (`brand/`) are part of this repository. The x in xslop means "crossed out", not the X company.
- "Community Notes" names a feature of X. The site uses the words only to compare.
- **GitHub** and the GitHub mark are trademarks of GitHub, Inc. `/download` shows the mark only beside the links to the xslop repository.

## Every package of the three lockfiles

Generated from `server/package-lock.json`, `extension/package-lock.json` and `site/package-lock.json` (the `license` field of each entry). "Build and test only" packages never ship.

### `server/package-lock.json`, run time (61)

| Licence | Packages |
|---|---|
| MIT | @fastify/ajv-compiler 4.0.7, @fastify/deepmerge 3.2.4, @fastify/error 4.2.1, @fastify/fast-json-stringify-compiler 5.1.1, @fastify/forwarded 3.1.2, @fastify/merge-json-schemas 0.2.2, @fastify/proxy-addr 5.1.2, @pinojs/redact 0.4.0, abstract-logging 2.0.1, ajv 8.20.0, ajv-formats 3.0.1, atomic-sleep 1.0.0, avvio 9.3.1, cookie 2.0.2, dequal 2.0.3, fast-decode-uri-component 1.0.1, fast-deep-equal 3.1.3, fast-json-stringify 7.3.1, fast-querystring 1.1.2, fastify 5.12.8, find-my-way 9.10.0, ipaddr.js 2.5.0, json-schema-ref-resolver 3.0.1, json-schema-traverse 1.0.0, on-exit-leak-free 2.1.2, pg 8.23.1, pg-cloudflare 1.4.1, pg-connection-string 2.14.1, pg-pool 3.14.0, pg-protocol 1.16.1, pg-types 2.2.0, pgpass 1.0.5, pino 10.4.0, pino-abstract-transport 3.0.0, pino-std-serializers 7.1.0, postgres-array 2.0.0, postgres-bytea 1.0.1, postgres-date 1.0.7, postgres-interval 1.2.0, process-warning 5.1.1, quick-format-unescaped 4.0.4, real-require 1.0.0, require-from-string 2.0.2, ret 0.5.1, reusify 1.1.0, rfdc 1.4.1, safe-regex2 5.1.2, safe-stable-stringify 2.5.0, set-cookie-parser 3.2.2, sonic-boom 4.2.1, thread-stream 4.2.1, toad-cache 3.7.4, xtend 4.0.2 |
| BSD-3-Clause | fast-uri 3.1.9, fast-uri 4.2.3, light-my-request 6.8.0, secure-json-parse 4.1.1 |
| ISC | fastq 1.20.3, pg-int8 1.0.1, semver 7.8.6, split2 4.2.0 |

### `server/package-lock.json`, build and test only (85)

| Licence | Packages |
|---|---|
| MIT | @jridgewell/resolve-uri 3.1.2, @jridgewell/sourcemap-codec 1.6.0, @jridgewell/trace-mapping 0.3.31, @oxc-project/types 0.156.0, @rolldown/binding-android-arm-eabi 1.2.16, @rolldown/binding-android-arm64 1.2.16, @rolldown/binding-darwin-arm64 1.2.16, @rolldown/binding-darwin-x64 1.2.16, @rolldown/binding-freebsd-x64 1.2.16, @rolldown/binding-linux-arm-gnueabihf 1.2.16, @rolldown/binding-linux-arm64-gnu 1.2.16, @rolldown/binding-linux-arm64-musl 1.2.16, @rolldown/binding-linux-ppc64-gnu 1.2.16, @rolldown/binding-linux-s390x-gnu 1.2.16, @rolldown/binding-linux-x64-gnu 1.2.16, @rolldown/binding-linux-x64-musl 1.2.16, @rolldown/binding-openharmony-arm64 1.2.16, @rolldown/binding-win32-arm64-msvc 1.2.16, @rolldown/binding-win32-x64-msvc 1.2.16, @rolldown/pluginutils 1.0.1, @types/chai 5.2.3, @types/deep-eql 4.0.2, @types/estree 1.0.10, @types/node 24.19.2, @types/pg 8.23.1, @vitest/mocker 5.1.0, @vitest/spy 5.1.0, assertion-error 2.0.1, chai 6.3.0, es-module-lexer 2.3.2, estree-walker 3.0.3, fdir 6.5.0, fsevents 2.3.3, magic-string 1.4.5, nanoid 3.3.20, obug 3.0.0, picomatch 4.0.7, postcss 8.5.32, rolldown 1.2.16, std-env 4.3.0, tinybench 6.2.3, tinyexec 1.3.1, tinyglobby 0.2.17, undici-types 7.24.6, vite 8.3.6, vitest 5.1.0, why-is-node-running 3.2.1 |
| Apache-2.0 | @electric-sql/pglite 0.5.15, @typescript/typescript-aix-ppc64 7.0.2, @typescript/typescript-darwin-arm64 7.0.2, @typescript/typescript-darwin-x64 7.0.2, @typescript/typescript-freebsd-arm64 7.0.2, @typescript/typescript-freebsd-x64 7.0.2, @typescript/typescript-linux-arm 7.0.2, @typescript/typescript-linux-arm64 7.0.2, @typescript/typescript-linux-loong64 7.0.2, @typescript/typescript-linux-mips64el 7.0.2, @typescript/typescript-linux-ppc64 7.0.2, @typescript/typescript-linux-riscv64 7.0.2, @typescript/typescript-linux-s390x 7.0.2, @typescript/typescript-linux-x64 7.0.2, @typescript/typescript-netbsd-arm64 7.0.2, @typescript/typescript-netbsd-x64 7.0.2, @typescript/typescript-openbsd-arm64 7.0.2, @typescript/typescript-openbsd-x64 7.0.2, @typescript/typescript-sunos-x64 7.0.2, @typescript/typescript-win32-arm64 7.0.2, @typescript/typescript-win32-x64 7.0.2, detect-libc 2.1.2, expect-type 1.4.0, typescript 7.0.2 |
| MPL-2.0 | lightningcss 1.33.0, lightningcss-android-arm64 1.33.0, lightningcss-darwin-arm64 1.33.0, lightningcss-darwin-x64 1.33.0, lightningcss-freebsd-x64 1.33.0, lightningcss-linux-arm-gnueabihf 1.33.0, lightningcss-linux-arm64-gnu 1.33.0, lightningcss-linux-arm64-musl 1.33.0, lightningcss-linux-x64-gnu 1.33.0, lightningcss-linux-x64-musl 1.33.0, lightningcss-win32-arm64-msvc 1.33.0, lightningcss-win32-x64-msvc 1.33.0 |
| BSD-3-Clause | source-map-js 1.2.2 |
| ISC | picocolors 1.1.1 |

### `extension/package-lock.json`, build and test only (123)

| Licence | Packages |
|---|---|
| MIT | @esbuild/aix-ppc64 0.28.2, @esbuild/android-arm 0.28.2, @esbuild/android-arm64 0.28.2, @esbuild/android-x64 0.28.2, @esbuild/darwin-arm64 0.28.2, @esbuild/darwin-x64 0.28.2, @esbuild/freebsd-arm64 0.28.2, @esbuild/freebsd-x64 0.28.2, @esbuild/linux-arm 0.28.2, @esbuild/linux-arm64 0.28.2, @esbuild/linux-ia32 0.28.2, @esbuild/linux-loong64 0.28.2, @esbuild/linux-mips64el 0.28.2, @esbuild/linux-ppc64 0.28.2, @esbuild/linux-riscv64 0.28.2, @esbuild/linux-s390x 0.28.2, @esbuild/linux-x64 0.28.2, @esbuild/netbsd-arm64 0.28.2, @esbuild/netbsd-x64 0.28.2, @esbuild/openbsd-arm64 0.28.2, @esbuild/openbsd-x64 0.28.2, @esbuild/openharmony-arm64 0.28.2, @esbuild/sunos-x64 0.28.2, @esbuild/win32-arm64 0.28.2, @esbuild/win32-ia32 0.28.2, @esbuild/win32-x64 0.28.2, @jridgewell/resolve-uri 3.1.2, @jridgewell/sourcemap-codec 1.6.0, @jridgewell/trace-mapping 0.3.31, @oxc-project/types 0.156.0, @rolldown/binding-android-arm-eabi 1.2.16, @rolldown/binding-android-arm64 1.2.16, @rolldown/binding-darwin-arm64 1.2.16, @rolldown/binding-darwin-x64 1.2.16, @rolldown/binding-freebsd-x64 1.2.16, @rolldown/binding-linux-arm-gnueabihf 1.2.16, @rolldown/binding-linux-arm64-gnu 1.2.16, @rolldown/binding-linux-arm64-musl 1.2.16, @rolldown/binding-linux-ppc64-gnu 1.2.16, @rolldown/binding-linux-s390x-gnu 1.2.16, @rolldown/binding-linux-x64-gnu 1.2.16, @rolldown/binding-linux-x64-musl 1.2.16, @rolldown/binding-openharmony-arm64 1.2.16, @rolldown/binding-win32-arm64-msvc 1.2.16, @rolldown/binding-win32-x64-msvc 1.2.16, @rolldown/pluginutils 1.0.1, @types/chai 5.2.3, @types/chrome 0.3.7, @types/deep-eql 4.0.2, @types/estree 1.0.10, @types/har-format 1.2.16, @types/node 24.19.2, @types/whatwg-mimetype 3.0.2, @types/ws 8.18.2, @vitest/mocker 5.1.0, @vitest/spy 5.1.0, assertion-error 2.0.1, buffer-image-size 0.6.4, chai 6.3.0, es-module-lexer 2.3.2, esbuild 0.28.2, estree-walker 3.0.3, fdir 6.5.0, fflate 0.8.3, fsevents 2.3.3, happy-dom 21.0.4, magic-string 1.4.5, nanoid 3.3.20, obug 3.0.0, picomatch 4.0.7, postcss 8.5.32, rolldown 1.2.16, std-env 4.3.0, tinybench 6.2.3, tinyexec 1.3.1, tinyglobby 0.2.17, undici-types 7.24.6, vite 8.3.6, vitest 5.1.0, whatwg-mimetype 3.0.0, why-is-node-running 3.2.1, ws 8.22.1 |
| Apache-2.0 | @playwright/test 1.64.1, @typescript/typescript-aix-ppc64 7.0.2, @typescript/typescript-darwin-arm64 7.0.2, @typescript/typescript-darwin-x64 7.0.2, @typescript/typescript-freebsd-arm64 7.0.2, @typescript/typescript-freebsd-x64 7.0.2, @typescript/typescript-linux-arm 7.0.2, @typescript/typescript-linux-arm64 7.0.2, @typescript/typescript-linux-loong64 7.0.2, @typescript/typescript-linux-mips64el 7.0.2, @typescript/typescript-linux-ppc64 7.0.2, @typescript/typescript-linux-riscv64 7.0.2, @typescript/typescript-linux-s390x 7.0.2, @typescript/typescript-linux-x64 7.0.2, @typescript/typescript-netbsd-arm64 7.0.2, @typescript/typescript-netbsd-x64 7.0.2, @typescript/typescript-openbsd-arm64 7.0.2, @typescript/typescript-openbsd-x64 7.0.2, @typescript/typescript-sunos-x64 7.0.2, @typescript/typescript-win32-arm64 7.0.2, @typescript/typescript-win32-x64 7.0.2, detect-libc 2.1.2, expect-type 1.4.0, playwright 1.64.1, playwright-core 1.64.1, typescript 7.0.2 |
| MPL-2.0 | lightningcss 1.33.0, lightningcss-android-arm64 1.33.0, lightningcss-darwin-arm64 1.33.0, lightningcss-darwin-x64 1.33.0, lightningcss-freebsd-x64 1.33.0, lightningcss-linux-arm-gnueabihf 1.33.0, lightningcss-linux-arm64-gnu 1.33.0, lightningcss-linux-arm64-musl 1.33.0, lightningcss-linux-x64-gnu 1.33.0, lightningcss-linux-x64-musl 1.33.0, lightningcss-win32-arm64-msvc 1.33.0, lightningcss-win32-x64-msvc 1.33.0 |
| BSD-2-Clause | entities 7.0.1 |
| BSD-3-Clause | source-map-js 1.2.2 |
| ISC | picocolors 1.1.1 |

### `site/package-lock.json`, run time (1)

| Licence | Packages |
|---|---|
| MIT | three 0.187.0 |

### `site/package-lock.json`, build and test only (72)

| Licence | Packages |
|---|---|
| MIT | @oxc-project/types 0.156.0, @rolldown/binding-android-arm-eabi 1.2.16, @rolldown/binding-android-arm64 1.2.16, @rolldown/binding-darwin-arm64 1.2.16, @rolldown/binding-darwin-x64 1.2.16, @rolldown/binding-freebsd-x64 1.2.16, @rolldown/binding-linux-arm-gnueabihf 1.2.16, @rolldown/binding-linux-arm64-gnu 1.2.16, @rolldown/binding-linux-arm64-musl 1.2.16, @rolldown/binding-linux-ppc64-gnu 1.2.16, @rolldown/binding-linux-s390x-gnu 1.2.16, @rolldown/binding-linux-x64-gnu 1.2.16, @rolldown/binding-linux-x64-musl 1.2.16, @rolldown/binding-openharmony-arm64 1.2.16, @rolldown/binding-win32-arm64-msvc 1.2.16, @rolldown/binding-win32-x64-msvc 1.2.16, @rolldown/pluginutils 1.0.1, @tweenjs/tween.js 23.1.3, @types/node 24.19.2, @types/stats.js 0.17.4, @types/three 0.187.0, @types/webxr 0.5.24, fdir 6.5.0, fflate 0.8.3, fsevents 2.3.3, meshoptimizer 1.1.1, nanoid 3.3.20, picomatch 4.0.7, postcss 8.5.32, rolldown 1.2.16, tinyglobby 0.2.17, undici-types 7.24.6, vite 8.3.6 |
| Apache-2.0 | @dimforge/rapier3d-compat 0.12.0, @typescript/typescript-aix-ppc64 7.0.2, @typescript/typescript-darwin-arm64 7.0.2, @typescript/typescript-darwin-x64 7.0.2, @typescript/typescript-freebsd-arm64 7.0.2, @typescript/typescript-freebsd-x64 7.0.2, @typescript/typescript-linux-arm 7.0.2, @typescript/typescript-linux-arm64 7.0.2, @typescript/typescript-linux-loong64 7.0.2, @typescript/typescript-linux-mips64el 7.0.2, @typescript/typescript-linux-ppc64 7.0.2, @typescript/typescript-linux-riscv64 7.0.2, @typescript/typescript-linux-s390x 7.0.2, @typescript/typescript-linux-x64 7.0.2, @typescript/typescript-netbsd-arm64 7.0.2, @typescript/typescript-netbsd-x64 7.0.2, @typescript/typescript-openbsd-arm64 7.0.2, @typescript/typescript-openbsd-x64 7.0.2, @typescript/typescript-sunos-x64 7.0.2, @typescript/typescript-win32-arm64 7.0.2, @typescript/typescript-win32-x64 7.0.2, detect-libc 2.1.2, playwright 1.64.0, playwright-core 1.64.0, typescript 7.0.2 |
| MPL-2.0 | lightningcss 1.33.0, lightningcss-android-arm64 1.33.0, lightningcss-darwin-arm64 1.33.0, lightningcss-darwin-x64 1.33.0, lightningcss-freebsd-x64 1.33.0, lightningcss-linux-arm-gnueabihf 1.33.0, lightningcss-linux-arm64-gnu 1.33.0, lightningcss-linux-arm64-musl 1.33.0, lightningcss-linux-x64-gnu 1.33.0, lightningcss-linux-x64-musl 1.33.0, lightningcss-win32-arm64-msvc 1.33.0, lightningcss-win32-x64-msvc 1.33.0 |
| BSD-3-Clause | source-map-js 1.2.2 |
| ISC | picocolors 1.1.1 |
