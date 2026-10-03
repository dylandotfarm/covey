/**
 * The one glyph on the left of a thread row.
 *
 * The cell is two columns on every row, so it paints one glyph and the order
 * decides which. Two rules come out of that and these cases are both:
 *
 *  - A thread under review never carries the `✓`. The `✓` says the thread is
 *    the reader's again — settle it, ask more of it, or leave it — and a thread
 *    covey's own reviewers are still reading is none of those.
 *  - What the reader has to act on comes first. A failure and an approval are
 *    painted whatever covey is doing with the change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewerState, Thread } from "@covey/protocol";
import { REVIEW_MARK, threadMark } from "./components/Sidebar.js";
import { T } from "./theme.js";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1", projectId: "p1", title: "a thread", provider: "claude", sessionId: "s1", model: null,
    permissionMode: "default", branch: "covey/t1", worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, lastMessageAt: null, archivedAt: null, pinnedAt: null,
    movedTo: null, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" },
    ...over,
  } as Thread;
}

const reviewed = (...states: ReviewerState[]) => thread({
  watch: {
    number: 7, state: "watching", reason: null, merge: "manual", mergeMethod: "merge", role: "author",
    rounds: 0, maxRounds: 3, quiet: 0, startedAt: "", polledAt: null, endedAt: null, error: null,
    cursor: { head: null, checks: null, conflict: null, mergeTried: null, reviews: [], comments: [] },
    review: {
      required: states.length,
      reviewers: states.map((state, i) => ({ threadId: `r${i}`, index: i + 1, state, note: null, startedAt: "", decidedAt: null })),
    },
  },
} as Partial<Thread>);

const glyph = (t: Thread, attention?: "approval" | "done" | "error") => threadMark(t, attention, false).glyph;

test("a thread that finished its turn is the reader's again", () => {
  assert.equal(glyph(thread(), "done"), "✓");
  assert.equal(threadMark(thread(), "done", false).color, T.success);
  assert.equal(glyph(reviewed("signedOff"), "done"), "✓", "the review is over");
  assert.equal(glyph(reviewed("dropped"), "done"), "✓");
});

test("a thread under review carries the review and never the check", () => {
  // Both marks at once said "finished" and "still working" on one row, and the
  // reader went to a thread with nothing in it to do.
  for (const state of ["reviewing", "changesRequested"] as ReviewerState[]) {
    assert.equal(glyph(reviewed(state), "done"), REVIEW_MARK, state);
    assert.equal(glyph(reviewed(state)), REVIEW_MARK, `${state}, with nothing noted`);
  }
  assert.equal(threadMark(reviewed("reviewing"), "done", false).color, T.awaiting);
  // Two reviewers are one mark: the cell is one glyph, and the count is not it.
  assert.equal(glyph(reviewed("reviewing", "reviewing"), "done"), REVIEW_MARK);
});

test("what the reader has to act on is painted first", () => {
  assert.equal(glyph(reviewed("reviewing"), "error"), "✗", "a turn that failed");
  assert.equal(glyph({ ...reviewed("reviewing"), pendingApprovals: 1 }), "●", "an approval");
  assert.equal(glyph({ ...reviewed("reviewing"), status: "running" }), "●", "its own work");
  assert.equal(threadMark({ ...reviewed("reviewing"), status: "error" }, undefined, false).color, T.danger);
});

test("a thread with nothing to say keeps its pin, or its blank", () => {
  assert.equal(glyph(thread({ latestTurn: null })), " ");
  assert.equal(glyph(thread({ latestTurn: null, pinnedAt: "2026-10-02T00:00:00Z" })), "⋆");
  // The pin is the quietest of them: anything covey or the reader is doing
  // takes the cell.
  assert.equal(glyph({ ...reviewed("reviewing"), pinnedAt: "2026-10-02T00:00:00Z" }), REVIEW_MARK);
});
