# covey-mobile — a third client, in your pocket

*Issue #168. This is not a replacement. The TUI is still the client covey
ships, and `packages/web` still serves the phone's browser. This is a real
app beside them.*

## Why there is a third client

A phone can already run covey. `packages/web` is served by the daemon and
installs from the browser, and it is a good client. What it cannot do is be an
app.

- **It has no icon it did not borrow, and no notification.** A page cannot wake
  you when an agent asks a question. That is the one the app has since answered
  — see *Notifications* — and it is still the best reason for it to exist.
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
| Where speech is written out | `askMachine` in `src/transcribe.ts` (#180) | A phone that asked the machine about the device's audio and not about its own has two answers to one question. |
| What a thread's change says to a reader who is elsewhere | `threadNews` in `@covey/client` | A thread the terminal rings a bell for and the phone says nothing about is one reader with two answers. |

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

## Notifications

This is the reason an app is worth having. A page cannot wake anybody, so the
page's answer to "is it finished yet" is to go and look — and an agent works for
minutes at a time, so the reader looks far more often than there is anything to
see. The app says it the other way round: nothing, and then one line when the
thread is theirs again.

**They are local, and there is no push service.** The phone is already connected
to every machine of the fleet over the tailnet, and a thread's whole state
arrives on that socket as `thread.upserted` whether or not the conversation is
open. So covey hears the change itself and posts the row itself. Nothing is
registered with Expo, Firebase or anybody else, no token exists to leak, and a
fleet with no route to the internet notifies exactly as well as one with it.
That is what makes this *not* the design `docs/MOBILE.md` used to say was
needed: a daemon that can reach a push service would be a daemon that tells a
third party which of your threads just failed.

### What counts as news is not the phone's decision

`threadNews` in `@covey/client` is the rule, and the TUI reads the same one: it
rings a bell, raises a notice and marks the row from this function, and the
phone posts a notification from it. A thread the terminal calls done and the
phone says nothing about is one reader with two answers, which is exactly what
happened while that rule lived inline in `packages/tui/src/store.ts`.

It is a rule about a **change** and never about a state, because a running turn
re-sends its thread every few tens of milliseconds and a thread that has wanted
an approval for a minute must ring once. So it takes two threads, the one the
client held and the one that just arrived, and a client with nothing to compare
against says nothing at all. That is what makes a reconnect silent: a snapshot
carries every thread the machine has, and a phone coming back from a sleep must
not announce an hour of history the list already shows.

Four rules are the phone's own, in `src/notes.ts` and node-tested beside it:

- **The conversation on screen is never announced** — but only while the app is
  in front. A thread left open behind a locked screen is one nobody is reading.
- **Covey's own reviewers are silent**, through `threadIsHidden`, whose third
  term is the whole safety of it: a hidden thread that needs a person is never
  hidden, so a reviewer blocked on an approval still reaches the reader.
- **A row that has stopped being true comes down.** An approval answered in the
  terminal, or a thread set working again from anywhere, takes its own
  notification with it — and so does opening the conversation.
- **One row per conversation.** The notification's identifier is the Android
  tag, so the second thing a thread says replaces the first rather than queueing
  behind it.

### Hearing it with the screen off

A notification is worth nothing if the socket that carries the news is frozen,
and Android freezes a cached app's network in Doze and kills the process when
the app is swiped away. `modules/covey-link` already existed for exactly this
reason, for the Bluetooth device (#184), so it is what holds the process here
too — **held for reasons, and stopped when the last one is released**. Either
switch may be on without the other and neither may take the service down, so the
set of reasons lives in `CoveyLinkService`, which is also where the words of its
notification are: a reader looking at the shade is asking why covey is running,
and the answer is a list of length one or two.

The type is `specialUse`, and that is the second thing this change got wrong
before an emulator said so. `connectedDevice` is the obvious word — Android's
own definition is an external device reached over Bluetooth, NFC, IR, USB *or a
network connection* — but from Android 14 a type is checked against the
permissions the app actually **holds**, and that one wants one of the Bluetooth,
Wi-Fi, NFC or USB permissions. The reader grants the Bluetooth ones when they
turn the *device* on, so a reader who turns notifications on and owns no device
holds none of them: `startForeground` threw `SecurityException` out of
`onStartCommand`, which is not a feature that fails but an app that closes. On
the most ordinary path this feature has. Android 11, which the test phone runs,
has no such check and could not see it.

So the type is the one that describes what this service really does. It holds no
Bluetooth and no socket — it keeps covey's own process alive, which Android's
list has no name for, and `specialUse` is the category it offers for exactly
that. Its permission is a normal one, granted at install, so the check cannot
come back; the named types that need no permission are `dataSync` and
`mediaProcessing`, which Android 15 caps at six hours a day and which would make
this a feature that stops working in the evening. **And `startForeground` is
wrapped all the same**: a refusal now releases the hold and leaves the app
standing, because the next version of Android will have a rule covey has not
read yet, and that must cost the background rather than the launch.

The ongoing row that service puts in the shade is the whole cost of the feature
and the switch's hint names it rather than leaving a reader to find it. That is
also why the switch is **off until somebody asks**, like the device's.

### What Android decides, and what covey asks

`expo-notifications` is the native half, so `src/notify.ts` writes no Kotlin: it
makes the channel, reads the permission, posts, dismisses, and turns a tap into
a route. Three things there are decided rather than inherited:

- **The channel is created at `HIGH` importance**, which is what puts the
  notification *on the screen* rather than only in the shade. A channel's
  settings are fixed the moment it first exists on a device and only its name
  and description can change after, so this is a decision with one chance; a
  later change of mind would need a second channel id and would leave the
  reader's own choices on the first.
- **The permission is asked for at the switch**, not at launch. Android 13 and
  later show that dialog once in the life of an install, and a dialog about a
  feature nobody has switched on is one nobody reads. It is read again every
  time the app comes back, because it can be taken away in Android's settings
  while covey is away — a switch that still said "on" would be promising
  something nothing shows.
- **A tap is registered in `NavigationContainer`'s `onReady`**, not in an
  effect, because the first tap covey hears about may be the one that *launched*
  the app: Android hands that response over at startup, and an effect runs in
  the same commit as the navigator with no promise that there is a stack yet.

Adding `expo-notifications` is native code, so the runtime version moved to
`0.6.0` and every install needs one more sideload. `covey-link`'s own change
rides on that bump, and it needed to: its `hold` now takes an argument, and a
module DSL function that takes one is exactly what `modules/covey-keys`'
`build.gradle` warns about — so that module moved to `expo-module-gradle-plugin`
in the same change, before the reified type parameter could reach an app.

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

## Dictation

The microphone beside the composer and the covey device's talk button are one
feature with two buttons. Both hand the recording to the **machine**, which
writes out the words with a service on its own loopback — see *Transcription*
in `docs/DEVICE.md` for why that is the daemon's job and not a phone's.
`src/transcribe.ts` holds the decision, which is pure and node-tested, because
each caller sits behind hardware no agent in this loop can start.

### Which button is held

There are two push-to-talk buttons on a phone and they are not equally good.

The microphone beside the message box is where the feature started, and it has
one fault no layout can fix: a thumb held still on glass does not stay still.
The hand moves while the sentence is being thought out, the press ends somewhere
outside the button, and the recording stops mid-word. A volume key has an edge a
finger can feel, and a hold on one survives the hand moving.

So `src/talk.ts` is the choice — the button, the volume keys, or both — and it is
a preference of the **device**, like the level of detail and the hidden threads.
It travels in no command and no daemon hears it. The settings screen offers the
three rows and nothing else reads the mode.

`button` is the default and that is deliberate. While covey holds the keys they
do not change the volume, and a volume rocker that has stopped working is not a
thing to hand somebody who never asked for it. Two rules keep the cost bounded:

- **The keys are taken only while a composer is on screen.** The composer arms
  them as it mounts and gives them back as it goes, so the rocker works on the
  thread list, in the settings and over a picture.
- **A build that cannot read them keeps the button.** `talkButton` says so for
  every mode, because a bundle arrives over the air and a binary does not: today's
  JavaScript runs in whatever app is installed, and an app built before
  `modules/covey-keys` existed would otherwise paint nothing and listen to
  nothing. The settings screen says which install fixes it.

Covey takes *either* key. Nothing else on this phone wants a hardware button
yet, so there is no second gesture to tell them apart for.

`modules/covey-keys` is how a key press reaches JavaScript at all. An Expo
module has no activity and cannot see one; a `ReactActivityHandler` can, and
`expo-modules-core` offers `onKeyDown` and `onKeyUp` on it for exactly this —
every handler is asked, and the first that answers true consumes the event, so
`PhoneWindow` never sees the key and neither the volume nor its slider moves.
Three things about that module are load-bearing:

- **Autolinking finds the handler by the file's name and its import.** A file
  ending `Package.kt` that imports `expo.modules.core.interfaces.Package` is
  added to `ExpoModulesPackageList`. Rename either and the keys go quiet with
  nothing to say why.
- **The state is an `object`, not the module.** The handler is built with the
  activity, long before JavaScript runs, and the module is replaced on every
  reload. `CoveyKeys` is the one thing that outlives both, and it releases the
  keys when the module goes.
- **It fails open.** No listener means no consumption. A press covey misses is a
  sentence said twice; a press covey eats with nothing behind it is a phone whose
  volume keys have stopped working.
- **Its `build.gradle` applies `expo-module-gradle-plugin`,** and a hand-rolled
  `kotlin-android` setup is not a substitute. The plugin pins Kotlin to the
  version `expo-modules-core` was compiled with, and the module DSL carries its
  argument and return types through *reified* type parameters, which exist only
  while the compiler inlines them. Build against a different Kotlin and the
  reification marker survives into the bytecode, so the first thing the app does
  with the module is throw `UnsupportedOperationException: This function has a
  reified type parameter and thus can only be inlined at compilation time`. That
  happens while the module registry is built — before any JavaScript, so before
  the error boundary exists — and the app closes on launch with nothing on
  screen. It cost one release. A `Function` that takes **no argument** survives
  the mistake, which is why `modules/covey-link`, which is still hand-rolled, has
  never shown it: give it one that takes an argument and it will.

What a press and a release *mean* is `keyHold` in `src/talk.ts`, pure and
node-tested, because every case it holds needs a hand on a phone to make. Covey
offers both keys, so a squeeze of the rocker is two presses and two releases for
one hold. A release of a key covey never saw pressed does nothing, or the key
that dismissed a dialog would end a dictation the button started. And a press
that arrives while nothing is being held starts from an empty hand, because
Android can take a release away — a dialog with the focus, or the app going to
the background — and a key left down for ever would cost the reader every later
hold.

### A hold lasts until the reader lets go

Not until they pause. A person thinking a sentence out loud stops for longer
than any endpointer waits, and Android ended the utterance two seconds into the
pause and dropped the rest of the sentence.

Two seconds is not a number covey chose: `expo-speech-recognition` writes it
whenever a recording is persisted, because persisting one puts the recogniser in
Android's **segmented session** mode and that mode needs a silence to end on. So
`useDictation` widens it, with the `androidIntentOptions` the module applies
after its own — `COMPLETE_SILENCE` is the one the session ends on, and
`POSSIBLY_COMPLETE_SILENCE` goes with it because that is the endpointer cutting
a pause off mid-sentence. Both are `MAX_RECORDING_MS`.

Four things follow, and the first two are what a three-minute hold costs that a
two-second one did not:

- **Nothing between the press and the recording may be awaited.** Android puts
  its permission dialog up inside such an await, the dialog takes the focus and
  the key events, and the release that was meant to end the hold never arrives —
  so the recording starts with nobody holding it. `stop()` cannot save it either:
  before the recogniser exists the module posts `stopListening` to a recogniser
  it has not built, which does nothing and emits no event. So the permission is
  read once at mount, and a hold that still has to ask for it records nothing and
  says *hold again*.
- **A hold covey ended is not sent.** The cap is reached by a key against a table
  far more often than by a sentence, and uploading three minutes of a pocket over
  a mobile link is exactly what `MAX_RECORDING_MS` was written to prevent. The
  reader keeps the words this phone made of it, which is what that constant has
  always promised. The refusal in `phoneRecording` is the net under that rule and
  not the rule itself: it catches a timer that did not fire, or samples from
  another caller.
- **A hold may be several segments.** Android reports a segment as final and goes
  on listening, and each one carries its own words rather than the sentence so
  far. They are kept and joined. Replace the last instead and a reader who paused
  for breath watches their first sentence vanish when the second arrives — and a
  recogniser that re-sends the whole utterance instead stands in their place,
  because no test behind a microphone can tell which kind a given Android is.
- **`continuous: true` is not the way to do this, and it looks like it.** With a
  recording it keys the segmented session on the audio *source*, whose only end
  is the recorder closing — which `stop()` does not do. The hold would never
  settle.

A recogniser may ignore the silence extras; Android says so. The floor is the
behaviour before this change — the hold ends at that recogniser's own silence —
so nothing breaks, it just stops listening early. That is one of the two things
on this page a browser cannot show.

### Two stages, and the words are provisional until the second

The machine answers in about a second, and a dictation that shows nothing for a
second reads as a microphone that is not working. So the phone's own recogniser
runs on the same held button and puts its words in the draft as they are
spoken, and the machine's words replace them when they land. Those first words
are therefore **provisional**: `useDictation` reports `final` once, by
whichever recogniser had the last word. Report the phone's text as final and
the machine's answer is added to the draft rather than put in its place.

Three rules come out of that, and a reader meets each of them the first time
something goes wrong:

- **A late answer is dropped.** A reader who holds the button again has moved
  the draft on from under the answer in flight, so every answer is matched
  against the utterance it belongs to — the same guard the TUI's picture
  preview keeps, for the same reason.
- **A failure still leaves the reader their sentence.** The phone's words are
  already in the draft, so a machine with no service, a recording Android would
  not write, and a service that failed all settle on them. A failure says so as
  well, because a reader whose words came from the worse of the two recognisers
  should be able to tell which one wrote them.
- **There are three states and not two.** Resting, listening, and the machine
  writing it out. Anything that went back to rest at the second one says the
  dictation is over while the sentence is still about to change. The button
  paints all three; with the keys holding the gesture there is no button to turn
  red, so the composer paints the same three in the same place as a reading
  instead — and only while there is something to say, because a shape that looks
  like a button and is not one is worse than a gap.

It records with `recordingOptions.persist`, which is what gives the machine
something to be asked about: the module writes the one shape covey carries
(16 kHz, 16-bit, mono PCM in a WAV), `pcm16FromWav` reads it back, and the
samples go up as `pcm16` — the codec the protocol keeps for a caller that
already holds them. Two things follow. It needs Android 13, and below that
there is no file at all, which the null `audioend.uri` already covers. And
covey's own recorder feeds the recogniser from then on, which takes the start
and stop beep away; on a held button that is a mercy rather than a loss.

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
`pnpm run prebuild`, `pnpm run apk` — and reports at each step's boundary, so
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

Four rules hold it:

- **No `.env`, no build.** The run refuses before the first step when nothing
  names `EXPO_PUBLIC_COVEY_UPDATES_URL` — neither the daemon's environment nor
  `mobile/.env` beside the config. The section above says to set `.env` before
  either step, and a person at a terminal who forgets can read the warning in
  their own scrollback; a person who tapped a button on a phone cannot. With no
  variable `app.config.ts` leaves the whole `updates` block out, so the app that
  comes out is off the update channel, and covey keeps Expo's anti-bricking
  measure — only another sideload mends it. A missing file is one line to write.
  Forty minutes of gradle and a dead binary is not.
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

The progress is pushed at a step's boundary and nowhere else. The updater
streams its output and sends it every 150 ms, because an update takes a minute
and a reader watches it fill; this takes forty, gradle writes thousands of
lines, and every message carries a copy of all three steps' bounded output.
Nothing paints that output — `appBuildLabel` reads the state, the error and the
running step's name — so it accumulates on the daemon and rides along at the
next boundary, which is where a failure's tail is wanted anyway. A whole build
is about nine messages rather than tens of thousands. A client that connects
while a build is running is sent the record once, there and then, because the
next boundary may be half an hour away.

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
- **Push notifications**, in the sense of a server that pushes. The app is told
  about a thread over the socket it already holds and posts the row itself — see
  *Notifications* above — which covers everything covey has to say about a
  thread and costs an ongoing row in the shade. A real push service would be
  what buys that row back, and it would need a daemon that can reach one.
- **A theme picker.** The TUI has eight themes; `mobile/src/theme.ts` is a copy
  of the web client's one palette. Move a colour in one and move it in the
  other.
- **The command menu.** `commandMenu.ts` is shared and node-tested and the app
  does not use it yet, so a slash command has to be typed out.
