# covey

A multi-agent terminal UI for Claude Code, built from scratch on the official
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

- Left sidebar: machines → projects → threads. Many threads run concurrently.
- One small daemon per machine. The TUI connects to any number of them at once.
- Tailscale-native: a daemon bound to your tailnet accepts peers that `tailscale whois`
  says belong to you. No tokens to copy on a personal tailnet.
- Threads can be **moved between machines** and resume with full memory.
- A control panel per machine: update it from git and restart its daemon without leaving the
  TUI, and set the model and permission mode new threads there start with. The client can
  update and relaunch *itself* the same way — no quitting to pull and build.
- Per-turn diffs from git checkpoints, message queueing while a turn runs, and a bell when a
  background thread needs approval or finishes.
- Runs on Node 22+ with zero native dependencies (Linux, macOS; Windows-friendly paths and
  process handling, untested there).

## Quick start

```bash
npm install -g pnpm@12.4.0               # once per machine; pnpm then keeps itself on the pinned version
pnpm install
pnpm run build
node packages/cli/dist/index.js          # opens the TUI; starts a local daemon if none is running
```

After that first build you never have to quit to update: `ctrl+k → "Update covey"` pulls,
rebuilds, restarts the local daemon and relaunches the client in place. `covey update` does
the same from a terminal.

On another machine on the same tailnet:

```bash
node packages/cli/dist/index.js daemon   # foreground daemon, binds to the tailnet IP
node packages/cli/dist/index.js info     # prints the pairing hint and the fallback token
```

Back on the first machine:

```bash
node packages/cli/dist/index.js machines add ws://other-host.your-tailnet.ts.net:3790 --name other
```

Outside Tailscale, append `--token <token from covey info>`.

## Keys

| Key | Where | Action |
|---|---|---|
| `tab` | anywhere | switch focus: sidebar ↔ composer |
| `ctrl+k` | anywhere | command palette |
| `ctrl+n` | anywhere | new thread in the current project |
| `ctrl+t` | anywhere | toggle sidebar |
| `ctrl+o` | anywhere | show every tool call, or fold them back into `>_` rows |
| `ctrl+b` | anywhere | background the running tool calls — the turn moves on, they report back |
| `ctrl+c` ×2 | anywhere | quit |
| `j/k` `enter` | sidebar | move, open thread / fold project / machine control panel |
| `n` / `N` | sidebar | new thread (asks worktree vs. checkout in a repo) / straight to a worktree from HEAD |
| `a` | sidebar | add a project by browsing directories on that machine |
| `m` | sidebar | move thread to another machine |
| `r` `x` `D` | sidebar | rename, archive, delete |
| `enter` / `ctrl+j` | composer | send (a turn already running picks it up at its next tool call) / newline |
| `cmd+d` / `d` | anywhere / sidebar | show the last turn's diff; `j/k` scroll, `d` or `esc` close |
| `ctrl+k` → Revert | anywhere | restore files and conversation to before a chosen turn |
| `enter` on a machine | sidebar | control panel: update (pull, rebuild, restart), restart, default model, default mode |
| `ctrl+k` → Update covey | anywhere | pull, rebuild and relaunch the client itself (and, if you want, restart the local daemon) |
| `esc` | composer | interrupt the running turn |
| `y` `a` `n` | composer | allow / always allow / deny a pending tool approval |
| `1..9` or text | composer | answer a question from Claude |
| `cmd+←/→` `alt+←/→` | composer | caret to line start/end, or a word at a time |
| `cmd+↑↓` `cmd+j/k` | anywhere | scroll the conversation a line; add `shift` for a page (`pgup`/`pgdn` too) |
| `cmd+g` / `cmd+shift+g` | anywhere | jump to the oldest loaded line / back to the newest |
| `cmd+o` | anywhere | expand/collapse the last tool call |
| click | conversation | on a `▸` or `>_` row: fold or unfold it |

The conversation is never focused — `cmd` is its modifier, so scrolling works mid-sentence.
`cmd` needs a terminal that speaks the kitty keyboard protocol (kitty, Ghostty, WezTerm,
iTerm2 ≥ 3.5); everywhere else use `pgup`/`pgdn`, the mouse wheel, and `d` in the sidebar.

## Dependency policy: the 7-day rule

Recent npm supply-chain attacks were caught within days of publication. So this repo only
uses package versions that have been public for at least 7 days, enforced by pnpm itself.

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (minutes). Every `pnpm add` and
  `pnpm install` resolves only versions older than that. There is no wrapper to remember.
- `allowBuilds` denies install scripts per package (`esbuild: false`, `fsevents: false`).
  pnpm 12 fails the install for any dependency with a build script that has no entry, so a
  new one has to be reviewed and added explicitly before it can run code at install time.
- `node scripts/pkg-age.mjs check` (also `pnpm run check:age`) independently audits every
  version in `pnpm-lock.yaml` against the registry's publish times. CI runs it on every push.
- `pnpm run deps:refresh` re-resolves everything to the newest compliant versions.
- pnpm itself is pinned in `package.json → packageManager` to a version older than 7 days.
  Any pnpm ≥ 10 honours that field and switches to the pinned version automatically, so no
  corepack is needed (corepack is deprecated and gone from Node 25).

Override the window with `COVEY_PKG_MIN_DAYS` for the audit script; the pnpm setting is the
source of truth.

## Layout

```
packages/protocol   wire types shared by daemon and TUI
packages/daemon     per-machine daemon: SQLite, Claude SDK sessions, WebSocket server, tailscale auth
packages/tui        Ink (React) terminal client
packages/cli        `covey` entrypoint: tui | daemon | machines | info
docs/DESIGN.md      architecture and the reasoning behind it
```

Data lives in `~/.local/share/covey` (Linux), `~/Library/Application Support/covey` (macOS),
`%APPDATA%\covey` (Windows). Override with `COVEY_HOME` (daemon) and `COVEY_CONFIG` (TUI).
`COVEY_PORT` moves the local daemon and the client that starts it off 3790, so a throwaway
instance can run beside a real one.

## Contributing and licence

covey does not accept pull requests at the moment — see [CONTRIBUTING.md](CONTRIBUTING.md).
Bug reports and ideas are welcome as issues.

MIT licensed. See [LICENSE](LICENSE).
