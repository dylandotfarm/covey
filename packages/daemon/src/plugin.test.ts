/**
 * The `/covey` skill reaches a session as a plugin from the checkout, or not
 * at all: a checkout without the plugin, or no checkout, hands the session
 * nothing rather than a path that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveyPlugin } from "./plugin.js";
import { sourceRoot } from "./update.js";

test("this checkout ships the plugin, with the skill inside it", () => {
  const root = sourceRoot(dirname(fileURLToPath(import.meta.url)));
  assert.ok(root, "the test runs from a checkout");
  assert.equal(coveyPlugin(root), join(root, "plugin"));
});

test("no checkout, or a checkout without the plugin, hands the session nothing", (t) => {
  const bare = mkdtempSync(join(tmpdir(), "covey-plugin-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(coveyPlugin(null), null);
  assert.equal(coveyPlugin(bare), null);
  // A manifest without the skill is not the plugin either.
  mkdirSync(join(bare, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(bare, "plugin", ".claude-plugin", "plugin.json"), "{}");
  assert.equal(coveyPlugin(bare), null);
});
