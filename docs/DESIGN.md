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
2. TUI hands the export to the destination daemon's `thread.import` with either an existing
   project id or a directory to create a project from. Projects with the same normalised git
   remote are offered first. Transcript `cwd` fields are rewritten to the new root.
3. TUI calls `thread.markMoved` on the source; the old row becomes a tombstone pointing at the
   new machine + thread id and rejects further turns.
4. The next turn on the destination resumes via `SessionStore.load()`. Verified: the resumed
   session recalls earlier tool calls and reports its new working directory.

The client brokers the transfer, so daemons never need to authenticate to each other.

## Protocol

`packages/protocol/src/index.ts`. JSON over one WebSocket. Requests `{id, method, params}`,
responses `{id, ok, result|error}`, pushes `{push, subscriptionId, event}`. Methods: `hello`,
`shell.snapshot/subscribe`, `thread.snapshot/subscribe`, `unsubscribe`, `command`,
`thread.export/import/markMoved`, `fs.listDir/mkdir`, `models.list`, `project.git`, `turn.diff`,
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

Moving the sidebar cursor shows what it is pointing at, so the tree can be read
without committing to anything:

- a **thread** row opens its transcript, debounced by 120 ms so holding ↓ costs
  one `thread.snapshot` rather than one per row. Focus stays in the sidebar;
  enter is what moves you into the composer.
- a **project** row draws a summary in place of the transcript: path and git
  identity, where new threads run, the thread counts, and one line per thread
  with its status, its latest turn's diff and when it last spoke.
- a **machine** row draws the same thing one level up: os/arch, daemon and
  Claude versions, tailnet name, the defaults new threads inherit there, the
  last update, and a line per project.

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
actually painted there, which is not `screenRow - 1`: every machine header is
preceded by a blank line, and a tree taller than the pane is a window over the
rows. So `sidebar.ts` turns the rows into the list of lines as painted, and App
hands that one array to both `Sidebar` and the hit test — the same trick the
transcript uses for drag-selection. The wheel over the sidebar moves the cursor
instead of scrolling a viewport of its own, so one thing decides both what is
visible and what is shown.

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

## Where a new thread works

Parallel threads in one checkout fight over the same files, so in a git repo the first new
thread in a project asks where it should run, and offers to remember the answer:

- **Worktree from `<default branch>`** — `git worktree add -b covey/<id> … <base>`, where the
  base is `origin/HEAD` if that branch exists locally, else the local `main`/`master`. A clean
  start, unaffected by whatever is checked out.
- **Worktree from HEAD** — same, branched from the current checkout.
- **This checkout** — the project directory itself, shared with every other thread. The
  behaviour covey had before, and the only option in a non-git project.

Worktrees live in `<repo>/.covey/worktrees/<thread prefix>`, next to a self-ignoring
`.covey/.gitignore` so they never appear in the main checkout's `git status` — or in turn
checkpoints, which honour `.gitignore`.

The choice is a property of the **project** (`Project.defaultWorkspaceMode`, set through
`project.update`), not of the client, so it holds from any machine that connects. `null`
means ask. The palette's "New threads here" entry changes or clears it; `N` always takes a
worktree from HEAD without asking. A `thread.create` that omits `workspaceMode` falls back to
the project's remembered choice, then to the checkout.

A worktree that cannot be created (not a repo, no commits, no default branch, a name already
taken) fails the command with an error the TUI shows. It is never silently downgraded to the
shared checkout — isolation was the whole point of asking.

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
