import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalEvent } from "@covey/protocol";
import { DRIVER, ThreadTerminal, findShell, shellEnv } from "./terminal.js";

/**
 * The shell a reader opens on a thread (#10).
 *
 * These start a real bash, because the whole of this file is a claim about
 * what bash does with four pipes: that `cd` persists, that ctrl+c kills the
 * command and not the shell, and that a ctrl+c with nothing running is not the
 * end of the shell. A fake would answer whatever the test expected.
 */

/** A terminal in a scratch directory, with everything it said collected. */
function openShell(cwd?: string) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "covey-term-"));
  const events: TerminalEvent[] = [];
  const term = new ThreadTerminal("t1", {
    threadId: "th1", cwd: dir, cols: 80, rows: 24,
    onEvent: (ev) => events.push(ev),
  });
  return { term, events, dir };
}

/** Wait until `fn` is true, or give up. A shell answers in milliseconds. */
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const output = (events: TerminalEvent[]) => events.filter((e) => e.kind === "output").map((e) => (e as { data: string }).data).join("");
const ran = (events: TerminalEvent[]) => events.filter((e) => e.kind === "ran") as { kind: "ran"; exitCode: number; cwd: string }[];

test("runs a command and reports where the shell stands", async () => {
  const { term, events, dir } = openShell();
  try {
    term.write("echo hello\n");
    await until(() => ran(events).length === 1);
    assert.match(output(events), /hello/);
    assert.equal(ran(events)[0]!.exitCode, 0);
    // The directory is reported so covey can draw a prompt; a shell with no
    // pty prints none of its own.
    assert.match(ran(events)[0]!.cwd, new RegExp(dir.replace(/\//g, "/") + "$"));
  } finally { term.close(); }
});

test("stderr and stdout arrive as one stream", async () => {
  const { term, events } = openShell();
  try {
    term.write("echo out; echo err 1>&2\n");
    await until(() => ran(events).length === 1);
    const text = output(events);
    assert.match(text, /out/);
    assert.match(text, /err/);
  } finally { term.close(); }
});

test("a cd lasts to the next command", async () => {
  const { term, events, dir } = openShell();
  mkdirSync(join(dir, "inner"));
  try {
    term.write("cd inner\n");
    await until(() => ran(events).length === 1);
    assert.match(ran(events)[0]!.cwd, /inner$/);
    term.write("pwd\n");
    await until(() => ran(events).length === 2);
    // The point of the whole fd-3 arrangement: the command runs in the shell
    // itself, so the directory it moved to is the one the next command gets.
    // A driver that backgrounded each command passed this nowhere.
    assert.match(output(events), /inner/);
    assert.match(ran(events)[1]!.cwd, /inner$/);
  } finally { term.close(); }
});

test("an exit status comes back", async () => {
  const { term, events } = openShell();
  try {
    // A bare `exit 7` would be the end of the shell, not a status to report:
    // `eval` runs in the shell itself, which is the same property that makes
    // `cd` work. A subshell is how a reader asks for a status on purpose.
    term.write("(exit 7)\n");
    await until(() => ran(events).length === 1);
    assert.equal(ran(events)[0]!.exitCode, 7);
  } finally { term.close(); }
});

test("an interrupt ends the command and the shell carries on", async () => {
  const { term, events } = openShell();
  try {
    term.write("echo started; sleep 30 | cat\n");
    // Wait for the command to be *running*, not merely queued: the shell takes
    // a moment to read it, and a signal that arrives first lands on the `read`
    // the shell is still sitting in.
    await until(() => output(events).includes("started"));
    term.signal("int");
    await until(() => ran(events).length === 1);
    // 130 is 128 + SIGINT: the command died of the signal rather than finished.
    assert.equal(ran(events)[0]!.exitCode, 130);
    // And the shell is still there. `trap ':' INT` is what buys this: a
    // trapped signal is reset to its default in the child, so `sleep` dies
    // while the shell runs the trap and goes back to its read.
    term.write("echo alive\n");
    await until(() => ran(events).length === 2);
    assert.match(output(events), /alive/);
  } finally { term.close(); }
});

test("an interrupt with nothing running does not end the shell", async () => {
  const { term, events } = openShell();
  try {
    term.write("echo first\n");
    await until(() => ran(events).length === 1);
    term.signal("int");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!term.ended);
    term.write("echo second\n");
    await until(() => ran(events).length === 2);
    assert.match(output(events), /second/);
  } finally { term.close(); }
});

test("a running command reads what is typed next", async () => {
  const { term, events } = openShell();
  try {
    term.write("read answer; echo got $answer\n");
    await until(() => term.busy);
    // The reader's next line is the command's standard input, because fd 0 was
    // never used for the commands. A shell fed on stdin would have swallowed
    // the queued command instead.
    term.write("yes\n");
    await until(() => ran(events).length === 1);
    assert.match(output(events), /got yes/);
  } finally { term.close(); }
});

test("an empty line answers at once and runs nothing", async () => {
  const { term, events } = openShell();
  try {
    term.write("\n");
    await until(() => ran(events).length === 1);
    assert.equal(output(events), "");
  } finally { term.close(); }
});

test("a resize is not reported as a command the reader ran", async () => {
  const { term, events } = openShell();
  try {
    term.resize(120, 40);
    term.write("echo $COLUMNS\n");
    await until(() => ran(events).length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(output(events), /120/);
    // One `ran`, for the one command the reader typed. Covey's own line is a
    // command the driver owes a verdict for and the reader does not.
    assert.equal(ran(events).length, 1);
  } finally { term.close(); }
});

test("closing ends the shell", async () => {
  const { term, events } = openShell();
  try {
    term.write("echo hi\n");
    await until(() => ran(events).length === 1);
    term.close();
    await until(() => events.some((e) => e.kind === "exit"));
    assert.ok(term.ended);
  } finally { term.close(); }
});

test("a command with a null byte in it is refused", async () => {
  const { term } = openShell();
  try {
    // A NUL is what ends a command in the driver, so one inside a command
    // would cut it in half and run the back of it on its own.
    assert.throws(() => term.write("echo a\0b\n"), /null byte/);
  } finally { term.close(); }
});

test("the scrollback is kept for a reader who comes back", async () => {
  const { term, events } = openShell();
  try {
    term.write("echo remembered\n");
    await until(() => ran(events).length === 1);
    assert.match(term.scrollback, /remembered/);
  } finally { term.close(); }
});

test("findShell prefers bash and honours COVEY_SHELL", () => {
  assert.equal(findShell({ COVEY_SHELL: "/opt/bash" }), "/opt/bash");
  assert.equal(findShell({ SHELL: "/usr/local/bin/bash" }), "/usr/local/bin/bash");
  // The driver uses `read -d`, which these do not have, so their reader gets
  // bash rather than a shell that fails on the first command.
  assert.equal(findShell({ SHELL: "/bin/zsh" }), "bash");
  assert.equal(findShell({ SHELL: "/usr/bin/fish" }), "bash");
  assert.equal(findShell({}), "bash");
});

test("the shell's environment asks for colour and carries no covey names", () => {
  const env = shellEnv({ cols: 100, rows: 30, base: { PATH: "/bin", COVEY_THREAD_ID: "t1", COVEY_PROJECT_ID: "p1", TERM: "dumb" } });
  assert.equal(env.COLUMNS, "100");
  assert.equal(env.LINES, "30");
  assert.equal(env.FORCE_COLOR, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "color.ui");
  assert.equal(env.GIT_CONFIG_VALUE_0, "always");
  // A pager with no terminal to page on is a command that never ends.
  assert.equal(env.PAGER, "cat");
  // `dumb` is the one TERM a tool reads as "do not colour anything".
  assert.equal(env.TERM, "xterm-256color");
  // A script that reads these to find its thread must not find a reader's
  // shell: this is not a Claude session and files no work under the thread.
  assert.equal(env.COVEY_THREAD_ID, undefined);
  assert.equal(env.COVEY_PROJECT_ID, undefined);
});

test("the driver keeps the shell alive through an interrupt", () => {
  // Asserted on the text because these three lines are the reason the whole
  // arrangement works, and each is one character away from a bug that only
  // shows up under a reader's finger. See the note above `DRIVER`.
  assert.match(DRIVER, /trap ':' INT/);
  assert.match(DRIVER, /-gt 128.*continue/s);
  assert.match(DRIVER, /eval "\$__covey_cmd"/);
});
