/**
 * Regression tests for the capability probe.
 *
 * The defect: on 2026-09-16 the operator checked the Pi over `ssh`, found no
 * `pnpm`, and began to install it. `pnpm` was already there — the daemon runs
 * under `nvm`, which does not load in a non-interactive `ssh` session, so the
 * `ssh` probe read a different `PATH` than any agent would ever see.
 *
 * So the cases below drive `machineResources()` with a `PATH` of their own and
 * check that it reports what *that* `PATH` resolves. A probe that shelled out
 * to a login shell, or that read a fixed list of directories, fails them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { concurrencyLimit, hasTool } from "@covey/protocol";
import { machineResources } from "./resources.js";

/** A program that prints a version, so the probe has something real to run. */
function fakeTool(dir: string, name: string, version: string) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
  return file;
}

function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const was = process.env.PATH;
  process.env.PATH = path;
  return fn().finally(() => { process.env.PATH = was; });
}

test("the probe reports the tools this process's own PATH resolves", async (t) => {
  if (process.platform === "win32") return t.skip("the fake tools are shell scripts");
  const dir = mkdtempSync(join(tmpdir(), "covey-tools-"));
  try {
    fakeTool(dir, "pnpm", "12.4.0");
    fakeTool(dir, "gh", "gh version 2.60.1 (2026-09-01)");
    const r = await withPath(dir, () => machineResources());
    // This is the whole point: `pnpm` is on the daemon's PATH and nowhere else.
    // An ssh probe would have said the machine has no pnpm.
    assert.ok(hasTool(r, "pnpm"), "pnpm is on the PATH this process runs with");
    assert.ok(hasTool(r, "gh"), "gh is on the PATH this process runs with");
    assert.equal(r.tools.find((x) => x.name === "pnpm")!.path, join(dir, "pnpm"));
    assert.equal(r.tools.find((x) => x.name === "pnpm")!.version, "12.4.0");
    assert.equal(r.tools.find((x) => x.name === "gh")!.version, "2.60.1");
    assert.equal(r.path, dir, "the probe says which PATH it answered for");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tool the PATH does not resolve is not reported, wherever else it sits", async (t) => {
  if (process.platform === "win32") return t.skip("the fake tools are shell scripts");
  // `git` is in /usr/bin on every machine this runs on. It is still absent
  // here, because an agent inherits the PATH and not a list of well-known
  // directories — the same reason the ssh probe was wrong about pnpm.
  const dir = mkdtempSync(join(tmpdir(), "covey-tools-"));
  try {
    fakeTool(dir, "pnpm", "12.4.0");
    const r = await withPath(dir, () => machineResources());
    assert.equal(hasTool(r, "pnpm"), true);
    assert.equal(hasTool(r, "git"), false, "not on this PATH, so an agent cannot type it");
    assert.equal(hasTool(r, "tmux"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a second copy of a tool is reported after the one the PATH resolves", async (t) => {
  if (process.platform === "win32") return t.skip("the fake tools are shell scripts");
  // The run of 2026-09-16 needed the one machine with an old `/usr/bin/node`
  // (v18.19.1) to reproduce against, and that machine's PATH node was newer.
  // A list that only ever reports the resolved one cannot answer that question.
  const root = mkdtempSync(join(tmpdir(), "covey-tools-"));
  const nvm = join(root, "nvm");
  const usr = join(root, "usr");
  try {
    mkdirSync(nvm); mkdirSync(usr);
    fakeTool(nvm, "node", "v24.8.0");
    fakeTool(usr, "node", "v18.19.1");
    const r = await machineResources({ path: nvm, extraDirs: [usr] });
    const nodes = r.tools.filter((x) => x.name === "node");
    assert.equal(nodes.length, 2, "both copies of node, not just the resolved one");
    assert.equal(nodes[0]!.version, "24.8.0", "the PATH's own node comes first");
    assert.equal(nodes[1]!.version, "18.19.1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file the daemon cannot run is not a tool the machine has", async (t) => {
  if (process.platform === "win32") return t.skip("the fake tools are shell scripts");
  // A name on the PATH is not enough: an agent inherits the PATH *and* the
  // permissions. Reporting a file it cannot execute sends `needs=gh` work to a
  // machine that cannot do it, which is the same wrong answer the ssh probe
  // gave about pnpm, arrived at from the other side.
  const dir = mkdtempSync(join(tmpdir(), "covey-tools-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho 1.0\n");
    chmodSync(join(dir, "gh"), 0o644);
    fakeTool(dir, "pnpm", "12.4.0");
    const r = await machineResources({ path: dir, extraDirs: [] });
    assert.equal(hasTool(r, "gh"), false, "the daemon cannot run it, so the machine does not have it");
    assert.equal(hasTool(r, "pnpm"), true, "and the one it can run is still reported");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe reports what the machine is made of, and how many members it should take", async () => {
  const r = await machineResources();
  assert.equal(r.cpuCount, cpus().length);
  assert.equal(r.totalMemoryBytes, totalmem());
  assert.equal(r.tmpDir, tmpdir());
  assert.equal(r.concurrency, concurrencyLimit(r.cpuCount, r.totalMemoryBytes));
  assert.ok(r.concurrency >= 1);
  assert.ok(Date.parse(r.readAt) > 0);
});

test("a four-core Pi with 8 GB takes four members, not fifteen", () => {
  assert.equal(concurrencyLimit(4, 8 * 1024 ** 3), 4);
  // Memory binds first on a small machine: one agent may run a build.
  assert.equal(concurrencyLimit(8, 2 * 1024 ** 3), 1);
  assert.equal(concurrencyLimit(12, 64 * 1024 ** 3), 12);
  assert.equal(concurrencyLimit(1, 0), 1, "never zero — a machine can always take one");
});
