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
- A web client for a phone, served by the daemon on your tailnet or LAN: the same projects
  and threads, one open at a time, to check on the work and start a new idea from anywhere.
- Runs on Node 22+ with zero native dependencies (Linux, macOS; Windows-friendly paths and
  process handling, untested there).

## Quick start

One machine, from a fresh clone:

```bash
npm install -g pnpm@12.4.0               # once per machine; pnpm then keeps itself on the pinned version
git clone https://github.com/dylandotfarm/covey.git && cd covey
pnpm run setup                           # installs, builds, and puts `covey` on your PATH
covey                                    # opens the TUI; starts a local daemon if none is running
```

`pnpm run setup` links a small launcher (`bin/covey`) into a directory of yours that is
already on your PATH — `$PNPM_HOME`, `~/.local/bin` or `~/bin`. If none of them is on the
PATH it says so and prints the line to add. To have it write that line for you:

```bash
pnpm run setup --add-to-path             # appends to ~/.zshrc, ~/.bashrc or config.fish
pnpm run setup --bin-dir ~/bin           # or choose the directory yourself
```

It also links the `/covey` skill (`skills/covey`) into `~/.claude/skills`, so an agent inside
a covey thread knows how to take an issue to a merged pull request with `covey issue take`
and `covey pr open`. A brief is then one line: `/covey take issue 94 to completion, automerge
when done`.

The launcher and the skill always run from the checkout they were linked from, so `git pull`
is enough to update both, and the daemon makes the skill link again on every start. Run the
setup again only if you move the checkout. To install without it, run the entry
point directly:

```bash
pnpm install && pnpm run build
node packages/cli/dist/index.js
```

After that first build you never have to quit to update: `ctrl+k → "Update covey"` pulls,
rebuilds, restarts the local daemon and relaunches the client in place. `covey update` does
the same from a terminal.

### More machines

On another machine on the same tailnet, set it up the same way, then run the daemon there:

```bash
covey daemon                             # foreground daemon, binds to the tailnet IP
covey info                               # prints the pairing hint and the fallback token
```

Back on the first machine:

```bash
covey machines add ws://other-host.your-tailnet.ts.net:3790 --name other
```

Outside Tailscale, append `--token <token from covey info>`.

### On a phone

One machine in your fleet serves a web client at `http://<machine>:3790/`. Turn it on from
the TUI: press enter on the machine row, then choose "Web server: off". The machine's info
card shows whether it is on and at which address, and starting it on a second machine stops
it on the first, so a phone always has one address to keep. `covey info` prints the
address. On the tailnet the phone needs no token: the daemon accepts it because
`tailscale whois` says it is yours. On the LAN, run the daemon with `--bind all` and open the
URL that carries `?token=`; the page keeps the token, so you type it one time. Or skip the
typing: open the page over the tailnet first, tap the gear, and under "Get LAN address" tap
the LAN address. The link carries the token, and that address keeps it from then on. The
browser keeps a token per address, so this hand-off is the way one address learns it from
another. Add the page to the home screen and it opens without the browser's bars.

The phone shows the projects and threads of every machine the TUI knows, with the same
status dots the TUI shows. The machine that serves the page gets the list from the TUI when
you start the web server there, and again whenever you add or remove a machine. A project
checked out on two machines is one row, and `+` asks which machine the new thread goes to.
On the tailnet the phone needs no token for any of them. Tap a thread to read it, follow a turn as it streams, send a message, stop a turn,
and answer an approval or a question. Tap `+` on a project to start a thread. The phone does
not dispatch runs, move threads, or update machines; the TUI does those.

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
packages/cli        `covey` entrypoint: tui | daemon | machines | info | restart | stop,
                    and `covey issue …` / `covey pr …` for an agent inside a thread
bin/covey           launcher that setup links onto your PATH; runs its own checkout,
                    waits for it, and puts the terminal back however it died
skills/covey        the /covey skill: how an agent takes an issue to a merged pull request
scripts/setup.mjs   one command from a clone: install, build, link the launcher and the skill
docs/DESIGN.md      architecture and the reasoning behind it
```

Data lives in `~/.local/share/covey` (Linux), `~/Library/Application Support/covey` (macOS),
`%APPDATA%\covey` (Windows). Override with `COVEY_HOME` (daemon) and `COVEY_CONFIG` (TUI).
`COVEY_PORT` moves the local daemon and the client that starts it off 3790, so a throwaway
instance can run beside a real one. Stop one of them by port — `covey stop --port 3799` —
and never by a pattern over the command line: every daemon runs the same program, so a
pattern matches all of them. Each daemon writes `<COVEY_HOME>/daemon-<port>.pid` while it
runs, and takes that file away when it stops.

## Contributing and licence

covey does not accept pull requests at the moment — see [CONTRIBUTING.md](CONTRIBUTING.md).
Bug reports and ideas are welcome as issues. For a vulnerability, do not open an issue —
follow [SECURITY.md](SECURITY.md) instead.

MIT licensed. See [LICENSE](LICENSE).
