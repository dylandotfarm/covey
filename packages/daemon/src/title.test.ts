import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, fallbackTitle } from "./title.js";

test("cleanTitle strips the decoration models put around one-line answers", () => {
  assert.equal(cleanTitle("Fix websocket reconnect loop"), "Fix websocket reconnect loop");
  assert.equal(cleanTitle('  "Fix websocket reconnect loop."  '), "Fix websocket reconnect loop");
  assert.equal(cleanTitle("Title: Fix websocket reconnect loop"), "Fix websocket reconnect loop");
  assert.equal(cleanTitle("- `Fix websocket reconnect loop`"), "Fix websocket reconnect loop");
  assert.equal(cleanTitle("Fix reconnect\n\nThis names the task."), "Fix reconnect");
});

test("cleanTitle refuses prose and empty answers", () => {
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("   \n  "), null);
  assert.equal(cleanTitle("I am sorry, but I cannot write a title without more context about " +
    "what the user is asking for here."), null);
});

test("cleanTitle truncates a long but plausible title", () => {
  const t = cleanTitle("Rewrite the websocket reconnect loop and its backoff timer")!;
  assert.equal(t, "Rewrite the websocket reconnect loop and its backoff timer");
  const long = cleanTitle("Rewrite the websocket reconnect loop and its exponential backoff")!;
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("fallbackTitle takes the first line", () => {
  assert.equal(fallbackTitle("  fix the reconnect loop\nand the timer  "), "fix the reconnect loop");
  assert.equal(fallbackTitle("   "), "New thread");
  assert.equal(fallbackTitle("x".repeat(100)), "x".repeat(59) + "…");
});
