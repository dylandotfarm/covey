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

- Palette discipline: near-black greys, three text tiers, one accent. Only the composer has
  a box border. Tool calls are single lines; user messages are a tinted block.
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
   (default 15) loses its session. Idle means no command about that thread and no line from
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
process that is already up. A session quiet for longer than the prompt cache lives (about five
minutes) has no advantage left to hold, which is why the default limit can be a quarter of an
hour.

Both events are visible. The thread gets a note when its session goes, and another when a
turn starts one again, so a slow first reply reads as a resume rather than as a thread that
hangs. The daemon logs both lines, and `/health` reports `sessions: { live, limit,
idleMinutes }` — the number to compare a `ps` list against when a machine holds more `claude`
processes than this daemon started.

`COVEY_SESSION_IDLE_MINUTES` and `COVEY_MAX_LIVE_SESSIONS` seed the two settings for a machine
whose `daemon.json` says nothing. `sessionIdleMinutes: 0` keeps every session for ever.

## Credentials, and the 401 that follows a rotation

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

The daemon cannot refresh the token for the user. A refresh **is** the rotation that revokes
what the other sessions hold, so a daemon that refreshed early would cause the fault it means
to prevent. It does three other things, in `auth.ts` and the engine.

1. **It knows this failure from a failure of the work.** The error text must name the
   credential *and* say that the credential was refused. `401` alone is a page a tool fetched,
   and `invalid` alone is most of what a model ever gets told.
2. **It stops the processes that hold the dead token.** The thread that failed loses its
   session at once. Every session that owes nobody an answer goes with it, because they hold
   the same token. A busy session stays: to kill a turn in flight costs more than the failure
   it saves, and that turn arrives here by itself if its own token is dead.
3. **It restarts the work, once.** A turn that had already written something gets `Go on from
   the point where it stopped`, because the transcript holds that work. A turn that died
   before its first word is sent again word for word, because "go on" means nothing to a model
   that never started. The second failure in a row is a note that names `claude auth login`,
   not a third process — a thread must not talk to itself while the credentials stay broken.

The sweep timer also reads a fingerprint of the credential store: the `mdat` attribute of the
macOS keychain item, or the size and time of `~/.claude/.credentials.json`. A fingerprint that
changed means a rotation, and the idle sessions then go before anybody types into them. The
daemon never reads the token itself. An attribute needs no keychain prompt and costs about
40 ms, and a secret the daemon never reads is a secret it cannot leak. The macOS item holds
the MCP tokens beside the account token, so an MCP login cycles the idle sessions too; that
costs one resume. A store this daemon cannot read gives `null`, the watch stays off, and the
failure path above still catches the fault.

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
`run.gate/memberDiff/queue/merge/audit`.

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

## Browsing the sidebar

The tree is **projects first**. A project is a repository, and one row stands for it however
many machines hold a clone. The client groups every machine's projects by their normalised
remote (`projectGroups` in `store.ts`). The threads of every machine in the pool sit under
the one row, by recency. Each thread row names its machine when the pool has more than one.
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

After the repository, the machines. The pick offers every saved machine,Then the machines. The pick offers every saved machine,
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
in the directory itself.

`thread.delete` removes the thread's worktree. `project.delete` removes the rows; the clone
stays on disk, because its branches may hold commits nobody pushed. A later create for the
same repository finds the clone and fetches rather than cloning again.

## Where a new thread works

Every thread gets its own worktree, `git worktree add --no-track -b covey/<id> … <base>`,
where the base is `origin/HEAD` (else `origin/main`, `origin/master`), and only a local
`main`/`master` in a repo with no remote. Parallel threads in one checkout change the same
files, and a clone has no checkout to offer, so there is no choice to make and nothing to
ask.

covey **fetches `origin` first**. Work is pushed to `origin` and reviewed there, so `origin`
is the truth about what the default branch is; the local branch of that name is one machine's
opinion, and on a machine that dispatches agents it is a stale one, because nobody pulls a
checkout they only ever branch from. Before this (#76) a worktree branched from the local
`main`, which on the macOS host was 46 commits behind `origin/main`, so every agent started
two days back and spent a round merging before its work could land.

The fetch takes one branch, not the whole remote, and is bounded at 20s (a healthy no-op
fetch of this project measures 1.2s to 1.4s). One repository's fetch counts as fresh for a
minute, so a dispatch of eight threads in one project pays for one round trip, not eight.
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

## Folding tool calls away

The transcript collapses the tool calls of every turn *except the newest* into one
`>_ N tool calls` row, drawn where the first of them was. Only the calls fold — the prose
between them stays, so a turn still reads as what the agent said with one row where the
machinery used to be. Clicking the row (or any `▸` row) unfolds it; ctrl+o overrides the
lot and is remembered in `prefs.toolsExpanded`.

`layoutTranscript` owns this, and returns a `toggles` map of line index → fold key beside
the lines themselves — for the same reason `sidebar.ts` returns painted cells: the click
hit test and the painter have to agree on which row is where.

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
- **Attachments**: drag-and-drop attaches a file of any type, and `ctrl+v` attaches the
  clipboard image through `pngpaste` / `wl-paste` / `xclip` when one of them is installed.
  There is no reader for Windows, and no paste for a non-image on the clipboard.
- **Rust client**: the protocol is the contract; a ratatui client can replace `packages/tui`
  without daemon changes. Worth doing once the protocol stops moving.
- **A control for the session limits**: `sessionIdleMinutes` and `maxLiveSessions` are in
  `MachineSettings`, and the machine control panel does not offer them yet. Until it does,
  `daemon.json` or the two environment variables set them.
