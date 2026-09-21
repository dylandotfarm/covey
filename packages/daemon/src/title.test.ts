import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, fallbackTitle, titlePrompt } from "./title.js";

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

test("fallbackTitle skips a line that is only a command name", () => {
  assert.equal(fallbackTitle("/covey\nthe menu does not open in a new thread"), "the menu does not open in a new thread");
  assert.equal(fallbackTitle("/covey:covey\n\nfix the menu"), "fix the menu");
  // A command with arguments says what the thread is about.
  assert.equal(fallbackTitle("/covey take issue 12"), "/covey take issue 12");
  // A bare command and nothing else is still better than no title.
  assert.equal(fallbackTitle("/compact"), "/compact");
});

test("the prompt never starts with a slash, or the SDK runs it as a command", () => {
  const p = titlePrompt("/covey\nfix the menu");
  assert.ok(!p.startsWith("/"));
  assert.ok(p.includes("/covey\nfix the menu"));
  assert.ok(titlePrompt("x".repeat(3000)).length < 2100);
});
