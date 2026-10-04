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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppBuildRun } from "@covey/protocol";
import { AppBuilder, updatesUrl } from "../src/appBuild.js";

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
