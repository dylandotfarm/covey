import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tail, sourceRoot, sourceInfo } from "./update.js";

test("tail keeps the end of long output, where the error is", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const cut = tail(text, 100);
  assert.ok(cut.length <= 101, "bounded");
  assert.ok(cut.startsWith("…"), "marks that the head was dropped");
  assert.ok(cut.endsWith("line 499"), "keeps the tail");
  assert.equal(tail("short", 100), "short");
});

test("sourceRoot finds the checkout the daemon is running from", () => {
  const root = sourceRoot();
  assert.ok(root, "running from a git checkout in this repo");
  assert.ok(existsSync(join(root!, ".git")));
  assert.ok(existsSync(join(root!, "pnpm-workspace.yaml")), "it is the covey workspace root, not a nested repo");
});

test("sourceRoot can be asked about another directory — the CLI asks about its own", () => {
  const root = sourceRoot()!;
  assert.equal(sourceRoot(join(root, "packages", "cli", "src")), root, "walks up to the same checkout");
  assert.equal(sourceRoot(tmpdir()), null, "no checkout above a temp dir");
});

test("sourceInfo reads the commit, and only offers to update with a remote", async () => {
  const src = await sourceInfo();
  assert.equal(src.root, sourceRoot());
  assert.equal(typeof src.commit, "string");
  assert.equal(src.canUpdate, !!src.remote);
});
