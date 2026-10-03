import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { TERMINAL_SCROLLBACK_BYTES, type TerminalEvent, type TerminalSignal } from "@covey/protocol";

/**
 * A shell in a thread's working directory, run by the daemon (#10).
 *
 * The shell has to run here. A thread's directory is a path on this machine,
 * and in the normal setup the client is a laptop somewhere else, so a shell the
 * client spawned would open in the wrong place. The bytes cross the websocket
 * the rest of covey already uses.
 *
 * There is no pty, and there cannot be one cheaply: `node-pty` is a native
 * module, this repository blocks install scripts (`onlyBuiltDependencies: []`),
 * and node ships no pty of its own. So the shell is driven through pipes. That
 * is enough for `git status`, `ls` and `pnpm test`, which is what a reader
 * opens a shell for, and it is not enough for `vim` or `top`.
 *
 * Pipes cost three things, and each is answered here rather than left to the
 * reader to discover:
 *
 * - **No prompt.** A non-interactive shell prints none, so covey draws its own
 *   and needs the directory to put in it. The driver below reports `$PWD`
 *   after every command, which is also how a `cd` shows up on the screen.
 * - **No job control from the terminal.** ctrl+c cannot arrive as a character,
 *   because there is no terminal to turn it into one. `signal` sends the real
 *   signal to the running command's process group instead.
 * - **No colour.** Most tools drop it when stdout is not a tty. `shellEnv`
 *   asks for it back by name, for the handful of tools a reader runs most.
 */

/**
 * The shell script covey drives, and the reason the whole thing works.
 *
 * Commands arrive on **fd 3**, NUL-terminated, and the shell's verdict on each
 * goes out on **fd 4**. Keeping both off stdin is the point: fd 0 stays the
 * *command's* standard input, so `read`, a `y/n` prompt and `cat` with no
 * argument all work, and a command that reads stdin cannot swallow the command
 * covey queued behind it. A shell fed its commands on stdin loses both.
 *
 * Three details are load-bearing:
 *
 * - `eval "$cmd"` runs in the shell itself, not in a subshell and not in the
 *   background. That is what makes `cd` persist to the next command, which is
 *   most of what a reader wants a *shell* for rather than a command runner.
 *   The first draft ran each command as a background job to get it a process
 *   group of its own, and `cd /etc` then moved a subshell that exited.
 * - `trap ':' INT` keeps the shell alive through the ctrl+c that kills what it
 *   is running. A *trapped* signal is reset to its default in a child, so the
 *   command still dies; an *ignored* one (`trap '' INT`) would be inherited as
 *   ignored and ctrl+c would do nothing at all. That one character is the
 *   difference.
 * - A `read` cut short by that signal returns a status above 128, and the loop
 *   has to tell it from the status 1 that means the pipe closed. Without the
 *   distinction, a ctrl+c pressed while the shell sat idle ended the shell.
 *
 * `read -r -d ''` is bash, not POSIX, which is why `findShell` wants bash.
 */
export const DRIVER = `
trap ':' INT
while :; do
  IFS= read -r -d '' __covey_cmd <&3
  __covey_read=$?
  if [ $__covey_read -gt 128 ]; then continue; fi
  if [ $__covey_read -ne 0 ]; then break; fi
  eval "$__covey_cmd"
  printf '%s\\037%s\\036' "$?" "$PWD" >&4
done
`;

/** Ends one command's verdict on fd 4; `\\x1f` separates the two fields in it. */
const VERDICT_END = "\x1e";
const VERDICT_SEP = "\x1f";

/**
 * Which bash to run.
 *
 * The driver uses `read -d`, which dash and the POSIX shell do not have, so
 * this wants bash and says so rather than running something that will fail on
 * the first command. `$SHELL` is honoured when it *is* bash, so a reader whose
 * bash is somewhere unusual gets theirs; anything else falls back to the bash
 * on the PATH. `COVEY_SHELL` overrides both, for a machine where neither
 * guess is right.
 */
export function findShell(env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.COVEY_SHELL?.trim();
  if (forced) return forced;
  const login = env.SHELL?.trim();
  if (login && basename(login) === "bash") return login;
  return "bash";
}

/**
 * The environment a reader's shell gets, which is *not* the one the agent gets.
 *
 * Two differences, both deliberate.
 *
 * The thread's secrets are left out. The agent needs them to do the work and
 * covey takes them back out of everything it writes down (`redact.ts`); a
 * reader needs none of them to run `git status`, and every value in an
 * environment is one more way for a value to reach a screen. A reader who does
 * need one types `covey env exec -- …` in this very shell, which works because
 * the shell runs on the machine that holds the secret.
 *
 * Colour is asked for by name. A tool that sees a pipe where a terminal should
 * be turns colour off, and `git status` without colour is most of why a reader
 * opened this. `GIT_CONFIG_*` is how one git setting is forced without writing
 * to anybody's config file.
 */
export function shellEnv(o: { cols: number; rows: number; base?: NodeJS.ProcessEnv }): Record<string, string> {
  const base = o.base ?? process.env;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.COLUMNS = String(o.cols);
  env.LINES = String(o.rows);
  // A name covey's own clients set; a shell here is not a Claude session, and a
  // script that reads these to find its thread must not find a reader's shell.
  delete env.COVEY_THREAD_ID;
  delete env.COVEY_PROJECT_ID;
  // The reader's panel paints colour, so ask for it. `TERM` is what a tool
  // reads to decide a pipe might still be worth colouring.
  env.TERM = base.TERM && base.TERM !== "dumb" ? base.TERM : "xterm-256color";
  env.FORCE_COLOR = "1";
  env.CLICOLOR_FORCE = "1";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "color.ui";
  env.GIT_CONFIG_VALUE_0 = "always";
  // No pager can work without a terminal to page on, and one that waits for a
  // keypress is a command that never ends.
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  return env;
}

export interface TerminalOptions {
  threadId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Everything the shell says, after the daemon has had its look at it. */
  onEvent: (ev: TerminalEvent) => void;
  /** Overridden by a test, which otherwise reads `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class TerminalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One live shell. The engine owns these; nothing else makes one. */
export class ThreadTerminal {
  readonly id: string;
  readonly threadId: string;
  readonly shell: string;
  cwd: string;
  exitCode: number | null = null;
  /** When the shell last ran something, so the engine can close the stalest. */
  touchedAt = Date.now();
  private child: ChildProcess;
  private commands: NodeJS.WritableStream;
  /**
   * One entry per command the driver still owes a verdict for, and whether the
   * reader is owed one too. A resize is a command the reader never typed, so
   * its verdict is swallowed rather than painted as a command that ran.
   */
  private pending: boolean[] = [];
  private verdicts = "";
  private history: string[] = [];
  private historyBytes = 0;
  private done = false;
  /** The size the panel last asked for, and the size the shell was last told. */
  private want: { cols: number; rows: number };
  private sent: { cols: number; rows: number };

  constructor(id: string, private o: TerminalOptions) {
    this.id = id;
    this.threadId = o.threadId;
    this.cwd = o.cwd;
    this.want = { cols: o.cols, rows: o.rows };
    this.sent = { cols: o.cols, rows: o.rows };
    this.shell = findShell(o.env);
    try {
      this.child = spawn(this.shell, ["-c", DRIVER], {
        cwd: o.cwd,
        env: shellEnv({ cols: o.cols, rows: o.rows, base: o.env }),
        // fd 3 carries the commands in and fd 4 carries the verdicts out, so
        // fd 0 stays the running command's own standard input. See `DRIVER`.
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        // Its own process group, so `signal` can interrupt what the shell is
        // running without covey having to find the child's pid. The shell is in
        // that group too and survives by the trap in `DRIVER`.
        detached: true,
      });
    } catch (e: any) {
      throw new TerminalError("shell", `could not start ${this.shell}: ${e?.message ?? e}`);
    }
    if (!this.child.pid || !this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw new TerminalError("shell", `could not start ${this.shell}`);
    }
    this.commands = this.child.stdio[3] as NodeJS.WritableStream;
    // stdout and stderr go out as one stream, in the order the pipes delivered
    // them: that is the order a terminal would have shown them in, and a reader
    // reading a build failure wants the error beside the line that caused it.
    this.child.stdout.on("data", (d: Buffer) => this.output(d.toString("utf8")));
    this.child.stderr.on("data", (d: Buffer) => this.output(d.toString("utf8")));
    (this.child.stdio[4] as NodeJS.ReadableStream).on("data", (d: Buffer) => this.verdict(d.toString("utf8")));
    this.child.on("exit", (code, signal) => {
      this.done = true;
      this.pending = [];
      this.o.onEvent({ kind: "exit", code, signal });
    });
    // A pipe whose other end has gone raises EPIPE on the next write. There is
    // nothing to do about it and an unhandled one would take the daemon down.
    this.child.on("error", () => {});
    for (const s of [this.child.stdin, this.commands]) s.on("error", () => {});
  }

  /**
   * A command the *reader* ran is still going.
   *
   * Only the reader's, which is why `pending` holds a flag rather than a
   * count: covey's own `COLUMNS=…` is a command the driver owes a verdict for,
   * and reading it as busy sent the reader's next command line into its
   * standard input instead of running it.
   */
  get busy() { return this.pending.includes(true); }
  get ended() { return this.done; }

  /** Everything the shell has written, capped. Handed to every reader who opens. */
  get scrollback(): string { return this.history.join(""); }

  /**
   * Run `data`, or hand it to what is already running.
   *
   * The daemon decides which, because it is the one side that knows for
   * certain whether a command is still going. A client that guessed would send
   * a command line into a build's stdin the moment the build outlived its own
   * idea of the timing.
   */
  write(data: string) {
    if (this.done) throw new TerminalError("closed", "the shell has ended");
    if (this.busy) { this.child.stdin!.write(data); return; }
    const cmd = data.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    // An empty line is what a reader presses to get a fresh prompt. There is
    // nothing to run, so answer it here rather than paying a round of the
    // driver for it.
    if (cmd.trim() === "") { this.o.onEvent({ kind: "ran", exitCode: this.exitCode ?? 0, cwd: this.cwd }); return; }
    // A NUL ends a command in the driver, so one inside a command would cut it
    // in half and run the back of it on its own.
    if (cmd.includes("\0")) throw new TerminalError("bad_input", "a command cannot contain a null byte");
    this.touchedAt = Date.now();
    this.run(cmd, true);
  }

  /**
   * Interrupt the running command, the way ctrl+c does.
   *
   * The signal goes to the whole process group, which is where a pipeline's
   * other halves are; `DRIVER`'s trap is what keeps the shell itself alive. A
   * shell with nothing running is left alone, because the signal would only
   * cut short the `read` it is sitting in.
   */
  signal(sig: TerminalSignal) {
    if (this.done || !this.busy) return;
    const name = sig === "quit" ? "SIGQUIT" : sig === "term" ? "SIGTERM" : "SIGINT";
    try { process.kill(-this.child.pid!, name); } catch { /* it ended between the check and here */ }
  }

  /**
   * The panel's new size.
   *
   * With no pty this cannot reach a command already running — there is no
   * window to resize — so it is written as two assignments the shell runs
   * before the next command. A size that arrives while the shell is busy is
   * remembered and sent when it next goes idle, so dragging a window during a
   * build still leaves the shell with the width it ended at.
   */
  resize(cols: number, rows: number) {
    if (this.done) return;
    this.want = { cols, rows };
    this.sendSize();
  }

  private sendSize() {
    if (this.done || this.pending.length > 0) return;
    if (this.want.cols === this.sent.cols && this.want.rows === this.sent.rows) return;
    this.sent = { ...this.want };
    this.run(`COLUMNS=${this.sent.cols}; LINES=${this.sent.rows}`, false);
  }

  /** Queue one line for the driver. `report` is false for covey's own. */
  private run(cmd: string, report: boolean) {
    this.pending.push(report);
    this.commands.write(cmd + "\0");
  }

  /** End the shell. Closing fd 3 is how `DRIVER`'s loop reaches its end. */
  close() {
    if (this.done) return;
    try { this.commands.end(); } catch { /* already gone */ }
    // A shell waiting on a command of its own will not notice the closed pipe
    // until that command ends, and a reader who asked to close is not waiting.
    try { process.kill(-this.child.pid!, "SIGTERM"); } catch { /* already gone */ }
  }

  private output(data: string) {
    this.keep(data);
    this.o.onEvent({ kind: "output", data });
  }

  /**
   * One verdict from fd 4: the exit status and where the shell now stands.
   *
   * Read as a stream, not as a message, because a pipe may cut anywhere — and
   * `\x1e` rather than a newline, so a `$PWD` with a newline in it (which a
   * directory may have) cannot be read as two verdicts.
   */
  private verdict(chunk: string) {
    this.verdicts += chunk;
    let at: number;
    while ((at = this.verdicts.indexOf(VERDICT_END)) >= 0) {
      const body = this.verdicts.slice(0, at);
      this.verdicts = this.verdicts.slice(at + 1);
      const sep = body.indexOf(VERDICT_SEP);
      if (sep < 0) continue;
      const code = Number(body.slice(0, sep));
      this.cwd = body.slice(sep + 1) || this.cwd;
      const report = this.pending.shift() ?? true;
      this.touchedAt = Date.now();
      if (!report) { this.sendSize(); continue; }
      this.exitCode = Number.isFinite(code) ? code : null;
      this.o.onEvent({ kind: "ran", exitCode: this.exitCode ?? 0, cwd: this.cwd });
      this.sendSize();
    }
  }

  /**
   * Keep the tail of the output, bounded by bytes rather than by chunks.
   *
   * Bytes, because one chunk is a prompt and another is a megabyte of test
   * output, and a bound on chunks would hold either four lines or four
   * screenfuls depending on which (the rule `PreviewCache` follows, #163).
   * The oldest chunk goes whole: half a chunk is a line cut mid-escape, and
   * the client's parser would paint the rest of the screen in whatever colour
   * the cut was in.
   */
  private keep(data: string) {
    this.history.push(data);
    // `byteLength`, not `length`: the cap is named in bytes and a string's
    // length is a count of UTF-16 code units, so a shell writing anything but
    // ASCII kept more than the number says. Both sides of the sum, or the
    // running total drifts the other way — subtracting 1000 for a chunk that
    // added 3000 trimmed the whole scrollback down to its last chunk.
    this.historyBytes += Buffer.byteLength(data, "utf8");
    while (this.historyBytes > TERMINAL_SCROLLBACK_BYTES && this.history.length > 1) {
      this.historyBytes -= Buffer.byteLength(this.history.shift()!, "utf8");
    }
  }
}
