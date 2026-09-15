/**
 * Updating a machine from inside the app: pull the daemon's own checkout,
 * reinstall if the lockfile moved, rebuild, and restart the daemon.
 *
 * The restart is the awkward part — a process cannot free its own port and then
 * bind it again. So we hand the job to a tiny detached node process: it waits
 * for this pid to disappear, then starts the daemon again with the exact same
 * argv, cwd and log file. That is the same dance `covey restart` does from a
 * terminal, minus the terminal.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { MachineSource, MachineUpdate, UpdateStep, UpdateStepName } from "@covey/protocol";
import { dataDir } from "./config.js";

const run = promisify(execFile);

/** Per-step cap on captured output; we keep the tail, which is where errors are. */
const MAX_OUTPUT = 8_000;

/** Longest a single step may take before it is killed (a Pi builds slowly). */
const STEP_TIMEOUT_MS = 10 * 60_000;

export function tail(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : "…" + text.slice(text.length - max);
}

/**
 * The git checkout a process is running out of: walk up from `from` (our own
 * module by default) until a `.git` turns up. Installed some other way
 * (tarball, npm) there is no source root, and we say so rather than guess.
 * The CLI passes its own directory, so "the client's checkout" is the one the
 * client was launched from even if a shared package lives elsewhere.
 */
export function sourceRoot(from = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  const root = parse(dir).root;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 15_000, env: gitEnv() });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Never let git stop for credentials: a prompt would hang the daemon's update. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export async function sourceInfo(from?: string): Promise<MachineSource> {
  const root = sourceRoot(from);
  if (!root) {
    return { root: null, branch: null, commit: null, subject: null, dirty: false, remote: null, canUpdate: false, reason: "not running from a git checkout" };
  }
  const [branch, commit, subject, status, remote] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["log", "-1", "--pretty=%s"]),
    git(root, ["status", "--porcelain"]),
    git(root, ["remote", "get-url", "origin"]),
  ]);
  const canUpdate = !!remote;
  return {
    root,
    branch: branch === "HEAD" ? null : branch,
    commit,
    subject,
    dirty: !!status,
    remote,
    canUpdate,
    ...(canUpdate ? {} : { reason: "the checkout has no `origin` remote to pull from" }),
  };
}

type Emit = (u: MachineUpdate) => void;

/**
 * Owns the one update that may be in flight, and fans progress out to every
 * connected client (an update affects them all, so it is broadcast rather than
 * subscribed to).
 */
export class Updater {
  private listeners = new Set<Emit>();
  /** The run in flight, or the last one that finished. */
  current: MachineUpdate | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Resolves when the run in flight finishes; awaited by `runToCompletion`. */
  private pending: Promise<void> = Promise.resolve();

  /** `from` scopes which checkout is updated; defaults to this module's own. */
  constructor(private machineId: string, private log: (m: string) => void, private from?: string) {}

  on(l: Emit): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private emit(now = true) {
    if (!this.current) return;
    if (!now) {
      // Output arrives line by line; coalesce so a noisy build does not send a
      // message per line to every client.
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.emit(); }, 150);
      return;
    }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const snapshot = structuredClone(this.current);
    for (const l of this.listeners) l(snapshot);
  }

  /**
   * Start an update. Returns the initial record straight away — the work runs
   * in the background and reports through `on()`. A call while one is already
   * running returns the run in flight instead of starting a second.
   */
  start(opts: { restart?: boolean } = {}): MachineUpdate {
    if (this.current?.state === "running" || this.current?.state === "restarting") return structuredClone(this.current);
    const restart = opts.restart !== false;
    const steps: UpdateStep[] = [
      step("pull", "pull", "git pull --ff-only"),
      step("install", "install", "pnpm install --frozen-lockfile"),
      step("build", "build", "pnpm run build"),
      ...(restart ? [step("restart", "restart", "restart the daemon")] : []),
    ];
    this.current = {
      id: randomUUID(), machineId: this.machineId, state: "running", steps,
      startedAt: new Date().toISOString(), finishedAt: null, error: null, fromCommit: null, toCommit: null,
    };
    this.pending = this.run(restart);
    return structuredClone(this.current);
  }

  /**
   * Start and wait. The daemon fires and forgets (clients watch the pushes);
   * the CLI has a terminal to report into and needs to know when it is done —
   * it updates the checkout the TUI is about to be relaunched from.
   */
  async runToCompletion(opts: { restart?: boolean } = {}): Promise<MachineUpdate> {
    this.start(opts);
    await this.pending;
    return structuredClone(this.current!);
  }

  private stepByName(name: UpdateStepName): UpdateStep {
    return this.current!.steps.find((s) => s.name === name)!;
  }

  private fail(message: string) {
    const u = this.current!;
    u.state = "failed";
    u.error = message;
    u.finishedAt = new Date().toISOString();
    for (const s of u.steps) if (s.status === "pending" || s.status === "running") s.status = s.status === "running" ? "failed" : "skipped";
    this.log(`update failed: ${message}`);
    this.emit();
  }

  private async run(restart: boolean) {
    const u = this.current!;
    const src = await sourceInfo(this.from);
    if (!src.root || !src.canUpdate) return this.fail(src.reason ?? "this machine cannot update itself");
    const root = src.root;
    u.fromCommit = src.commit;
    this.emit();

    const lockBefore = hashFile(join(root, "pnpm-lock.yaml"));
    if (!(await this.exec(this.stepByName("pull"), "git", ["pull", "--ff-only"], root, gitEnv()))) {
      return this.fail(src.dirty
        ? "git pull failed — the checkout has uncommitted changes"
        : "git pull failed");
    }
    u.toCommit = await git(root, ["rev-parse", "--short", "HEAD"]);
    this.emit();

    const install = this.stepByName("install");
    if (hashFile(join(root, "pnpm-lock.yaml")) === lockBefore) {
      install.status = "skipped";
      install.note = "dependencies unchanged";
      this.emit();
    } else if (!(await this.exec(install, "pnpm", ["install", "--frozen-lockfile"], root))) {
      return this.fail("pnpm install failed");
    }

    if (!(await this.exec(this.stepByName("build"), "pnpm", ["run", "build"], root))) {
      return this.fail("build failed — the daemon was left running the old code");
    }

    if (!restart) {
      u.state = "succeeded";
      u.finishedAt = new Date().toISOString();
      this.emit();
      return;
    }

    const rs = this.stepByName("restart");
    rs.status = "running";
    u.state = "restarting";
    this.emit();
    try {
      const pid = scheduleRestart(this.log);
      rs.status = "ok";
      rs.output = `restarter pid ${pid}`;
      u.finishedAt = new Date().toISOString();
      this.emit();
    } catch (e: any) {
      rs.status = "failed";
      rs.output = tail(String(e?.message ?? e));
      return this.fail(`could not schedule a restart: ${e?.message ?? e}`);
    }
  }

  /** Run one step, streaming its output into the record. Resolves to success. */
  private exec(s: UpdateStep, cmd: string, args: string[], cwd: string, env = childEnv()): Promise<boolean> {
    return new Promise((resolve) => {
      s.status = "running";
      s.output = "";
      this.emit();
      this.log(`update: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        s.note = `timed out after ${Math.round(STEP_TIMEOUT_MS / 60_000)} minutes`;
        child.kill("SIGKILL");
      }, STEP_TIMEOUT_MS);
      const take = (b: Buffer) => { s.output = tail(s.output + b.toString()); this.emit(false); };
      child.stdout!.on("data", take);
      child.stderr!.on("data", take);
      child.on("error", (e: any) => {
        clearTimeout(timer);
        s.status = "failed";
        s.exitCode = null;
        s.note = e?.code === "ENOENT" ? `${cmd} is not installed on this machine` : String(e?.message ?? e);
        this.emit();
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        s.exitCode = code;
        s.status = code === 0 ? "ok" : "failed";
        this.emit();
        resolve(code === 0);
      });
    });
  }
}

function step(name: UpdateStepName, label: string, command: string): UpdateStep {
  return { name, label, command, status: "pending", output: "", exitCode: null };
}

function hashFile(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

/**
 * pnpm usually lives beside the node that is running us (nvm, volta, a global
 * npm prefix), which is not always on the daemon's inherited PATH — it was
 * started by a launcher, not a login shell.
 */
function childEnv(): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  const path = process.env.PATH ?? "";
  return { ...process.env, PATH: path.split(delimiter).includes(nodeBin) ? path : `${nodeBin}${delimiter}${path}` };
}

export function daemonLogFile(): string {
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "daemon.log");
}

/**
 * Hand the restart to a detached helper, then ask ourselves to stop. The helper
 * waits for this process to be gone (the port with it) before starting the
 * replacement, and re-uses our own argv/cwd so it does not need to know how the
 * daemon was launched.
 *
 * Returns the helper's pid. Exits this process shortly after.
 */
export function scheduleRestart(log: (m: string) => void, delayMs = 400): number {
  const logFile = daemonLogFile();
  const payload = {
    pid: process.pid,
    node: process.execPath,
    // execArgv keeps `--import tsx` when running from source.
    args: [...process.execArgv, ...process.argv.slice(1)],
    cwd: process.cwd(),
    log: logFile,
    delayMs,
  };
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, ["-e", RESTARTER, JSON.stringify(payload)], {
    cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  log(`restart scheduled: helper pid ${child.pid}, replacing pid ${process.pid}`);
  setTimeout(() => {
    // SIGTERM so the daemon's own handler closes sessions and the db cleanly;
    // the timer is the backstop if something refuses to unwind.
    try { process.kill(process.pid, "SIGTERM"); } catch { /* already going */ }
    setTimeout(() => process.exit(0), 3000).unref();
  }, delayMs).unref();
  return child.pid!;
}

/** Runs in a separate `node -e`, so it must be plain CommonJS with no imports. */
const RESTARTER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const o = JSON.parse(process.argv[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = () => { try { process.kill(o.pid, 0); return true; } catch { return false; } };
(async () => {
  await sleep(o.delayMs);
  for (let i = 0; i < 150 && alive(); i++) await sleep(100);
  if (alive()) { try { process.kill(o.pid, "SIGKILL"); } catch {} await sleep(500); }
  await sleep(250);
  const fd = fs.openSync(o.log, "a");
  fs.writeSync(fd, "\\n=== " + new Date().toISOString() + " covey daemon restarting ===\\n");
  spawn(o.node, o.args, { cwd: o.cwd, detached: true, stdio: ["ignore", fd, fd] }).unref();
})();
`;
