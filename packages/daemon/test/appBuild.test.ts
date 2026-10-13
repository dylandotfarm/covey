/**
 * What the daemon decides around an app build (#185).
 *
 * Nothing here spawns a process. The steps themselves are `pnpm`, `expo
 * prebuild` and gradle — tens of minutes, an Android SDK and a JDK — so a test
 * that ran them would prove the part no reader doubts and would take the gate
 * with it. What is held here is the rest: that a machine with nothing to build
 * refuses by name, and that a second press of the button never starts a second
 * gradle beside the first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppBuildRun } from "@covey/protocol";
import { AppBuilder, androidSdk, defaultSdkPaths, gradleReason, updatesUrl } from "../src/appBuild.js";

/** The run this builder ends at, however it ends. */
function ended(b: AppBuilder): Promise<AppBuildRun> {
  return new Promise((resolve) => {
    const off = b.on((r) => { if (r.state !== "running") { off(); resolve(r); } });
  });
}

/** A directory with no app in it, which is every machine but a few. */
const empty = () => mkdtemp(join(tmpdir(), "covey-appbuild-"));

/**
 * A checkout as far as the builder can tell, with whatever `.env` is given.
 *
 * The variable is taken out of this process's own environment for the test:
 * Expo reads it from either place, so a machine that happened to export it
 * would make the refusal below pass by never being reached — and would then
 * spawn a real `pnpm`.
 */
async function checkout(env?: string): Promise<string> {
  const dir = await empty();
  await writeFile(join(dir, "package.json"), '{"name":"covey-mobile"}');
  if (env !== undefined) await writeFile(join(dir, ".env"), env);
  return dir;
}

/** A directory an SDK lookup accepts: one of the three the build reads. */
async function sdk(): Promise<string> {
  const dir = await empty();
  await mkdir(join(dir, "platform-tools"));
  return dir;
}

/** `local.properties`, as the SDK tools write it, inside a checkout. */
async function withProperties(dir: string, value: string): Promise<string> {
  await mkdir(join(dir, "android"), { recursive: true });
  await writeFile(join(dir, "android", "local.properties"), `## generated\nsdk.dir=${value}\n`);
  return dir;
}

/** No SDK named in this process, so a machine that exports one cannot pass a test for us. */
function noSdkHere(t: { after: (f: () => void) => void }) {
  const was = { ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT };
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  t.after(() => {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}

test("a machine with no mobile/ refuses the build by name", async () => {
  const b = new AppBuilder("m1", () => {}, await empty());

  const started = b.start();
  assert.equal(started.state, "running");
  assert.deepEqual(started.steps.map((s) => s.name), ["install", "prebuild", "apk"]);

  const run = await ended(b);
  assert.equal(run.state, "failed");
  // The reason names the missing thing. "the build failed" about a machine that
  // never held the source sends a reader to a gradle log that is not there
  // either.
  assert.match(run.error ?? "", /mobile\//);
  assert.equal(run.built, null);
  // Nothing ran, so no step is left saying it is running: a row that spins for
  // ever is the one failure a reader cannot tell from a build still going.
  assert.deepEqual(run.steps.map((s) => s.status), ["skipped", "skipped", "skipped"]);
  assert.ok(run.finishedAt, "a run that ended says when");
});

test("a second start joins the build in flight instead of beginning another", async () => {
  // Two gradles in one output directory is a corrupt build and an hour lost, so
  // the second caller is handed the run in flight. The refusal is a file read,
  // so both calls here happen while the run is still running.
  const b = new AppBuilder("m1", () => {}, await empty());

  const first = b.start();
  const second = b.start();
  assert.equal(second.id, first.id);
  assert.equal(second.state, "running");
  // A copy each time: a client holding one record must not have it rewritten
  // under them by the next step.
  assert.notEqual(second, first);

  const run = await ended(b);
  assert.equal(run.id, first.id);
  // And the button is not spent — a build that failed is one a reader retries.
  assert.notEqual(b.start().id, first.id);
});

test("a build that could never take an update is refused before it starts", async (t) => {
  const was = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL;
  delete process.env.EXPO_PUBLIC_COVEY_UPDATES_URL;
  t.after(() => { if (was !== undefined) process.env.EXPO_PUBLIC_COVEY_UPDATES_URL = was; });

  // `mobile/.env` is gitignored and per checkout, so the machine that pulled
  // the code and never wrote one is the ordinary case — and it is the machine
  // the Install row most wants to offer. Without the variable `app.config.ts`
  // leaves the whole `updates` block out, and covey keeps Expo's anti-bricking
  // measure, so the app that comes out is off the update channel until somebody
  // sideloads another one. Forty minutes of gradle to get there is the worst
  // way to find out.
  const b = new AppBuilder("m1", () => {}, await checkout("# nothing here\n"));
  b.start();
  const run = await ended(b);
  assert.equal(run.state, "failed");
  assert.match(run.error ?? "", /EXPO_PUBLIC_COVEY_UPDATES_URL/);
  assert.match(run.error ?? "", /mobile\/\.env/, "the reader is told which file to write");
  assert.deepEqual(run.steps.map((s) => s.status), ["skipped", "skipped", "skipped"], "nothing ran");

  // A commented-out line is not a value, and neither is an empty one.
  const off = new AppBuilder("m1", () => {}, await checkout("#EXPO_PUBLIC_COVEY_UPDATES_URL=http://box:3790/updates\nEXPO_PUBLIC_COVEY_UPDATES_URL=\n"));
  off.start();
  assert.match((await ended(off)).error ?? "", /EXPO_PUBLIC_COVEY_UPDATES_URL/);
});

test("the update URL is read from the two places Expo reads it", async (t) => {
  const was = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL;
  delete process.env.EXPO_PUBLIC_COVEY_UPDATES_URL;
  t.after(() => { if (was !== undefined) process.env.EXPO_PUBLIC_COVEY_UPDATES_URL = was; });
  const URL = "http://box.lonk-adder.ts.net:3790/updates";

  assert.equal(await updatesUrl(await checkout()), null, "no file, nowhere to update from");
  assert.equal(await updatesUrl(await checkout(`EXPO_PUBLIC_COVEY_UPDATES_URL=${URL}\n`)), URL);
  // The template writes it quoted, and a reader may leave the quotes on.
  assert.equal(await updatesUrl(await checkout(`EXPO_PUBLIC_COVEY_UPDATES_URL="${URL}"\n`)), URL);
  assert.equal(await updatesUrl(await checkout(`OTHER=1\nEXPO_PUBLIC_COVEY_UPDATES_URL = ${URL}\n`)), URL);
  assert.equal(await updatesUrl(await checkout(`#EXPO_PUBLIC_COVEY_UPDATES_URL=${URL}\n`)), null, "a line a reader commented out is not a value");
  assert.equal(await updatesUrl(await checkout("EXPO_PUBLIC_COVEY_UPDATES_URL=\n")), null, "and neither is an empty one");
  // A name that merely ends with ours is another variable.
  assert.equal(await updatesUrl(await checkout(`MY_EXPO_PUBLIC_COVEY_UPDATES_URL=${URL}\n`)), null);

  // The environment the daemon would hand the child wins, because Expo reads it
  // that way: a machine that exports the variable needs no file.
  process.env.EXPO_PUBLIC_COVEY_UPDATES_URL = "http://exported:3790/updates";
  assert.equal(await updatesUrl(await checkout(`EXPO_PUBLIC_COVEY_UPDATES_URL=${URL}\n`)), "http://exported:3790/updates");
  assert.equal(await updatesUrl(await checkout()), "http://exported:3790/updates");
});

test("a build with no Android SDK anywhere is refused before it starts", async (t) => {
  noSdkHere(t);
  const was = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL;
  process.env.EXPO_PUBLIC_COVEY_UPDATES_URL = "http://box:3790/updates";
  t.after(() => { if (was === undefined) delete process.env.EXPO_PUBLIC_COVEY_UPDATES_URL; else process.env.EXPO_PUBLIC_COVEY_UPDATES_URL = was; });

  // The third step is the one that needs the SDK, and it is forty minutes in —
  // except that gradle refuses while it configures, so what the reader saw was
  // a button that failed in two seconds and a sentence about gradle that named
  // nothing. The refusal belongs at the top, with the one for the update URL,
  // and it names the variable to export.
  const b = new AppBuilder("m1", () => {}, await checkout("EXPO_PUBLIC_COVEY_UPDATES_URL=http://box:3790/updates\n"), () => []);
  b.start();
  const run = await ended(b);
  assert.equal(run.state, "failed");
  assert.match(run.error ?? "", /ANDROID_HOME/);
  assert.deepEqual(run.steps.map((s) => s.status), ["skipped", "skipped", "skipped"], "nothing ran");
});

test("the SDK is looked for in the three places it is recorded", async (t) => {
  noSdkHere(t);
  const here = await sdk();

  assert.equal(await androidSdk(await empty(), []), null, "a checkout that names none, on a machine with none");

  // `local.properties` is what the SDK tools write and what a person who built
  // by hand has. It is read before `prebuild` deletes it with the rest of
  // `android/`, which is the whole reason this lookup exists.
  assert.equal(await androidSdk(await withProperties(await empty(), here), []), here);
  // A Windows path comes out of a properties file escaped.
  assert.equal(await androidSdk(await withProperties(await empty(), here.replace(/\//g, "\\/")), []), here);

  // A directory that exists and holds no SDK is not an answer: handing it to
  // gradle is the same failure, one directory further on.
  assert.equal(await androidSdk(await withProperties(await empty(), await empty()), []), null);

  // The environment wins, because that is where gradle looks first.
  process.env.ANDROID_HOME = here;
  assert.equal(await androidSdk(await withProperties(await empty(), await empty()), []), here);
  delete process.env.ANDROID_HOME;
  // And the name Android deprecated is still read, because its own tools set it.
  process.env.ANDROID_SDK_ROOT = here;
  assert.equal(await androidSdk(await empty(), []), here);
  delete process.env.ANDROID_SDK_ROOT;
  // An exported name pointing nowhere falls through rather than standing.
  process.env.ANDROID_HOME = join(here, "gone");
  assert.equal(await androidSdk(await withProperties(await empty(), here), []), here);
});

test("a failed step carries the reason gradle gave", () => {
  // Nothing paints the step output, so the sentence in `error` is all a reader
  // on a phone gets. Gradle nests its causes and the last one is the fault:
  // "SDK location not found", not "A problem occurred evaluating root project".
  const out = [
    "> Configure project :",
    "FAILURE: Build failed with an exception.",
    "",
    "* Where:",
    "Build file '/home/dylan/covey/mobile/android/build.gradle' line: 24",
    "",
    "* What went wrong:",
    "A problem occurred evaluating root project 'covey'.",
    "> Failed to apply plugin 'com.facebook.react.rootproject'.",
    "   > A problem occurred configuring project ':app'.",
    "      > SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.",
    "",
    "* Try:",
    "> Run with --stacktrace option to get the stack trace.",
  ].join("\n");
  assert.match(gradleReason(out) ?? "", /^SDK location not found\./);
  assert.doesNotMatch(gradleReason(out) ?? "", /stacktrace/, "the block ends at the next `* `");

  // Gradle paints its output, and an escape left in would be printed.
  assert.equal(gradleReason("* What went wrong:\n\u001b[31mOut of memory\u001b[0m\n"), "Out of memory");
  // A cause with no nesting is the first line of the block.
  assert.equal(gradleReason("* What went wrong:\nExecution failed for task ':app:x'.\n"), "Execution failed for task ':app:x'.");
  // A step that failed some other way — pnpm, expo — has no reason here.
  assert.equal(gradleReason("npm ERR! something\n"), null);
  assert.equal(gradleReason(""), null);
  // The row is one line on a phone, so a reason longer than that is cut.
  const long = `* What went wrong:\n> ${"x".repeat(400)}\n`;
  assert.ok((gradleReason(long) ?? "").length <= 160);
  assert.match(gradleReason(long) ?? "", /…$/);
});

test("the places looked in last are the ones expo itself checks", () => {
  // A machine where `pnpm run apk` works at a terminal has to work from the
  // button. Two lists that disagree is one machine with two answers.
  const paths = defaultSdkPaths();
  assert.ok(paths.length > 0);
  assert.ok(paths.every((p) => p.startsWith("/")), "absolute, so the daemon's cwd decides nothing");
  assert.ok(paths.some((p) => /Android/.test(p)));
});
