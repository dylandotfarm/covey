# covey-mobile — a third client, in your pocket

*Issue #168. This is not a replacement. The TUI is still the client covey
ships, and `packages/web` still serves the phone's browser. This is a real
app beside them.*

## Why there is a third client

A phone can already run covey. `packages/web` is served by the daemon and
installs from the browser, and it is a good client. What it cannot do is be an
app.

- **It has no icon it did not borrow, and no notification.** A page cannot wake
  you when an agent asks a question.
- **It has no camera and no photo roll of its own** — only what a file input
  gives it.
- **Its socket dies with the tab**, and its storage lives under the browser's
  rules rather than the device's keychain.
- **On Android a page is a page.** The back gesture, the share sheet and the
  keyboard belong to Chrome. covey only borrows them.

## Why it is mostly a paint

Very little of this client is new, and that is the point. The ground was laid
before there was anything to stand on it.

- `@covey/client` and `@covey/protocol` **import no node module** — CLAUDE.md
  enforces that so a browser can load them — and `MachineClient` opens the
  runtime's own `WebSocket`. Both run in React Native unchanged.
- `packages/web/src/state.ts` holds no DOM and node tests it: the routes, the
  project rows, the thread rows, the sheets, the attachments, the media, the
  timeline. `packages/web/package.json` already named it the package's entry,
  so another client imports it as `@covey/web`.
- `timelineRows`, `projectPool`, `sessionBudget` and the markdown table parser
  are pure and were already shared by the TUI and the page.

So the app imports the same three packages and writes a new paint. What it must
never do is write a second copy of a decision:

| Decision | Where it lives | Why not here |
| --- | --- | --- |
| What a project row is | `projectRows`, and `projectPool` under it | Key it anywhere else and a thread starts from the wrong commit and opens its pull request against the wrong base. |
| Where a chain starts and ends | `timelineRows` (#149) | A chain must fold in the same place on a phone's browser and in a phone's app. |
| What a sheet says | `sheetRows`, `sheetChoices` | Two lists of settings that disagree is two clients. |
| What counts as a table | `tableAt` in `@covey/client` | A reply read as a table on one client and as prose on the other is a bug the reader cannot explain. |
| The attachment caps and the four failure words | `readPicked` in `@covey/web/attach` | One word for four problems is what made a screenshot read as "unreadable" for weeks (#132). |

The one thing the app parses for itself is the markdown *layout*, because a
`<Text>` is not HTML. `mobile/src/markdown.test.ts` holds that parser against
`markdownToHtml` on every input rather than against a fixture — a fixture would
let the two drift together.

## Its own toolchain, outside the workspace

`mobile/` is its own pnpm workspace root, exactly as `desktop/` is its own
cargo workspace, and for the same reasons: `tsc -b` must never see its files,
and Metro must never inherit install rules written for a node project. React
Native wants a bundler and it wants install scripts, and the workspace's
`allowBuilds` and its 7-day policy are the workspace's own business.

The 7-day dependency rule still holds. It is kept in pnpm's own terms in
`mobile/pnpm-workspace.yaml` rather than in a script, and it earned its place on
the first install by resolving `expo` 57.0.24 instead of the four-day-old
57.0.25. Three packages had to be pinned a patch back for the same reason.

Metro is told where the three shared packages are (`metro.config.js`) and the
type checker is told the same thing separately (`tsconfig.json`), because the
bundler never reads a `tsconfig`. Both need `pnpm run build` in the checkout
above to have run: the app bundles what `tsc -b` wrote.

## Over the air, and who is allowed to send it

An app a person sideloads is an app they must sideload again for every change,
which is the reason a covey change would stop reaching the phone. So the bundle
comes over the air, and it comes from the same place the page comes from: the
daemon.

`packages/daemon/src/updates.ts` answers the Expo Updates protocol, version 1:

```
GET /updates                  the manifest, or a directive
GET /updates/assets/<path>     one file of the export
```

Both run through `authenticate()` in `server.ts` — the same gate as the socket,
and the whole gate. Neither is behind `settings.webEnabled`: the machine that
serves the app's bundles is chosen when the app is built and is very often not
the machine that serves the page, so a reader who turned the web client off has
said nothing about their phone. Anyone who can pass that gate can already start
a Claude session on the machine, so authentication is the right bar.

Three parts of the protocol are not ours to choose, and `updates.test.ts` checks
each against bytes rather than intent:

- **The reply is `multipart/mixed`, and the signature is a header on the
  manifest *part*.** It signs that part's exact bytes, so the manifest is
  serialised once and both signed and sent from one string. Build it twice and a
  stray key order breaks verification.
- **An asset is named by the base64url SHA-256 of its own bytes.** That is what
  lets the app refuse a bundle that changed underneath it, and it is why an
  export that names a file it does not hold is refused rather than served thin.
- **A runtime version that does not match gets a `noUpdateAvailable` directive
  and never a manifest.** It is what stops a bundle built against one set of
  native modules from launching inside another app. `expo export` records the
  runtime version nowhere, so `scripts/export.mjs` writes `covey-update.json`
  beside the bundle and the daemon matches on that.

A directive is signed as well. An unsigned "nothing for you" is a downgrade
anybody on the path could send.

### The URL is baked in and the token is not

This is the one design decision in the feature worth arguing about, so here is
the argument.

**The machine is chosen at build time.** `COVEY_UPDATES_URL` names it and it
goes into the binary. A daemon that serves updates serves the JavaScript the
app runs, so that trust is named once, by the person who builds the app, and is
never inferred from a fleet list. The alternative is Expo's
`setUpdateURLAndRequestHeadersOverride`, which needs
`updates.disableAntiBrickingMeasures` — and that gives up the one measure that
lets a later update repair a broken one. A bad bundle would then need an
uninstall to recover, and an update that rewrote the update URL could take the
installation over. covey keeps the measure and rebuilds instead.

**The token is not baked in.** It is a credential and a binary is no place for
one. `app.config.ts` declares an empty `authorization` header — Expo will only
let a header be overridden if the build declared it — and `src/ota.ts` fills it
at run time from the device's keychain with `setUpdateRequestHeadersOverride`,
which needs no such flag. The token is matched to the update URL *by host*,
never taken from the first machine in the list.

The asset URLs carry the token as a query parameter instead of a header, for the
reason `/file` and `/media` already do: the fetch is native code inside
`expo-updates` and covey sets no header on it.

Nothing decides on its own to restart the app. A reload throws away what the
reader was typing, so covey says an update is ready and the reader taps.

## The stack is the route

The page keeps what is on screen in `location.hash` so the browser's back
control, a swipe from the edge and a reload all read the same thing. The app has
a navigation stack, which does the same job better — Android's back gesture and
its back button are the stack's own. Two screens exist because of that:

- **`Media` is a screen**, so a picture is a step in the stack and back shuts
  it. That is #167's whole lesson.
- **`Sheet` is a screen**, which fixes a bug the page still has. On the page the
  settings sheet is not a layer, and it has pages of its own, so back inside it
  means more than one thing.

The transcript is an **inverted** `FlatList`, and that is this platform's answer
to #114: row zero is the newest, so a reply that streams longer pushes nothing
and a reader who scrolled up stays where they were.

## Working on it

```sh
pnpm run build                 # in the checkout above: the app bundles what tsc -b wrote
cd mobile
pnpm install
pnpm run typecheck
pnpm test                      # the pure modules: markdown, address, sheet
pnpm run export                # the bundle the daemon serves
```

`pnpm run export` is the integration test that matters. It is the only thing
that proves Metro still resolves `@covey/client`, `@covey/protocol` and
`@covey/web` from outside the workspace, and CI runs it for exactly that reason.

To serve what you just built, from the machine you built it on:

```sh
COVEY_HOME=/tmp/h COVEY_CONFIG=/tmp/c node packages/daemon/dist/main.js --bind loopback --port 3799
curl -H "expo-platform: android" -H "expo-runtime-version: 0.1.0" http://127.0.0.1:3799/updates
```

### Signing, once per machine

```sh
cd mobile && pnpm run codesign
```

It writes `mobile/certs/certificate.pem`, which is committed and built into the
app, and the private key to `$COVEY_HOME/mobile-signing-key.pem`, which is
never committed. It refuses to overwrite: every app already built against the
old certificate would stop accepting updates.

A machine with no key serves unsigned manifests, and an app that expects a
signature gets a 500 that says so rather than a manifest it would silently
refuse.

### Building the app itself

```sh
cd mobile
COVEY_UPDATES_URL=http://pi.tail1234.ts.net:3790/updates pnpm run prebuild
# then a debug or release build with the Android SDK, or `eas build`
```

`prebuild` writes `android/` from `app.config.ts`, so the config is the source
and the native project is not committed.

**This has not been done yet.** No APK has been built or installed, because
this machine has no Android SDK. Everything up to the bundle is verified —
the bundle builds, the daemon serves it, and every asset's hash checks out —
and nothing past it is. The first person to build one should expect to find
something.

## What is not here

- **iOS.** Nothing in the design excludes it and `expo export --platform ios`
  would very likely work, but the export, the manifest and the app config are
  written and tested for Android alone.
- **Push notifications**, which is the reason an app is worth having and is not
  parity with the page. It wants a daemon that can reach a push service, and
  that is a design of its own.
- **A theme picker.** The TUI has eight themes; `mobile/src/theme.ts` is a copy
  of the web client's one palette. Move a colour in one and move it in the
  other.
- **The command menu.** `commandMenu.ts` is shared and node-tested and the app
  does not use it yet, so a slash command has to be typed out.
