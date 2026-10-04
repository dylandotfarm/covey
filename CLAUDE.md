# covey — notes for agents working in this repo

- pnpm workspaces (version pinned via `packageManager`; install once with
  `npm i -g pnpm@12.4.0`, no corepack), TypeScript project
  references. Build everything with `pnpm run build` (`tsc -b`). No bundler, no native deps.
  Node ≥ 22 (uses `node:sqlite`).
- Packages: `protocol` (types only) → `client` (the `MachineClient`, node and browser) →
  `daemon`, `tui` and `web` → `cli`. Change the protocol first, then both sides.
- `packages/web` is the phone's client, served by the daemon at `/` (`packages/daemon/src/web.ts`)
  when `settings.webEnabled` is on — the machine control panel sets it, `COVEY_WEB=1` seeds
  it for a throwaway daemon, and the TUI keeps it to one machine (`store.setWebServer`).
  The page dials every machine in the fleet; the TUI hands the serving daemon that list
  (`store.fleetFor`, `machine.fleet`) and the page reads it from `machine.access`.
  `machine.settings { bind }` moves the daemon's listeners while it runs (`EngineOptions.rebind`
  in `main.ts`); a `--bind` flag wins at start and is never written to `daemon.json`.
  No bundler: `tsc -b` writes browser ES modules and the import map in `static/index.html`
  names `@covey/protocol` and `@covey/client`. Nothing in `client` or `protocol` may import
  a node module, or the page stops loading. `web/src/state.ts`, `commandMenu.ts` and `markdown.ts`
  hold no DOM and node tests them; `render.ts` and `main.ts` are DOM and are checked by `tsc` only,
  so try a change against a real daemon in a browser. `packages/daemon/test/web.test.ts`
  fetches every module the page names.
- `pnpm run setup` (`scripts/setup.mjs`) is the one-machine install: it installs, builds, and
  links `bin/covey` into a directory on the PATH. The launcher follows its own symlink back
  to the checkout, so a linked `covey` always runs that checkout — keep it that way.
- `packages/cli/src/index.ts` sets `NODE_ENV=production`, for React and for nothing else.
  React reads it when its module body runs, and the development reconciler calls
  `performance.measure()` per commit — entries node never drops, which grew the client to
  4.2 GB (#61). Keep the entry free of static imports: node evaluates every static import
  before the first statement in the file, so one import there undoes the line.
  `packages/cli/src/nodeEnv.ts` hands the setting back once React has read it. Nothing covey
  starts may inherit it: the daemon spawns the Claude sessions, and a command such as
  `npm install` under `NODE_ENV=production` installs without the devDependencies and says
  nothing. `clientEnv.test.ts` and `nodeEnv.test.ts` hold both halves.
- Ink 7 batches fast keystrokes and pastes into one `useInput` call; `App.tsx` splits them.
  Two rules come out of that, and #128 is what happens without them. A handler that runs
  inside one chunk sees state from the render before it, so the overlay's field is read from
  `ovFilterRef`, never from `ovFilter` — write both, decide on the ref, paint the state. And
  every key of a chunk but the last carries `pasted`, so a one-line prompt can tell a newline
  inside a paste from the enter that ends the chunk; the last key of a chunk is never marked,
  or a fast typist loses their enter. A masked prompt keeps a pasted newline, so a private
  key pastes whole.
  Test the TUI in tmux with small delays between `send-keys`, and capture with
  `tmux capture-pane -p -e` to see colours.
- A dropped file is read on the machine the *client* runs on, and its bytes go inline over the
  wire, so a TUI on a laptop can attach to a daemon anywhere. The daemon writes them into the
  thread's file store, `<cwd>/.covey/threads/<id>/files`, inside the worktree the session runs
  in — so the agent opens a drop with a path it can guess, the files go when the worktree
  goes, and `.covey/.gitignore` (`*`) keeps them out of `git status` and out of a checkpoint.
  Everything from the wire is cut down first (`safeSegments`): a name must not write outside
  that store. Two caps, and never one again: `MAX_ATTACHMENT_BYTES` is what covey carries on
  one drop and bounds the socket frame with it; `MAX_IMAGE_BYTES` is what the model may be
  shown. An image over the second is shrunk — `shrinkImage` scales the long edge to
  `SHRINK_LONG_EDGE` with `sips`, `magick`, `convert` or `ffmpeg`, whichever the machine has,
  and that constant is the API's own, so scaling to it costs nothing; scaling comes before
  quality because heavy JPEG is what makes a screenshot's text illegible. An image no tool
  could shrink still travels, with a warning that the model will read it as a file. Over 1 MB
  a file goes `gzip`ped when that saves more than a tenth. A dropped *directory* goes as one
  attachment per file, each with the path it had inside and all sharing one `dir`, so the tree
  arrives whole and the composer shows one chip; never an archive, because the agent would
  have to unpack it. When a read fails, say which of the four things went wrong — not there,
  no permission, over the cap, or anything else — in the chip as well as the notice (#132);
  one word for four problems is what made a screenshot read as "unreadable" for weeks.
  `pasteText` reads a chunk twice: whole, then joined onto the seam the last paste left
  (`readSplitDrop`, #130), because a terminal can write one path in two goes — and a path that
  ends at a separator is never a directory drop, because that is exactly what the front half
  of a cut path looks like. Both routes end at the same `attach`, so a change to one wants the
  other. A chip is one key to delete, not one key per character (`tagSpanAt`, `cutTag`),
  and one arrow key to walk over.
- A paste of more than two lines is a chip as well: the draft gets `[pasted 200 lines]`
  and `AppState.pendingPastes` holds the lines, which `sendTurn` puts back where the chip
  stood (`expandPastes`). The rules are `packages/client/src/paste.ts`, beside the drop's
  own, because a chip is a chip whatever stands behind it — one tag, ordinary text, one key
  to delete. Three lines is the floor because one line and two are something the reader
  writes *with*: a path, a branch, a two-line error. Nothing of a paste is a file — no
  bytes on the wire, no cap, no file store — so it is held beside the attachments and
  never inside them. Two rules a reader cannot undo: **paste the same block again and the
  chip becomes the text**, in place, which is the only way back to what it holds; and that
  reveal is decided *before* the seam, because two pastes inside `PASTE_SEAM_MS` is exactly
  what a person does when they want to see one, and the seam would have joined them into
  one chip of twice the lines.
- The agent shows its own work the same way the reader drops one (#160): `covey show
  shot.png --text "…"` copies the file into that one store and writes a `note` carrying
  `SystemNoteItem.files`, which the web client paints inline and the TUI names with an
  OSC 8 link to the daemon's `/file` route (`threadFileUri`, `httpBaseFor`) — the daemon
  that holds the thread serves it, so a TUI on a laptop opens a screenshot made anywhere.
  A note carries no `groupId`, so a picture never folds away into a chain row. The store's
  boundary does not move: `thread.showFiles` copies *into* it, and `/file` still serves
  that one thread's own files. The command answers a loopback connection only, as
  `secrets.env` does, because `path` names a file on the daemon's machine. This is not
  `covey pr --attach`, and never becomes it: one shows a thing to the person reading now,
  the other puts it on a pull request. Change `packages/cli/src/show.ts` and the `/covey`
  skill together, as with the loop and `covey env`.
- A terminal that speaks the kitty graphics protocol paints that picture, over the
  transcript, on a plain click (#163). `media.ts` is pure and holds the escapes; the route
  is *Unicode placeholders* and may never become a plain placement: ink erases the rows it
  rewrites and `relTime` re-renders the client every `CLOCK_MS`, so a picture anchored to
  the screen is a picture the next frame deletes. A virtual placement belongs to cells
  instead — covey sends the bytes once with `U=1`, then paints a rectangle of `U+10EEEE`
  whose foreground colour carries the image id, and every repaint re-composites for free.
  The measurements are the whole reason it works, and `mediaPaint.test.ts` holds them
  against the real ink: the graphics escape costs 17 columns, so it goes out of band to
  the stream ink owns and never inside a span; a placeholder cell costs 1 and a combining
  mark 0, so a painted row measures exactly the cells it covers. Every escape carries
  `q=2`, because the terminal's answer would arrive on stdin and `useInput` would read it
  as typing — which is also why every `CSI … t` the terminal writes back, covey's own
  cell size answer and the window reports some terminals send unasked, is taken out in
  `App.tsx` (`takeWindowReports`) before the mouse parse. Match one whole and you match
  nothing: ink splits a chunk into one event per escape sequence and then drops that
  event's *leading* escape, so the answer arrives as `[6;34;16t`, and the guard that
  wanted the escape put thirty-eight of them in a reader's composer. It is read from
  anywhere in the chunk all the same, because a bracketed paste is the one chunk that
  carries text around a report — covey registers no `usePaste`, so ink hands the whole
  of a paste to `useInput` — and a report inside pasted text goes with nothing said.
  The question is asked once the resize stops (`CELL_SIZE_DELAY_MS`), because a window
  dragged by its corner resizes tens of times and every question is answered.
  Inline in the transcript is the next step and it waits on #24:
  `width()` counts a combining mark as a column, so `wrapSpans` would misjudge a row. The
  overlay builds its own rows and never calls it. kitty takes PNG and raw RGB alone, so
  `mediaView.ts` converts with the four tools `attachments.ts` already looks for, and a
  video becomes its first frame — never a stream of frames, which is the paint budget
  gone. `graphicsEnabled` is asked at the click and not read into a constant beside
  `HYPERLINKS`: one click cannot pay for a module that has to load after the environment
  is set, which is the `NODE_ENV` trap again.
  The arrow keys walk every picture of the conversation (#165), in transcript order, and
  stop at each end rather than wrap — the `n of m` beside the name is what says there is
  no more. The list is `Overlay.files`, frozen when the preview opens, because a reader
  looks at what was on the screen when they clicked. `showMedia` is the one route a click
  and an arrow both take, and its guard is `at` *and* the list's identity, so a slow fetch
  can never paint over a later one. Walking on must forget the picture walked away from —
  the `useEffect` keyed on the image id is what sends `a=d,d=I`, and `mediaClick.test.ts`
  holds it, or every picture a reader stepped past stays in the terminal for the session.
  `PreviewCache` bounds by bytes and never by count, because one screenshot is a hundred
  times another, and never holds a failure: a machine away for a moment must not be away
  for the session.
- `mobile/` is the React Native client (#168), a *third* client beside the TUI and the
  page, and a pnpm workspace of its own outside the repository's: `tsc -b` never sees it
  and Metro never inherits install rules written for a node project. It is mostly a
  paint, because `@covey/client` and `@covey/protocol` import no node module and
  `packages/web/package.json` already named `state.ts` its entry — so the app imports the
  same `State` the page keeps and applies it with the same functions. Never write a second
  copy of a decision: `projectRows` (and `projectPool` under it), `timelineRows`,
  `sheetRows`, `tableAt`, and `readPicked` for the caps and the four failure words (#132)
  are all shared, and the web package names `./attach` and `./markdown` in its exports for
  exactly that. The one thing the app parses itself is the markdown *layout*, because a
  `<Text>` is not HTML — and `mobile/src/markdown.test.ts` holds it against
  `markdownToHtml` on every input, not against a fixture, because the page applies its
  patterns in order to one flat string and so bold may hold a link *and* a link's label
  may be bold. A recursive descent gets one or the other.
  The bundle comes over the air from the daemon (`packages/daemon/src/updates.ts`, the
  Expo Updates protocol v1 on `/updates`), gated by `authenticate()` and by nothing else —
  the machine that serves bundles is chosen when the app is built and is very often not
  the machine that serves the page. The signature is a header on the manifest *part* and
  signs that part's exact bytes, so serialise the manifest once; an asset is named by the
  base64url SHA-256 of its own bytes; and a runtime version that does not match gets a
  directive, never a manifest, which is what stops a bundle built against other native
  modules from launching. `expo export` records no runtime version, so
  `mobile/scripts/export.mjs` writes `covey-update.json` beside the bundle. A machine
  update does *not* refresh that bundle — it runs `git pull`, `pnpm install` and
  `pnpm run build`, and none of those touch `mobile/` — so putting a change on the phone
  is a second act, `pnpm run export` on the machine that serves updates.
  The update URL is baked in at build time and the token is not: a run-time URL needs
  Expo's `disableAntiBrickingMeasures`, which gives up the one measure that lets a later
  update repair a broken one, so covey rebuilds instead. That URL is
  `EXPO_PUBLIC_COVEY_UPDATES_URL` in `mobile/.env` and is read from the environment in
  both halves — never from `Constants.expoConfig`, because `expo prebuild` writes the
  native manifest and the gradle build writes `assets/app.config`, and a variable set for
  one step and not the other ships an app that updates itself while telling the reader it
  cannot. `pnpm run apk` is the build, and its three flags are all load-bearing: the
  template's gradle runs out of metaspace, release lint fails inside `expo-modules-core`,
  and one ABI is four times less native compilation. Two screens are screens on
  purpose — a picture, which is #167's lesson, and the settings sheet, which fixes a bug
  the page still has — and the transcript is an inverted `FlatList`, this platform's
  answer to #114. A thread the app has just asked for does not exist on the daemon
  yet — `thread.create` is awaited over a fetch and a `git worktree add` — and the
  list opens the conversation the moment it has an id, because a tap must not wait
  on a clone. So everything that names that thread to that daemon waits in
  `store.whenMade` first: a subscription sent ahead of the worktree is answered
  `thread not found`, and the view keeps that error until the reader leaves the
  screen and comes back, which reads as a conversation the daemon lost.
  Relative imports carry no `.js`: Metro does not follow TypeScript's
  convention. There is no device in this loop, so `pnpm run web` renders the app in a
  browser through `react-native-web` — not a platform covey ships, just a way to *look*:
  the components, the styles and the gestures are the real ones, the two packages are
  devDependencies Metro resolves for platform web alone, and the android bundle is the same
  with or without them. Every layout bug this client has had is one a look would have
  caught. `pnpm run export` is the integration test that matters and CI runs it,
  because it is the only thing that proves Metro still resolves the three shared packages
  from outside the workspace. `docs/MOBILE.md` holds the reasoning and the rules; no APK
  has been built yet.
- `firmware/` is the covey device (#178), a Waveshare ESP32-S3 1.54inch e-Paper
  board: 200x200, two buttons, an ES8311 microphone, ESP-IDF 5.5 and its own
  toolchain outside both the pnpm and the cargo workspace. It is a *peripheral
  of the phone* and never a fourth client: it holds no covey state, no socket
  and no token, so unplug the app and it is a screen with two buttons. Hold
  talk and it records, let go and the utterance goes to the phone; the phone
  passes it to the daemon, which writes out the words (#180), sends them to the
  thread as an ordinary turn, and sends the answer back to be painted. The chip has
  Bluetooth Low Energy and no Classic, so the link is GATT and never a serial
  port profile. One wire definition, in `packages/client/src/device.ts`, which
  node tests — the other end is C that can never run beside it, so the device
  prints its own encoder's bytes over USB (`console.py key t`) and
  `device.test.ts` holds them; if that fails the two drifted and the words
  stopped arriving. Audio is IMA ADPCM at 16 kHz because 16-bit samples are ten
  times the radio time BLE has, and it is *block based* so a block lost on the
  air costs its own 32 ms and not the sentence. The last block is padded, so
  the message carries the **count of samples** — without it the recogniser is
  handed up to 31 ms of sound nobody made at the end of every utterance. Android
  transcribes a file and takes one shape of it, 16 kHz 16-bit mono PCM in a WAV,
  and answers `audio-capture` to everything else — which reads as a broken
  microphone rather than a wrong header, so `wavFromPcm16` writes that one shape.
  Never write a second copy of a decision: the menu is `projectRows` flattened,
  busy is `threadIsBusy`, and the reply is `replyLead`'s rule. The device answers
  a pick with a *position and the generation it belonged to*, never a thread id,
  and a pick against a list that has since changed is refused. A `MachineClient`
  holds one thread subscription, so the device and the phone cannot look at
  different threads and the device wins — it is a remote control for the phone,
  which is why it needs no credentials. A refresh is 300 ms partial and 2 s full
  and the panel ghosts, so one task paints, nothing paints from a radio callback,
  nothing animates, and the reply lands once when the turn ends rather than forty
  times a second while it streams. The talk button is PWR and not BOOT because
  GPIO0 is sampled at reset and the button held for seconds must not be the one
  that lands a reader in the bootloader. `tools/console.py` drives the device
  over USB and `>` plus base64 is one downlink message — the real protocol over a
  second transport, not a fixture, which is how a change is tried with no phone
  in the room and how every picture of a screen was made. `react-native-ble-plx`
  is native, so `mobile/app.config.ts` moved to `0.3.0` and every install needs
  one more sideload. **The daemon writes out speech, not the phone** (#180): the
  `transcribe` RPC takes the device's own ADPCM — a quarter of the bytes of the
  samples — and `packages/daemon/src/transcribe.ts` hands a WAV to a service at
  `COVEY_TRANSCRIBE_URL` (default `http://127.0.0.1:8790`; the *empty string*
  turns it off, which is not the same as unset). It is the daemon's job because
  the key is a secret and secrets live on the machine that runs the work, and
  because a service can then change with no new app. `unavailable` is the one
  code that makes a client fall back to its own recogniser; every other failure
  carries the service's own sentence to the screen, because those sentences were
  written for it.
  Android stops a *background* app from receiving Bluetooth scan results while
  the screen is off and kills a swiped-away process, so the device is
  unreachable with a locked phone (#184): `mobile/modules/covey-link` is a
  foreground service that **does nothing** — `ble.ts` still owns the scan and the
  connection, and the service only keeps the process alive. From Android 14 the
  service type is declared twice, in the manifest and again at `startForeground`,
  and a mismatch throws. Load it with `requireOptionalNativeModule`, never the
  strict one: a bundle sent over the air can land in an app built before the
  module existed, and the throw would be at import time. The firmware records
  even with no link and **holds** the utterance until one returns, sent from the
  status sweep rather than the connect event, because a phone is connected a
  moment before it subscribes. A native module moved the app to `0.4.0`, so the
  daemon serves the binary it built at `/apk` and the settings screen links to
  it (#185, `MachineInfo.appBuild`) — gated like `/updates`, with the token on
  the URL because a download carries no header. That is *not* the update channel
  and never becomes it: `/updates` ships JavaScript into an installed app,
  `/apk` hands a whole binary to somebody who chose to install it. The same row
  *asks* for a new one (`machine.buildApp`, `AppBuilder` in the daemon): the
  three commands of the build on that machine, one run at a time, with every
  step broadcast as a `machine.appBuild` push — because a machine update never
  touches `mobile/`, so the binary a machine offers can be weeks older than the
  code it runs. `pnpm run export` is never one of those steps: a bundle lands
  in every installed app of that runtime version unasked, and an APK is
  installed by a person who chose to.
  `docs/DEVICE.md` holds the reasoning and the rules.
- `desktop/` is the experimental Rust client (#142), a cargo workspace of its own, outside
  the pnpm one: `tsc -b` never sees it and `cargo` never needs node. It is a *second* client
  and not a replacement — never change the TUI to suit it. The idea is one `Grid` of styled
  cells that also carries *media placements*, a rectangle of cells a picture is painted over
  instead of glyphs, so the layout stays row-and-column and the scroll stays a count of
  lines. A placement owns its cells. `covey-grid/src/theme.rs` is a copy of
  covey's own palette in `packages/tui/src/theme.ts`; move a colour in both or neither.
  The other seven themes are not copied — this client has no picker yet. It fetches a dropped file
  over the daemon's existing `/file` route and decodes a video by piping `ffmpeg`, the same
  rule `shrinkImage` follows. With no display, `cargo run --bin covey-desktop -- --render
  f.png` draws one frame and `--probe ws://…` dials a daemon and prints what came back; both
  run under an agent. `docs/DESKTOP.md` holds the reasoning and the rules.
- ctrl+` opens a shell in the thread's working directory (#10), in place of the
  transcript as the diff panel is. The shell runs on the *daemon's* machine, because
  that is where the directory is, and the bytes cross the same socket: `terminal.open`
  / `input` / `signal` / `resize` / `close`, and a `terminal` push that carries no seq
  and no replay, because a stream is not a timeline. There is no pty and there will not
  be one cheaply — `node-pty` is native and this repo blocks install scripts — so
  `packages/daemon/src/terminal.ts` drives bash through four pipes. Commands go in on
  **fd 3** and the exit status and `$PWD` come back on **fd 4**, which keeps fd 0 as the
  *command's* own stdin, so `read` works and a command cannot swallow the command queued
  behind it. Three characters in `DRIVER` are the whole thing and each is one edit from a
  bug a reader finds with their finger: `eval` runs in the shell itself, so `cd` lasts;
  `trap ':' INT` keeps the shell alive through the ctrl+c that kills what it runs, where
  `trap '' INT` would be inherited as ignored and kill nothing; and a `read` cut short by
  that signal returns above 128, which has to be told from the 1 that means the pipe
  closed, or a ctrl+c pressed at an idle prompt ends the shell. One shell per thread, and
  shutting the panel does not end it — `cd` and a running `pnpm test` survive, and
  `TerminalInfo.scrollback` paints the screen the reader left. The shell gets no secrets
  (`covey env exec` is the route, and it runs on the right machine), and its output is
  redacted like a timeline item anyway. A shell dies with its thread's worktree. The
  client parses the escapes rather than passing them to Ink: `packages/tui/src/ansi.ts`
  is a *scrolling log*, never an emulator — SGR, `\r`, `CSI K`, `\b` and `\t` are
  honoured and every cursor move is dropped — because an escape left in the text is
  columns `width()` would count, which is the invariant `resize.test.ts` holds. ctrl+`
  needs no ctrl fallback, unlike covey's cmd bindings: under the kitty protocol it is
  codepoint 96 with ctrl, and without it the terminal sends a bare NUL that Ink's legacy
  parser turns into `String.fromCharCode(0 + 96)` — the backtick either way.
- Ink cannot paint under `position="absolute"`; overlays render in place of the transcript.
- A paint is the client's dearest act — 30–45 ms of its one thread on this project's
  Pi, at 120×45 with a 200-item transcript — and the keyboard waits behind it. So the
  store has two ways to change state: `set` paints at once and is for what the reader
  did, `setFromMachine` paints on a frame boundary and is for everything a daemon said.
  Every `MachineClient` callback is on the second side of that line, and so is `notify`,
  because most notices are raised from those callbacks. `frames.ts` paces the boundary
  off the lateness its own timer measures, so a loaded machine paints less and types the
  same; `FRAME_MS` is Ink's own throttle period, so move it with `maxFps` or not at all.
  Four things hold the budget up. Don't notify React per event (`typing.test.ts`). Don't
  tick the spinner with nothing to animate — but do keep ticking at `CLOCK_MS`, because
  `relTime` dates every sidebar row from `Date.now()` and nothing else re-renders an idle
  client. Ask `threadIsBusy` on both sides of that, never a restatement of it: a thread
  the store calls still and a component draws moving is a spinner that never advances.
  And don't lay out two hundred timeline items to follow one of them changing
  (`ItemLines` in `lines.ts`, keyed on item identity — sound only while the daemon keeps
  re-sending items whole).
- The palette is one object every pane reads (`T` in `packages/tui/src/theme.ts`), and
  `setTheme` rewrites it *in place* — so a module that imported `T` never holds a stale
  theme and nothing has to be re-imported. A theme is the *device's* preference, like the
  level of detail: `prefs.theme`, no command carries it, no daemon hears it. Two things
  follow. Never read a colour into a module-level constant; it would freeze at the theme
  the process started in. And anything that memoises painted lines — `ItemLines`, the
  `useMemo`s in `App.tsx` — has to watch `themeGeneration()`, because an item does not
  change when the colours do, and a frame repainted around a stale transcript is what that
  number exists to prevent. `theme.test.ts` measures every theme, not just the default:
  a palette that fails the contrast rules is one a reader cannot use.
- A message covey wrote itself is marked (`UserMessageItem.system`, set by the daemon for
  the pull-request news and the turn it restarts after an authentication failure) and the
  wire refuses the claim from a client (`server.ts`). The TUI paints it as its own block
  with a rail, on the left; the reader's own messages go to the right edge. `lines.ts`
  keeps `isSystemMessage`, whose text-prefix fallback is what makes a transcript already
  on disk read right — keep it in step with `integrate/news.ts`.
- The transcript's scroll is a count of lines from the bottom, and a streaming item is
  re-sent whole and longer, so the bottom moves under it. `setScroll` therefore also takes
  an anchor — the item under the top row and the offset into it — and App resolves the
  anchor against the layout it is about to paint (`scroll.ts`). Read `scrollFromBottom`
  from that resolved number, never from `state.scrollFromBottom`, or a reply that streams
  drags the screen away from the reader again (#114). A count of 0 is "follow the bottom"
  and has no anchor.
- Screen rows are not row indices: the sidebar puts a blank line above each top-level
  row after the first and windows a long tree. `sidebar.ts` builds the painted line list and `App.tsx` gives
  the same array to the renderer and to the mouse hit test — change both or neither.
- The daemon can be exercised without the TUI: run `node packages/daemon/dist/main.js
  --bind loopback --port 3799` with `COVEY_HOME=/tmp/x`, then speak JSON over ws (see
  `docs/DESIGN.md` → Protocol).
- A project is a bare clone the daemon owns, at `<projectsDir>/<owner>/<repo>/repo.git`, and
  each thread's worktree sits beside it. `projectsDir` is `COVEY_PROJECTS`, else
  `<COVEY_HOME>/projects` when `COVEY_HOME` is set, else `~/.covey/projects`. A test that makes a project clones a
  scratch remote from `packages/daemon/src/scratch.ts`; nothing in `pnpm test` reaches a
  real remote. What makes two projects one row is the repository *and* the base branch —
  `projectPool` in `@covey/client`, which the TUI (`projectGroups`, `placementMachines`) and
  the web client (`projectKey`) both key on. The same repository on `main` and on a feature
  branch is two projects that share one bare clone, and the daemon refuses only a second
  project on a base another one already holds. Never key any of this on
  `repositoryIdentity` alone: a thread would start from the wrong commit and open its pull
  request against the wrong base.
- A **fleet** is the line between two sets of machines on one tailnet — the ones at work
  and the ones at home. The machine declares its own (`MachineSettings.fleet`, `null`
  for the default `covey`), so the terminal, the page and the phone group it the same
  way and no client can put one machine in two fleets; `SavedMachine.fleet` is a
  *cache* and nothing else, and it is what holds a machine that is away in its fleet
  rather than dropping it into the default one. The rules are
  `packages/client/src/fleets.ts`, pure and node-tested. The line is real and not a
  heading, which is the whole reason the feature exists: `projectGroups` pools a
  repository inside one fleet, `ghMachines` and `listRepos` read the repository list
  from a `gh` in that fleet — a work login lists work repositories, and offering them
  at home is exactly the confusion fleets remove — and `placementMachines` places a
  run's members inside its own fleet. **covey never chooses a machine across the line;
  the reader may still name one.** So `moveThread` offers every connected machine — a
  move names both the machine and the project it lands in, and it is how a machine is
  retired — while `moveMember` is scoped, because the store refuses a member placed
  outside its run's fleet and a pick that offered one would report "no checkout" about a
  machine that holds one. The sidebar grows one level of fold above the
  projects, **and only when there is more than one fleet**: a reader who never makes a
  second one sees the tree they always saw, at the depth they always saw it. For the
  same reason the default fleet scopes no fold key (`fleetScope` is empty for it) — a
  project's key lives in the client's config, and a key that changed would unfurl the
  whole tree the first time covey learned the word. `machine.peers` is what
  `machine.fleet` used to be, the machines the phone's page dials, which is *every*
  machine and never one fleet; the daemon still answers the old name for an older TUI
  and reads the old `fleet` key out of `daemon.json` once more, so an update does not
  leave a phone dialling one machine.
- A project needs a commit to exist (#176). A repository with no commits has no branch,
  so `git remote set-head origin --auto` fails after a fetch that worked, and nothing
  could branch a worktree from it anyway — so `cloneBare` refuses it by name rather than
  pass on git's "Cannot determine remote HEAD", and `New repository…` passes
  `--add-readme` to `gh repo create` so covey never makes one it cannot use. A remote
  that has branches but no *default* is not that case: `remoteDefaultRef` falls back to
  main and then master, and that clone stands.
- A notice is the only channel a failure has, and it lives on the title bar's one row.
  So it is measured before it is painted (`barNotice` in `App.tsx`): an error or a
  warning takes the whole bar and the title steps aside, and what will not fit goes from
  the *middle* (`elide`), because a line reads "what failed: why" and the repository's
  name alone can be fifty columns. Never hand that row an unbounded `Text` — Ink wraps it
  inside the `height={1}` box, paints the remainder over the transcript, and the reader
  keeps the last two words of the sentence and none of the reason. A keybinding hint is
  ranked the other way round (#87): it takes only what the title leaves, in the longest
  of its forms that fits whole, and below the shortest it is not painted — a hint cut
  from either end is a hint nobody can read, and the composer's own status row says the
  same keys anyway. `titleBar.ts` shares the row out and node tests it; the boxes keep
  their own shrink as a net only because Ink measures with `string-width` and covey with
  its own `width`. Never let two children of that row both want more than there is: what
  flex settles there depends on a cached text measurement, which is how the width the
  client *mounted* at used to change this row and no other.
- A project's URL names the *repository*; how to reach it is each machine's own business
  (#157). The client sends one URL to the whole pool, and every daemon works out its own
  clone URL with `cloneUrlsFor` — two machines may be set up for different styles of
  authentication on purpose, one on an ssh key and one on the `gh` token over https, and
  the machine that happened to answer the repository pick must not decide for the rest.
  `gh` speaks for github.com and for no other host, so a repository elsewhere keeps the URL
  as it came, and `remoteForms` rewrites nothing it cannot name — a path, a host from the
  user's ssh config, a port, a credential in the URL. The other protocol follows as a
  second chance inside the same clone budget, so a machine whose `gh` says `ssh` but which
  holds no key still gets its project; `origin` and `Project.remoteUrl` then keep the URL
  that answered, so every later fetch and push takes that route. A git call that reaches a
  remote runs with no terminal prompt and with `ssh -o BatchMode=yes`, because a daemon has
  no terminal and a prompt is a command that hangs until its timeout.
- A covey session knows which thread it is: the daemon puts `COVEY_THREAD_ID` and
  `COVEY_PROJECT_ID` in the environment of every Claude session it starts. Pass the thread
  id back as `threadId` at `hello` and every thread and every run that connection creates
  is filed under it in the sidebar. Leave it out and the work lands beside the thread that
  asked for it, which is what made some agent threads nest and some stand alone.
- Timeline streaming re-sends whole items (same id, accumulated text); there is no delta
  channel. Keep it that way; it makes replay and reconnect trivial.
- A *chain* is the run of tool calls and thoughts the agent made between two things it
  said, and the transcript folds one into a row that says what it was for (#149). The
  daemon marks it: `ChainTracker` in `daemon/src/activity.ts` decides, `persistItem`
  writes `ItemBase.groupId` — the id of the chain's first item — and prose, a user
  message, a question and an approval close the chain and join none, because a reader
  must not lose one of those to a fold. A chain never spans two turns, and an item
  already on disk keeps the chain it was filed under or a streaming item would move
  between chains as it is re-sent. The sentence is `summariseActivity`, which is
  `title.ts` in another hat — one throwaway weak-model query, no tools, no settings
  files, `COVEY_ACTIVITY_MODEL=off` to turn it off — and it lands on the head item's
  `groupSummary` as an ordinary `item.upserted`. **Only the tool calls go to the model.**
  A thought folds away but its text is never read and never sent; keep it that way.
  Until the sentence lands, and for good when the model is off, the client paints
  `chainLabel`, which counts the calls rather than reading them.
  The fold itself is `timelineRows` in `@covey/client`: pure, node-tested, and read by
  the TUI and the web client both, so a chain starts and ends in the same place on a
  phone. Four levels (`Lod`: `minimal`, `compact`, `steps`, `full`), and `compact` is
  the default. The level is the *device's* preference and travels in no command —
  `prefs.lod` and ctrl+o in the TUI, `localStorage` and the Detail rows at the head of
  the settings page in the web client. The rows a reader changed are a `toggled` set,
  never a list of open rows, because at `full` a tap shuts a row. No two rows share a
  key: a chain's is `chain:<id>`, never its head item's own id, or one tap opens both.
- `/clear` empties the conversation and keeps the thread (#16). It is the first command
  covey answers itself, and `COVEY_COMMANDS` in `@covey/client` is the whole list — one
  list, because a command the TUI offers and the phone does not is a command the reader
  cannot find. `coveyCommand` takes the line out of each client's send path, and a covey
  command hides the SDK command of the same name: Claude Code's own `/clear` empties the
  model's context and leaves covey's transcript on the screen. The name has to stand
  alone, because none of these takes an argument. The daemon's half is `thread.clear`:
  the items, the live session and the transcript go, the `sessionId` is new so the next
  turn starts rather than resumes, and the thread keeps its worktree, its branch, its
  secrets and its pull request. The checkpoints stay — they name real git trees and the
  clear touches no file. **`lastMessageAt` is never reset**, or the thread falls to the
  bottom of its project; `startTurn` names a thread again from the title alone, because
  `titleIsAuto(t) && (firstMessage || t.title === "New thread")` is already satisfied by
  putting the title back — and only an *automatic* title goes back, because a name the
  reader typed is in no row and no undo gives it back. One `thread.cleared` event says it
  all, never an `item.removed` per item.
- Transcripts are keyed by thread id in the SDK session store on purpose (cwd-independent
  so threads can move between machines).
- A thread's session is a subprocess of about 250 MB. That figure is `Pss` and never `Rss`:
  about 100 MB of every process is the binary's own code pages, which every session on the
  machine shares, so `Rss` counts them once per process and reads eight sessions as most of a
  gigabyte more than they cost. The 300 MB covey assumed before was the `Rss` of a session
  with no sibling. The default ceiling is a quarter of the machine's memory at that figure,
  with a floor of two and nothing above — 31 sessions on a 31 GiB workstation, where the old
  cap of eight made the memory this rule reads decide nothing. The engine releases one after
  `sessionIdleMinutes` (default 120) and holds at most `maxLiveSessions`; the next message
  resumes it from the transcript. `maxLiveSessions` is what bounds the memory, so the idle
  timer only gives memory back under that ceiling — and it charges for it, because the
  resumed session that replaces a fresh one cannot refresh its own token (below). Measured
  over three days: 25 of the 31 released threads came back within two hours, which is the
  number. Never release a session that runs a turn, waits on an
  approval, or still owns a background task — `Engine.sessionBusy` decides, and a background
  task dies with its session. `/health` reports `sessions.live`. Both limits are rows on the
  machine control panel and on the web client's machine sheet. A `null` means "the daemon's
  default" and no client can name it — the ceiling is read from that machine's memory — so
  `MachineInfo.sessionBudget` carries the two resolved figures and what one session costs,
  and the panel prints the number behind the word. The choices are
  `client/src/sessionBudget.ts`, pure and read by both clients; keep a panel hint short, or
  `Overlay` truncates the label away to make room for it.
- Every session on a machine reads one credential store and then holds its access token in
  memory, so a refresh anywhere revokes what the others hold: `401 OAuth access token has
  been revoked`, and that process never recovers — an SDK session has no `/login`. A *resumed*
  session cannot refresh at all: the SDK copies the store into a temporary config directory
  without the refresh token, so at the token's expiry it dies with `401 OAuth access token
  has expired`, and a daemon that holds only resumed sessions has nothing that refreshes the
  store. The daemon never touches the token and never talks to the OAuth server; it makes
  Claude Code refresh, by running one fresh one-turn process against the real store
  (`auth.ts`, `refreshCredentials`), and only when the token is expired or about to be, or a
  session that read it failed — a refresh is the rotation that breaks the siblings, so never
  add one at another time. `credentialExpiry` reads when the token runs out, `auth.ts` tells
  this failure from a failure of the work, and the engine drops the session, cycles the idle
  ones, refreshes, and restarts the turn once (`authRecovery.test.ts`).
  `EXPIRY_MARGIN_MS` is five minutes because Claude Code refreshes inside
  `Date.now() + 300000 >= expiresAt` and nowhere else: ask earlier and it rotates nothing, so
  never widen that window to win more life. covey reads those last five minutes as gone — it
  releases a resumed session there rather than hand a reader the end of a token — and the
  sweep refreshes there *ahead* of a reader (`refreshAhead`), on the one condition that the
  daemon holds no live session at all. That condition is the whole safety of it: a rotation
  revokes every live token, so a busy turn would end and a fresh session, which refreshes for
  itself, would be revoked for nothing. Every refresh covey makes is a rotation, so
  `refreshStore` records the stamp it leaves, inside the promise the callers share, and
  `watchRotation` stands aside while one runs. Read that stamp anywhere else and the watch
  cycles the sessions holding the *new* token (#151). And a process that writes is a process
  covey never stops: `ClaudeSession.answering` is the second half of `busy`, because the CLI
  ends turns covey never started — a resumed session answers the background-task
  notifications it inherits, and covey reads that result as the end of its own turn.
- The CLI also *starts* work covey never asked for, and that work gets a turn of its own
  (#156). A background task reports, the agent reads files and writes prose, and
  `currentTurnId` is already `null` from the earlier result — so the first line the CLI
  writes opens a turn (`openUnpromptedTurn`, `SessionSink.onUnpromptedTurn`) and the next
  result ends it like any other. Without it 52 items landed under no turn, the `turns`
  table held no row for 34 minutes of real work, and the thread read idle while the agent
  wrote. The turn is marked, because a reader has to be told why a thread nobody wrote to
  is busy: `LatestTurn.unprompted` is the TUI's "a background task woke this" and the
  page's "background work". It takes no checkpoint and so reports no diff — a `before`
  tree read after the agent started would be a diff that is not one. And the tail of an
  interrupted turn opens nothing (`ClaudeSession.interrupted`), or esc would leave the
  thread running.
- The model picker is read from the Claude Code covey runs, not from a list covey ships:
  the daemon asks it (`packages/daemon/src/models.ts`, a query whose prompt never yields —
  no turn, no tokens, about 300 ms) and the answer rides on `MachineInfo.models`. The
  Claude Code covey runs is the one the Agent SDK ships, *not* the `claude` on the PATH:
  the SDK spawns its own binary unless `pathToClaudeCodeExecutable` is set and covey never
  sets it, and SDK `0.3.N` carries Claude Code `2.1.N`. So a new model reaches covey by
  bumping `@anthropic-ai/claude-agent-sdk` — which is the one package excused from the
  seven-day age rule, in pnpm-workspace.yaml and in `scripts/pkg-age.mjs` both. Never add a
  model to `KNOWN_MODELS`; that list is only the fallback for a daemon too old to send one.
  Store the id Claude Code gives, usually an alias (`sonnet`, `opus[1m]`), so a pinned
  thread follows the SDK; match a stored id on `resolved` too, because covey stored wire
  ids before this. A session that reports a new version makes the daemon read again.
- The daemon listens on port 3790 by default. `COVEY_PORT` moves it.
- A machine's control panel (enter on a sidebar machine row) makes the daemon pull, rebuild
  and restart itself (`packages/daemon/src/update.ts`). Restarting ends every turn that
  daemon is running — which may include the session you are in, if you are a covey thread.
  Try update/restart changes against a throwaway clone + daemon on another port, not 3790:
  `COVEY_PORT=3799 COVEY_HOME=/tmp/h COVEY_CONFIG=/tmp/c node packages/cli/dist/index.js`
  runs a complete second instance (client + daemon) that cannot touch the real one.
- Stop a throwaway daemon by port, never by pattern:
  `COVEY_HOME=/tmp/h node packages/cli/dist/index.js stop --port 3799`.
  Every daemon runs the same program, so `pkill -f "index.js daemon"` and
  `pkill -f "covey.*daemon"` also kill the daemon on 3790 — which may be the one that hosts
  you. `covey stop` signals one pid, taken from `/health` on that port or from
  `<COVEY_HOME>/daemon-<port>.pid`. To check first: `cat /tmp/h/daemon-3799.pid`.
- The client updates itself by quitting with a request the CLI performs (pull, build, restart
  the daemon) before `process.execve`ing back into the new build — see `packages/cli/src/main.ts`.
- A run's capability data is read *in the daemon* (`packages/daemon/src/resources.ts`), never
  over ssh: the daemon starts from a login shell, an ssh session does not, and an agent
  inherits the daemon's `PATH`. Keep it that way.
- A test that starts a daemon must start it with `packages/daemon/test/daemons.ts`,
  and the file must `after(stopAll)`. It unrefs the child so a daemon nobody stopped
  can never hold the runner open — that, not a slow test, is what hung a gate run
  for eleven minutes (#53). `--test-timeout` does not cover it: node bounds a test,
  not a process that lingers once the tests are over.
- Dependencies: `pnpm add <pkg>`; pnpm refuses versions younger than 7 days
  (`minimumReleaseAge` in pnpm-workspace.yaml). Keep `pnpm run check:age` green. Install
  scripts are blocked (`onlyBuiltDependencies: []`); never use npm in this repo.
- The same 7-day rule covers the crates in `desktop/`, but cargo cannot hold it yet:
  `registry.global-min-publish-age` and `resolver.incompatible-publish-age` are set in
  `desktop/.cargo/config.toml` and became stable only in Rust 1.100, so an older cargo warns
  that it ignores them and resolves whatever it likes. Until then `scripts/crate-age.mjs` is
  the only thing holding the rule — keep `pnpm run check:crate-age` green. After `cargo add`
  run `node scripts/crate-age.mjs refresh` to add the new publish dates to
  `desktop/crate-publish-times.json`, and `… pin` to get the `cargo update --precise` lines
  that put a young lockfile back. That file is a cache of immutable facts, which is why the
  check normally makes no network requests; asking crates.io for four hundred versions per
  push met its rate limit and turned clean crates into "lookup failed" violations. A crate
  the script cannot date counts as a violation, never as a pass. CI passes `--locked` to
  every cargo command so it never resolves a version the audit has not seen. Keep the two
  ignore warnings: they name the flag and say the rule waits on the toolchain.
- `packages/daemon/src/integrate/` reaches `gh` and `git` through one `GhHost`
  (`integrate/gh.ts`); everything else there is pure. Tests use `fakeHost`, so nothing
  merges and nothing opens a pull request during `pnpm test`. The read path calls
  `assertReadOnly` first, which throws on a `gh` command that can change a repository. The
  four writes, `mergePullRequest`, `createPullRequest`, `commentPullRequest` and
  `uploadAttachment`, exist on a host only when it was built with `allowMerge`,
  `allowCreate`, `allowComment` or `allowAttach`.
- A thread can take an issue (`thread.takeIssue`), open a pull request
  (`thread.openPullRequest`) and be watched (`Thread.watch`): the daemon that holds the
  branch polls the pull request and sends every checks verdict, review, comment and merge to
  the thread as a turn (`integrate/news.ts` decides what is news; `Engine.pollWatches` polls).
  Read the checks from the check runs, never from `mergeStateStatus`, and give every watch an
  end — `watch.test.ts` and `news.test.ts` hold the rules. The merge is the one end that
  sends no turn: the loop is over, so the only answer a turn could bring back is "it
  merged", and covey writes the news as a note (`describeArchive`, which carries the rest
  of the batch so a sign-off delivered by the same poll is not lost) and archives the
  thread. `MachineSettings.archiveOnMerge` turns it off and is on unless the machine says
  otherwise, so `null` reads as on. Archiving drops the session, so it waits for anything
  that session still owes — a turn, an approval, or a background task, which leaves no
  running turn behind and dies with the process (`ClaudeSession.owes`, the half of `busy`
  that outlives a turn, because the CLI clears its own bookkeeping after the result
  handler). A message nobody has answered stops it outright. Change `plugin/skills/covey/SKILL.md` with it: the
  agent's last turn is then the one before the merge. An engine test passes
  `EngineOptions.ghHost` so no test reaches GitHub. A watch's merge policy is `manual` unless
  the caller says `auto`; under `auto` the daemon merges only what `mergeReadiness` calls
  ready, and never under a running turn. A green check is not a merge, and the other half
  of the verdict is `mergeBlock`: a draft, a conflict, a base that has moved, a review the
  repository asks for, or GitHub's own `BLOCKED` all leave the merge button grey with
  every check passing, and a watch that said only "the checks passed" taught the agent to
  answer "ready to merge" about a pull request GitHub refuses. That block *is* part of the
  checks cursor's key, never a note beside it, because the base branch moves under a pass
  the thread has already heard.
  `maxRounds` bounds the *work* covey asks a thread for, and it never bounds the watch
  (#199). Two rules come out of that. A base that moved costs no round — `behind`, and the
  stale pass it is a sibling of, are the base's news and not the change's, and on a
  repository several covey threads land on they fire every few minutes, so every open pull
  request of 2026-10-02 spent two of its three rounds merging main and met the first real
  failure with nothing left. And a budget that *is* spent mutes the work rather than ending
  the watch: `splitForBudget` holds back what asks for work, which goes in the transcript as
  a note a person reads, and everything else — a review that signs off, a checks verdict
  with nothing to fix, the merge — still arrives as a turn, so an `auto` watch still merges.
  `PullRequestWatch.spentAt` records when covey stopped waking the thread. A `reviewer` watch
  is the one exception and still ends `blocked`: a review that may not read another push can
  never sign off, and the author would wait for a verdict that is not coming. `mergeStateStatus` is still never a checks verdict: GitHub
  answers `BLOCKED` while the checks run, so every reader of it here waits for them first.
  The base head is read on every poll under either policy — `isStale` refuses on doubt, so
  an unknown base made `PullRequestWatch.readiness` (#172) call every `manual` watch not
  ready, with a reason naming the base it could not read. An agent asks with `covey issue …` and `covey pr …`
  (`packages/cli/src/loop.ts`), and the `/covey` skill in `plugin/skills/covey/SKILL.md`
  tells it the loop. There are two (#191) and they differ in one step, whether the thread
  takes an issue: a number the user named takes the issue loop, and everything the user
  only described takes the no-issue loop, which files *nothing* — an issue opened and
  closed inside the minute by the same agent is a row no reader saw. The skill's
  frontmatter `description` is the whole of what a plugin puts in a session's context, so
  it names both loops or the model never loads the skill for work that has no number
  (`plugin.test.ts`). The daemon carries none of this: `Closes #N` goes on only
  `if (t.issue && …)`. `--attach F` on `covey pr open` and `covey pr comment` puts a video or
  an image on the pull request as a GitHub *user attachment*, the only kind that renders
  inline (`integrate/attach.ts` holds the rules; the route is undocumented and
  `uploadAttachment` fails closed on anything but 201, before the push). A video over 10 MB
  is refused unless the owner's plan reads as paid, and a `gh` token without the `user`
  scope cannot read the plan, so keep a demo video under 10 MB. The daemon hands `plugin/` to every session as a local plugin
  (`plugin.ts`); a personal skill in `~/.claude/skills` does not reach a resumed session,
  because the SDK resumes into a temporary `CLAUDE_CONFIG_DIR` that carries no skills.
  A body on its way to GitHub is unwrapped first (`integrate/reflow.ts`, #189): GitHub
  reads one newline inside a paragraph as a line break, and a model writes its prose
  wrapped at about eighty columns. The unwrap runs before `attachMedia`, never after,
  or the attachment URLs that go in one per line would be joined into the prose. It
  joins a run of lines only on the signature of a wrap — the widest line between 60 and
  120 columns, and every line but the last too long to hold the next line's first word —
  so a column of short lines, a column of paths and every fence, table, list and
  indented block stand. `gh issue create` is the agent's own call and gets none of it,
  which is why the skill asks for one line per paragraph as well.
  Change the CLI and the skill together. The plugin only *offers* the skill, and the
  model chose per turn whether to read it, so a thread that opened with "fix this bug"
  pushed with `git` and opened with `gh` and no watch ever started. `COVEY_PREAMBLE` in
  `plugin.ts` is what makes the loop the default: the engine sends it as
  `systemPrompt.append` beside the plugin, together or neither, because a note naming a
  skill the session cannot load is worse than no note. Keep it a pointer and not a copy
  of the skill — it rides on every turn of every thread, and the skill costs nothing
  until the model loads it — and keep the two rules a reader cannot undo in it, because
  the session reads the note before it decides to read the skill. The SDK records the
  rendered prompt at a conversation's first request, so an edit reaches a running thread
  only at its next compaction; a new thread takes it at once.
- Opening a pull request starts a **reviewer**: a second covey thread that reads the
  change, comments on the pull request, and signs off or asks for changes. Covey does
  not call the pull request ready and an `auto` watch does not merge until it signs off.
  A reviewer is a *thread*, not a mode — `origin.parentThreadId` nests it under its
  author, `Thread.reviewOf` is the link back, and the author's record is
  `PullRequestWatch.review` — so the sidebar, the watch, the archive and the transcript
  all come free. Its worktree is the branch *under review*: `newWorktree` takes a ref,
  and `trackBranch` sets the upstream to that branch, which makes `git pull` work and
  makes git itself refuse a push. The words go on the pull request and the verdict goes
  in the database, because a review thread writes from the author's own `gh` login and
  GitHub refuses an approval on your own pull request — so the sign-off can never be a
  GitHub review. `integrate/review.ts` is pure and owns the tagline (`from an automated
  covey review`), which covey writes and the reviewer never does, anchored to the start
  of a line so a comment that *quotes* a review is not read as one. `PullRequestWatch.role`
  splits what the two sides hear: the author owns the build and hears every checks verdict,
  the reviewer owns the code and hears the *push* and no checks at all. No thread hears a comment it wrote itself, and the proof is
  on the comment: covey signs every comment it posts with the id of the thread that wrote it
  (`integrate/sign.ts`), and the watch drops a comment carrying its own signature. Every
  thread of one pull request writes from one account, so no author login can tell them apart,
  and without this a reviewer was woken by its own review for ever. The marker is an HTML
  comment — nothing on GitHub — and covey's own markdown escapes it, so `itemBase` strips it
  from what a client shows and `quote` from what an agent is told. `WatchCursor.posted` is
  the second half and was the first attempt: a URL is a key only when GitHub lists one, and a
  cursor is a bounded list on the row, so it covered neither a comment GitHub listed with no
  URL nor a watch stopped and started again. It stays for a comment covey posted before it
  signed them, and is never the only guard.
  The review needs no watch event of its own: it is a `mergeBlock` under the code
  `unreviewed`, so the checks verdict is keyed on it and the pass is re-delivered the moment
  the review signs off. It is the one block that is covey's refusal and not GitHub's, which
  is what `blockLead` is for, and it costs no round because no push makes a reviewer finish
  sooner. `mergeReadiness` and `mergeBlock` both read the review last, after every fact
  GitHub reported. A reviewer that ends with no verdict is reported to the author by the
  daemon and not by a poll, because there is no artefact to read it from. A reviewer is **not
  painted**: `Thread.hidden`, read only through `threadIsHidden`, whose third term is the
  whole safety of it — a hidden thread that needs a person is never hidden, or a reviewer
  blocked on an approval would hang the pull request for ever off the screen. The switch is
  the device's (`prefs.showHidden`, `localStorage`, `AsyncStorage` on the phone), and the
  hiding goes where the lists are built (`liveThreads`, `projectRows`) so the counts hide what
  the rows hide. All three clients offer the switch and `hiddenPanel` in
  `client/src/hidden.ts` owns its two sentences — in `client`, because the TUI cannot import
  `web`, and over plain threads, because each client keeps its machines in a shape of its own.
  Three copies is what it was, and they had drifted: "2 automated reviews hidden" on one
  screen and "2 hidden now" on another, about the same two threads. Because the
  reviewers are invisible the thread under review must say so, or it reads as stalled:
  `threadReviewing` counts them and the TUI paints `⊙` (a glyph, like `AGENT_MARK`), while the
  web says it in `threadStatusLabel`, which answered `idle` for the whole review before; one that signed off is archived by covey itself and
  is never a drop.
  **A reviewer is archived through `archiveWhenIdle` and never through a plain
  `thread.archive`.** `covey review approve` runs from inside the reviewer's own turn, so the
  thread is busy at the one moment it decides and a direct archive is refused as `busy` —
  which is how ten reviewers of one afternoon stayed on the sidebar, each with a warning note
  nobody reads and nothing left to wake it. For the same reason `windUpReviewers` archives
  *every* live reviewer of a thread being put away, whatever its verdict: the seat says what
  the review decided and never whether the thread went, so `reviewing` is not the test for
  "still on the screen". And because `archivePending` is memory only,
  `Engine.sweepFinishedReviewers` repairs the rest at start, beside "anything that was running
  when we last exited is now idle". **A `dropped` seat is the one it leaves.** Most of what
  writes `dropped` — `windUpReviewers`, `dropReviewer` — belongs to a thread archived or
  deleted in the same breath, so the sweep never meets one. What it does meet is the three ends
  of a reviewer's own watch, and two of those keep the thread on purpose: a reviewer out
  of rounds, whose watch ends `blocked` and whose worktree stays on the branch so the person
  covey asked for has the half-finished review and the code together; and a merge on a machine
  with `archiveOnMerge` off, which asked for its threads to be kept. The third is a closed pull
  request, and **the close archives its own reviewer** where it happens, after the news, the
  way the merge branch above it does — a reviewer left there sits hidden on a branch nothing
  will look at again, and unlike a spent budget there is nobody coming to read it. The sweep
  names the close as well, from the reviewer's *own* watch rather than the seat, because that
  archive waits for a turn and a restart inside it loses the archive exactly as a restart
  inside a sign-off does; `blocked`, `merged` and `closed` are what tell those three apart, and
  the seat cannot.
  Change `packages/cli/src/loop.ts` and the `/covey` skill together, as
  with the loop and `covey env`.
- A project holds an environment and a thread may hold its own on top (#126): the daemon
  merges the two into `options.env` of the Claude session, so a tool call reads `$STRIPE_KEY`
  like `$PATH`. `e` on a sidebar row is the editor, and a project's panel writes to every
  machine of the pool. A value lives in the `secrets` table of the daemon's database and goes
  nowhere else: a command carries one in, an event carries only the names
  (`Project.secretKeys`, `Thread.secretKeys`), and `secrets.env` — the one call that answers
  with a value — is refused off loopback, which is why `server.ts` passes `handleConnection`
  a flag it worked out rather than one a client declared. Every timeline item and every
  transcript line goes through `redact.ts` first, so a `printenv` writes `[secret NAME]`;
  keep it that way, and keep the eight-character floor, or a short value rewrites ordinary
  prose. Never let a secret take a name covey sets (`secretKeyError`): a thread that could
  rewrite `COVEY_THREAD_ID` would file its work under another thread. The agent reads
  `covey env`, which prints names; `packages/cli/src/env.ts` and the `/covey` skill are one
  change, like the loop.
- An issue or a pull request is a screen in the web client (#108): a `#N` in the transcript,
  or a chip in the header of the open thread, opens it, and the bar under it reviews,
  comments, merges, closes or reopens. In the thread list the chips are text and the row is
  one target (#115): a thumb aimed at the row used to hit the chip. Hold a row there and the
  conversation's sheet comes up, and its first rows name each item in full (`threadSheetRows`,
  `viewRowNumber`). `attachSwipe` in `render.ts` owns the hold and the drag, and each cancels
  the other. `github.item` reads it and `github.act` acts, each act on a `GhHost`
  built for that one write (`allowReview`, `allowClose`, `allowComment`, `allowMerge`), so
  `pnpm test` still changes nothing on GitHub (`githubItem.test.ts`). The TUI has no such
  screen: `links.ts` makes a `#N` an OSC 8 hyperlink when the project is on GitHub, and
  the palette opens the issue or the pull request in the browser. The gesture is
  `cmd+click`, and covey never sees it: a mouse report has a bit for alt and one for
  ctrl and none for cmd, so the terminal itself opens the hyperlink. covey only names
  the gesture (`openGesture`, in the help overlay and in the notice a plain click on a
  link raises) and keeps `alt+click` as its own route for a terminal without OSC 8.
  Never make a plain click open a link; a plain click selects text.
- A setting in the web client is a sheet at the foot of the page (#117). The `⋮`
  in the conversation nav bar opens that thread's model, permission mode,
  streaming, rename and archive, and a hold on its row in the list opens the same
  sheet (#115); the `⋮` on a machine card on the settings page
  opens that machine's defaults. `state.ts` holds what a sheet says
  (`sheetRows`, `sheetChoices`, `sheetNote`) and node tests it; `render.ts`
  paints it and `main.ts` maps one choice to one command (`sheetCommand`).
  The sheet is rebuilt only when `sheetKey` changes, because a paint runs on
  every frame of a turn and a panel rebuilt under a finger loses the tap. The
  machine that serves the page is not offered the web server row: to turn it
  off there is to close the page.
- Media in the web client is inline (#110): `markdown.ts` writes an `<img>` or a `<video>`
  and the style sheet caps it at 40% of the screen; a tap on an image opens it full size.
  That picture is a *layer on the route*, `#/t/<machine>/<thread>/media` (#167), because
  the phone's back control and the swipe from the edge are the same gesture as the one
  that leaves a screen — and a picture outside the route meant one gesture shut nothing
  and skipped a level. The hash says *that* a picture is open and never *which*: the
  source carries that machine's token, and `readToken` takes the token out of the address
  bar on the first load, so naming the picture would write it into the browser's history.
  `routeOf` reads the whole hash first and only then strips the suffix, or a conversation
  whose id is `media` would come out as a layer over nothing. A route that names a picture
  covey does not hold — a reload, a pasted URL — is replaced by the screen it was over.
  Every close runs through that one route change: the tap, `esc`, the in-page control, and
  the browser's own. Never shut a layer by clearing the state alone; the entry would
  outlive it and the next back would be a press that did nothing. The settings sheet is
  *not* a layer yet and has the same bug — it has pages of its own, so back inside it
  means more than one thing.
  A GitHub user attachment loads through `GET /media?url=…` on the daemon (`media.ts`):
  GitHub answers 404 without the account's token and a five-minute signed redirect with
  it, and the daemon forwards that redirect with the `gh` token. The route is gated like
  the socket, refuses every host but GitHub's two, and is on only with the web client.
