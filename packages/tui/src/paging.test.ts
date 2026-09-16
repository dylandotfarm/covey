import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem } from "@covey/protocol";
import { previewPage, FULL_PAGE, type ThreadView } from "./store.js";
import { layoutTranscript } from "./components/Transcript.js";

/**
 * A collapsed tool call is the cheapest item the transcript can paint: exactly
 * one line. A page of them is the worst case for a page counted in items, so it
 * is what the sizing has to survive.
 */
const oneLiner = (seq: number): TimelineItem => ({
  id: `i${seq}`, threadId: "t", turnId: null, seq, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "tool", name: "Bash", summary: `step ${seq}`,
  input: {}, output: null, status: "ok", durationMs: 10, isError: false,
} as unknown as TimelineItem);

const viewOf = (n: number): ThreadView => {
  const items = Array.from({ length: n }, (_, i) => oneLiner(i + 1));
  return {
    machine: "pi", threadId: "t", thread: null, items: new Map(items.map((i) => [i.id, i])),
    loading: false, error: null, hasMore: true, loadingOlder: false, seq: n, commands: null, dirs: new Map(),
  };
};

const linesFor = (n: number) => layoutTranscript(viewOf(n), 120, new Set()).lines.length;

test("a collapsed tool call is one line — the assumption the page size rests on", () => {
  assert.equal(linesFor(1), 1);
  assert.equal(linesFor(50), 50);
});

test("a preview's first page fills the pane it was sized for", () => {
  // Every height a terminal plausibly has, against the shortest items there are.
  for (const height of [3, 10, 24, 40, 60, 120, 300]) {
    assert.ok(
      linesFor(previewPage(height)) >= height,
      `a page of ${previewPage(height)} items only painted ${linesFor(previewPage(height))} of ${height} lines`,
    );
  }
});

test("past the cap a page can come up short, which is what loadOlder is for", () => {
  // Above FULL_PAGE the page stops growing, so a pane taller than that can be
  // left half empty — App watches the painted line count and asks for more.
  const tall = FULL_PAGE + 100;
  assert.equal(previewPage(tall), FULL_PAGE);
  assert.ok(linesFor(previewPage(tall)) < tall);
});

test("a preview never asks for more than a full open would", () => {
  assert.ok(previewPage(1e6) <= FULL_PAGE);
  // …nor so few that a short pane costs a second round trip to fill.
  assert.ok(previewPage(1) >= 1);
});
