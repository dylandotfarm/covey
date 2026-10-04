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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppBuildRun } from "@covey/protocol";
import { AppBuilder } from "../src/appBuild.js";

/** The run this builder ends at, however it ends. */
function ended(b: AppBuilder): Promise<AppBuildRun> {
  return new Promise((resolve) => {
    const off = b.on((r) => { if (r.state !== "running") { off(); resolve(r); } });
  });
}

/** A directory with no app in it, which is every machine but a few. */
const empty = () => mkdtemp(join(tmpdir(), "covey-appbuild-"));

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
