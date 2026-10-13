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
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  /** Where this run found the Android SDK, handed to every step as `ANDROID_HOME`. */
  private sdk: string | null = null;

  /**
   * `dir` is the app's workspace; a test points it somewhere with nothing in
   * it. `sdkPaths` is where to look for an Android SDK when nothing names one,
   * which a test empties — this machine may well hold an SDK of its own, and a
   * test for the refusal would then run a real `pnpm`.
   */
  constructor(private machineId: string, private log: (m: string) => void, private dir = MOBILE_DIR, private sdkPaths = defaultSdkPaths) {}

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

    // Read before the first step, because `prebuild` deletes `android/` and
    // takes `local.properties` with it: a machine whose only record of the SDK
    // is that file has it until the second step and not after. And refused here
    // rather than at the third step, which is the one that needs it.
    const sdk = await androidSdk(this.dir, this.sdkPaths());
    this.sdk = sdk;
    if (!sdk) {
      return this.fail("this machine names no Android SDK, so the gradle step would fail. Export ANDROID_HOME for the daemon — the path the SDK is installed at, such as ~/Android/sdk — and build again. docs/MOBILE.md says why a line in android/local.properties is not enough.");
    }

    if (!(await this.exec(this.stepByName("install"), "pnpm", ["install", "--frozen-lockfile"]))) {
      return this.fail(`pnpm install failed in mobile/${why(this.stepByName("install"))}`);
    }
    // `prebuild` writes `android/` from `app.config.ts`, so the version the
    // next step stamps into the binary is the version the checkout names.
    if (!(await this.exec(this.stepByName("prebuild"), "pnpm", ["run", "prebuild"]))) {
      return this.fail(`expo prebuild failed${why(this.stepByName("prebuild"))}`);
    }
    // Put the record back that the step above deleted. Covey's own steps need
    // no file — they carry `ANDROID_HOME` — but the reader who later runs
    // `./gradlew` in that directory does, and it was their file. The template
    // writes no `local.properties`, so without this a build from the button
    // leaves the checkout less able to build than it found it.
    await writeFile(join(this.dir, "android", "local.properties"), `sdk.dir=${sdk.replace(/([\\:])/g, "\\$1")}\n`).catch(() => {});
    if (!(await this.exec(this.stepByName("apk"), "pnpm", ["run", "apk"]))) {
      return this.fail(`the gradle build failed${why(this.stepByName("apk"))} — the machine still holds the app it held before`);
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
      // `ANDROID_HOME` because the daemon starts from a login shell and most
      // people never exported it there — `android/local.properties`, which the
      // SDK tools write, is the usual record and `prebuild` deletes it. Gradle
      // then reports "SDK location not found" two seconds into the third step,
      // which reads as a broken button.
      const env = { ...childEnv(), CI: "1", ...(this.sdk ? { ANDROID_HOME: this.sdk } : {}) };
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

/**
 * Where this machine keeps the Android SDK, or null for nowhere.
 *
 * Gradle reads `ANDROID_HOME` from its environment, or `sdk.dir` out of
 * `android/local.properties`. The SDK tools write the second and almost nobody
 * writes the first, which is the trap: `prebuild` clears `android/` and deletes
 * `local.properties` with it, so a machine that built the app by hand for
 * months fails the moment this button runs the two steps in order. The daemon
 * also starts from a login shell and inherits a terminal's `PATH` and nothing
 * else, so a variable exported for an interactive shell is not there either.
 *
 * So covey looks in all three places and hands the answer to every step. The
 * file is read before `prebuild` runs, because after it the file is gone.
 * `ANDROID_SDK_ROOT` is read as well and never written: Android deprecated the
 * name years ago and the tools still set it.
 */
export async function androidSdk(dir: string, paths = defaultSdkPaths()): Promise<string | null> {
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = process.env[name]?.trim();
    if (value && (await isSdk(value))) return value;
  }
  const text = await readFile(join(dir, "android", "local.properties"), "utf8").catch(() => null);
  const line = text ? /^[^\S\n]*sdk\.dir[^\S\n]*=(.*)$/m.exec(text) : null;
  // A properties file escapes the separators of a Windows path; nothing else
  // here carries a backslash, so one is always an escape.
  const fromFile = line?.[1]?.trim().replace(/\\(.)/g, "$1");
  if (fromFile && (await isSdk(fromFile))) return fromFile;
  for (const path of paths) if (await isSdk(path)) return path;
  return null;
}

/**
 * Where to look when nothing names one.
 *
 * This is the list `expo run:android` checks and deliberately the same one: a
 * machine where the app builds at a terminal has to build from the button, and
 * two lists that disagree is one machine with two answers. Android Studio
 * writes `Android/Sdk`, `sdkmanager` unpacked by hand goes where the reader put
 * it, and a Linux filesystem tells those two apart — so both are named.
 */
export function defaultSdkPaths(): string[] {
  const home = homedir();
  return process.platform === "darwin"
    ? [join(home, "Library", "Android", "sdk")]
    : [join(home, "Android", "Sdk"), join(home, "Android", "sdk")];
}

/**
 * Whether a path holds an SDK rather than merely existing.
 *
 * A directory, and one of the three directories the build reads. An empty
 * `~/Android/sdk` left behind by an uninstall would otherwise be handed to
 * gradle as the answer, which is the failure this lookup exists to prevent,
 * one directory further on.
 */
async function isSdk(path: string): Promise<boolean> {
  for (const part of ["platforms", "build-tools", "platform-tools"]) {
    const ok = await stat(join(path, part)).then((st) => st.isDirectory(), () => false);
    if (ok) return true;
  }
  return false;
}

/**
 * What to add to a failed step's sentence, or nothing.
 *
 * The error is the only thing a client paints — the output stays on the daemon
 * — so a step that failed for a reason it wrote down has to put that reason in
 * the one line. A `note` is covey's own (a step killed at its ceiling), and it
 * wins, because gradle's last words under a `SIGKILL` are about the kill.
 */
function why(s: UpdateStep): string {
  const reason = s.note ?? gradleReason(s.output);
  return reason ? `: ${reason}` : "";
}

/** How much of gradle's reason fits in a sentence a phone paints in a row. */
const REASON_MAX = 160;

/**
 * The one line under gradle's `* What went wrong:`, or null.
 *
 * Gradle nests the real cause: the first line names the project, and each `>`
 * below it is a layer closer to the fault, so the *last* one is the sentence a
 * reader needs — `SDK location not found…`, not `A problem occurred evaluating
 * root project 'covey'`. The block ends at the next `* `, which is `* Try:`.
 *
 * It reads the tail covey kept and nothing else. A failure with no such block —
 * pnpm, expo, a step killed outright — has no reason here and the caller says
 * only what failed, which is what it said before.
 */
export function gradleReason(output: string): string | null {
  const start = output.lastIndexOf("* What went wrong:");
  if (start < 0) return null;
  const lines = output.slice(start).split("\n").slice(1);
  const end = lines.findIndex((l) => /^\* /.test(l));
  const block = (end < 0 ? lines : lines.slice(0, end)).map(strip).filter((l) => l.length > 0);
  if (block.length === 0) return null;
  const deepest = block.filter((l) => l.startsWith(">"));
  const reason = (deepest.at(-1) ?? block[0]!).replace(/^>\s*/, "").trim();
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1).trimEnd()}…` : reason;
}

/** Gradle paints its output, and a colour left in would be printed as escapes. */
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").trim();
