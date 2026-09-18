/**
 * The launcher puts the terminal back after the client dies.
 *
 * No test inside the client can cover this, because the failure is the absence
 * of a process: V8's out-of-memory path calls `abort()`, and `SIGKILL` and a
 * segfault are the same — no JavaScript runs, so `process.on("exit")` and
 * every signal handler stay silent. Only `bin/covey`, the parent, is still
 * there to turn mouse reporting off and leave the alternate screen.
 *
 * So these tests drive the launcher itself. A stand-in `node` first on the
 * PATH turns the modes on and then dies in the way each test names, which
 * reproduces the 2026-09-18 crash without a four-gigabyte heap. The launcher
 * writes the restore only to a terminal, so the tests that read it run the
 * launcher under a pseudo-terminal from Python's `pty` module; the tests for
 * the exit status need no terminal and use a pipe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const launcher = join(repo, "bin", "covey");
const tuiSrc = join(repo, "packages", "tui", "src");

/** The modes the client turns on: mouse reporting, then the alternate screen. */
const ENABLE = "\x1b[?1002h\x1b[?1006h\x1b[?1049h";
/** What the launcher owes the terminal afterwards, whatever killed the client. */
const RESTORE = "\x1b[?1002l\x1b[?1006l\x1b[?1049l";

const dirs: string[] = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A copy of the launcher in a root of its own, with a stand-in `node` first on
 * the PATH. The copy keeps the real build out of the test: the stand-in
 * answers `node -v` for the version test, then runs the scenario in
 * `$COVEY_CHILD` instead of the client.
 */
function stage(scenario: string): { bin: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "covey-restore-"));
  dirs.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  // The launcher builds the checkout when this file is missing. The stand-in
  // never reads it; it only has to be there.
  writeFileSync(join(root, "packages", "cli", "dist", "index.js"), "// stand-in\n");
  const bin = join(root, "bin", "covey");
  writeFileSync(bin, readFileSync(launcher, "utf8"));
  chmodSync(bin, 0o755);
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  const node = join(fakeBin, "node");
  writeFileSync(node, '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.0.0; exit 0; fi\nexec "$COVEY_REAL_NODE" -e "$COVEY_CHILD"\n');
  chmodSync(node, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    COVEY_REAL_NODE: process.execPath,
    COVEY_CHILD: scenario,
  };
  return { bin, env };
}

/** A child that turns the modes on, says so, and then dies as `end` says. */
const child = (end: string) =>
  `const fs=require("fs");fs.writeSync(1,${JSON.stringify(ENABLE)}+"CHILD-UP\\n");${end}`;

/**
 * Run the launcher with its three standard streams on a pseudo-terminal, and
 * give back everything the terminal saw. `SIG` and `AFTER` send one signal to
 * the whole process group — what the terminal driver does on ctrl+c — as soon
 * as the marker appears, so the signal lands while the client is still up.
 */
const PTY_RUNNER = `
import json, os, pty, select, signal, subprocess, sys
master, slave = pty.openpty()
p = subprocess.Popen(["/bin/sh", sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
out = b""
sig = os.environ.get("SIG") or ""
after = (os.environ.get("AFTER") or "").encode()
sent = False
while True:
    try:
        ready, _, _ = select.select([master], [], [], 20)
        if not ready:
            break
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if sig and after and not sent and after in out:
        sent = True
        os.killpg(os.getpgid(p.pid), getattr(signal, "SIG" + sig))
print(json.dumps({"out": out.decode("utf8", "replace"), "code": p.wait()}))
`;

/** `code` is the exit status, or the negative signal number that killed it. */
interface PtyRun { out: string; code: number }

function inPty(scenario: string, opts: { signal?: string; after?: string } = {}): PtyRun {
  const { bin, env } = stage(scenario);
  const r = spawnSync("python3", ["-c", PTY_RUNNER, bin], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...env, SIG: opts.signal ?? "", AFTER: opts.after ?? "" },
  });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as PtyRun;
  } catch {
    throw new Error(`the pseudo-terminal run said nothing readable.\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
}

function inPipe(scenario: string): SpawnSyncReturns<string> {
  const { bin, env } = stage(scenario);
  return spawnSync("/bin/sh", [bin], { encoding: "utf8", timeout: 30_000, env });
}

const show = (r: PtyRun) => `exit ${r.code}\n--- the terminal saw ---\n${JSON.stringify(r.out)}`;

const noPty = spawnSync("python3", ["-c", "import pty"]).status === 0
  ? false
  : "no python3 with the pty module on this machine";
const noExecve = "execve" in process ? false : "this Node has no process.execve";

// The crash of 2026-09-18: V8 aborts, and nothing in the client ever runs again.
test("an abort leaves mouse reporting off", { skip: noPty }, () => {
  const r = inPty(child("process.abort()"));
  assert.ok(r.out.includes(ENABLE), `the stand-in never turned the modes on, so this test proves nothing.\n${show(r)}`);
  assert.ok(r.out.endsWith(RESTORE),
    `the launcher left the terminal in mouse reporting after an abort: every wheel notch now types itself into the shell.\n${show(r)}`);
  assert.equal(r.code, -6, `the abort did not reach the parent shell as SIGABRT.\n${show(r)}`);
});

test("a SIGKILL leaves mouse reporting off", { skip: noPty }, () => {
  const r = inPty(child('process.kill(process.pid,"SIGKILL")'));
  assert.ok(r.out.endsWith(RESTORE), `the launcher left the terminal in mouse reporting after a SIGKILL.\n${show(r)}`);
  assert.equal(r.code, -9, `the SIGKILL did not reach the parent shell.\n${show(r)}`);
});

test("a failed exit leaves mouse reporting off", { skip: noPty }, () => {
  const r = inPty(child("process.exit(3)"));
  assert.ok(r.out.endsWith(RESTORE), `the launcher left the terminal in mouse reporting after a failed exit.\n${show(r)}`);
  assert.equal(r.code, 3, `the exit status did not come through the launcher.\n${show(r)}`);
});

test("a clean exit leaves mouse reporting off", { skip: noPty }, () => {
  const r = inPty(child(""));
  assert.ok(r.out.endsWith(RESTORE), `the launcher left the terminal in mouse reporting after a clean exit.\n${show(r)}`);
  assert.equal(r.code, 0, show(r));
});

// A wrapper that eats the status breaks `covey` in a script and in an `&&` chain.
test("the exit status comes through the launcher", () => {
  const clean = inPipe(child(""));
  assert.equal(clean.status, 0, `a clean exit did not come through as 0.\n${clean.stdout}${clean.stderr}`);
  const failed = inPipe(child("process.exit(3)"));
  assert.equal(failed.status, 3, `exit 3 did not come through.\n${failed.stdout}${failed.stderr}`);
});

test("a client killed by a signal kills the launcher the same way", () => {
  const aborted = inPipe(child("process.abort()"));
  assert.equal(aborted.signal, "SIGABRT", `an abort came back as exit ${aborted.status}, so the shell no longer says \`abort\`.`);
  const killed = inPipe(child('process.kill(process.pid,"SIGKILL")'));
  assert.equal(killed.signal, "SIGKILL", `a SIGKILL came back as exit ${killed.status}.`);
});

/**
 * ctrl+c goes to every process in the foreground group, so the launcher gets
 * one too. The client owns it: the launcher must wait, and must not restore
 * the terminal under a client that is still running.
 */
test("ctrl+c reaches the client, and the launcher waits for it", { skip: noPty }, () => {
  const scenario = 'const fs=require("fs");fs.writeSync(1,"CHILD-UP\\n");'
    + 'process.on("SIGINT",()=>{fs.writeSync(1,"CHILD-GOT-SIGINT\\n");'
    + 'setTimeout(()=>{fs.writeSync(1,"CHILD-EXITING\\n");process.exit(0);},300);});'
    + "setTimeout(()=>{fs.writeSync(1,\"CHILD-RAN-ON\\n\");process.exit(7);},8000);";
  const r = inPty(scenario, { signal: "INT", after: "CHILD-UP" });
  assert.ok(r.out.includes("CHILD-GOT-SIGINT"),
    `the client never got the SIGINT: the launcher took ctrl+c away from it.\n${show(r)}`);
  assert.ok(r.out.includes(RESTORE), `the launcher left the terminal in mouse reporting after a ctrl+c.\n${show(r)}`);
  assert.ok(r.out.indexOf(RESTORE) > r.out.indexOf("CHILD-EXITING"),
    `the launcher restored the terminal while the client was still running.\n${show(r)}`);
  assert.equal(r.code, 0, `the launcher did not report what the client did with the SIGINT.\n${show(r)}`);
});

/**
 * The client updates itself in place with `process.execve`: same pid, same
 * terminal. The launcher waits on that pid, so a relaunch must not stack a
 * second launcher, and the terminal must be restored once, at the end.
 */
test("an in-place relaunch keeps one launcher and one restore", { skip: noPty || noExecve }, () => {
  const second = 'require("fs").writeSync(1,"RELAUNCHED\\n")';
  const r = inPty(child(`process.execve(process.execPath,[process.execPath,"-e",${JSON.stringify(second)}],process.env)`));
  assert.ok(r.out.includes("RELAUNCHED"), `the relaunch never came back.\n${show(r)}`);
  assert.ok(r.out.indexOf("RELAUNCHED") > r.out.indexOf("CHILD-UP"), `the relaunch came back out of order.\n${show(r)}`);
  assert.equal(r.out.split(RESTORE).length - 1, 1, `the terminal was restored ${r.out.split(RESTORE).length - 1} times, not once.\n${show(r)}`);
  assert.ok(r.out.endsWith(RESTORE), `the launcher did not restore the terminal after the relaunch.\n${show(r)}`);
  assert.equal(r.code, 0, show(r));
});

test("the launcher writes no escape sequence into a pipe", () => {
  // A child that writes plain text only, so every escape in the output is the
  // launcher's own.
  const r = inPipe('require("fs").writeSync(1,"CHILD-UP\\n")');
  assert.equal(r.stdout, "CHILD-UP\n",
    `the launcher wrote terminal control bytes into a pipe, where they are noise: ${JSON.stringify(r.stdout)}`);
});

/**
 * The launcher holds the list of modes a second time, in shell. This test is
 * what keeps the two lists together: it reads every mode the client turns on
 * out of the TUI sources, and every mode the launcher turns off out of the
 * launcher, and fails when they differ. Add a mode to the client, and this
 * test names the line in `bin/covey` that has to follow.
 */
test("the launcher turns off exactly the modes the client turns on", () => {
  const modes = (text: string, re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]!));
  const on = modes(readTree(tuiSrc), /\\x1b\[\?(\d+)h/g);
  const off = modes(readFileSync(launcher, "utf8"), /\\033\[\?(\d+)l/g);
  assert.ok(on.size > 0, "no mode was found in the TUI sources; this test has stopped reading them");
  assert.deepEqual([...off].sort(), [...on].sort(),
    "bin/covey and the TUI disagree about which terminal modes covey turns on. Put the missing mode in the printf in bin/covey.");
});

/** Every TypeScript source under `dir`, as one string. */
function readTree(dir: string): string {
  let text = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) text += readTree(p);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) text += readFileSync(p, "utf8");
  }
  return text;
}
