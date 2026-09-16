import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
