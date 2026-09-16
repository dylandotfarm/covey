import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDirs, buildInfo, buildIsNewerThan, buildLabel, newestBuildMtime } from "./build.js";

const execFile = promisify(execFileCb);

/** A checkout shaped like this one: a git root with `packages/<name>/dist`. */
function scratchTree(): string {
  const root = mkdtempSync(join(tmpdir(), "covey-build-"));
  for (const pkg of ["cli", "tui", "daemon"]) {
    mkdirSync(join(root, "packages", pkg, "dist"), { recursive: true });
    writeFileSync(join(root, "packages", pkg, "dist", "index.js"), "// built\n");
  }
  return root;
}

/** Set one file's mtime, in seconds since the epoch. */
function setMtime(path: string, seconds: number) {
  utimesSync(path, seconds, seconds);
}

test("buildDirs covers every package, because tsc -b rewrites only what changed", (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = buildDirs(join(root, "packages", "cli", "dist")).sort();
  assert.deepEqual(dirs, [
    join(root, "packages", "cli", "dist"),
    join(root, "packages", "daemon", "dist"),
    join(root, "packages", "tui", "dist"),
  ]);
});

test("buildDirs falls back to the one directory outside a packages tree", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "covey-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(buildDirs(dir), [dir]);
});

test("a rebuild of another package moves the newest mtime", (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "packages", "cli", "dist");
  const tui = join(root, "packages", "tui", "dist", "index.js");
  const dirs = buildDirs(cli);
  for (const d of dirs) setMtime(join(d, "index.js"), 1_000_000);
  const before = newestBuildMtime(dirs);
  assert.equal(before, 1_000_000_000);

  // The keybinding case from issue #7: only packages/tui is rewritten, so the
  // CLI's own file says nothing.
  setMtime(tui, 1_000_500);
  assert.equal(newestBuildMtime([cli]), before, "the CLI's own directory misses it");
  assert.ok(newestBuildMtime(dirs) > before, "every package together catches it");
});

/**
 * Regression test for the second half of issue #7: the check that decides
 * whether a running process is behind the build on disk.
 *
 * Revert `buildIsNewerThan` to the one-file form it replaced —
 * `statSync(join(entryDir, "index.js")).mtimeMs > at` — and the second
 * assertion fails: a rebuild of another package leaves the entry file alone.
 */
test("a rebuild of any package counts, not only the one the process started from", (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "packages", "cli", "dist");
  for (const d of buildDirs(cli)) setMtime(join(d, "index.js"), 1_000_000);
  // The daemon started half a second after that build, so it runs it.
  const startedAt = new Date(1_000_500_000).toISOString();
  assert.equal(buildIsNewerThan(cli, startedAt), false, "nothing was rebuilt after the process started");

  // The keybinding case from the issue: `tsc -b` rewrites packages/tui only.
  setMtime(join(root, "packages", "tui", "dist", "index.js"), 1_001_000);
  assert.equal(buildIsNewerThan(cli, startedAt), true,
    "a rebuild of another package leaves packages/cli/dist/index.js alone, and must still count");
});

test("buildIsNewerThan claims nothing without a start time it can read", (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "packages", "cli", "dist");
  for (const d of buildDirs(cli)) setMtime(join(d, "index.js"), 2_000_000);
  assert.equal(buildIsNewerThan(cli, null), false);
  assert.equal(buildIsNewerThan(cli, undefined), false);
  assert.equal(buildIsNewerThan(cli, "not a date"), false);
});

test("newestBuildMtime walks into subdirectories and ignores what is not code", (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "packages", "tui", "dist");
  mkdirSync(join(dist, "components"));
  writeFileSync(join(dist, "components", "App.js"), "// built\n");
  writeFileSync(join(dist, "components", "App.js.map"), "{}\n");
  setMtime(join(dist, "index.js"), 1_000_000);
  setMtime(join(dist, "components", "App.js"), 1_000_400);
  setMtime(join(dist, "components", "App.js.map"), 2_000_000);
  assert.equal(newestBuildMtime([dist]), 1_000_400_000);
});

test("an empty tree has no build, so nothing ever looks newer than it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "covey-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(newestBuildMtime([dir]), 0);
  assert.equal(newestBuildMtime([join(dir, "nowhere")]), 0);
});

test("buildInfo reports the commit and its date from the checkout", async (t) => {
  const root = scratchTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args: string[]) => execFile("git", args, { cwd: root });
  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "test@covey");
  await run("config", "user.name", "covey test");
  await run("add", "-A");
  await run("commit", "-qm", "init");

  const from = join(root, "packages", "cli", "dist");
  const clean = await buildInfo(from);
  assert.match(clean.commit ?? "", /^[0-9a-f]{7,}$/);
  assert.equal(clean.branch, "main");
  assert.equal(clean.dirty, false);
  assert.ok(clean.committedAt && Number.isFinite(Date.parse(clean.committedAt)), "the commit date parses");
  assert.ok(clean.builtAt, "the newest mtime of the build is reported");
  assert.equal(buildLabel(clean), clean.commit);

  writeFileSync(join(root, "packages", "cli", "dist", "index.js"), "// edited\n");
  const dirty = await buildInfo(from);
  assert.equal(dirty.dirty, true);
  assert.equal(buildLabel(dirty), `${dirty.commit}-dirty`);
});

test("buildInfo outside a checkout still says when the code was built", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "covey-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.js"), "// built\n");
  setMtime(join(dir, "index.js"), 1_000_000);
  const b = await buildInfo(dir);
  assert.equal(b.commit, null);
  assert.equal(b.builtAt, new Date(1_000_000_000).toISOString());
  assert.equal(buildLabel(b), `built ${b.builtAt!.slice(0, 10)}`);
});
