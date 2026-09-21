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
  Test the TUI in tmux with small delays between `send-keys`, and capture with
  `tmux capture-pane -p -e` to see colours.
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
  real remote.
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
  `sessionIdleMinutes` (default 15) and holds at most `maxLiveSessions`; the next message
  resumes it from the transcript. Never release a session that runs a turn, waits on an
  approval, or still owns a background task — `Engine.sessionBusy` decides, and a background
  task dies with its session. `/health` reports `sessions.live`.
- Every session on a machine reads one credential store and then holds its access token in
  memory, so a refresh anywhere revokes what the others hold: `401 OAuth access token has
  been revoked`, and that process never recovers — an SDK session has no `/login`. Never make
  the daemon refresh a token; a refresh is the rotation that breaks the siblings. `auth.ts`
  tells this failure from a failure of the work, and the engine drops the session, cycles the
  idle ones and restarts the turn once (`authRecovery.test.ts`).
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
  two writes, `mergePullRequest` and `createPullRequest`, exist on a host only when it was
  built with `allowMerge` or `allowCreate`.
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
  tells it the loop. The daemon hands `plugin/` to every session as a local plugin
  (`plugin.ts`); a personal skill in `~/.claude/skills` does not reach a resumed session,
  because the SDK resumes into a temporary `CLAUDE_CONFIG_DIR` that carries no skills.
  Change the CLI and the skill together.
