/**
 * Changing which Claude Code a machine's sessions run.
 *
 * `Updater` in another hat, as `AppBuilder` is: the same step record, the same
 * bounded output, the same one-run-at-a-time rule, the same broadcast to every
 * client. Three steps — install, verify, restart — and each one earns its place:
 *
 * - **install** is a 223 MB download on a cold pnpm store and nothing at all
 *   when the reader picked the lockfile's version, the PATH's `claude`, or a
 *   version this machine already holds. It is skipped by name in those cases,
 *   because "install: skipped — already here" is the answer to "why was that
 *   instant" and a blank row is not.
 * - **verify** loads the install and asks it for its models. That is the only
 *   check that proves the chain the reader cares about: the JavaScript loads,
 *   the binary extracts, and it answers with the model they picked it for. It
 *   runs before the setting is written, never after.
 * - **restart** is unavoidable. The SDK is imported once per process and every
 *   session is a subprocess of that import, so a new Claude Code reaches a
 *   thread only through a new daemon. It ends every turn this machine is
 *   running, exactly as a machine update does, and the control panel warns in
 *   the same words.
 *
 * **The setting is written between verify and restart, and never before.** A
 * `claudeVersion` naming a version that would not install is a machine that
 * falls back on every start with a reason nobody ever clears — and the reader
 * would have no way to tell a bad choice from a bad machine. So the file keeps
 * the last version that actually worked until a new one has proved itself.
 */
import { randomUUID } from "node:crypto";
import type { ClaudeInstallRun, ClaudeRelease, MachineId, UpdateStep } from "@covey/protocol";
import { CLAUDE_SYSTEM } from "@covey/protocol";
import { entryFor, installDir, installSdk, loadInstalled, lockfileRelease, releaseFor, systemClaude, verifyInstall } from "./claudeInstall.js";
import { saveMachineSettings } from "./config.js";
import { scheduleRestart, tail } from "./update.js";

type Emit = (run: ClaudeInstallRun) => void;

/** Owns the one Claude Code change that may be in flight on this machine. */
export class ClaudeSwitcher {
  private listeners = new Set<Emit>();
  /** The run in flight, or the last one that finished. */
  current: ClaudeInstallRun | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private machineId: MachineId, private log: (m: string) => void) {}

  on(l: Emit): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  /** At a step's boundary and nowhere else: `AppBuilder`'s rule, same reason. */
  private emit() {
    if (!this.current) return;
    const snapshot = structuredClone(this.current);
    for (const l of this.listeners) l(snapshot);
  }

  /**
   * Switch this machine to `version`: `null` for the one the lockfile pins,
   * `CLAUDE_SYSTEM` for the PATH's `claude`, or an exact Agent SDK version.
   *
   * Answers at once; the work runs in the background and reports through
   * `on()`. A call while one is running returns the run in flight rather than
   * starting a second pnpm in the same directory.
   */
  start(version: string | null, opts: { restart?: boolean } = {}): ClaudeInstallRun {
    if (this.current?.state === "running") return structuredClone(this.current);
    const restart = opts.restart !== false;
    this.current = {
      id: randomUUID(), machineId: this.machineId, state: "running", requested: version,
      steps: [
        step("install", "install", version && version !== CLAUDE_SYSTEM ? `pnpm install @anthropic-ai/claude-agent-sdk@${version}` : "nothing to install"),
        step("verify", "verify", "read the models it offers"),
        ...(restart ? [step("restart", "restart", "restart the daemon")] : []),
      ],
      startedAt: new Date().toISOString(), finishedAt: null, error: null, installed: null,
    };
    this.pending = this.run(version, restart);
    return structuredClone(this.current);
  }

  /** Start and wait. For a test, and for a caller with a terminal to report in. */
  async runToCompletion(version: string | null, opts: { restart?: boolean } = {}): Promise<ClaudeInstallRun> {
    this.start(version, opts);
    await this.pending;
    return structuredClone(this.current!);
  }

  private stepByName(name: UpdateStep["name"]): UpdateStep {
    return this.current!.steps.find((s) => s.name === name)!;
  }

  private fail(message: string) {
    const u = this.current!;
    u.state = "failed";
    u.error = message;
    u.finishedAt = new Date().toISOString();
    for (const s of u.steps) if (s.status === "pending") s.status = "skipped";
      else if (s.status === "running") s.status = "failed";
    this.log(`claude install failed: ${message}`);
    this.emit();
  }

  private async run(version: string | null, restart: boolean) {
    const u = this.current!;
    const install = this.stepByName("install");
    const verify = this.stepByName("verify");
    let release: ClaudeRelease | null = null;
    let query: Parameters<typeof verifyInstall>[1] | null = null;

    // ------------------------------------------------------------- install
    if (version === null) {
      release = lockfileRelease();
      install.status = "skipped";
      install.note = "the version this daemon's own lockfile pins";
    } else if (version === CLAUDE_SYSTEM) {
      const sys = systemClaude();
      // Refused by name, before anything is written: a setting that names the
      // PATH's `claude` on a machine that has none is a permanent fallback.
      if (!sys) return this.fail("there is no `claude` on this machine's PATH");
      release = releaseFor(sys.version, { claude: sys.version });
      install.status = "skipped";
      install.note = `the \`claude\` at ${sys.path}`;
    } else if (entryFor(version)) {
      // Already here, so nothing is downloaded — but it is still *loaded*
      // below, because `entryFor` tests that `sdk.mjs` exists and nothing
      // more. A half-written directory would otherwise be written down as the
      // machine's Claude Code and fall back on every start after the restart.
      try {
        const loaded = await loadInstalled(version);
        release = loaded.release;
        query = loaded.query;
      } catch (e: any) {
        install.status = "failed";
        return this.fail(`the Claude Code ${version} install on this machine is broken: ${e?.message ?? e}`);
      }
      install.status = "skipped";
      install.note = "already installed on this machine";
    } else {
      install.status = "running";
      this.emit();
      try {
        const done = await installSdk(version, (m) => { install.output = tail(install.output + m + "\n"); this.log(m); });
        release = done.release;
        query = done.query;
        install.status = "ok";
        install.exitCode = 0;
      } catch (e: any) {
        install.status = "failed";
        install.output = tail(install.output + String(e?.message ?? e));
        return this.fail(`could not install Claude Code ${version}: ${e?.message ?? e}`);
      }
    }
    this.emit();

    // -------------------------------------------------------------- verify
    verify.status = "running";
    this.emit();
    if (query) {
      const models = await verifyInstall(installDir(version!), query);
      // A warning and not a failure. `readModels` also answers null on a
      // machine with no credentials, and a missing login is not a broken
      // install — refusing here would make this feature unusable on exactly
      // the machine a reader is setting up.
      verify.note = models ? `offers ${models.length} models: ${models.slice(0, 4).join(", ")}…` : "covey could not read its model list; the install itself loaded";
      verify.status = "ok";
    } else {
      // The two that covey never loads here: the lockfile's is already running
      // in this process, and `system` is a binary the reader installed and
      // covey has only checked the version of.
      verify.status = "skipped";
      verify.note = version === CLAUDE_SYSTEM ? "a Claude Code the reader installed" : "this daemon is already running it";
    }
    u.installed = release;
    this.emit();

    // ------------------------------------------- write it down, then restart
    try {
      saveMachineSettings({ claudeVersion: version });
    } catch (e: any) {
      return this.fail(`could not write the setting: ${e?.message ?? e}`);
    }
    this.log(`claude install: this machine will run ${release?.claude ?? version ?? "the lockfile's Claude Code"} after the restart`);

    if (!restart) {
      u.state = "succeeded";
      u.finishedAt = new Date().toISOString();
      this.emit();
      return;
    }
    const rs = this.stepByName("restart");
    rs.status = "running";
    this.emit();
    try {
      const pid = scheduleRestart(this.log);
      rs.status = "ok";
      rs.output = `restarter pid ${pid}`;
      // `succeeded` before the process goes, because the clients watching are
      // about to lose the socket and this record is the last thing they hear.
      u.state = "succeeded";
      u.finishedAt = new Date().toISOString();
      this.emit();
    } catch (e: any) {
      rs.status = "failed";
      rs.output = tail(String(e?.message ?? e));
      // The install stands and the setting is written, so the next restart by
      // any route picks it up. Say that rather than report a total failure.
      return this.fail(`installed, but could not schedule a restart: ${e?.message ?? e} — restart this daemon to use it`);
    }
  }
}

function step(name: UpdateStep["name"], label: string, command: string): UpdateStep {
  return { name, label, command, status: "pending", output: "", exitCode: null };
}
