/**
 * The words and the choices of the model picker's second screen. The TUI
 * reads this, so the scopes a row offers are decided in one place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadModel } from "@covey/protocol";
import { modelApplyNotice, modelScopeOption, modelScopes, modelSourceLabel } from "./modelScope.js";

test("each row offers its own scope and every wider one, and all of covey always", () => {
  assert.deepEqual(modelScopes("thread"), ["thread", "project", "fleet", "covey"]);
  assert.deepEqual(modelScopes("project"), ["project", "fleet", "covey"]);
  assert.deepEqual(modelScopes("fleet"), ["fleet", "covey"]);
  assert.deepEqual(modelScopes("machine"), ["fleet", "covey"]);
});

test("one fleet offers no fleet, because it reaches what all of covey reaches", () => {
  assert.deepEqual(modelScopes("thread", 1), ["thread", "project", "covey"]);
  assert.deepEqual(modelScopes("machine", 1), ["covey"]);
});

test("a scope says where it writes and what it takes back", () => {
  const f = { thread: "fix login", project: "covey", fleet: "work", machines: { project: 2, fleet: 1, covey: 4 }, clears: { project: 3, covey: 0 } };
  assert.deepEqual(modelScopeOption("thread", f), { label: "This thread — fix login", hint: "this thread only" });
  assert.deepEqual(modelScopeOption("project", f), { label: "This project — covey", hint: "on 2 machines · replaces 3 narrower choices" });
  assert.deepEqual(modelScopeOption("fleet", f), { label: "This fleet — work", hint: "on 1 machine" });
  assert.deepEqual(modelScopeOption("covey", f), { label: "All of covey", hint: "every machine (4)" });
});

test("the narrowest choice wins, and nothing chosen is Claude Code's own default", () => {
  const machine = { defaultModel: "sonnet" };
  assert.deepEqual(threadModel({ model: "haiku" }, { defaultModel: "opus" }, machine), { model: "haiku", from: "thread" });
  assert.deepEqual(threadModel({ model: null }, { defaultModel: "opus" }, machine), { model: "opus", from: "project" });
  assert.deepEqual(threadModel({ model: null }, { defaultModel: null }, machine), { model: "sonnet", from: "machine" });
  assert.deepEqual(threadModel({ model: null }, null, { defaultModel: null }), { model: null, from: null });
  assert.equal(modelSourceLabel("project"), "from the project");
  assert.equal(modelSourceLabel(null), "Claude Code's default");
});

test("the notice names every machine that did not take the model, and why", () => {
  const f = { project: "covey", machines: { project: 2 }, clears: {} };
  assert.deepEqual(modelApplyNotice("Opus", "project", f, []), { text: "Opus now applies to this project — covey", level: "success" });
  assert.deepEqual(
    modelApplyNotice("Opus", "covey", f, [{ machine: "steamdeck", why: "not connected" }]),
    { text: "Opus applies to all of covey, except on steamdeck (not connected)", level: "warning" },
  );
});
