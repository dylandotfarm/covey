# covey — notes for agents working in this repo

- pnpm workspaces (version pinned via `packageManager`; install once with
  `npm i -g pnpm@12.4.0`, no corepack), TypeScript project
  references. Build everything with `pnpm run build` (`tsc -b`). No bundler, no native deps.
  Node ≥ 22 (uses `node:sqlite`).
- Packages: `protocol` (types only) → `daemon` and `tui` → `cli`. Change the protocol first,
  then both sides.
- `pnpm run setup` (`scripts/setup.mjs`) is the one-machine install: it installs, builds, and
  links `bin/covey` into a directory on the PATH. The launcher follows its own symlink back
  to the checkout, so a linked `covey` always runs that checkout — keep it that way.
- Ink 7 batches fast keystrokes and pastes into one `useInput` call; `App.tsx` splits them.
  Test the TUI in tmux with small delays between `send-keys`, and capture with
  `tmux capture-pane -p -e` to see colours.
- Ink cannot paint under `position="absolute"`; overlays render in place of the transcript.
- Screen rows are not row indices: the sidebar puts a blank line above each machine
  and windows a long tree. `sidebar.ts` builds the painted line list and `App.tsx` gives
  the same array to the renderer and to the mouse hit test — change both or neither.
- The daemon can be exercised without the TUI: run `node packages/daemon/dist/main.js
  --bind loopback --port 3799` with `COVEY_HOME=/tmp/x`, then speak JSON over ws (see
  `docs/DESIGN.md` → Protocol).
- Timeline streaming re-sends whole items (same id, accumulated text); there is no delta
  channel. Keep it that way; it makes replay and reconnect trivial.
- Transcripts are keyed by thread id in the SDK session store on purpose (cwd-independent
  so threads can move between machines).
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
- Dependencies: `pnpm add <pkg>`; pnpm refuses versions younger than 7 days
  (`minimumReleaseAge` in pnpm-workspace.yaml). Keep `pnpm run check:age` green. Install
  scripts are blocked (`onlyBuiltDependencies: []`); never use npm in this repo.
