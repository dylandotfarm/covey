import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionModeLabel, isLoopbackUrl } from "./store.js";

test("permissionModeLabel names the modes the way the machine panel offers them", () => {
  assert.equal(permissionModeLabel("default"), "manual");
  assert.equal(permissionModeLabel("acceptEdits"), "auto");
  assert.equal(permissionModeLabel("bypassPermissions"), "bypass");
  assert.equal(permissionModeLabel(null), "from Claude settings");
});

test("isLoopbackUrl decides whether a daemon shares this machine", () => {
  assert.ok(isLoopbackUrl("ws://127.0.0.1:3790"));
  assert.ok(isLoopbackUrl("ws://localhost:3790"));
  assert.ok(isLoopbackUrl("ws://[::1]:3790"));
  assert.ok(!isLoopbackUrl("ws://pi.tail.ts.net:3790"));
  assert.ok(!isLoopbackUrl("not a url"));
});
