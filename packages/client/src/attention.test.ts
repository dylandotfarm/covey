/**
 * The rule every client reads before it interrupts somebody.
 *
 * The TUI owned this decision inline and the phone needed it to decide what to
 * put in a notification. These cases are the TUI's own, moved down with the
 * rule — `packages/tui/src/attention.test.ts` still holds the bell, the notice
 * and the mark, which is what the terminal does *with* the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewerState, Thread } from "@covey/protocol";
import { threadNews } from "./attention.js";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1", projectId: "p1", title: "a thread", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "", updatedAt: "", ...over,
} as Thread);

const running = (over: Partial<Thread> = {}) =>
  thread({ status: "running", latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null }, ...over });
const ended = (over: Partial<Thread> = {}) =>
  thread({ latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" }, ...over });
const failed = (over: Partial<Thread> = {}) =>
  thread({ latestTurn: { turnId: "x", state: "error", startedAt: "", completedAt: "" }, ...over });

const underReview = (...states: ReviewerState[]): Partial<Thread> => ({
  watch: {
    number: 7, state: "watching", reason: null, merge: "manual", mergeMethod: "merge", role: "author",
    rounds: 0, maxRounds: 3, quiet: 0, startedAt: "", polledAt: null, endedAt: null, error: null,
    cursor: { head: null, checks: null, conflict: null, mergeTried: null, reviews: [], comments: [] },
    review: { required: states.length, reviewers: states.map((state, i) => ({ threadId: `r${i}`, index: i + 1, state, note: null, startedAt: "", decidedAt: null })) },
  },
} as Partial<Thread>);

test("a turn that ended with nothing else running is the reader's again", () => {
  assert.deepEqual(threadNews(running(), ended()), { mark: "done", lead: "done", wants: true });
});

test("an approval and a question are one mark and two sentences", () => {
  // One dot on the row since #49: the thread stopped and only the reader can
  // start it. Two sentences, because one of them is answered with a word.
  assert.deepEqual(threadNews(running(), running({ pendingApprovals: 1 })),
    { mark: "approval", lead: "needs approval", wants: true });
  assert.deepEqual(threadNews(running(), thread({ status: "waiting" })),
    { mark: "approval", lead: "asks you something", wants: true });
});

test("a turn that failed says so", () => {
  assert.deepEqual(threadNews(running(), failed()), { mark: "error", lead: "failed", wants: true });
});

test("nothing is said twice: the rule reads the change and not the state", () => {
  // The whole reason this takes two threads. A running turn re-sends its thread
  // every few tens of milliseconds, and a thread that has wanted an approval
  // for a minute must ring once.
  assert.equal(threadNews(running({ pendingApprovals: 1 }), running({ pendingApprovals: 1 })), null);
  assert.equal(threadNews(ended(), ended()), null);
  assert.equal(threadNews(failed(), failed()), null);
  assert.equal(threadNews(running(), running()), null);
});

test("a turn that ended into a review is progress and not an interruption", () => {
  for (const state of ["reviewing", "changesRequested"] as ReviewerState[]) {
    assert.deepEqual(threadNews(running(underReview(state)), ended(underReview(state))),
      { mark: null, lead: "under review", wants: false }, state);
  }
});

test("a review that is over leaves the turn to finish the thread", () => {
  for (const state of ["signedOff", "dropped"] as ReviewerState[]) {
    assert.deepEqual(threadNews(running(underReview(state)), ended(underReview(state))),
      { mark: "done", lead: "done", wants: true }, state);
  }
});

test("a thread under review that needs the reader still says so", () => {
  // The review is covey's work. An approval and a failure are the reader's, and
  // nothing covey is doing may bury one.
  assert.deepEqual(threadNews(running(underReview("reviewing")), ended({ ...underReview("reviewing"), pendingApprovals: 1 })),
    { mark: "approval", lead: "needs approval", wants: true });
  assert.deepEqual(threadNews(running(underReview("reviewing")), failed(underReview("reviewing"))),
    { mark: "error", lead: "failed", wants: true });
});

test("a thread that has been put away is not news", () => {
  // The merge archives the thread as its last turn ends, so without this the
  // end of covey's own loop interrupts somebody about a row no client paints.
  assert.equal(threadNews(running(), ended({ archivedAt: "2026-10-13T00:00:00.000Z" })), null);
  assert.equal(threadNews(running(), failed({ archivedAt: "2026-10-13T00:00:00.000Z" })), null);
});
