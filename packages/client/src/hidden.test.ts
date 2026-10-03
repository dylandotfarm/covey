/**
 * The hidden-threads switch, in the one place its words live.
 *
 * The TUI, the page and the app each wrote their own sentence for this switch
 * and the three had drifted. This file is what keeps the one copy honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread } from "@covey/protocol";
import { hiddenPanel } from "./hidden.js";

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `s-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "", updatedAt: "", ...over,
  } as Thread;
}

test("the switch says what it holds back, and counts it", () => {
  assert.deepEqual(hiddenPanel([], false), {
    label: "Hidden threads: hidden", hint: "covey's automated reviewers, when it has any",
  });

  const threads = [
    thread("author"),
    thread("rev1", { hidden: true }),
    thread("rev2", { hidden: true }),
  ];
  assert.deepEqual(hiddenPanel(threads, false), {
    label: "Hidden threads: hidden", hint: "2 hidden now; one that needs you is never hidden",
  });
  assert.deepEqual(hiddenPanel(threads, true), {
    label: "Hidden threads: shown", hint: "painted under the threads they review",
  });
  assert.match(hiddenPanel([thread("rev", { hidden: true })], false).hint, /^1 hidden now/);
});

test("the count is of threads a reader could actually be missing", () => {
  // An archived or moved reviewer is off the screen whatever the switch says,
  // and one that needs a person is painted whatever it says. Counting either
  // would offer to reveal a thread the switch does not reveal.
  const invisible = [
    thread("gone", { hidden: true, archivedAt: "2026-10-02T10:00:00Z" }),
    thread("moved", { hidden: true, movedTo: { machineId: "m2", threadId: "t9" } }),
    thread("asks", { hidden: true, pendingApprovals: 1 }),
    thread("failed", { hidden: true, status: "error" }),
    thread("waits", { hidden: true, status: "waiting" }),
  ];
  assert.equal(hiddenPanel(invisible, false).hint, "covey's automated reviewers, when it has any");
  assert.equal(hiddenPanel([...invisible, thread("rev", { hidden: true })], false).hint,
    "1 hidden now; one that needs you is never hidden");
});
