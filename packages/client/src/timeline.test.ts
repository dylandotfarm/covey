import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem, ToolCallItem } from "@covey/protocol";
import { chainLabel, chainsOf, timelineRows, type ChainRow, type ItemRow, type SaidRow } from "./timeline.js";

const AT = "2026-09-24T00:00:00.000Z";
let seq = 0;

function base(id: string, turnId: string | null = "t1") {
  return { id, threadId: "th", turnId, seq: seq++, createdAt: AT, updatedAt: AT };
}

function tool(id: string, o: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    ...base(id), kind: "tool", toolUseId: id, toolName: "Read", input: {}, summary: `Read ${id}`,
    status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 100, ...o,
  } as ToolCallItem;
}

function thought(id: string, o: Partial<TimelineItem> = {}): TimelineItem {
  return { ...base(id), kind: "thinking", text: "private", streaming: false, ...o } as TimelineItem;
}

function said(id: string, text = "hello", o: Partial<TimelineItem> = {}): TimelineItem {
  return { ...base(id), kind: "assistant", text, streaming: false, model: "sonnet", ...o } as TimelineItem;
}

/** A chain the daemon would have marked: every item points at the first one. */
function chain(items: TimelineItem[]): TimelineItem[] {
  return items.map((i) => ({ ...i, groupId: items[0]!.id }));
}

const rowKinds = (rows: { kind: string }[]) => rows.map((r) => r.kind);

test("compact folds a chain into one row and keeps what the agent said", () => {
  const items = [
    said("a1", "Let me look"),
    ...chain([tool("c1"), thought("c2"), tool("c3"), tool("c4")]),
    said("a2", "Found it"),
  ];
  const rows = timelineRows(items, { lod: "compact" });
  assert.deepEqual(rowKinds(rows), ["item", "chain", "item"]);
  const ch = rows[1] as ChainRow;
  assert.equal(ch.items.length, 4);
  assert.equal(ch.open, false);
  // Three calls and one thought: the thought is folded, never counted.
  assert.equal(ch.label, "Read 3 files");
});

test("a chain of one item is never folded", () => {
  const items = [said("a1"), ...chain([tool("c1")]), said("a2")];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "compact" })), ["item", "item", "item"]);
  assert.equal(chainsOf(items).size, 0);
});

test("an item with no groupId never folds, so an old transcript reads as it did", () => {
  const items = [said("a1"), tool("c1"), tool("c2"), thought("c3"), said("a2")];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "compact" })), ["item", "item", "item", "item", "item"]);
});

test("the model's sentence wins over the derived one", () => {
  const items = chain([tool("c1"), tool("c2")]);
  items[0]!.groupSummary = "Traced the reconnect loop";
  const row = timelineRows(items, { lod: "compact" })[0] as ChainRow;
  assert.equal(row.label, "Traced the reconnect loop");
  assert.equal(row.written, true);
});

test("a derived sentence says so, so a client can mark it", () => {
  const row = timelineRows(chain([tool("c1"), tool("c2")]), { lod: "compact" })[0] as ChainRow;
  assert.equal(row.written, false);
});

test("a folded chain still shows the call that is running", () => {
  const items = chain([tool("c1"), tool("c2", { status: "running", durationMs: null }), tool("c3")]);
  const rows = timelineRows(items, { lod: "compact" });
  assert.deepEqual(rowKinds(rows), ["chain", "item"]);
  assert.equal((rows[0] as ChainRow).running, 1);
  const live = rows[1] as ItemRow;
  assert.equal(live.item.id, "c2");
  assert.equal(live.live, true);
});

test("a chain counts its failures and its time without being opened", () => {
  const items = chain([tool("c1", { durationMs: 300 }), tool("c2", { status: "error", durationMs: 200 })]);
  const row = timelineRows(items, { lod: "compact" })[0] as ChainRow;
  assert.equal(row.failed, 1);
  assert.equal(row.durationMs, 500);
});

test("opening a chain paints the items it holds", () => {
  const items = chain([tool("c1"), thought("c2"), tool("c3")]);
  const rows = timelineRows(items, { lod: "compact", toggled: new Set(["chain:c1"]) });
  assert.deepEqual(rowKinds(rows), ["chain", "item", "item", "item"]);
  assert.equal((rows[0] as ChainRow).open, true);
  // Opening the chain does not open the calls inside it — that is a second tap.
  assert.equal((rows[1] as ItemRow).open, false);
});

test("steps gives every item a row of its own, folded", () => {
  const items = chain([tool("c1"), thought("c2"), tool("c3")]);
  const rows = timelineRows(items, { lod: "steps" });
  assert.deepEqual(rowKinds(rows), ["item", "item", "item"]);
  assert.ok(rows.every((r) => (r as ItemRow).open === false));
});

test("full opens every item, and a tap shuts one", () => {
  const items = chain([tool("c1"), tool("c2")]);
  const rows = timelineRows(items, { lod: "full", toggled: new Set(["c2"]) });
  assert.equal((rows[0] as ItemRow).open, true);
  assert.equal((rows[1] as ItemRow).open, false);
});

test("minimal keeps the first and the last thing the agent said in a turn", () => {
  const items = [said("a1", "starting"), said("a2", "middle"), said("a3", "more middle"), said("a4", "done")];
  const rows = timelineRows(items, { lod: "minimal" });
  assert.deepEqual(rowKinds(rows), ["item", "said", "item"]);
  assert.equal((rows[0] as ItemRow).item.id, "a1");
  assert.deepEqual((rows[1] as SaidRow).items.map((i) => i.id), ["a2", "a3"]);
  assert.equal((rows[1] as SaidRow).key, "said:a2");
  assert.equal((rows[2] as ItemRow).item.id, "a4");
});

test("minimal hides nothing when a turn said two things or fewer", () => {
  const items = [said("a1"), said("a2")];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "minimal" })), ["item", "item"]);
});

test("minimal counts each turn on its own", () => {
  const items = [
    said("a1", "x", { turnId: "t1" }), said("a2", "x", { turnId: "t1" }), said("a3", "x", { turnId: "t1" }),
    said("b1", "x", { turnId: "t2" }), said("b2", "x", { turnId: "t2" }),
  ];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "minimal" })), ["item", "said", "item", "item", "item"]);
});

test("compact never folds what the agent said", () => {
  const items = [said("a1"), said("a2"), said("a3"), said("a4")];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "compact" })), ["item", "item", "item", "item"]);
});

test("a user message, a question and an approval are never folded", () => {
  const items: TimelineItem[] = [
    { ...base("u1"), kind: "user", text: "do it", attachments: [] } as TimelineItem,
    { ...base("q1"), kind: "question", requestId: "r", questions: [], answers: [], status: "pending" } as TimelineItem,
    { ...base("p1"), kind: "approval", requestId: "r2", toolUseId: null, toolName: "Bash", input: {}, summary: "rm", suggestions: [], status: "pending", decidedAt: null } as TimelineItem,
  ];
  assert.deepEqual(rowKinds(timelineRows(items, { lod: "minimal" })), ["item", "item", "item"]);
});

test("the derived sentence names the two busiest verbs", () => {
  assert.equal(chainLabel([tool("a"), tool("b"), tool("c", { toolName: "Bash", summary: "build" })]), "Read 2 files and ran 1 command");
  assert.equal(chainLabel([tool("a", { toolName: "Edit" }), tool("b", { toolName: "Edit" })]), "Edited 2 files");
});

test("a chain with more than two kinds of call says so", () => {
  const items = [tool("a"), tool("b", { toolName: "Bash" }), tool("c", { toolName: "Edit" })];
  assert.match(chainLabel(items), /, and more$/);
});

test("a chain of thoughts alone is named without reading one", () => {
  assert.equal(chainLabel([thought("t1"), thought("t2")]), "Thought it through");
});

test("an unknown tool still counts", () => {
  assert.equal(chainLabel([tool("a", { toolName: "mcp__x__y" }), tool("b", { toolName: "mcp__x__y" })]), "Called 2 tools");
});
