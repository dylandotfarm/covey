import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
 * True when a process with this pid exists. Signal 0 delivers nothing; it only
 * tests the pid. `EPERM` means the process exists and belongs to another user,
 * so it counts as alive.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
