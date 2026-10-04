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

**Two acts, not one.** A machine update — the control panel, or
`machine.update` — runs `git pull`, `pnpm install` and `pnpm run build`, and none
of those touch `mobile/`: `tsc -b` never sees it and Metro is not part of that
build. An updated machine therefore serves the bundle it last exported. To put a
change on the phone, run `pnpm run export` in `mobile/` on the machine that
serves updates; the phone takes it on its next cold start.

That is deliberate for now rather than forgotten. A bundler inside the daemon's
own update path is a step that can fail, and a failure there would block the
update that was meant to fix it. Making the export part of a machine update is a
reasonable next change — it would need to be gated on an export already existing,
so a machine that has never built the app does not start needing the Expo CLI.

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

### One variable, loaded from a file

`EXPO_PUBLIC_COVEY_UPDATES_URL` names the machine, and it lives in `mobile/.env`
(`.env.example` is the committed template). **Every checkout needs its own**:
`.env` is not committed, so a git worktree starts without one, and a bundle
exported there names no machine. That is not fatal — the installed app holds the
real URL in its native configuration and goes on updating — but the bundle
cannot match a token to that machine, and the settings screen says so.
`pnpm run export` prints the URL it baked in, and warns when there is none. Expo loads `.env` for every one of
its commands, and `EXPO_PUBLIC_` is what makes Metro inline the value into the
bundle, so `app.config.ts` and `src/ota.ts` read one value from one place.

That is not tidiness, it is a bug this feature already had. The first APK built
here set the variable for `expo prebuild` — which writes the URL into
`AndroidManifest.xml` — and not for the gradle build, which writes
`assets/app.config` from `app.config.ts`. The binary then carried a native layer
that would update and a JavaScript layer that reported it could not, and the
settings screen said "this build takes no updates over the air" while the app
updated itself. `src/ota.ts` reads the variable rather than
`Constants.expoConfig` for exactly that reason, and `updateInconsistency()`
names the mismatch on screen if the two halves ever diverge again — it is the
one failure nothing else on screen would reveal.

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

You need the Android SDK and a JDK. `ANDROID_HOME` has to be exported, not just
written into `android/local.properties`: `prebuild` regenerates `android/` and
takes any file you put there with it.

```sh
export ANDROID_HOME=$HOME/Android/sdk        # wherever your SDK lives
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

cd mobile
cp .env.example .env          # and name your own machine in it
pnpm run prebuild             # writes android/ from app.config.ts
pnpm run apk                  # android/app/build/outputs/apk/release/app-release.apk
pnpm run export               # the bundle the daemon serves from then on
```

With nothing but the command-line tools, the packages this needs are
`platform-tools`, `platforms;android-36`, `build-tools;36.0.0`,
`ndk;27.1.12297006` and `cmake;3.22.1` — about 4.7 GB.

`prebuild` writes `android/` from `app.config.ts`, so the config is the source
and the native project is not committed. Set `.env` **before** either step: it is
the one place both of them read, and the section above says what happens
otherwise.

`pnpm run apk` carries three flags and none of them are optional. The plain
`./gradlew assembleRelease` the template gives you **does not finish**:

- **It runs out of metaspace.** React Native's template sets
  `-XX:MaxMetaspaceSize=512m`, and four ABIs plus Kotlin plus lint exhaust it —
  the first build here died on `OutOfMemoryError: Metaspace` after 24 minutes.
  `expo-build-properties` has no option for JVM arguments, so this cannot live
  in `app.config.ts` and has to be a flag.
- **Release lint fails inside `expo-modules-core`**, which has nothing to say
  about this app. Exclude the *parent* task, `lintVitalRelease`; excluding its
  two subtasks instead leaves the text-output task demanding files nothing
  produced, which is its own confusing failure.
- **One ABI, not four.** `arm64-v8a` is every modern phone, and it is four times
  less native compilation.

On a machine with little memory add `--max-workers=2`.

#### Asking the machine to build it, from the app

The settings screen's **Install** section lists every machine that holds an APK
or could build one, and each row carries a **Build the app** button. It runs
those same three commands on that machine — `pnpm install --frozen-lockfile`,
`pnpm run prebuild`, `pnpm run apk` — and sends every step back as it goes, so
the row says which one is running and how it ended. When it succeeds the
machine's `appBuild` moves to the new version and the row above the button
becomes the app to install.

It exists because the version a machine serves and the code a machine runs are
two different things. A machine update is `git pull`, `pnpm install` and
`pnpm run build`; none of those reach `mobile/`, so a machine that took a
native change goes on offering the binary it built weeks earlier. That is the
right answer about the file on disk and the wrong one for the reader who wants
the current app, and before this the only way to move it was a terminal on that
machine.

Three rules hold it:

- **One build per machine.** A second call while one is running answers with
  the run in flight. Two gradles in one output directory is a corrupt build and
  an hour lost.
- **It is not the over-the-air route.** `pnpm run export` is not one of the
  steps. An APK is installed by a person who chose to; a bundle lands in every
  installed app of that runtime version without being asked, and covey does not
  do the second on the way to the first. Exporting stays a second act.
- **It promises nothing about the toolchain.** `canBuildApp` is true when the
  daemon runs from a checkout that holds `mobile/`, and nothing more. A machine
  with no Android SDK and no JDK fails the gradle step, with gradle's own words
  in the step's output.

#### What the APK is, and is not

Verified: it builds. 37 MB, `arm64-v8a`, 21 native libraries, a 1.88 MB embedded
JavaScript bundle, and both halves of the update configuration agreeing — the
native `EXPO_UPDATE_URL` and `assets/app.config` naming the same machine, with
`{"authorization":""}` as the declared header the run-time override needs.

Two things it is not:

- **It has never run.** This machine has no access to `/dev/kvm`, so no
  emulator, and there is no device here. Nothing about the app's behaviour on a
  screen is verified — only that it compiles, bundles and is packaged. Expect
  the first launch to find something.
- **It is signed with the Android *debug* certificate**, which is what React
  Native's template configures for release builds. That is fine for sideloading
  onto your own phone and wrong for anything else. A real keystore is a
  `signingConfigs` change in the generated project, which means it belongs in a
  config plugin before anybody distributes this.

## Looking at it, without a device

There is no Android device in this loop and no emulator, and every layout change
made without one was reasoned rather than seen. Several shipped wrong because of
it: a composer behind the keyboard, a send button under a camera lens, a row of
controls that were blank circles.

`pnpm run web` renders the app in a browser through `react-native-web`. It is
**not** a supported platform and nothing about it ships: the two packages are
devDependencies, Metro resolves them for platform web alone, and the Android
bundle is byte-identical with or without them. What it is good for is looking —
the components, the styles and the gestures are the real ones, so a control laid
out off the screen shows up as a control laid out off the screen.

It is good enough to record with, too. `PanResponder` answers a real pointer
drag in a browser, so a swipe captured there is `SwipeRow` doing the work rather
than an animation of it. Point it at a throwaway daemon and nothing real is at
risk:

```sh
COVEY_HOME=/tmp/h COVEY_CONFIG=/tmp/c node packages/daemon/dist/main.js --bind loopback --port 3799
cd mobile && pnpm run web:export
# serve the build, then drive the cached chromium over the DevTools protocol
```

What it is *not* is Android. The native modules take their web implementations,
the fonts are the browser's, and nothing here says how a gesture feels in a
hand. It catches the layout mistakes, which were most of them.

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
