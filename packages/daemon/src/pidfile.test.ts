import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

// dataDir() reads COVEY_HOME at call time, so point it at a throwaway dir
// before importing the module under test.
process.env.COVEY_HOME = mkdtempSync(join(tmpdir(), "covey-daemon-pid-"));
const { pidFilePath, writePidFile, readPidFile, clearPidFile, isAlive } = await import("./pidfile.js");

test("the pid file names one port, so a cleanup step never needs a pattern", () => {
  const file = writePidFile(3799);
  assert.equal(file, pidFilePath(3799));
  assert.match(file, /daemon-3799\.pid$/);
  const r = readPidFile(3799);
  assert.equal(r?.pid, process.pid);
  assert.equal(r?.port, 3799);
  assert.ok(r && !Number.isNaN(Date.parse(r.startedAt)), "startedAt is a timestamp");
  // A second port gets a second file. One daemon cannot hide another.
  writePidFile(3790);
  assert.notEqual(pidFilePath(3790), pidFilePath(3799));
  assert.equal(readPidFile(3790)?.port, 3790);
  clearPidFile(3790, process.pid);
});

test("a port with no daemon reads as null", () => {
  assert.equal(readPidFile(3801), null);
});

test("a damaged pid file reads as null instead of a wrong pid", () => {
  writeFileSync(pidFilePath(3802), "not json\n");
  assert.equal(readPidFile(3802), null);
  writeFileSync(pidFilePath(3803), JSON.stringify({ pid: 0, port: 3803 }));
  assert.equal(readPidFile(3803), null, "pid 0 means the whole process group; never return it");
  writeFileSync(pidFilePath(3804), JSON.stringify({ pid: -1, port: 3804 }));
  assert.equal(readPidFile(3804), null, "a negative pid means a process group too");
});

test("a process removes the pid file only while the file still names it", () => {
  writePidFile(3799);
  // A restart writes the replacement's pid before the old process exits.
  const other = process.pid + 1;
  writeFileSync(pidFilePath(3799), JSON.stringify({ pid: other, port: 3799, startedAt: new Date().toISOString() }));
  clearPidFile(3799, process.pid);
  assert.equal(readPidFile(3799)?.pid, other, "the old process must not delete the new daemon's pid file");
  clearPidFile(3799, other);
  assert.equal(existsSync(pidFilePath(3799)), false);
  // Removing a file that is gone already is not an error.
  clearPidFile(3799, other);
});

test("isAlive tells a running daemon from a stale record", () => {
  assert.equal(isAlive(process.pid), true);
  // Pids count up to a large maximum, so one near the top is free.
  assert.equal(isAlive(0x7fffffff), false);
});

/**
 * The case of #153, made the way covey makes it.
 *
 * A helper starts a detached child, exactly as the CLI starts the local daemon,
 * and then replaces its own runtime with `process.execve`, exactly as the TUI
 * relaunches itself. The pid stays, so the helper is still the child's parent,
 * but the new runtime holds no watcher for it. The child covey stops next can
 * never be reaped, and signal 0 answers for it until the helper goes.
 */
test("a zombie daemon is not alive, or every second update reports a restart that worked as a failure (#153)", async (t) => {
  if (typeof (process as any).execve !== "function") return t.skip("this node cannot execve, so it cannot make a zombie the way covey does");
  const pidFile = join(process.env.COVEY_HOME!, "helper-child.pid");
  const idle = "setTimeout(() => {}, 60000)";
  const helper = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "${idle}; process.on('SIGTERM', () => process.exit(0))"], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setTimeout(() => process.execve(process.execPath, [process.execPath, "-e", "${idle}"], process.env), 100);
  `;
  const parent = spawn(process.execPath, ["-e", helper], { stdio: "ignore" });
  t.after(() => { try { parent.kill("SIGKILL"); } catch { /* gone */ } });

  const until = async (want: () => boolean, why: string) => {
    for (let i = 0; i < 80; i++) { if (want()) return; await setTimeout(50); }
    assert.fail(why);
  };
  await until(() => existsSync(pidFile), "the helper never reported the child's pid");
  const child = Number(readFileSync(pidFile, "utf8"));
  assert.ok(child > 0);
  assert.equal(isAlive(child), true, "a running daemon is alive");

  // Let the helper execve first, so nothing is left to reap the child.
  await setTimeout(400);
  process.kill(child, "SIGTERM");
  await until(() => !isAlive(child), "the stopped daemon still reads as alive: isAlive counts a zombie");

  // And the case is the real one: the pid is still there, so the old test —
  // signal 0 alone — would still call this corpse a running daemon.
  let signalled = false;
  try { process.kill(child, 0); signalled = true; } catch { /* reaped after all */ }
  assert.equal(signalled, true, "the child was reaped, so this run proved nothing about a zombie");
});
