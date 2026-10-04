/**
 * Building the Android app on the machine that serves it (#185).
 *
 * `/apk` hands over whatever `pnpm run apk` last left behind, and nothing in
 * covey ever wrote it. A machine update runs `git pull`, `pnpm install` and
 * `pnpm run build`; none of those reach `mobile/`, so a machine that pulled a
 * native change went on offering the binary it built weeks before — the right
 * answer about the file on disk, and a confusing one for the reader who wanted
 * the app the code says. This is the row that asks for a new one.
 *
 * It is `Updater` in another hat and deliberately so: the same step record, the
 * same bounded output, the same one-run-at-a-time rule, the same broadcast to
 * every client. What differs is that nothing restarts at the end, and that the
 * job is long — gradle alone is tens of minutes — so every step gets its own
 * ceiling rather than the update's single one.
 *
 * Three steps and no fourth. `pnpm run export`, which writes the bundle
 * `/updates` serves, is **not** here: an APK is installed by a person who chose
 * to, and a bundle lands in every installed app of that runtime version
 * without being asked. Covey does not do the second on the way to the first.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppBuildRun, UpdateStep, UpdateStepName } from "@covey/protocol";
import { appBuild, canBuildApp, MOBILE_DIR } from "./apk.js";
import { childEnv, tail } from "./update.js";

/**
 * How long each step may run before it is killed.
 *
 * The gradle ceiling is an hour because the build this repository documents
 * took 24 minutes on this machine before it ran out of metaspace, and a slower
 * machine with `--max-workers=2` takes longer again. A step killed at its
 * ceiling says so in its note, which is the one thing worse than waiting:
 * a run that never ends and never reports.
 */
const STEP_TIMEOUT_MS: Record<AppBuildStep, number> = {
  install: 15 * 60_000,
  prebuild: 15 * 60_000,
  apk: 60 * 60_000,
};

type AppBuildStep = Extract<UpdateStepName, "install" | "prebuild" | "apk">;

type Emit = (run: AppBuildRun) => void;

/**
 * Owns the one app build that may be in flight on this machine, and fans
 * progress out to every connected client.
 */
export class AppBuilder {
  private listeners = new Set<Emit>();
  /** The run in flight, or the last one that finished. */
  current: AppBuildRun | null = null;

  /** `dir` is the app's workspace; a test points it somewhere with nothing in it. */
  constructor(private machineId: string, private log: (m: string) => void, private dir = MOBILE_DIR) {}

  on(l: Emit): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  /**
   * Send the record to every client, at a step's boundary and nowhere else.
   *
   * The updater streams its output and pushes every 150 ms, because an update
   * takes a minute and a reader watches it. This job takes forty, gradle writes
   * thousands of lines, and every push carries a `structuredClone` of all three
   * steps' bounded output — tens of kilobytes, hundreds of times a minute, to
   * every client including a phone on a mobile link, which would also render
   * once per message. Nothing paints that output: `appBuildLabel` reads the
   * state, the error and the running step's name. So the output accumulates
   * here and rides along at the next boundary, which is where a failure's tail
   * is wanted anyway, and a whole build costs about nine messages.
   */
  private emit() {
    if (!this.current) return;
    const snapshot = structuredClone(this.current);
    for (const l of this.listeners) l(snapshot);
  }

  /**
   * Start a build. Returns the initial record straight away — the work runs in
   * the background and reports through `on()`. A call while one is running
   * returns the run in flight rather than starting a second gradle, which
   * would fight the first for the same output directory.
   */
  start(): AppBuildRun {
    if (this.current?.state === "running") return structuredClone(this.current);
    this.current = {
      id: randomUUID(),
      machineId: this.machineId,
      state: "running",
      steps: [
        step("install", "install", "pnpm install --frozen-lockfile"),
        step("prebuild", "prebuild", "pnpm run prebuild"),
        step("apk", "apk", "pnpm run apk"),
      ],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      built: null,
    };
    void this.run();
    return structuredClone(this.current);
  }

  private stepByName(name: AppBuildStep): UpdateStep {
    return this.current!.steps.find((s) => s.name === name)!;
  }

  private fail(message: string) {
    const r = this.current!;
    r.state = "failed";
    r.error = message;
    r.finishedAt = new Date().toISOString();
    for (const s of r.steps) if (s.status === "pending" || s.status === "running") s.status = s.status === "running" ? "failed" : "skipped";
    this.log(`app build failed: ${message}`);
    this.emit();
  }

  private async run() {
    const r = this.current!;
    if (!(await canBuildApp(this.dir))) return this.fail("this daemon does not run from a checkout that holds mobile/");
    // Before anything runs, and not after forty minutes. With no
    // `EXPO_PUBLIC_COVEY_UPDATES_URL` the app config leaves the whole `updates`
    // block out, so the binary carries no update URL and the module is off —
    // and covey keeps Expo's anti-bricking measure, so that app is off the
    // channel for good. Only another sideload mends it. A missing file is one
    // line to write; a binary already installed is not.
    if (!(await updatesUrl(this.dir))) {
      return this.fail("mobile/.env does not name EXPO_PUBLIC_COVEY_UPDATES_URL, so this build would make an app that can never take an update over the air. Copy mobile/.env.example to mobile/.env, name the machine that serves updates, and build again. docs/MOBILE.md says why.");
    }

    if (!(await this.exec(this.stepByName("install"), "pnpm", ["install", "--frozen-lockfile"]))) {
      return this.fail("pnpm install failed in mobile/");
    }
    // `prebuild` writes `android/` from `app.config.ts`, so the version the
    // next step stamps into the binary is the version the checkout names.
    if (!(await this.exec(this.stepByName("prebuild"), "pnpm", ["run", "prebuild"]))) {
      return this.fail("expo prebuild failed");
    }
    if (!(await this.exec(this.stepByName("apk"), "pnpm", ["run", "apk"]))) {
      return this.fail("the gradle build failed — the machine still holds the app it held before");
    }

    // What `/apk` now hands over. A build that ended with no readable APK is a
    // failure however green gradle was: the row would offer a file that is not
    // there.
    const built = await appBuild(this.dir);
    if (!built) return this.fail("the build finished but left no readable APK");
    r.built = built;
    r.state = "succeeded";
    r.finishedAt = new Date().toISOString();
    this.log(`app build succeeded: covey ${built.version}, ${built.bytes} bytes`);
    this.emit();
  }

  /** Run one step in `mobile/`, streaming its output into the record. */
  private exec(s: UpdateStep, cmd: string, args: string[]): Promise<boolean> {
    const timeout = STEP_TIMEOUT_MS[s.name as AppBuildStep];
    return new Promise((resolve) => {
      s.status = "running";
      s.output = "";
      this.emit();
      this.log(`app build: ${cmd} ${args.join(" ")}`);
      // `CI` is what keeps expo from asking a question. The daemon has no
      // terminal, so a prompt is a step that hangs until its ceiling — the
      // same rule the updater keeps for git.
      const env = { ...childEnv(), CI: "1" };
      const child = spawn(cmd, args, { cwd: this.dir, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        s.note = `timed out after ${Math.round(timeout / 60_000)} minutes`;
        child.kill("SIGKILL");
      }, timeout);
      // Kept, not sent: see `emit`. The step's end carries the tail.
      const take = (b: Buffer) => { s.output = tail(s.output + b.toString()); };
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

/**
 * Where the app this build would make asks for its updates, or null for
 * nowhere.
 *
 * Expo loads `mobile/.env` for every one of its own commands and inlines the
 * variable into the bundle, and `app.config.ts` reads the same value for the
 * native manifest — so these are the two places the answer can come from: the
 * environment this daemon would hand the child, and the file beside the config.
 * A line scan and not a dotenv parser: Expo's loader is the authority, and all
 * this decides is whether to refuse.
 */
export async function updatesUrl(dir: string): Promise<string | null> {
  const fromEnv = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL?.trim();
  if (fromEnv) return fromEnv;
  // `.env.local` first, because Expo lets it win over `.env`.
  for (const name of [".env.local", ".env"]) {
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    const line = text ? /^[^\S\n]*EXPO_PUBLIC_COVEY_UPDATES_URL[^\S\n]*=(.*)$/m.exec(text) : null;
    const value = line?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
    if (value) return value;
  }
  return null;
}

function step(name: AppBuildStep, label: string, command: string): UpdateStep {
  return { name, label, command, status: "pending", output: "", exitCode: null };
}
