import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultPermissionMode } from "./config.js";

/**
 * These cover the project/local half only — the user-level file lives in the
 * real home directory and is left alone.
 */
function project(files: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), "covey-perm-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(cwd, ".claude", name), JSON.stringify(body));
  }
  return cwd;
}

test("reads permissions.defaultMode from project settings", () => {
  const cwd = project({ "settings.json": { permissions: { defaultMode: "bypassPermissions" } } });
  assert.equal(resolveDefaultPermissionMode(cwd), "bypassPermissions");
});

test("settings.local.json wins over settings.json", () => {
  const cwd = project({
    "settings.json": { permissions: { defaultMode: "bypassPermissions" } },
    "settings.local.json": { permissions: { defaultMode: "plan" } },
  });
  assert.equal(resolveDefaultPermissionMode(cwd), "plan");
});

test("modes we do not model fall back to default", () => {
  const cwd = project({ "settings.json": { permissions: { defaultMode: "dontAsk" } } });
  assert.equal(resolveDefaultPermissionMode(cwd), "default");
});

test("malformed settings do not break thread creation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "covey-perm-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
  assert.doesNotThrow(() => resolveDefaultPermissionMode(cwd));
});

test("a directory with no settings resolves to a concrete mode", () => {
  const cwd = mkdtempSync(join(tmpdir(), "covey-perm-"));
  assert.ok(["default", "acceptEdits", "plan", "bypassPermissions"].includes(resolveDefaultPermissionMode(cwd)));
});
