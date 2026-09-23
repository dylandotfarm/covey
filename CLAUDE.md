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
  other. A chip is one key to delete, not one key per character (`tagSpanAt`, `cutTag`).
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
- A covey session knows which thread it is: the daemon puts `COVEY_THREAD_ID` and
  `COVEY_PROJECT_ID` in the environment of every Claude session it starts. Pass the thread
  id back as `threadId` at `hello` and every thread and every run that connection creates
  is filed under it in the sidebar. Leave it out and the work lands beside the thread that
  asked for it, which is what made some agent threads nest and some stand alone.
- Timeline streaming re-sends whole items (same id, accumulated text); there is no delta
  channel. Keep it that way; it makes replay and reconnect trivial.
- Transcripts are keyed by thread id in the SDK session store on purpose (cwd-independent
  so threads can move between machines).
- A thread's session is a subprocess of about 300 MB. The engine releases one after
  `sessionIdleMinutes` (default 120) and holds at most `maxLiveSessions`; the next message
  resumes it from the transcript. `maxLiveSessions` is what bounds the memory, so the idle
  timer only gives memory back under that ceiling — and it charges for it, because the
  resumed session that replaces a fresh one cannot refresh its own token (below). Measured
  over three days: 25 of the 31 released threads came back within two hours, which is the
  number. Never release a session that runs a turn, waits on an
  approval, or still owns a background task — `Engine.sessionBusy` decides, and a background
  task dies with its session. `/health` reports `sessions.live`.
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
  itself, would be revoked for nothing.
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
  end — `watch.test.ts` and `news.test.ts` hold the rules. An engine test passes
  `EngineOptions.ghHost` so no test reaches GitHub. A watch's merge policy is `manual` unless
  the caller says `auto`; under `auto` the daemon merges only what `mergeReadiness` calls
  ready, and never under a running turn. An agent asks with `covey issue …` and `covey pr …`
  (`packages/cli/src/loop.ts`), and the `/covey` skill in `plugin/skills/covey/SKILL.md`
  tells it the loop. `--attach F` on `covey pr open` and `covey pr comment` puts a video or
  an image on the pull request as a GitHub *user attachment*, the only kind that renders
  inline (`integrate/attach.ts` holds the rules; the route is undocumented and
  `uploadAttachment` fails closed on anything but 201, before the push). A video over 10 MB
  is refused unless the owner's plan reads as paid, and a `gh` token without the `user`
  scope cannot read the plan, so keep a demo video under 10 MB. The daemon hands `plugin/` to every session as a local plugin
  (`plugin.ts`); a personal skill in `~/.claude/skills` does not reach a resumed session,
  because the SDK resumes into a temporary `CLAUDE_CONFIG_DIR` that carries no skills.
  Change the CLI and the skill together.
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
  A GitHub user attachment loads through `GET /media?url=…` on the daemon (`media.ts`):
  GitHub answers 404 without the account's token and a five-minute signed redirect with
  it, and the daemon forwards that redirect with the `gh` token. The route is gated like
  the socket, refuses every host but GitHub's two, and is on only with the web client.
