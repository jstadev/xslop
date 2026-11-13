# Browser matrix

These scripts run the release packages in real browsers. The extension's API host is the real xslop server on
PGlite, and x.com is a set of local fixtures behind a local TLS proxy. Every other host is refused and logged, so
nothing reaches X or production. The zips are not changed.

Put Node 24 first in PATH.

```sh
node extension/test/browsers/run.mjs                  # all browsers, about 2 minutes with browsers kept in --dir, 5 with downloads
node extension/test/browsers/run.mjs --list           # the names you can use with --only
node extension/test/browsers/run.mjs --only firefox,chrome --pow 14
node extension/test/browsers/run.mjs --only firefox-idle  # not in the default run, about 9 minutes
node extension/test/browsers/run.mjs --dir /tmp/keep  # keeps browsers, report.md and screenshots for the next run
```

`--pow` sets the proof-of-work difficulty, `--jobs` the number of parallel browsers (default 2). The script exits
with 1 if a run fails. It adds no dependency to the repo. It downloads browsers into its own folder and removes that folder at the end.

It needs Linux x64, Node 24, `openssl`, `tar`, and `npx` for Firefox and Chrome for Testing, `dpkg-deb` for Edge,
Brave, Opera and Vivaldi, `Xvfb` and `xdotool` for the toolbar panel. Vendor packages are checked against the SHA-256 in the vendor's
apt index. The index signature is not checked.

## What each run proves

Every run installs the package that users get and uses real input, then reads the real outcome: rows in the
server's database, requests at X's stand-in, and the text of the page.

| Name | What it runs |
| --- | --- |
| firefox, firefox-esr, firefox-140 | The whole path in the Firefox zip, as a temporary add-on, plus the Firefox prompts for host access and data collection |
| firefox-panel | The real toolbar panel in a real window under Xvfb, with an operating system click on the share switch |
| chrome, chrome-120, chromium, edge, brave, opera, vivaldi | The whole path in the Chrome zip, unpacked and loaded in new headless mode |
| webkit | The Safari bundles in WebKit with a stand-in for `browser`. See below |
| firefox-idle | Only with `--only`. 16 page loads with sharing on. Every batch of observations must reach the server while the Firefox event page stops and starts |

The path: proof of work and key accepted by the real server, onboarding and popup render, storage, alarms and
IndexedDB, permissions, the content script under an X-like CSP, a real click that hides the reply, mutes in the X
session and sends a signed vote, keyboard undo, the X menu fallback, live settings, a stopped background that
wakes, twitter.com and mobile.x.com, and no script error from the extension.

## What it does not prove

- Safari: WebKit outside Safari cannot load an extension. The `webkit` row proves only the JavaScript, CSS, WebCrypto
  and IndexedDB of the Safari bundles in a current WebKit, not Safari's extension system and not Safari 16.4.
- Real X: the fixtures copy X's markup and CSP. Nothing here calls x.com.
- Chromium idle stop: a service worker with a debugger attached does not stop by itself. The runs stop it by force, so
  they do not exercise the 30 s idle stop. Only `firefox-idle` measures a real idle stop, and only on Firefox.
- Firefox for Android: not run.
- Stores: Chrome, Edge, Opera and add-on store review and signing are not part of this run.

## Safari: what you must do yourself

Both ways need the Safari zip from a release build. Apple calls the converter `safari-web-extension-packager` now.

Without a Mac (needs Apple Developer Program membership): in App Store Connect, create an app record for macOS and
iOS with bundle id `com.koglabs.xslop`. In Users and Access, open Xcode Cloud, select Safari Web Extension Packager,
and upload the zip. Read the reported exceptions, then test with TestFlight.

On a Mac with Xcode:

1. Run `sh scripts/safari/convert.sh xslop-safari-v<version>.zip safari-app`. Read the manifest warnings it prints.
   Remove `safari-app` first if it exists.
2. Open `safari-app/xslop/xslop.xcodeproj`, and choose Product > Run with the macOS scheme.
3. In Safari, open Settings > Advanced and check "Show features for web developers". In Settings > Developer, check
   "Allow unsigned extensions". Safari clears this box every time it quits.
4. In Settings > Extensions, turn on xslop, and allow it on x.com and x-slop.com when Safari asks.
5. On x.com, click the button on a reply. Check that the reply hides, the Undo toast appears, and the account appears
   in Muted accounts on X. Click Undo, and check that the mute goes away. Wait a minute, then click another reply.
6. For iOS, select the iOS scheme and a device or simulator, then Run. Turn on xslop in Settings > Safari > Extensions.
   A real device needs Apple Developer Program membership.
