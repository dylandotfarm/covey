import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem, ToolCallItem } from "@covey/protocol";
import { activityPrompt, ChainTracker, cleanActivity, toolCalls } from "./activity.js";

/**
 * The sentence a folded chain says, and which chain each item belongs to.
 *
 * Nothing here reaches a model: `summariseActivity` is the only part that
 * does, and it is one `query` around the pure pieces tested below.
 */

const AT = "2026-09-24T00:00:00.000Z";
let n = 0;
const base = (id: string, turnId: string | null = "t1") =>
  ({ id, threadId: "th", turnId, seq: n++, createdAt: AT, updatedAt: AT });

const tool = (id: string, o: Partial<ToolCallItem> = {}): ToolCallItem => ({
  ...base(id), kind: "tool", toolUseId: id, toolName: "Read", input: { file_path: "/x" }, summary: `Read ${id}`,
  status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 1, ...o,
} as ToolCallItem);

const thought = (id: string, turnId: string | null = "t1"): TimelineItem =>
  ({ ...base(id, turnId), kind: "thinking", text: "PRIVATE THOUGHT", streaming: false } as TimelineItem);

const said = (id: string, turnId: string | null = "t1"): TimelineItem =>
  ({ ...base(id, turnId), kind: "assistant", text: "on it", streaming: false, model: "sonnet" } as TimelineItem);

// ---- what goes to the model -------------------------------------------------

test("a thought is never a tool call, so it never goes to the model", () => {
  const items = [tool("a"), thought("b"), tool("c")];
  assert.deepEqual(toolCalls(items).map((c) => c.id), ["a", "c"]);
  const prompt = activityPrompt(toolCalls(items));
  assert.ok(!prompt.includes("PRIVATE THOUGHT"));
});

test("the prompt carries the name and the summary of each call, not its input", () => {
  const prompt = activityPrompt([tool("a", { toolName: "Bash", summary: "Run the tests", input: { command: "SECRET" } })]);
  assert.match(prompt, /- Bash: Run the tests/);
  assert.ok(!prompt.includes("SECRET"));
});

test("a long chain is cut, and says it was cut", () => {
  const calls = Array.from({ length: 30 }, (_, i) => tool(`c${i}`));
  const prompt = activityPrompt(calls);
  assert.match(prompt, /… and 6 more/);
});

// ---- the sentence the model gave -------------------------------------------

test("decoration around the answer is stripped", () => {
  assert.equal(cleanActivity('  "Fixed the reconnect loop."  '), "Fixed the reconnect loop");
  assert.equal(cleanActivity("- Summary: Read the parser\n"), "Read the parser");
});

test("a long sentence is cut at a whole word, not inside one", () => {
  const long = cleanActivity("Debugged the chunked transfer decoding and the media fetch handling and the rest of it");
  assert.ok(long);
  assert.ok(long.endsWith("…"));
  assert.ok(!/\s…$/.test(long), "no space before the ellipsis");
  // The cut lands between words, so the last word is whole.
  assert.ok(!long.slice(0, -1).endsWith("han"), "cut mid-word");
  assert.ok(long.length <= 81);
});

test("prose is refused, so the derived sentence stands", () => {
  assert.equal(cleanActivity("x".repeat(200)), null);
  assert.equal(cleanActivity("   "), null);
});

// ---- which chain an item belongs to -----------------------------------------

test("consecutive calls and thoughts share one chain", () => {
  const t = new ChainTracker();
  assert.equal(t.file(tool("a"), null).groupId, "a");
  assert.equal(t.file(thought("b"), null).groupId, "a");
  assert.equal(t.file(tool("c"), null).groupId, "a");
});

test("what the agent says closes the chain and joins none", () => {
  const t = new ChainTracker();
  t.file(tool("a"), null);
  t.file(tool("b"), null);
  const r = t.file(said("s"), null);
  assert.equal(r.groupId, undefined);
  assert.deepEqual(r.closed?.itemIds, ["a", "b"]);
  // The next call starts a chain of its own.
  assert.equal(t.file(tool("c"), null).groupId, "c");
});

test("a chain of one is closed but never named", () => {
  const t = new ChainTracker();
  t.file(tool("a"), null);
  assert.equal(t.file(said("s"), null).closed, null);
});

test("a chain never spans two turns", () => {
  const t = new ChainTracker();
  t.file(tool("a", { turnId: "t1" }), null);
  t.file(tool("b", { turnId: "t1" }), null);
  const r = t.file(tool("c", { turnId: "t2" }), null);
  assert.equal(r.groupId, "c");
  assert.deepEqual(r.closed?.itemIds, ["a", "b"]);
});

test("an item already on disk keeps the chain it was filed under", () => {
  const t = new ChainTracker();
  const a = tool("a");
  t.file(a, null);
  t.file(tool("b"), null);
  // The same call, streamed again with its input filled in.
  const again = t.file({ ...a, input: { file_path: "/y" } }, { ...a, groupId: "a" } as TimelineItem);
  assert.equal(again.groupId, "a");
  assert.equal(again.closed, null);
  // And it did not join the chain twice.
  assert.deepEqual(t.close("th")?.itemIds, ["a", "b"]);
});

test("a message that was streamed before does not close the chain again", () => {
  const t = new ChainTracker();
  t.file(tool("a"), null);
  t.file(tool("b"), null);
  const s = said("s");
  assert.deepEqual(t.file(s, null).closed?.itemIds, ["a", "b"]);
  assert.equal(t.file(s, s).closed, null);
});

test("each thread keeps its own chain", () => {
  const t = new ChainTracker();
  t.file({ ...tool("a"), threadId: "one" }, null);
  t.file({ ...tool("b"), threadId: "two" }, null);
  t.file({ ...tool("c"), threadId: "one" }, null);
  assert.deepEqual(t.close("one")?.itemIds, ["a", "c"]);
  assert.equal(t.close("two"), null);
});

test("closing twice names a chain once", () => {
  const t = new ChainTracker();
  t.file(tool("a"), null);
  t.file(tool("b"), null);
  assert.ok(t.close("th"));
  assert.equal(t.close("th"), null);
});

test("a stopping daemon closes every chain it holds", () => {
  const t = new ChainTracker();
  t.file({ ...tool("a"), threadId: "one" }, null);
  t.file({ ...tool("b"), threadId: "one" }, null);
  t.file({ ...tool("c"), threadId: "two" }, null);
  // One thread has two calls and the other has one, so only one is worth naming.
  assert.deepEqual(t.closeAll().map((c) => c.id), ["a"]);
  assert.deepEqual(t.closeAll(), []);
});
