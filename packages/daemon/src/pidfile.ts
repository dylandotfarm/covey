import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { dataDir } from "./config.js";

/**
 * One pid file for each port, so a cleanup step can name a port.
 *
 * Every daemon starts with the same first two arguments, `node <dir>/index.js
 * daemon`. A pattern such as `pkill -f "index.js daemon"` therefore matches a
 * throwaway daemon and the daemon that hosts the session equally. A session
 * once killed its own host that way. A port is a name for one daemon. A
 * pattern is not.
 *
 * The file lives under the data directory, which `COVEY_HOME` moves. A
 * throwaway instance keeps its own data directory, so its pid file cannot
 * collide with the pid file of the real daemon.
 */
export interface PidRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export function pidFilePath(port: number): string {
  return join(dataDir(), `daemon-${port}.pid`);
}

/** Record this process as the daemon on `port`. Returns the path it wrote. */
export function writePidFile(port: number): string {
  const file = pidFilePath(port);
  const record: PidRecord = { pid: process.pid, port, startedAt: new Date().toISOString() };
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  return file;
}

/** The record for `port`, or null when no file exists or the file is damaged. */
export function readPidFile(port: number): PidRecord | null {
  const file = pidFilePath(port);
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as PidRecord;
    return Number.isInteger(r?.pid) && r.pid > 0 ? { ...r, port } : null;
  } catch {
    return null;
  }
}

/**
 * Remove the pid file for `port`, but only while it still names `pid`.
 *
 * A restart starts the replacement before the old process finishes its own
 * exit. The replacement overwrites the file with its own pid. The check makes
 * the late removal by the old process a no-op, so the new daemon keeps a pid
 * file.
 */
export function clearPidFile(port: number, pid: number): void {
  const r = readPidFile(port);
  if (r && r.pid !== pid) return;
  try { unlinkSync(pidFilePath(port)); } catch { /* gone already, or never written */ }
}

/**
 * True when a process with this pid can still do something.
 *
 * Signal 0 delivers nothing; it only tests the pid. `EPERM` means the process
 * exists and belongs to another user, so it counts as alive.
 *
 * A zombie does not count. It is a process that has already exited and waits
 * for a parent that will never read its status, and signal 0 succeeds on one
 * for as long as that parent lives. covey makes such a parent itself: the CLI
 * starts the local daemon as a detached child, then relaunches itself with
 * `process.execve`, which keeps the pid and leaves the child watcher behind
 * with the old runtime. The daemon it stops next is nobody's to reap. So
 * `stopDaemon` waited ten seconds on a corpse, said "the daemon did not
 * restart", and skipped the daemon it was about to start — every second update
 * (#153). A zombie holds no port and runs no code, so it is not a daemon.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    return e?.code === "EPERM";
  }
  return !isZombie(pid);
}

/** The `ps` keyword for the process state. BSD spells it one way, POSIX the other. */
const STATE_KEYWORDS = ["state=", "stat="];

/**
 * True when the pid names a process that has exited and was never reaped.
 *
 * Linux answers from `/proc`, which costs one read. Everywhere else `ps`
 * answers: macOS and Linux both print `Z` first in the state column. A
 * question `ps` cannot answer reads as "not a zombie", which is what this file
 * assumed before it could ask at all.
 */
function isZombie(pid: number): boolean {
  if (platform() === "win32") return false;
  if (platform() === "linux") {
    try {
      // The second field is the command, it may hold ")" and spaces, and the
      // state is the character after it. So read from the last ") ", never the
      // first.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(") ");
      return end >= 0 && stat[end + 2] === "Z";
    } catch {
      return false;
    }
  }
  for (const keyword of STATE_KEYWORDS) {
    try {
      const out = execFileSync("ps", ["-o", keyword, "-p", String(pid)], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      return out.toString().trim().startsWith("Z");
    } catch {
      // An unknown keyword, or no `ps` at all. Try the other spelling.
    }
  }
  return false;
}
