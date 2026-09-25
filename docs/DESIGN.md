# covey design

## Goals

1. A TUI with projects on the left, threads under them, and many agents at once.
2. Claude Code via the official Agent SDK today; room for other providers later.
3. Tailscale as the primary remote story, with explicit machine selection.
4. Threads can move between machines.
5. Linux and macOS now, Windows later: Node only, no native modules.

## The rules the design follows

Server and protocol:

- Clients are command-in / event-out. Every command carries a client-minted `commandId`;
  the daemon keeps receipts so retries are idempotent.
- Every subscription starts with a snapshot, replays events after a client-supplied `seq`,
  then emits `synchronized`. Reconnects are gap-filling, not full refetches.
- Shell vs detail split: the sidebar subscribes to a light projection of all threads; only
  the open thread pays for message bodies.
- Session ids are minted by the client before the first turn, so the thread ↔ SDK session
  mapping exists before the SDK replies.
- Approvals are durable timeline items, not in-flight RPC state. `canUseTool` parks on a
  promise that a later `approval.respond` command resolves.
- Capability flags on `MachineInfo` instead of version sniffing.
- `MachineInfo.build` reports the daemon's commit and its commit date. The client compares
  it with its own to show which machines run older code. Nothing branches on it: what a
  daemon can do is still a capability flag, and the field is optional so an older daemon
  stays legal.

TUI:

- Palette discipline: three text tiers over a near-black ground, one accent, one colour per
  state. Only the composer has a box border. Tool calls are single lines.
- Three kinds of message, told apart by where they sit before they are read. The agent's
  prose runs the width of the pane. The reader's own words are a tinted block against the
  *right* edge, hugging their longest line — "yes" is a small block, not a bar. A message
  covey wrote itself — the news from a watched pull request — keeps the left edge, takes a
  ground of its own, and carries a rail and the word `covey`, because two near-black
  grounds are one colour on a terminal that has 256 of them.
- Eight themes, picked in this client's own settings panel. See *The machine control panel*.
- Pulsing status dots on threads; a collapsed project shows an aggregate dot.
- Per-thread composer drafts, XDG paths on Linux.

What we deliberately did **not** do:

- The "threads never move between machines" rule that comparable clients apply (see below).
- A refetch of the whole read model on every event, and an unvirtualised transcript. The TUI
  applies events incrementally and renders only visible lines.
- Effect-TS, event sourcing with projectors, and the ~150-method RPC surface. This is a
  from-scratch tool; the wire protocol is 17 methods and two event streams.

## Renderer choice: Ink, not OpenTUI

OpenTUI is the obvious alternative, but it needs Bun or Node ≥ 26.4 and ships native Zig
binaries per platform. The goals say Node, cross-platform, and light. Ink 7 is pure JavaScript,
runs on Node 22+, and is what Claude Code itself is built on. The cost is that Ink has no
scroll container, no native markdown/diff widgets, and paints nothing under absolutely
positioned boxes. We handle that by:

- rendering timeline items to styled lines in pure code (`packages/tui/src/lines.ts`), so the
  transcript is a virtualised window over a line array with exact scrolling;
- anchoring that window to the line under its top row while a reply streams
  (`packages/tui/src/scroll.ts`), so the transcript growing at the bottom does not move it;
- rendering overlays in place of the transcript rather than floating them;
- a small markdown-lite formatter (fences, headers, bullets, inline code, bold).

If the look ever becomes the priority over portability, the store/client/protocol layers are
renderer-agnostic and an OpenTUI front end could replace `components/`.

## Processes

```
  ┌──────────── machine A ────────────┐        ┌──────────── machine B ────────────┐
  │ covey (TUI)  ──ws──▶ coveyd ──▶ claude │        │            coveyd ──▶ claude       │
  │                        │ sqlite  │        │              │ sqlite             │
  └────────────────────────┼─────────┘        └──────────────┼────────────────────┘
                           └───────── tailnet ws ────────────┘
```

- **Daemon** (`packages/daemon`): one per machine, long-lived, owns the SQLite db and the
  Claude subprocesses. The TUI can come and go; turns keep running.
- **TUI** (`packages/tui`): connects to N daemons. One `MachineClient` per daemon owns the
  reconnect loop, the shell subscription and at most one thread subscription.
- **CLI** (`packages/cli`): `covey` opens the TUI and spawns a detached local daemon if the
  health check fails.
- **Client** (`packages/client`): the one `MachineClient`. It owns the reconnect loop, the
  shell subscription and at most one thread subscription. It runs in node and in a browser,
  so the TUI and the web client speak to a daemon through the same code.
- **Web** (`packages/web`): the phone's client. The daemon serves it; see below.

## Persistence

`node:sqlite` (bundled with Node 22.5+), WAL mode. Tables: `projects`, `threads`, `items`
(timeline), `shell_events` and `thread_events` (bounded replay logs with `seq`),
`command_receipts`, and `transcripts`.

`transcripts` is the interesting one: it is an SDK `SessionStore`. The SDK mirrors every
JSONL transcript line into it after its own local write, and on `resume` it calls `load()`
and materialises a temporary JSONL for the subprocess. We key transcripts by **thread id**,
not by the SDK's default cwd-derived key, so the key is identical on every machine.

## Driving Claude

`packages/daemon/src/claude.ts`. One `query()` per thread with a streaming input iterable,
so successive turns reuse the subprocess. Options that matter:

- `includePartialMessages`: **always true**, because the SDK takes it at start time only.
  What each thread sees is decided in the daemon by `Thread.streaming`, which
  `thread.setStreaming` moves at any time — mid-turn included, with no restart. The palette
  holds the per-thread switch and the machine control panel holds the default for new
  threads (`machine.settings.defaultStreaming`, seeded by `COVEY_STREAM=1`).
  With streaming **off** the `stream_event` case drops everything but the `message_start`
  reset, so replies land whole, item ids come from the API message id (a replayed `assistant`
  message cannot duplicate rows), and the transcript shows a live activity row (spinner,
  elapsed, tool count, and whether the model runs a tool or writes text) so the wait is
  legible. With streaming **on** the deltas fold into the same item id and are re-sent with
  accumulated text (throttled to ~60 ms), and the final `assistant` message reconciles the
  blocks authoritatively. The whole-item re-send contract is the same either way — there is
  still no delta channel.
- `sessionId` on first start, `resume` afterwards (decided by whether a transcript exists).
- `canUseTool`: creates an `approval` item (or a `question` item for `AskUserQuestion`),
  sets thread status to `waiting`, and awaits the user's command. "Always allow" returns the
  SDK's own `suggestions` as `updatedPermissions`. For `AskUserQuestion` the original tool
  input is kept on the pending record and passed back untouched: `updatedInput` is validated
  against the tool's own schema, which requires at least one question, so it cannot be
  rebuilt from our timeline item. The answer goes in `answers` (keyed by question text), or
  in `response` when the user typed something other than one of the offered options.
- `allowDangerouslySkipPermissions` is always `true`. It is a start-time-only consent flag,
  not an override — the SDK refuses to select `bypassPermissions` without it, so deriving it
  from the initial mode would make a live session started in `default` impossible to switch.
  Behaviour is governed entirely by `permissionMode`, which we can change at runtime.
- New threads take their permission mode from the user's own settings
  (`permissions.defaultMode`, user → project → local). The SDK does *not* apply that itself:
  omitting the `permissionMode` option yields `default` no matter what settings say, so
  without this a user configured for `bypassPermissions` would still be prompted for
  everything. An explicit choice (shift+tab, or the palette) wins and is remembered as the
  default for subsequent threads.
- `settingSources: ["user","project","local"]` and the `claude_code` system prompt preset, so
  the user's CLAUDE.md, hooks and MCP config apply exactly as in the CLI.
- Tool results arrive as `user` messages with `tool_result` blocks and are joined to the tool
  item by `tool_use_id`.

## Session lifetime

A live session is a CLI subprocess that costs 270-390 MB of resident memory (measured on
macOS with SDK 0.3.265). Before this rule existed a session lived from the first turn of a
thread until the user stopped it by hand, so a machine that had run a dozen threads held
gigabytes for conversations nobody was reading, and the machine went into swap.

The engine therefore releases a session that nobody needs. Two rules, in this order:

1. **The timer.** A thread idle longer than `MachineSettings.sessionIdleMinutes`
   (default 120) loses its session. Idle means no command about that thread and no line from
   the agent.
2. **The budget.** While more sessions are live than `MachineSettings.maxLiveSessions`
   allows, the least recently used ones go. The default comes from the machine's own memory:
   15% of it at 300 MB a session, and never fewer than two nor more than eight. The budget is
   a target, not a promise — a machine with more turns in flight than memory keeps every
   running turn.

A session is never released while it owes somebody an answer: a turn in flight, a tool
approval on screen, a question in front of the user, or a background task that still runs. A
thread that waits on an approval is idle by status, and the answer needs the same process, so
status alone cannot decide this. `ClaudeSession.busy` reports what the process itself is doing
and the thread row is read beside it.

A background task is the case the thread row cannot show at all. `run_in_background` and
ctrl+b end the turn and leave the work running, so the status says idle while a build runs.
The work is a child of the session subprocess and only that subprocess reads the
`task_notification` that ends it. Measured against a live daemon: a `sleep 100` handed to the
background died with the released session, its output file was never written, and the tool row
still read "running in the background" five minutes later. So a live background task holds its
session, and a task that never reports holds it for ever — 300 MB costs less than the build.

Nothing is lost. The transcript lives in the session store, keyed by thread id, so the next
message starts a new process with `resume` and the model reads the whole conversation back.
Measured: a resume costs about 0.3 s of start time on a 458 KB transcript, against 5 ms for a
process that is already up.

The two rules are not the same rule with two numbers, and the timer is the one that has to
justify itself. The budget is what bounds the memory: it releases a session as soon as the
machine holds more than it allows, whatever the timer says. So the timer only gives memory
back *under* that ceiling, and the section below is the price it pays for it — a session
covey starts fresh refreshes its own token and can live all day, and the resumed session that
replaces it holds a token it cannot replace and dies at that token's expiry. An idle release
therefore trades a session that would have lived for one with a deadline.

Two hours, because that is what the threads do. Measured over three days on one machine: of
the 31 idle releases whose thread spoke again, 25 spoke again within two hours, and the 6 that
did not came back after three hours or more. A limit of two hours keeps the session across the
pause a person takes — a build, a review, a meeting — and still releases the thread that was
left for the day. Fifteen minutes, the limit before this one, released a session 19 times in
those three days for a thread that came back inside the hour.

Both events are visible. The thread gets a note when its session goes, and another when a
turn starts one again, so a slow first reply reads as a resume rather than as a thread that
hangs. The daemon logs both lines, and `/health` reports `sessions: { live, limit,
idleMinutes }` — the number to compare a `ps` list against when a machine holds more `claude`
processes than this daemon started.

`COVEY_SESSION_IDLE_MINUTES` and `COVEY_MAX_LIVE_SESSIONS` seed the two settings for a machine
whose `daemon.json` says nothing. `sessionIdleMinutes: 0` keeps every session for ever. Both
limits are also rows on the machine control panel and on the web client's machine sheet, so
changing one needs neither an ssh session nor a restart — see *The machine control panel*.

## Credentials, and the 401 that follows a rotation or an expiry

Every session on a machine reads one credential store, and then holds its access token in its
own memory. The token lives about eight hours. Whichever process refreshes it first receives a
new pair, and the server revokes the old one. Every other live session now holds a token the
API refuses:

```
Failed to authenticate. API Error: 401 OAuth access token has been revoked.
```

Measured on 2026-09-18 against a daemon with six live sessions: the store changed at 21:09:20,
a session that started at 20:52 failed at 21:17, and a new process on the same credentials
answered at once. The process cannot recover. An SDK session has no terminal, so `/login`
answers `isn't available in this environment`, and every later message to that process fails
the same way — a thread where even a bare `ping` returns the 401.

A resumed session cannot refresh at all. The SDK resumes from covey's store by writing a
temporary config directory and copying the credentials into it, and the copy carries the
access token and **no refresh token** (`wnt` in `sdk.mjs` deletes it; measured on 2026-09-22
on six such copies in `/tmp/claude-resume-*`). So a resumed session dies when the access token
expires, whatever else happens:

```
Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.
```

A daemon that has run for a day holds only resumed sessions, so nothing on the machine
refreshes the store. Every new session copies the same expired token and fails the same way,
and every thread on the machine is stuck until a person runs `claude` by hand. That is what a
thread looked like on 2026-09-21: a merge landed, the next turn failed on `expired`, the
restart failed on `expired`, and the note said to log in, on a machine whose login was fine.

The daemon does not refresh the token itself, and never talks to the OAuth server. It asks
Claude Code to, in `auth.ts` and the engine.

1. **It knows this failure from a failure of the work.** The error text must name the
   credential *and* say that the credential was refused. `401` alone is a page a tool fetched,
   and `invalid` alone is most of what a model ever gets told.
2. **It knows when the token runs out, and it reads the last five minutes as gone.**
   `credentialExpiry` reads `expiresAt` out of the store: one number from `.credentials.json`,
   or from the keychain item on macOS, read the way the SDK itself reads it at every resume. A
   resumed session is recorded with the expiry of the token it copied. The sweep stops such a
   session once the token is inside the window, before a user types into it, and a message to
   one starts a new process instead.

   The window is `EXPIRY_MARGIN_MS`, and it is not a number covey chose. Claude Code refreshes
   the store when, and only when, `Date.now() + 300000 >= expiresAt` — read out of the Claude
   Code the SDK ships, 2.1.280. Ask earlier and the process answers without rotating anything;
   ask later and the token is already dead. So five minutes is both the soonest a refresh can
   be had and the least life worth giving a session that cannot refresh, and it moves only
   when that number in Claude Code moves.
3. **It refreshes before a session copies a dead token.** Before a process starts, the engine
   reads the expiry. When the token is inside the window, or when a session that read the
   store as it is now has failed on the credentials, `refreshCredentials` runs one fresh
   one-turn Claude Code process against the real store — no resume, no temporary directory, no
   tools, no transcript, one word from the cheapest model. That process holds the refresh
   token, refreshes the pair, and saves it where every later session reads it, exactly as
   under `claude -p`. Ten threads that fail at once wait on one refresh.
4. **It refreshes ahead of the expiry, when that costs nobody anything.** A refresh takes a
   process and a second or two, and left to rule 3 that wait lands on whoever types first
   after the token runs out. So the sweep does it instead (`refreshAhead`), on one condition:
   the daemon holds **no live session at all**. A refresh is a rotation and a rotation revokes
   what every live session holds, which covers the two cases covey must never break — a busy
   session, whose turn the rotation would end, and a session covey started fresh, which reads
   the real store and refreshes for itself and would be revoked for nothing. By then the
   resumed sessions are already gone: rule 2 ran first, and the window that makes a refresh
   due is the window that makes their copy spent. A refresh ahead of the expiry that fails is
   a line in the log and is not tried again for half an hour, because a dead refresh token
   fails every time and must not become a process every thirty seconds.
5. **It stops the processes that hold the dead token.** The thread that failed loses its
   session at once. Every session that owes nobody an answer goes with it, because they hold
   the same token. A busy session stays: to kill a turn in flight costs more than the failure
   it saves, and that turn arrives here by itself if its own token is dead.
6. **It restarts the work, once, on the refreshed store.** A turn that had already written
   something gets `Go on from the point where it stopped`, because the transcript holds that
   work. A turn that died before its first word is sent again word for word, because "go on"
   means nothing to a model that never started. The second failure in a row is a note that
   names `claude auth login`, not a third process — a thread must not talk to itself while the
   credentials stay broken.

A refresh that fails on the credentials is a dead refresh token — a logout, a revocation, or
the end of its own life — and only `claude auth login` mends it. The note says so, and no
process starts, because one started now would fail the same way. A refresh that fails on the
network or on the model lets the session start anyway: Claude Code saves a refreshed pair
before it asks the model, so the store may well be fresh, and a token that is not fails on its
own and lands in the path above.

The sweep timer also reads a fingerprint of the credential store: the `mdat` attribute of the
macOS keychain item, or the size and time of `~/.claude/.credentials.json`. A fingerprint that
changed means a rotation, and the idle sessions then go before anybody types into them. The
attribute needs no keychain prompt and costs about 40 ms. The macOS item holds the MCP tokens
beside the account token, so an MCP login cycles the idle sessions too; that costs one resume.
A store this daemon cannot read gives `null`, the watch stays off, and the failure path above
still catches the fault.

One credential ends the race for good. `claude setup-token` issues a long-lived token, and a
daemon started with that token in `CLAUDE_CODE_OAUTH_TOKEN` never refreshes and never rotates.
That is a choice for the user, not a default: covey runs on whatever credentials Claude Code
itself runs on, and it keeps no token of its own.

## Remote access and auth

The daemon binds to the tailnet IPv4 by default (plus loopback), never `0.0.0.0` unless
asked. On WebSocket upgrade:

1. loopback → accept;
2. `?token=` or bearer matching the daemon's generated token → accept (non-Tailscale path);
3. source is a CGNAT/tailnet address → `tailscale whois --json <ip>`; accept iff the peer's
   Tailscale user id equals the daemon host's own user id.

`whois` runs through the CLI (with macOS App Store and Homebrew paths tried) so the same code
works on every OS; results are cached for a minute. Tailscale ACLs remain the outer wall.

## The web client

The TUI is the tool at a desk. On a phone a person wants less: which threads are busy, what
an agent said, an approval to answer, one new idea to type. `packages/web` is that, and the
daemon serves it beside `/health`, so a machine that runs covey already runs the page.

- **One machine serves it, and the control panel says which.** `MachineSettings.webEnabled`
  turns the routes on and off while the daemon runs; a daemon says no with a line that
  names the panel. A phone keeps one address, so the TUI's `setWebServer` stops the client
  on every other connected machine before it starts one, and names a machine it could not
  reach rather than pretend. `COVEY_WEB=1` seeds a daemon that has no TUI to turn it on.
- **The daemon serves files, and the WebSocket stays the one gate.** `web.ts` maps four URL
  prefixes to four directories and nothing else: `/` and `/static/*` to the page and its
  style, `/app/*` to the page's own modules, `/lib/protocol/*` and `/lib/client/*` to the
  two packages the page imports. The files carry no secret, so anyone the listener can hear
  may read them. Auth happens when the page dials `ws://` on its own origin, through the
  policy above: a tailnet phone passes `whois`, a LAN phone carries `?token=` on the page
  URL one time and the page keeps it in local storage.
- **The token moves between addresses by a tap, not by itself.** Local storage is per
  origin, and browsers partition what a cross-site frame can store, so the tailnet page
  cannot write the token into the LAN address for the reader. Instead `machine.access`
  hands any accepted connection the token and every address the daemon has
  (`addresses.ts`, which `covey info` prints too), and the gear on the page lists them as
  links that carry the token. A tailnet peer may hold the token because `whois` already
  says it is the owner; a loopback or token client holds it already.
- **No bundler.** `tsc -b` writes browser ES modules into `packages/web/dist`, and an import
  map in `index.html` turns `@covey/protocol` and `@covey/client` into URLs. The daemon test
  for the route fetches every module the page names and checks that each import is either
  relative or in the map, because a bare specifier the map does not know fails only in a
  browser.
- **One fold, no framework.** `state.ts` folds shell and thread events the way the TUI store
  does — whole items under stable ids — and node tests it. `render.ts` paints with plain DOM:
  the list is rebuilt per paint, the open thread keeps its skeleton because the composer
  holds the reader's text and keyboard, and each timeline row is keyed by item id and
  rebuilt only when the daemon re-sent that item. Events schedule one paint per animation
  frame, never a paint per event.
- **The `/` menu is a popover.** A draft that starts a command name opens a list over the
  bottom of the timeline, filtered on every keystroke; a tap or enter takes a row, the arrows
  move on a keyboard, escape shuts it until the name changes. The TUI draws the same list
  above its composer, because Ink cannot paint over the transcript, and both rank it with
  `commandMenu` in `@covey/client`, so the phone and the desk agree on what `/co` offers.
- **A phone sleeps.** The socket drops, the client dials its budget out and goes offline. When
  the page becomes visible again it retries, and the subscriptions resume from the seq the
  page holds, so what it missed is replayed rather than refetched.
- **Where a daemon listens is a setting, not only a flag.** `machine.settings { bind }`
  moves the listeners while the daemon runs: `main.ts` closes them and opens new ones
  through `EngineOptions.rebind`, and a bind that fails brings the old ones back before
  the error reaches the caller. The socket that asked stays open, because an upgraded
  connection is no longer the http server's to close; the daemon test proves both. A
  `--bind` flag still wins at start and is never written, so what the machine reports is
  where it listens, not what the file says.
- **The page dials the fleet.** A daemon holds no list of the others; the TUI does. So
  `store.fleetFor` builds the list for the machine that serves the page — every other
  machine, with a URL the phone can reach (a loopback entry becomes the machine's tailnet
  name), the server itself left out — and sends it as `machine.fleet` when the web server
  starts there, when the machine list changes, and on every reconnect. The daemon keeps it
  in `daemon.json` and hands it back in `machine.access`. The page dials each member the
  way the TUI does, one `MachineClient` per machine, and groups projects across machines by
  repository the way the sidebar does. A machine that is down is a line on the settings
  page, not a banner: the banner speaks for the page's own connection alone.
- **An issue or a pull request is a screen (#108).** A thread row and the thread header
  carry the issue the thread took and the pull request it opened as chips, and every `#N`
  in the transcript is a link. A tap puts the item on screen over the thread or the list:
  the state, the branch and the base, the checks as the gate folds them, the reviews, the
  comments, the body, and the thread that holds it. The bar under it does the standard
  acts: approve, request changes, comment, merge with a chosen method, close, reopen. The
  URL names it, `#/gh/<machine>/<project>/<number>`, so back and reload work. The daemon
  of that machine reads it with `github.item` and acts with `github.act`, each act on a
  host built for that one write (see *The loop*). The TUI has no such screen: a `#N`
  there is an OSC 8 hyperlink to GitHub, `cmd+click` opens it in the browser, and the
  palette opens the thread's own issue or pull request. The gesture is the terminal's,
  not covey's: a mouse report carries a bit for alt and one for ctrl and none for cmd,
  and a macOS terminal keeps cmd for itself, so covey never sees that click. A plain
  click therefore keeps selecting text and names the gesture in the status line
  (`openGesture`), and `alt+click` stays as covey's own route for a terminal that knows
  no OSC 8.
- **Media is inline, and a private attachment loads (#110).** `markdown.ts` makes an
  `![name](url)` and GitHub's own `<img src>` an image, and a video URL or a bare user
  attachment on a line of its own a video with its controls; the style sheet caps both at
  40% of the screen, and a tap on an image opens it full size over the page. GitHub serves
  `github.com/user-attachments/assets/<id>` only to a request with the account's token:
  404 without one, 302 to a signed link on its store with one, good for five minutes and
  then served to anyone. A phone's browser holds no GitHub token, and the daemon holds one
  through `gh`. So an attachment loads from `GET /media?url=…` on the page's own origin:
  the daemon authenticates the request the way it does the socket, refuses any host but
  the two GitHub uses (`media.ts`, `mediaTarget`), asks GitHub with the token, and answers
  the phone with the same redirect. The bytes never pass through the daemon, a range
  request for a video goes straight to the store, and the browser keeps the answer for
  four minutes. The route is on only with the web client. A LAN page puts its token on
  the media URL; a tailnet or loopback page needs none.
- **Not yet:** runs, moving threads, attachments, and push notifications. The last needs a service worker, which needs a secure context, which
  `http://100.x.y.z` is not; `tailscale serve` can front the daemon with HTTPS later.

## Moving a thread between machines

Comparable clients forbid this. With the SDK's pluggable session store it is a data copy:

1. TUI asks source daemon for `thread.export`: thread row, timeline items, and every
   transcript subpath (main + subagents). Refused while a turn is running.
2. TUI hands the export to the destination daemon's `thread.import`, with a project id when
   the operator picked one. Otherwise the daemon uses its project for the same repository,
   and makes one — a clone — when it has none. Transcript `cwd` fields are rewritten to the
   thread's new worktree.
3. TUI calls `thread.markMoved` on the source; the old row becomes a tombstone pointing at the
   new machine + thread id and rejects further turns.
4. The next turn on the destination resumes via `SessionStore.load()`. Verified: the resumed
   session recalls earlier tool calls and reports its new working directory.

The client brokers the transfer, so daemons never need to authenticate to each other.

## Protocol

`packages/protocol/src/index.ts`. JSON over one WebSocket. Requests `{id, method, params}`,
responses `{id, ok, result|error}`, pushes `{push, subscriptionId, event}`. Methods: `hello`,
`shell.snapshot/subscribe`, `thread.snapshot/subscribe`, `unsubscribe`, `command`,
`thread.export/import/markMoved`, `models.list`, `project.git`, `turn.diff`,
`machine.source/update/restart`, `run.issues/pullRequest`,
`run.gate/memberDiff/queue/merge/audit`, `thread.openPullRequest`,
`thread.commentPullRequest`, `github.item/act`, `secrets.list/env`.

## Secrets: an environment the agent uses and never reads

An agent needs credentials to do real work. Paste one into the composer and it is in the
transcript, in the database, in every export, and in the context of every later turn. So
covey holds the value and hands the agent the name (#126).

A **project** holds a set of names and values. A **thread** may hold its own, which hide the
project's names of the same spelling. `e` on a sidebar row opens the editor: the project row
for every thread of the project, the thread row for one thread. The value is typed masked and
is never painted again — there is nothing to paint it from, because no client keeps one.

A value goes to three places and no others:

1. **The environment of the Claude session.** `Engine.startSession` merges the two scopes and
   hands them to `ClaudeSession`, which puts them in `options.env`. A tool call reads
   `$STRIPE_KEY` the way it reads `$PATH`. A secret may not take a name covey sets itself or
   the session needs (`secretKeyError`): `PATH`, `HOME`, anything starting with `COVEY_`.
2. **The redactor** (`redact.ts`). Every timeline item and every transcript line the daemon
   stores passes through it first, and a value it finds becomes `[secret NAME]`. That covers
   a stray `printenv`, a script that echoes its own command line, a library that logs the
   header it sent. A value under eight characters is left alone: a short string turns up by
   chance, and replacing every one of them would cost the reader more than it protects. The
   SDK's own transcript is redacted too, because that is what a resumed session reads back.
3. **`covey env exec`**, over loopback. `secrets.env` is the one call that answers with a
   value and the one a token does not open — the server allows it on a loopback connection
   alone, which is the only fact about a connection the daemon works out for itself.

`covey env` lists the names and where each comes from. That is what the agent reads, and the
`/covey` skill tells it so. Setting a secret releases the thread's session if it is idle, so
the next turn starts with the new environment; a session in the middle of a turn keeps what
it started with and the thread is told.

This is not a secret manager and not a sandbox. An agent told to print a value can print it
to the screen of the tool that runs it. The promise is narrower, and worth stating plainly:
covey does not write the value down, and it takes the value back out when something else
does. The database is `0600` and its directory `0700`, because that is where the values live.

A moved thread arrives with its names dropped and a note that says which ones went: a value
never leaves the machine that holds it.

## Runs

A **run** is a named group of threads with one goal: one request from the operator becomes
many threads across many machines, each with one task, tracked to a finish. Call it a run —
it has a beginning, an end and a result.

### Where a run lives

The record is **daemon state**, on the daemon the operator started the run from: a run
outlives a client restart, so it cannot live in the TUI's config. It is one JSON row in the
`runs` table, sent whole in `ShellSnapshot.runs` and re-sent whole on every change as
`run.upserted` — the same rule timeline items follow, so a client that reconnects mid-run
sees what one that watched throughout does.

A run is **dispatched by the client**, because a daemon holds no connection to another
daemon. Only the TUI has one to every machine. So the daemon stores and fans out, and the
client places, creates the threads, sends the briefs and patches each member's row.

A member carries `review`, which issue #45 owns: gates, the conflict queue and the merge
order attach there. Dispatch and tracking carry that field and never read it.

### What placement uses

`MachineCapabilities` says nothing a run can place work with. `MachineInfo.resources`
(`MachineResources`) says the rest: cores, memory, a concurrency limit from the two, the
machine's tmpdir, and the tools the daemon can run.

**The daemon reads it, never `ssh`.** The daemon is started from a login shell — often
through `nvm` — and a non-interactive `ssh` session is not, so the two resolve different
`PATH`s. An agent inherits the daemon's. On 2026-09-16 an `ssh` probe reported that a machine
had no `pnpm`; it had `pnpm`, and the operator nearly installed a second one.
`packages/daemon/src/resources.ts` therefore probes `process.env.PATH`, after the listener
binds, and pushes the answer as `machine.updated`. It reports a second copy of a name when
there is one — which is how the machine with the old `/usr/bin/node` answers for itself.

### The rule

> Each task goes to the fastest machine that meets its requirements and still has room; when
> every machine is full, to the one carrying least for its size.

A task may carry requirements — `os=darwin`, `arch=arm64`, `needs=tmux`, `machine=pi` — and
placement obeys every one. The rule is shown in the run panel while the run is still being
planned, and `m` moves a member to another machine until it has a thread. Placement that
cannot be overridden will be wrong on the first run that matters.

### One set of resources per member

Each member gets a port, a `COVEY_HOME` and a `COVEY_CONFIG` that nobody else in the run has,
and the brief template substitutes them. This is the defect that made the issue: the brief of
2026-09-16 gave all fifteen agents the same throwaway port, and one of them ran
`covey stop --port 3799` and stopped a daemon another agent had started.

Ports come from a contiguous block in 3800–3999, chosen from the run's id, so a member can
never be handed 3790. The block depends on the run's id alone and not on how many members it
has, or adding a task would re-number a member already at work on its own port.

### Tracking, and talking to it

A run is a sidebar row that opens to its members: task, thread, machine, branch, pull
request, state. `planned → dispatched → working → review → merged`, plus `blocked` and
`withdrawn`. `blocked` is not an error, and `withdrawn` is an outcome beside `merged`, with
the reasoning kept in `note`.

Everything but the pull request streams over the shell subscription the sidebar already
holds. `run.pullRequest` fetches the rest, with `gh` on the machine that holds the branch —
identity and state only; mergeability is #45's.

`s` in the run panel sends one message to every member, to the marked ones, or to one. The
operator of 2026-09-16 sent the same correction to fifteen threads four separate times, each
one a hand-written loop over thread ids.

## Integrating a run

A run dispatches work and tracks it (#44). This is what happens when the work comes back:
the gate, the conflict queue, the audit, and the one party that merges. The rules come from
a real run of fifteen agents on 2026-09-16, and every one of them cost something.

`packages/daemon/src/integrate/` holds it. Everything in there is pure but `gh.ts`, which is
the only file that starts a process, so a test passes a `fakeHost` and nothing reaches GitHub.

**Green is not the gate.** A check is green against the base it ran on, and the base moves.
Two pull requests of that run were each green and each `MERGEABLE`, shared no line, and broke
`main` when both landed: the second one's checks were computed before the first existed. So
`summariseChecks` treats four states as a refusal — `failing`, `pending`, `stale` and
`absent` — and a green check whose `startedAt` is earlier than the base head's commit date is
stale. GitHub's own `mergeStateStatus` of `BEHIND` says the same thing and counts too.
A merge queue cures this at the source, because it runs the checks on the queued merge
result; the rule stays, because the queue is a repository setting a run cannot assume.

**A test that exists is not the gate either.** When the operator asked every agent to revert
its fix and run its test again, three of five already-merged agents found their tests proved
nothing. So a member carries a `RegressionEvidence` record: what it reverted, which test, and
the failure verbatim. No machine can judge a test, and `evidence.ts` does not pretend to. It
refuses the three cheap fakes — no record, no failure text, and the output of a run that
passed — and shows the rest to a person.

**The conflict queue is serial, largest diff first**, so the cheapest change pays the
re-merge tax. `buildQueue` also writes each member a brief that names what lands before it
and in which file. The brief says in its own words that file overlap is a hint: in the real
run the predicted collision never happened, the real one was in a file nobody listed, and the
hard part was a behaviour question rather than a merge.

**Never merge under a running turn.** A run owns the map from thread to branch, so the gate
refuses while the member's thread runs. The daemon reads that from the thread itself and
never from the caller. After any merge the audit asks
`git rev-list origin/<base>..origin/<branch>` of every merged branch; one line of shell that
would have caught a real loss of 211 lines at once.

**One party merges.** `mergeMember` is the only path to a merge, it takes a `MergeParty` and
refuses anybody without `integrator`, and it reads the gate fresh rather than trusting a
verdict from a minute ago. Members never get push rights to the base branch.

The RPCs are `run.gate`, `run.memberDiff`, `run.queue`, `run.merge` and `run.audit`. Each is
answered by the daemon that holds the member's branch, because that daemon has the checkout,
the `PATH` and the `gh` login.

## The loop: an issue, a pull request, and the answer

A run dispatches work (#44) and a run lands work (#45). Issue #94 is the part between the
two: a thread takes an issue, opens a pull request, and hears what GitHub says about it. An
agent ran that loop by hand on 2026-09-21 and got it wrong three ways, which is what the
rules below come from.

**The record is on the thread.** `Thread.issue`, `Thread.pullRequest` and `Thread.watch` sit
on the thread row, so a restart reads them back and a move carries them (an export copies the
thread whole). The sidebar puts the issue number before the title.

**Taking an issue** is `thread.takeIssue`, or `issue` on `thread.create`, which is what a run
member gets from its task. The daemon refuses, with `taken`, when another live thread of the
same project on the same machine holds the number. Two machines cannot see each other, so
the claim is per machine; a claim every machine can see is a known gap below.

**Opening a pull request** is `thread.openPullRequest`. The daemon that holds the branch
pushes it, runs `gh pr create`, records the number and starts the watch. When the thread took
an issue and the body does not name it, the daemon adds `Closes #N`. `createPullRequest` is
the second write on `GhHost`, beside `mergePullRequest`; a host has neither unless it was
built with it, and `assertReadOnly` still refuses `pr create` on the read path. A pull request
opened by hand is handed to covey with `thread.watch`.

**Media on the pull request** is `attachments` on `thread.openPullRequest` and on
`thread.commentPullRequest` (#105), which `covey pr open --attach F` and `covey pr comment
--attach F` ask for. GitHub renders a video or an image inline only when the file is a *user
attachment*, the kind the web form makes; a release asset, a raw file in the repository or an
outside host stays a link, and the markdown sanitizer strips a `<video>` with an outside
source. The REST and GraphQL APIs have no endpoint for one, but the route the web form uses
takes the `gh` token: `POST uploads.github.com/user-attachments/assets` with the name, the
media type and the repository id in the query, and the bytes as the body, answers 201 and a
`github.com/user-attachments/assets/<uuid>` URL. `uploadAttachment` on `GhHost` is that
call, the third write, and `commentPullRequest` the fourth; each exists only on a host built
with `allowAttach` or `allowComment`. `integrate/attach.ts` is pure and holds the rules: the
media type comes from the extension and only what GitHub renders is allowed; an image may be
10 MB and a video 10 MB on the free plan or 100 MB on a paid one, with the free cap when the
token cannot read the plan; every check runs before the first upload, and every upload runs
before the push, so a refusal leaves no branch on the remote and no pull request with a path
in its body. Anything but 201 is shown whole, with the by-hand fallback, because the route is
undocumented and the answer is the only clue. A video goes into the body as a bare URL on its
own line and an image as an image, at the end in the order the flags were given, or where a
`{{attach:NAME}}` stands. Each file is copied into `<data dir>/attachments/<thread id>` first
— the daemon's own dir, not the thread's file store, because the copy has to outlive the
worktree — and a note names the file, its URL and the copy, so a person can re-upload by hand
when the URL dies.

**The daemon that holds the branch watches.** A poll runs on a timer, thirty seconds after
the last one and half as long again after every quiet poll, up to five minutes. It reads the
pull request and its line comments through `GhHost`, so a test hands in `fakeHost` and
reaches nothing. `integrate/news.ts` is pure: it takes the facts and the cursor of what the
thread has heard, and answers with the events the thread has not seen. Three rules live
there, and each has a test:

- **Every terminal state is news.** A failed check fires exactly as a passed one does. The
  hand loop left when the merge state stopped being `BLOCKED`, and a failure never fired for
  95 minutes.
- **The checks are read from the check runs, never from the merge state.** GitHub answers
  `BLOCKED` both while the checks run and after they fail. A head with no check at all is an
  answer too, after two minutes of grace.
- **An answer is delivered once.** A checks verdict is keyed by the head it was for, a
  conflict by its head, and every review and comment by its id. The cursor is in the row, so a
  retry, a reconnect or a restart sends nothing twice.

**An event reaches the thread as a turn.** This is the primitive the rest exists for. A note
in a transcript is read by a person; a `turn.send` resumes a session the engine released,
and the agent reads the failure, fixes it, and pushes. The turn names the checks that failed
with their URLs, the review with its words, the comment with its file and line, and which
round this is.

**The loop is bounded.** An event that asks for work — a failing check, a conflict, a review
that asks for changes — costs a round; a pass, a comment or an approval costs none. A watch
sends at most `maxRounds` (default three) such turns; the next one ends the watch in
`blocked`, with the news in the transcript as a note and the reason on the row. A watch that
runs 72 hours without a merge or a close ends in `blocked` too. The TUI reads a run member's
thread and moves the member to `blocked` with that reason, which is the run's own word for
"a person has to look".

**An agent asks from its shell.** `covey issue take <n>`, `covey pr open`, `covey pr comment`,
`covey pr watch`, `covey pr policy` and `covey pr status` (`packages/cli/src/loop.ts`) speak to the local
daemon over loopback for the thread in `COVEY_THREAD_ID`, with Node's own `WebSocket`, so
they need nothing installed in the agent's shell. The `/covey` skill
(`plugin/skills/covey/SKILL.md`) tells the agent the loop: take the issue, work, prove it,
open through covey, stop the turn, and act on each `covey watch:` message; `--auto` only when
the user said to merge on their behalf.

The skill reaches a session as a **plugin**, not as a personal skill. The daemon hands
`plugin/` from its own checkout to every session it starts (`plugin.ts`, the SDK's `plugins`
option, one `--plugin-dir` on the process), so a pull updates it and the internal update
installs it on every machine. The first version linked the skill into `~/.claude/skills`,
and it answered `Unknown command` after every restart: the SDK resumes a session from
covey's store by building a temporary config directory (`claude-resume-<id>`) and pointing
`CLAUDE_CONFIG_DIR` at it, and that directory carries the transcript, the credentials,
`.claude.json` and `settings.json` — nothing from `~/.claude/skills`. A thread's first
session read the link; none after it did. A brief is then one line:
`/covey take issue 94 to completion, automerge when done`.

**Acting from a client (#108).** A person at the web client reads an item with
`github.item` and acts with `github.act`: a review (`approve`, `request_changes`,
`comment`), a comment, a merge with a method, a close or a reopen. The daemon of the
project's machine runs each in the project's checkout on a host built for that one write:
`allowReview` for `reviewPullRequest`, `allowComment` for `commentIssue` beside
`commentPullRequest`, `allowClose` for `closeItem` and `reopenItem`, `allowMerge` for the
merge; the read path still refuses `pr review`, `pr close`, `pr reopen`, `issue close` and
`issue reopen`. The engine checks before `gh` starts: a review on an issue, a merge of an
issue, a review that asks for changes with no body. The thread that holds the number gets
a note that names the act and the client, and the watch delivers the review, the comment
or the merge as a turn on its next poll, the same as one made on GitHub. A merge from the
client is the person's decision, so it is not held under a running turn; the client warns
when the thread is still working, because the daemon's own `auto` merge would wait.

**Every watch has an end.** A merge or a close ends it. Archiving, deleting or moving the
thread drops it, as does `thread.watch` with `null`. The two hand-rolled loops still asking
GitHub every fifteen seconds an hour after their timeout are the reason.

**Who accepts the work.** The watch carries a merge policy, `PullRequestWatch.merge`, set at
`thread.openPullRequest` or `thread.watch` and changed with `thread.setMerge` (`M` on the
thread row, or the palette). The default is `manual`: green is not the gate (#45), so a
passing check ends nothing, and the watch goes on until a person or the run's merge party
merges the pull request. That is the flow for "post screenshots, and I will look". `auto` is
for "fix this, then merge when you're done": the daemon merges on the first poll that finds
the pull request ready. Ready is `mergeReadiness` in `news.ts`, and every refusal is a fact
GitHub reported: open, not a draft, `MERGEABLE`, no review that asks for changes, no review
the repository still requires, and the checks green against the current base head by the
same `summariseChecks` the gate reads. Under `auto` a green check against an older base is a
`stale` event, which asks the agent to merge the base in and push, and costs a round. The
merge never runs under a running turn: the poll reads the thread row and waits for the next
poll. GitHub refusing the merge is reported to the thread once per head and the watch goes
on; a person decides, or a push starts the loop again.

## Browsing the sidebar

The tree is **projects first**. A project is a repository on one base branch, and one row
stands for it however many machines hold a clone. The client groups every machine's projects
by their normalised remote *and* their base branch (`projectPool` in `@covey/client`, which
`projectGroups` in `store.ts` keys on). One repository on `main` and the same repository on a
feature branch are therefore two rows: the work differs, and so does the commit each thread
starts from. The threads of every machine in the pool sit under the one row, by recency. Each thread row names its machine when the pool has more than one.
A project with no remote is a group of its own, keyed by machine and id, so two machines'
directories of the same name never merge. The fold key of a project is its group key. A fold
made under the old key, `<machine>:<project id>`, moves to the group key when the machine's
snapshot arrives, so a fold from before pooled rows still holds. The machines sit in a
section of their own below the projects, furled by default: they are where the work runs,
not what it is. The machine row still opens the control panel, and an offline one still says
what to press.

A new thread goes to a machine of the pool. One connected machine needs no question. More
than one asks, and the pick lists the machines the way `rankMachines` orders them for a run:
the fastest with room first. The project's name starts as the repository's, and `r` on the
row renames it on every machine of the pool, because each daemon holds its own row.

A new project starts from a pick of the repositories the user can reach. The pick opens at
once, with two fixed rows, and the list joins it when a machine answers. The client asks the
connected machines whose daemon found `gh`, in turn, because the token lives on the machine
and a `gh` on the path is not always logged in. `repos.list` is one REST call, paged, for the
user's own repositories and every organisation's, newest push first. The reader filters the
list by what they type. The two fixed rows make a new repository through `repos.create`,
private or public, or take a URL for one `gh` cannot list. With no `gh` to ask, the URL is
the whole of it. The list goes through the daemon's read-only `gh` path. `repos.create` is
the one write beside a run's merge, and it sits alone in `repos.ts`. This version has no
local repository, where one machine holds the bare repository for the others: the others
would have to pull from it, and daemons do not talk to each other.

After the repository, the branch it works from: `repos.branches` reads the remote with
`git ls-remote` on a machine, and the pick lists the default branch first, as the row that
leaves the base unset, then the others (see *A project on a branch of its own*). A remote
that cannot be read goes straight on with the default branch. A repository just made has one
branch, so that pick is skipped. Then the machines. The pick offers every saved machine,
connected or not, with the connected ones marked. A machine that is not connected clones when
it next answers. The request waits in `TuiConfig.prefs.pendingProjects`, and the store sends
it on the next connection. The entry leaves the list once the machine has the project, and
not before, so a client that stops mid-clone still owes it on the next start. This lets an
offline machine join a pool now, and it needs no channel between daemons. The palette adds a
machine to a pool later. `D` on the project takes a machine out of one: the rows and the
threads go from that machine, and the clone stays on disk.

Moving the sidebar cursor shows what it is pointing at, so the tree can be read
without committing to anything:

- a **thread** row opens its transcript, debounced by 120 ms so holding ↓ costs
  one `thread.snapshot` rather than one per row. Focus stays in the sidebar;
  enter is what moves you into the composer.
- a **project** row draws a summary in place of the transcript: the repository,
  one line per machine in the pool with what runs there, the thread counts, and
  one line per thread with its status, its latest turn's diff and when it last
  spoke.
- a **machine** row draws the machine: os/arch, daemon and Claude versions,
  tailnet name, the defaults new threads inherit there, the last update, and a
  line per project. The **machines** header draws the fleet.

The cursor is a row *key*, not an index into the row list. The tree re-sorts
under it — `byRecency` moves a thread to the top of its project on every turn
that starts and every turn that finishes, on any machine — so an index points
at a different thread a moment later, and the preview opens a conversation
nobody asked for. `cursorIndex` in `sidebar.ts` turns the key back into an
index, because the painter and the hit test below still speak in rows. When the
row a key names goes — archived, deleted, moved, folded away with its project —
the cursor falls back to the index that row was on, and App writes the key of
whatever is there back, so the next re-sort has a live key to hold.

A preview fetches a screen's worth of the thread, not the thread. The page is
`previewPage(height)` items for a transcript pane `height` lines tall: an item
is at least one line, so that always covers the pane, and in practice covers it
several times over. The saving is not mainly the bytes — it is that
`layoutTranscript` renders *every loaded item* to lines on every frame, whether
or not it is on screen, so a 300-item page makes each preview several times more
expensive to paint and to keep painting. Scrolling back, or opening the thread
for real, pulls the rest in through `loadOlder()`. In the one case the sizing
cannot cover — a pane taller than the 300-item cap, filled with one-line items
— App notices the layout came up short of the pane and asks for another page.

For the same reason `watchThread` puts only the snapshot on the critical path:
dropping the old subscription and opening the new one happen behind the first
paint, since the new subscription carries `afterSeq = snap.seq` and replays
anything it missed. Browsing used to pay three round trips per row for one
paint's worth of data.

Clicking a row does exactly what enter does on it — open the thread, fold the
project, open the machine's control panel — because the mouse should not have a
vocabulary of its own. That requires the click to land on the row that is
actually painted there, which is not `screenRow - 1`: every top-level row after
the first is preceded by a blank line, and a tree taller than the pane is a
window over the rows. So `sidebar.ts` turns the rows into the list of lines as painted, and App
hands that one array to both `Sidebar` and the hit test — the same trick the
transcript uses for drag-selection. The wheel over the sidebar moves the cursor
instead of scrolling a viewport of its own, so one thing decides both what is
visible and what is shown.

## Who started a thread, and where it sits

A thread a program started used to look exactly like a thread the user opened by
hand. On 2026-09-16 an operator ran fifteen agents over two machines, and all
fifteen threads appeared beside the user's own, with nothing to tell them apart
but their titles.

`Thread.origin` records the difference: whether a person or a program asked for
the thread, the `client` name the creating connection gave at `hello`, and the
thread that started it. It is optional, the rule `titleAuto` follows, so every
thread that predates it keeps working and paints as it did.

The name comes from the connection, not from one call. `hello` has always
carried it and the daemon used to discard it; the server now holds it for the
life of the connection and `Engine.dispatch` takes it. `USER_CLIENT`
(`covey-tui`) is the one client a person types into, so every other name is a
program, and a connection that names nothing gets no origin at all.

**It is a hint, not a boundary.** `client` is self-declared and the daemon cannot
check it. Nothing that must not be spoofable may rest on it.

`thread.create` can carry an explicit `origin`, because the client name cannot
answer every case: the TUI dispatches a run's members over the same connection a
person types into, so it says `{ by: "agent" }` outright and the command wins.

### In the sidebar

A child sits under its parent, indented, **furled by default** — fifteen
dispatched threads become one row, with a count on the parent saying what it is
holding. `◇` marks a thread a program started: a glyph, not colour alone,
because covey runs over ssh and in tmux, and colour alone also fails a reader
who cannot tell the pair apart.

**One gutter cell, two columns, every thread row.** It holds the caret when the
row heads a group and the `◇` when it does not. The mark used to sit between the
status dot and the title, which pushed an agent's title two columns right: the
indent is the sidebar's one way of saying *under*, so a thread that was nobody's
child read as somebody's child. A row that is both a group and an agent spends
the cell on the caret — what it is holding is the more useful of the two, and
its children carry the mark.

**The arrow keys furl; the click never does.** `→` unfurls a furled group as it
unfurls a project, `←` furls it, and `enter` and a click both open the thread —
the mouse keeps no vocabulary of its own. Were a click to furl, the row that
most wants clicking, the thread that dispatched everything below it, could not
be opened without collapsing everything under it. `←` on a *child* moves to its
parent, so `←←` is the way out of a group from any row inside it.

The same two keys work a run row, and for a while only one of them did: `←`
furled a run and `→` opened its panel, so a run the operator closed could not be
opened again from the sidebar at all. `→` unfurls first and opens second, on
every kind of group there is. Which default a key reads travels with the key —
a run is open until furled, a thread group furled until opened — because reading
one without the other answers "is this furled?" wrongly for half the tree.

A furled group hides the children that are **working**. It never hides one that
failed, is `waiting`, or has a pending approval: nobody else is watching a
thread that failed, and a run in a strict permission mode would deadlock in
silence behind a hidden approval. Quiet while it works, painted the moment it
needs a person.

A thread's group holds the runs it asked for as well as the threads it started,
and paints them first: a run is the larger piece of work and it names itself.
The count on a furled row covers both.

`threadGroupKey(machine, threadId)` sits beside `archiveKey` and `runKey` in
`AppState.expanded` and persists through `TuiConfig.prefs.expanded`, so a furled
group is still furled after a restart.

A `parentThreadId` naming a thread the sidebar cannot see — archived, deleted,
on another machine — leaves the child a top-level row: a thread is never lost
behind a link that leads nowhere. Two threads naming each other have no parent
outside the pair, so the reachable set is settled from the roots *before*
anything paints; resolving it during the paint would treat "furled" as
"unowned" and resurrect every hidden child.

### A run is not a manager thread

A run is a named group somebody created — the operator in the TUI, or an agent
over the wire — and it finds its members through `run.members`. A manager thread's children find *it*, through a back-pointer on
the child. Same edge, opposite directions, and unifying them would mean
inventing a run nobody named or a parent thread that does not exist. What they
share is the furl mechanism, and that is reused rather than rebuilt: a third
grouping *key*, not a third grouping *model*. A run member's thread is marked
`agent` with no parent, so it is grouped under its run row and nowhere else.

**Nowhere else means nowhere else.** `sidebarRows` claims every thread a run's
members name and takes it out of its project's list, because the member row *is*
that thread — clicking it opens the conversation. Until it did, a dispatched
thread was painted twice: once as a task under the run, once more as a `◇` row
sorted into the project by recency, belonging to no group and so with nothing to
furl it into. The claim is read from the runs this client actually holds, so it
can only hide a thread that something else is really painting; a machine that
has not answered yet claims nothing and its threads stay where they are.

The project row still counts them. Its number means *the work in this project*,
furled work included — a thread group's children are already in it — and so are
the tasks of its runs that are not threads yet (`pendingTasks`). A run spends
most of its life planned rather than dispatched, and a planned task has no
thread, so a project holding one thread and three runs of five used to read
"1" and a furled row hid fifteen pieces of work behind that number. A task that
was dispatched is a thread in the project and is counted as that thread; a task
that merged or was withdrawn is over and is counted nowhere.

The dot beside the number answers for the runs as well (`runIsBusy`,
`runNeedsPerson`). A fold may hide a row; it may never hide that something
inside it is working, or that something inside it is waiting on a person.

A furled run follows the thread group's rule exactly: it hides the members that
are working and lets through the ones that need a person — `blocked`, or a
thread that `needsPerson` answers for. A run in a strict permission mode would
otherwise deadlock in silence behind an approval the operator furled away. It
carries no hidden-count: a run row's meta already says how many members it has,
which is the thing that count exists to tell a thread row.

### Where a run sits

A run used to be painted under the machine, above every project, wherever its
members worked. So a run of five threads in one project stood beside the project
those five threads were in, and the thread that asked for the run had nothing
under it at all: the reader had to know that the two rows were one piece of work.

A run goes where its work goes. `runProject` names the one project every placed
member works in, on the machine that holds the run, and the run becomes a row of
that project. When the run also carries a `parentThreadId` the sidebar can
paint, it goes inside that thread's group instead, above the threads that thread
started — the same place, and the same fold, a child thread gets.

A run this client cannot place stays where every run used to be: under the
machine, above the projects. No members placed yet, members in two projects, a
member dispatched to another machine — a project id means nothing off its own
machine, and one level too high is a run the operator can still find, while a run
filed under a project it does not work in is a lie.

A fold may never hide the fact that something inside it is waiting on a person,
and a run inside the tree gives that rule two more places to fail:

- A furled thread group hides the runs it holds, and never one whose member
  needs a person (`runNeedsPerson`).
- A thread that is quietly working, holding a blocked run, would sit inside its
  *own* parent's fold and take the run with it — not furled, absent, with no
  count on any row to say it is there. `wantsPerson` walks what a thread is
  holding, runs and threads and their runs, so such a thread comes through its
  parent's fold and the path down to the blocked member comes with it. Each
  level filters by the same rule, so letting the thread through lets through
  what raised the need.
- A furled *project* hides its runs the way it hides its threads, which is new:
  a run used to sit outside every project fold. So the project row's attention
  dot reads its runs as well as its threads. A member the operator or the
  tracker called `blocked` has no thread status to read, and without this the
  fold would swallow it in silence.

Three indents say all of this on screen, and they are worked out against each
other rather than written down as constants: `threadIndent`, `runIndent` and
`memberIndent` in `Sidebar.tsx`. A thread row spends two columns on its gutter
and two on its status dot; a run and a project spend two on a caret and a space.
The titles line up because the numbers are derived, not because three literals
happen to agree.

### Telling an agent which thread it is

An agent had no way to know. The daemon sees a websocket, not the process behind
it, so a program that created a thread could not name its parent even when it
wanted to — and that is why some agent threads nested under the thread that
asked for them and some stood alone beside it.

The session now carries `COVEY_THREAD_ID` and `COVEY_PROJECT_ID` in its
environment (`ClaudeSession.start`, through the SDK's `env`, which *replaces*
the environment rather than merging it — hence the spread of `process.env`). A
program that reads them can pass the thread id back at `hello`, and every thread
and every run that connection creates is recorded as a child of it:

```
{"id":"1","method":"hello","params":{"protocolVersion":1,"client":"my-script","threadId":"<COVEY_THREAD_ID>"}}
```

The daemon checks the id against its own database (`Engine.knownThread`) and
drops one that names no thread of its own, or the thread being created. The
same check covers a parent named in the command itself — `thread.create` and
`run.create` both take the id the caller asked for, resolve it, and record only
what resolved — so the stored data can never hold a link to a thread nobody can
paint. Like `client`, the id is self-declared: a hint for a reader, never a
permission. Nothing but the sidebar's shape and its `←` key reads it.

## The machine control panel

Enter on a machine row in the sidebar opens the per-machine panel, so keeping a remote
daemon current does not mean finding an ssh session for it:

- **Update** — the daemon pulls its *own* checkout (found by walking up from its module until
  a `.git` turns up), reinstalls only if `pnpm-lock.yaml` moved, runs `pnpm run build`, and
  restarts. Each step streams its output to every connected client as a `machine.update`
  push; the whole record is re-sent on each change, like timeline items, so a client that
  joins mid-update sees the same thing as one that watched from the start. A failed step
  stops the run — a daemon is never restarted onto a build that did not compile.
- **Restart** — the same restart without the pull.
- **Default model** and **default mode** (manual / auto / bypass) for new threads on that
  machine.
- **Live sessions** and **Release when idle** — the two session limits, which is to say how
  much memory that machine spends on Claude sessions. Neither is a default a new thread
  inherits: both apply to the threads running now, and the daemon re-sweeps as soon as one
  changes, so a lower ceiling frees memory on the spot.

  A `null` in either setting means "the daemon's own default", and no client can work out
  what that resolves to — the ceiling's default is read from the machine's memory, so it is 4
  on a Pi and 8 on a workstation. So the daemon says: `MachineInfo.sessionBudget` carries the
  two resolved figures and what one session costs, and it is re-sent with every
  `machine.updated`. The panel therefore reads `from memory (4)` and `default (2 hours)`
  rather than the bare word, and every row of the ceiling's picker is priced
  (`4 sessions · about 1.3 GB`) — the count of sessions is not what the reader is choosing.
  A daemon built before that field says "default" with no number, rather than a guess made
  from the memory of the machine the *client* runs on.

  The words are `packages/client/src/sessionBudget.ts`: pure, node-tested, and read by the
  TUI's panel and the web client's machine sheet both, so the setting reads the same on a
  phone and in a terminal. Keep the panel's hints short — `Overlay` gives the label whatever
  the hint leaves of the row, so a long hint truncates the label away and the row reads as
  its own footnote. The picker is where the reasoning fits.
- **covey settings** — the last row, and the odd one out: it opens *this client's* own
  panel, which no daemon hears about. That is the whole distinction the row's hint draws,
  and it is there because "settings" is what a reader goes looking for on a control panel.
  `ctrl+k → Settings` opens the same panel.

## This client's settings

Three rows, all written to this machine's `config.json` and read at the next start.

- **Theme** — eight palettes: covey's own, Catppuccin Mocha, Dracula, Everforest Dark,
  Gruvbox Dark, Nord, Solarized Dark, Tokyo Night. Five blocks in front of each name are
  that theme's accent and its four state colours, because the word tells a reader nothing
  about a palette they have not seen.

  `T` in `packages/tui/src/theme.ts` is one object the whole program reads, and `setTheme`
  writes the chosen palette *into* it. Nothing has to be re-imported or rebuilt, and no
  module may read a colour into a constant of its own — that would freeze at the palette
  the process started in. What does have to be told is anything holding painted lines:
  `ItemLines` and the layout memos in `App.tsx` watch `themeGeneration()`, because an item
  does not change when the colours do.

  covey does not paint the ground; the terminal does. So each theme names the background it
  was measured against and the picker says it, and `theme.test.ts` measures every theme
  against *its own* background rather than against black. A palette that leaves a machine's
  mark under 3:1 on the cursor row, or the selection invisible on a surface it can land on,
  fails a test — which is how Dracula's own current-line and Solarized's base02 both ended
  up one shade darker here than in the theme they come from.
- **Detail** — the same four levels as `ctrl+o`.
- **Bell** — whether a thread that needs approval, finishes or fails rings the terminal.
  Stored as `prefs.quiet`, the name it was written under before it had a row.

A process cannot free its own port and then bind it again, so the restart is delegated: the
daemon spawns a detached `node -e` helper carrying its pid, argv, execArgv, cwd and log path,
then SIGTERMs itself (which closes sessions and the db through the normal shutdown path).
The helper waits for the pid to disappear, then starts the daemon again exactly as it was
launched. Because the daemon is gone before it could report success, the *client* closes the
loop: when a machine it asked to restart reconnects, the update is marked succeeded and the
TUI says so.

## Updating the client itself

The daemon can rebuild itself because the code it is running was read long ago; a TUI cannot
do the same and stay on screen, and it certainly cannot re-exec from inside its own render
loop. So the client asks the layer above it. `ctrl+k → "Update covey"` (or the control panel
of the machine that shares its checkout) sets a `RelaunchRequest`; the app unmounts, `runTui`
returns the request, and `packages/cli` does the work in a plain terminal:

1. the same `Updater` the daemon uses — pull, install if `pnpm-lock.yaml` moved, build —
   pointed at the checkout the *CLI* was launched from (`sourceInfo(here())`);
2. optionally `covey restart` for the local daemon, which is running the same now-stale build
   (offered as a separate answer in the dialog, because it ends any turns in flight — when
   turns are running that option is not the first one);
3. `process.execve` back into the freshly built entry with the original argv. That replaces
   the process image: same pid, same terminal, no supervisor left behind. Where `execve` does
   not exist (older Node, Windows) we spawn a child on the same stdio and wait for it.

The outcome rides along in `COVEY_NOTICE`, which the new process shows as its first notice —
"updated 8689389 → 959cb0b", or the reason it failed. A failed update still relaunches: the
alternative is dropping the user at a shell with no explanation. `covey update` does the same
three steps from a terminal, which is what you want over ssh.

The defaults live in `daemon.json`, not in the TUI's config, so they hold for every client
that connects and survive the restart. `thread.create` resolves a model as command →
project → machine, and a permission mode as command → machine → the user's own
`permissions.defaultMode`. The TUI omits its own last-used mode when a machine default is
set, so the panel is not silently overridden by the client.

### The models a machine offers

The model picker is not a list covey ships. A list covey ships is stale the day a model
ships, and it is stale differently on every machine, because one daemon runs a Claude Code
from last week and another runs today's. So the daemon asks the Claude Code it runs
(`packages/daemon/src/models.ts`): a query whose prompt stream never yields, which starts
the CLI, answers `supportedModels()` from the handshake, and aborts. It runs no turn and
spends no tokens, and it takes about a third of a second.

**Which Claude Code that is.** Not the `claude` on the PATH. The Agent SDK ships its own
binary and spawns it unless a caller sets `pathToClaudeCodeExecutable`, and covey never
does, so the Claude Code covey runs is the one inside `@anthropic-ai/claude-agent-sdk`:
SDK `0.3.N` carries Claude Code `2.1.N`. That is the version `MachineInfo.claudeCodeVersion`
reports, and it is the point of reading the list from it rather than from a constant — the
picker offers exactly what a session on that machine can run, and a machine whose daemon
runs an older build says so. A new model therefore reaches covey through the SDK
dependency, which is why that package is the one exception to the seven-day age rule
(`minimumReleaseAgeExclude` in pnpm-workspace.yaml, and the matching `EXEMPT` in
`scripts/pkg-age.mjs`).

The answer is Claude Code's own list, the account's plan already accounted for. It reaches
clients on `MachineInfo.models`, so both of them have it without asking, and the read
happens behind the listener like the machine's resources do — a client that connects first
shows `KNOWN_MODELS` and a `machine.updated` push corrects it a moment later. `models.list`
answers from the same place, for a caller that holds no `MachineInfo`.

Three rules make it hold up:

- **Store the id Claude Code gives**, which is usually an alias — `sonnet`, `opus[1m]`.
  An alias names the newest model of its family, so a thread pinned to one follows the
  install. A wire id is what froze the old list.
- **Match a stored id on `resolved` as well as on `id`**, because covey stored wire ids
  before this and a thread on `claude-sonnet-5` must still read as "Sonnet". An id no row
  covers is shown as itself: it is what the thread really runs.
- **Read the list again when a session reports a Claude Code that is not the one the
  machine knows** (`onSessionInit`). It is the one signal that costs nothing. This is why
  `detectClaudeVersion` reads the SDK's manifest and not `claude --version`: a start-up
  version from the PATH disagrees with the one every session reports, and the re-read then
  fires once per daemon start for nothing.

`KNOWN_MODELS` in the protocol is the fallback, for a daemon too old to send a list and for
the moment before the first read answers. It is aliases for the same reason.

## Projects: a repository, cloned by covey

A project is a repository. The daemon clones it, and the clone is the daemon's:

```
~/.covey/projects/github.com/<owner>/<repo>/repo.git     the bare clone
~/.covey/projects/github.com/<owner>/<repo>/<prefix>     one worktree per thread
```

`project.create` takes a URL. The daemon normalises it to the identity every machine derives
from a remote, `github.com/org/repo`, and refuses a second create for a repository this
machine already has. The directory is that identity as a path. The host stays in it, because
`github.com/acme/api` and `gitlab.com/acme/api` are two repositories and must not share one
clone. The root is `COVEY_PROJECTS`, else `<COVEY_HOME>/projects` when `COVEY_HOME` is set,
else `~/.covey/projects`. A throwaway daemon on another port therefore clones into its own
directory and never into the real one. `MachineInfo.projectsDir` says which.

The clone is **bare** on purpose. There is no checkout to work from. So there is no "worktree
from HEAD" and no "this checkout" for threads to share. And nothing on the machine is two
days behind `origin` because nobody pulled it.

`git clone --bare` writes no fetch refspec, which would leave `origin/main` unset for ever.
The daemon does `init --bare`, `remote set-url`, a fetch and `remote set-head` instead. The
URL is set on every create, so a retry with another URL for the same repository does not
fetch from the one that failed. The bare repository's own `HEAD` stays unborn. A local copy
of the default branch would never move, and an agent that ran `git merge main` in its
worktree would merge the copy. `origin/main` is the ref every worktree can reach, and the
one a thread is told to merge.

`Project.kind` tells a `clone` from a `checkout`: a directory the user pointed covey at,
from before projects were clones. No new project is made that way. The rows that exist keep
working. Their worktrees stay under `<root>/.covey/worktrees`, next to a self-ignoring
`.gitignore`. A `checkout` with nothing to branch from is the one place a thread still works
in the directory itself. A machine may hold a repository twice, as a checkout from before
and as a clone: `project.create` refuses a second clone, not a clone beside a checkout. The
sidebar shows the two as one project, new threads and runs go to the clone, and `D` on the
project names each row by kind, so the reader can remove the checkout once its threads are
done.

`thread.delete` removes the thread's worktree. `project.delete` removes the rows; the clone
stays on disk, because its branches may hold commits nobody pushed. A later create for the
same repository finds the clone and fetches rather than cloning again.

### A project on a branch of its own

A reader who builds one feature branch over many threads does not want each thread to start
from `main` and each pull request to target it. `project.create` takes `baseBranch`, and the
row keeps it as `Project.baseBranch`. Every thread of that project branches from
`origin/<baseBranch>`, and every pull request the thread opens targets `<baseBranch>`, on
GitHub and in `Thread.pullRequest.base`. A run's brief names it too (`{{base}}`). Absent,
nothing changes: the remote's default branch is the base, and the row reads as it did before
the field existed.

The TUI asks for the branch between the repository and the machines: `repos.branches` runs
`git ls-remote --symref <url>` on a machine, with the credentials a clone would use, and the
pick lists the default branch first (the row that leaves the base unset), the other branches
by name, and the `covey/` branches of threads last. `b` on a project row changes the base
later, on every machine of the pool, through `project.update { baseBranch }`; `null` returns
the project to the default branch. A create or an update that names a branch the remote does
not have is refused with code `no_branch`, and a name git would read as an option or a range
(`--x`, `a..b`) is refused before any fetch. The threads that exist keep their worktrees; the
next thread starts from the new base.

A project is one per repository **per base branch** per machine. A second create for a base
another project already works from is refused with code `exists`, and so is a
`project.update` that would move a project onto another one's base: two rows on one base
would fold into one sidebar row, and a new thread could land on either. The bare repository
and the worktree directory are shared by identity, so the two projects share one clone on
disk and `cloneOnce` makes it once. The sidebar, the placement of a new thread and of a run's
members, and the pending clones of a machine that is away are all keyed on the pool, not on
the identity alone. The sidebar row and the web client's row name the base beside the title,
because the two rows carry the same title otherwise.

## Where a new thread works

Every thread gets its own worktree, `git worktree add --no-track -b covey/<id> … <base>`,
where the base is `origin/<baseBranch>` for a project that names one, else `origin/HEAD`
(else `origin/main`, `origin/master`), and only a local branch in a repo with no remote. Parallel threads in one checkout change the same
files, and a clone has no checkout to offer, so there is no choice to make and nothing to
ask.

covey **fetches `origin` first**. Work is pushed to `origin` and reviewed there, so `origin`
is the truth about what the default branch is; the local branch of that name is one machine's
opinion, and on a machine that dispatches agents it is a stale one, because nobody pulls a
checkout they only ever branch from. Before this (#76) a worktree branched from the local
`main`, which on the macOS host was 46 commits behind `origin/main`, so every agent started
two days back and spent a round merging before its work could land.

The fetch takes one branch, the base, not the whole remote, and is bounded at 20s (a
healthy no-op fetch of this project measures 1.2s to 1.4s). One repository's fetch counts as
fresh for a minute, so a dispatch of eight threads in one project pays for one round trip,
not eight. The record names the branch it took: a fetch of `main` is no answer for a project
that works from `feature`.
A fetch that *failed* is not remembered: the next thread tries again, because a blip of one
second must not decide where the next seven agents start.
**A fetch that fails never stops the worktree.** Offline, no credentials, a remote that is
down: the worktree is branched from the refs that are here and the thread gets a warning
naming the ref and the commit it really got. An agent that starts stale and knows it can
merge first; an agent that cannot start does nothing at all. Every thread gets that line,
warning or not — "Branched from `origin/main` at `774c764`, fetched from origin just now."

`--no-track` keeps `origin/main` from becoming the new branch's upstream, which would make
`git push` under `push.default=simple` refuse it.

A worktree that cannot be created (no commits, no default branch, a name already taken)
fails the command with an error the TUI shows. It is never silently downgraded to a shared
directory — isolation was the whole point.

A thread that **moves** to another machine gets a worktree there too. When `origin` has the
thread's `covey/` branch, the worktree opens on it, with the commits the source pushed. When
it does not, the thread starts from the default branch, and its transcript says where the
old branch's commits are. A branch the destination held from an earlier visit is moved to
what `origin` has. The source gives its worktree back when the move is marked; the branch
stays. A machine with no project for the repository clones it first, from the URL the
export carries.

## Dropped files: read on the client, carried to the machine that works

A terminal does not hand a program the bytes of a dropped file. It pastes a path, and that
path names a file on the machine the **client** runs on. The daemon may be somewhere else, so
covey reads the file where the drop happened and carries the bytes inline, in `turn.send`.

`packages/tui/src/attachments.ts` does the reading. A pasted chunk becomes a drop when every
token of it rejoins into a path that names a file or a directory here; a chunk that names
nothing stays prose, and a chunk a terminal wrote in two goes joins onto the seam the last
paste left (`readSplitDrop`). A path that ends at a separator is never a directory drop,
because that is what the front half of a cut path looks like and the directory it names is
real.

Three shapes go over the wire, all as one `Attachment`:

- **A file.** The bytes, base64. Over 1 MB covey tries `gzip` and keeps the result when it
  saved more than a tenth, so a log or a source file costs a fraction of its size and a
  photograph costs nothing extra. `packing` says which.
- **An image over the API's own limit.** Scaled to `SHRINK_LONG_EDGE` with `sips`, `magick`,
  `convert` or `ffmpeg`, whichever the machine has, because the API scales anything past that
  down before it reads it. When no tool is there the image still goes, and a warning says the
  model will read it as a file rather than see it.
- **A directory.** One attachment per file under it, each carrying the path it had inside and
  all sharing one `dir`. Not an archive: the point is for the agent to open the files, and an
  archive is one more step before anybody can. `.git` and symbolic links never go, and a
  directory over `MAX_DIRECTORY_FILES` is refused by count rather than read for a minute.

Two limits, not one. `MAX_ATTACHMENT_BYTES` (32 MB) is what covey carries on one drop, and it
bounds the websocket frame too: 32 MB of bytes is about 43 MB of base64, under the 64 MB the
socket accepts. `MAX_IMAGE_BYTES` (5 MB) is what the model may be shown. They used to be one
number, which is why a 6 MB screenshot was refused outright instead of travelling as a file.

The daemon writes what arrives into the thread's **file store**, `<cwd>/.covey/threads/<thread
id>/files`, where `cwd` is the worktree the thread's session runs in
(`materialiseAttachments`). The file keeps the name it was dropped under, a second file of
that name becomes `shot-2.png`, and a directory becomes a folder. Three things follow from
the store being in the worktree rather than in the daemon's data dir: the agent opens a
dropped file with a path it can guess, the files go when the worktree goes, and
`.covey/.gitignore` — one line, `*` — keeps every one of them out of `git status`, out of a
diff, and out of a turn checkpoint. Nothing off the wire reaches the filesystem unchecked:
`..`, a leading separator and a drive letter are cut out of every name first, and the bytes
are counted against the same limit the client applies.

`attachmentBlocks` then builds the turn. An image under the API's limit becomes a real
`image` block; everything else is a line that names the file and its path relative to the
agent's own cwd, and a dropped directory is one line with the count, not one line per file.

In the composer a drop is a **chip** — `[shot.png]`, `[notes/]`, or `[shot.png — not on this
machine]` when it failed — spliced into the draft at the caret. The chip is ordinary text and
nothing protects it: delete it and the file goes with it on send (`keepTagged`). Backspace and
delete take a whole chip in one key, because a chip is one thing on the screen and a chip half
deleted is a file dropped with nothing said. Every file of one directory shares one chip.

**Not yet:** the bytes live on exactly one machine. A thread that moves takes its timeline but
not its files, and no client can ask for a file back. #85 has the shape of the content-addressed
store that would fix both.

## Thread titles

A thread's first message names it. The moment the turn starts the title becomes that
message's first line, so the sidebar is never showing "New thread" while work is happening;
a few seconds later a weak model (`claude-sonnet-5`, `COVEY_TITLE_MODEL` to change it or
`off` to disable) replaces it with a short phrase and the thread is re-emitted like any
other update.

The query runs through the Agent SDK, not the Messages API: it then reuses whatever
credentials Claude Code itself runs on, so nobody needs an `ANTHROPIC_API_KEY` for titles to
work. It carries the message text and nothing else — `tools: []`, `settingSources: []`,
`persistSession: false` — so it cannot touch the working tree, loads no CLAUDE.md, and
leaves no transcript on disk or in the db. It is bounded by a 20s abort and never throws:
a failure just leaves the derived title in place.

`Thread.titleAuto` records whose title it is. `thread.rename` clears it, and the generator
re-checks it before writing, so a title the user typed is never overwritten — including when
they rename the thread while the model is still thinking. Only the first message titles a
thread; later turns leave it alone. Threads from before the flag existed are read through
the sentinel it replaced (`title === "New thread"`).

## Turn checkpoints and diffs

Before a turn starts the daemon writes a git tree object of the whole working directory
(tracked + untracked, honouring `.gitignore`) using a throwaway index, and pins it under
`refs/covey/<thread>/<turn>/before`. When the turn ends it does the same for `after`.
The user's index, branch and stash are never touched. `turn.diff` runs `git diff-tree`
between the two trees on demand; `LatestTurn.diff` carries the numstat summary for the
sidebar/footer. Refs are removed when the thread is deleted. Non-git projects simply have
no diff.

## Reverting a turn

`turn.revert {turnId}` undoes that turn and everything after it, on both axes:

1. **Files.** Diff the current working tree (a fresh checkpoint) against the turn's
   `before` tree. Files added since are deleted; modified or deleted files are rewritten
   byte-for-byte from the tree with `git cat-file blob`. The user's index is not touched.
2. **Conversation.** The live subprocess is stopped. The SDK's `result` message carries the
   uuid of the user message that started the turn; we store it on the checkpoint and delete
   every transcript row from that uuid onward. The next turn resumes through
   `SessionStore.load()` and the model has no memory of the reverted turns. (If the turn
   never produced a result, we fall back to the user item's timestamp.)
3. **Timeline.** Items from the turn's user message onward are removed and a warning note
   records what happened. Later checkpoints are dropped.

Refused while a turn is running or queued. Verified live: after reverting an edit turn, the
model answers "no" to "have you edited any files in this conversation?".

## Dependency policy

See README → "the 7-day rule". pnpm's `minimumReleaseAge` enforces it at resolution time;
`onlyBuiltDependencies: []` blocks install scripts; `scripts/pkg-age.mjs` re-audits the
committed lockfile in CI so a misconfigured workspace file or hand-edited lock is caught.

## Messages sent mid-turn

A message typed while the agent is working goes *into* the running turn rather than behind
it. The CLI takes queued user messages off its input stream between tool rounds and folds
them into the turn in flight, so a correction lands at the next tool call instead of after
however long the turn has left to run.

`turn.send` on a running thread therefore hands the text straight to the live session
(`ClaudeSession.foldIntoTurn`) and persists the user item with `folded: true` and **the
running turn's `turnId`** — one turn, one checkpoint, one diff, because that is what the SDK
reports back. `finishTurn` clears the flag; the transcript shows "going in at the next tool
boundary" until then. A folded message is not a revert point, so the revert picker skips it.

The old queue survives as the fallback for the case folding cannot cover — a thread marked
running with no live session behind it (`turn.cancelQueued`, `Thread.queuedTurns`, and the
rebuild-from-`queued`-items-on-restart all still apply there).

## Backgrounding a tool call

`turn.background {toolUseId?}` calls the SDK's `Query.backgroundTasks()`, which is what
ctrl+b does in the CLI: every blocking tool call answers immediately with "running in the
background", the turn carries on, and the work reports back later. Without a `toolUseId`
every foreground call moves, which is the binding the TUI uses.

The daemon learns what happened from the CLI's task stream: `task_started` is the only
message carrying both a task id and a `tool_use_id`, so the pair is kept in `ClaudeSession`
and every later message (`task_updated` with `patch.is_backgrounded`, then
`task_notification`) is matched back to its timeline row through it. That row grows a
`ToolCallItem.background` record — `status` goes to `completed` the moment the turn stops
waiting, so `background.state` is what tracks the work itself. A notification for a task
with no row here becomes a plain note instead, unless the CLI marked it ambient.

## Folding a chain of tool calls away (#149)

A *chain* is the run of tool calls and thoughts the agent made between two things it
said. The transcript folds one into a single row that says, in a sentence, what the
chain was for — and the rest of the turn reads as what the agent said, with one row
where the machinery used to be.

The daemon marks the chains. `ChainTracker` in `activity.ts` decides which chain an
item joins and `Engine.persistItem` writes the answer to `ItemBase.groupId`, the id of
the chain's first item. Prose, a user message, a question and an approval close the
chain and join none: a reader must not lose one of those to a fold. A chain never spans
two turns. An item already on disk keeps the chain it was filed under, because a
streaming item is written many times and must never move.

The sentence comes from a weak model, exactly as a thread title does
(`summariseActivity`, beside `title.ts` in shape and in reasoning): one throwaway query,
no tools, no settings files, `persistSession: false`, and `COVEY_ACTIVITY_MODEL=off`
turns it off. It runs when the chain closes and lands on the head item's `groupSummary`,
which reaches the clients as an ordinary `item.upserted`. **Only the tool calls go to
the model** — their names and the one-line summaries `toolSummary.ts` wrote. A thought
folds away but its text is never read and never sent. Until the sentence lands, and for
good when the model is off or failed, the client paints one it derived from the calls
themselves (`chainLabel`), so a folded row always says something.

Three depths, and the reader moves between them one tap at a time: a chain row opens
into the items it holds, and an item opens into what went in and what came back.

A **level of detail** says which of those are open before anybody taps. `Lod` in
`@covey/protocol` names the four — `minimal`, `compact` (the default), `steps` and
`full` — and `timelineRows` in `@covey/client` is the fold itself: pure, node-tested,
and read by the TUI and the web client both, so a chain starts and ends in the same
place on a phone as on a laptop. The rows a reader has changed from the level's default
travel in a `toggled` set rather than a list of open rows, because at `full` a tap
shuts a row instead of opening one.

The level is a preference of the *device*, not of the machine: it travels in no command
and no event. The TUI keeps it in `prefs.lod` and cycles it with ctrl+o; the web client
keeps it in `localStorage` and offers it as **Detail** at the head of the settings page.
`startingLod` reads the `prefs.toolsExpanded` this replaced, so a reader who had every
call showing keeps `full`.

`layoutTranscript` turns those rows into lines, and returns a `toggles` map of line
index → fold key beside the lines themselves — for the same reason `sidebar.ts` returns
painted cells: the click hit test and the painter have to agree on which row is where.
No two rows share a key: a chain's is `chain:` and then its id, never the head item's
own id, or one tap would open both.

## Archiving threads

`Thread.archivedAt` is the only state; the sidebar does the rest. Archived threads leave
their project's thread list for an **Archived** folder inside that project — below its live
threads and inside its fold, so folding the project takes the archive with it — furled until
the user opens it (the fold state lives in `prefs.expanded` under
`${machine}:${projectId}:archived`, defaulting closed where projects default open). Opening
an archived thread is an ordinary selection — the transcript is untouched by archiving.

Archiving is "I am done here", so the thread gives its worktree back rather than leaving a
checkout behind for every thread ever finished: the session is stopped and `git worktree
remove` takes the directory, keeping the branch and every commit on it. It is never forced —
git refuses while the tree holds modified or untracked files (ignored ones like
`node_modules` do not count and go with it), and a tree we cannot remove safely is one we
keep. Either way the thread records what became of it in a note at the end of its
transcript, and keeps its `worktreePath`: that is where the worktree goes back.

A running turn is not archived at all — `thread.archive` fails with `busy` and asks for the
turn to be interrupted first, because the agent is working in the directory that would go.

Sending a message un-archives: `turn.send` clears `archivedAt` before it starts the turn, and
`startTurn` puts a missing worktree back at the same path on the same branch before working
out where to run, so a thread picked up months later runs where every earlier turn did. Turn
diffs survive the gap either way: checkpoints are trees in the repo, which outlives the
worktree they were taken in, so `turn.diff` reads them from the project checkout when the
worktree is gone.

## Notifications

Purely client side: when a thread that is not on screen transitions to waiting-on-approval,
completed, or error, the TUI rings the terminal bell, shows a notice, and marks the sidebar
row until it is opened. `prefs.quiet` disables the bell.

## Tests

`pnpm test` runs unit tests for the pure modules and an integration test that boots two
daemons on loopback with throwaway data dirs and exercises the protocol end to end, including
export → import → markMoved. `COVEY_LIVE_TESTS=1` adds a real Claude turn that checks
streaming, queueing, and diff capture.

## Known gaps / roadmap

- **Windows**: paths, config dirs and the Tailscale binary lookup are in place; `git worktree`,
  signal handling and the alternate-screen escape are untested there.
- **Other providers**: `Thread.provider` and `MachineCapabilities.providers` exist; the
  engine currently instantiates only `ClaudeSession`.
- **Attachments**: drag-and-drop attaches a file of any type, and `ctrl+v` attaches what the
  clipboard holds — a copied file, image bytes of any type the model takes, or text, which
  goes back through the drop parser so a copied path becomes the file it names. macOS reads
  the pasteboard with its own `osascript` and `sips`, and with `pngpaste` when it is there;
  Linux needs `wl-paste` or `xclip`. There is still no reader for Windows.
- **Rust client**: the protocol is the contract; a ratatui client can replace `packages/tui`
  without daemon changes. Worth doing once the protocol stops moving.
- **Local repositories**: a project whose bare repository lives on one machine, with the
  others in the pool pulling from it. The others would have to reach that machine's
  repository, over ssh or over git served by the daemon, and daemons do not talk to each
  other. The upgrade to a remote is easy once it exists: set the remote URL on every member
  and push once.
- **An issue claim every machine can see**: `thread.takeIssue` refuses a number another
  live thread holds on the same machine, and no further. Daemons do not talk to each other,
  so a claim across the pool needs a record on GitHub (an assignee, or a comment), which
  nothing writes yet.
- **A webhook for the watch**: a daemon on a tailnet has no public address, so the watch
  polls. A webhook needs an ingress, and would only make the poll rarer.
