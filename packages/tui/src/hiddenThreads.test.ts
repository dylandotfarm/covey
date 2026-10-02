/**
 * The threads covey hides, and the mark on the thread they are reviewing.
 *
 * A reviewer is machinery the reader did not ask for, so it is off the screen
 * (`Thread.hidden`). Two things have to hold for that to be safe, and they are
 * what these cases are:
 *
 *  - A hidden thread that needs a person is never hidden. A reviewer in a strict
 *    permission mode asks for an approval, and an approval nobody can see is a
 *    thread that waits for ever — the deadlock of #69, one step worse.
 *  - The thread being reviewed says so. Its reviewers are invisible, so without
 *    a mark a thread with a pull request open sits still for minutes with
 *    nothing on screen to say why, and reads as stalled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadIsFinished, threadIsHidden, threadNeedsPerson, threadReviewing, type ReviewerState, type Thread } from "@covey/protocol";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1", projectId: "p1", title: "a thread", provider: "claude", sessionId: "s1", model: null,
    permissionMode: "default", branch: "covey/t1", worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
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

test("a thread nobody hid is painted, whatever the switch says", () => {
  assert.equal(threadIsHidden(thread()), false);
  assert.equal(threadIsHidden(thread(), true), false);
});

test("a hidden thread is off the screen until the reader asks", () => {
  const t = thread({ hidden: true });
  assert.equal(threadIsHidden(t), true);
  assert.equal(threadIsHidden(t, false), true);
  assert.equal(threadIsHidden(t, true), false, "the switch is the way in");
});

test("a hidden thread that needs a person is never hidden", () => {
  // The whole safety of the feature. Each of these is a thread nobody else is
  // watching: a reviewer that failed, one blocked on an approval, one asking a
  // question. Off the screen, each is a deadlock in silence.
  for (const over of [{ status: "error" as const }, { status: "waiting" as const }, { pendingApprovals: 1 }]) {
    const t = thread({ hidden: true, ...over });
    assert.equal(threadNeedsPerson(t), true, JSON.stringify(over));
    assert.equal(threadIsHidden(t), false, `hidden while it needs a person: ${JSON.stringify(over)}`);
  }
});

test("a hidden thread that is merely working stays hidden", () => {
  // A reviewer reading a diff is quiet work, and quiet work is what hiding is
  // for. Only a thread that needs the reader comes through.
  assert.equal(threadIsHidden(thread({ hidden: true, status: "running" })), true);
  assert.equal(threadIsHidden(thread({ hidden: true, latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null } })), true);
});

test("a thread with no review is not under review", () => {
  assert.equal(threadReviewing(thread()), 0);
  assert.equal(threadReviewing(reviewed()), 0, "a requirement of none waits on nobody");
});

test("a reviewer that is reading, or waiting on the author, counts", () => {
  // Both are a live loop. A reviewer that asked for changes is as much a reason
  // the thread is not finished as one still reading.
  assert.equal(threadReviewing(reviewed("reviewing")), 1);
  assert.equal(threadReviewing(reviewed("changesRequested")), 1);
  assert.equal(threadReviewing(reviewed("reviewing", "reviewing")), 2);
  assert.equal(threadReviewing(reviewed("signedOff", "reviewing")), 1);
});

test("a review that is over leaves no mark", () => {
  assert.equal(threadReviewing(reviewed("signedOff")), 0);
  assert.equal(threadReviewing(reviewed("signedOff", "signedOff")), 0);
  // Nothing is reading, so nothing is marked as reading. That the pull request
  // is now short of a sign-off is the readiness on the row, not this.
  assert.equal(threadReviewing(reviewed("dropped")), 0);
});

test("a thread under review has not finished", () => {
  // The `✓` in the sidebar and the green dot on the phone say the same thing:
  // this thread is yours again. A turn that ended is not enough, because the
  // reviewers read the change after the author stops and the next turn comes
  // from them — both marks at once sent the reader to a thread with nothing to
  // do in it.
  const ended = { turnId: "x", state: "completed" as const, startedAt: "", completedAt: "" };
  assert.equal(threadIsFinished(thread({ latestTurn: ended })), true);
  assert.equal(threadIsFinished({ ...reviewed("reviewing"), latestTurn: ended }), false);
  assert.equal(threadIsFinished({ ...reviewed("changesRequested"), latestTurn: ended }), false);
  assert.equal(threadIsFinished({ ...reviewed("signedOff"), latestTurn: ended }), true, "the review is over");
  assert.equal(threadIsFinished({ ...reviewed("dropped"), latestTurn: ended }), true);
});

test("only a turn that ended finishes a thread", () => {
  assert.equal(threadIsFinished(thread()), false, "a thread that has never run");
  assert.equal(threadIsFinished(thread({ latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null } })), false);
  assert.equal(threadIsFinished(thread({ latestTurn: { turnId: "x", state: "error", startedAt: "", completedAt: "" } })), false);
});
