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

/**
 * A timer is the review's case under another name. The thread ended its
 * turn on purpose, with work running somewhere else and covey holding the only
 * thing that will wake it — so it is reported and it interrupts nobody. Said
 * as a bell, every agent that waits out a twenty-minute build would ring a
 * phone twice: once to say it was waiting and once to say it was done.
 */
test("a turn that ended onto a timer is progress and not an interruption", () => {
  const onTimer = (over: Partial<NonNullable<Thread["timer"]>> = {}): Partial<Thread> => ({
    timer: { note: "the CI run", lengthMs: 600_000, setAt: "", dueAt: "2099-01-01T00:00:00Z", firedAt: null, round: 1, ...over },
  });
  assert.deepEqual(threadNews(running(onTimer()), ended(onTimer())),
    { mark: null, lead: "waiting on a timer", wants: false });
  // The words are the timer's own. "Under review" about a thread with no pull
  // request is covey saying a thing that is not true.
  assert.deepEqual(threadNews(running(underReview("reviewing")), ended(underReview("reviewing"))),
    { mark: null, lead: "under review", wants: false });
  // A timer that fired is not one that runs, so the turn finishes the thread.
  assert.deepEqual(threadNews(running(onTimer({ firedAt: "2026-11-14T10:00:00Z" })), ended(onTimer({ firedAt: "2026-11-14T10:00:00Z" }))),
    { mark: "done", lead: "done", wants: true });
  // And anything the reader has to act on still buries it.
  assert.deepEqual(threadNews(running(onTimer()), ended({ ...onTimer(), pendingApprovals: 1 })),
    { mark: "approval", lead: "needs approval", wants: true });
});

/**
 * The usage limit is the timer's case again while covey is still coming back
 * to the thread — a line and never a bell, because nothing is wrong with the
 * work and the reader has nothing to do.
 *
 * It stops being that case the moment covey comes back with nothing it can
 * send. That is the one transition no turn marks: the turn failed hours
 * earlier, so the rule for a failure has long since passed, and the thread
 * would go quiet for good under a note saying nothing was needed.
 */
test("a usage limit is a line while covey holds the work, and a bell when it cannot", () => {
  const message = "You've hit your session limit · resets 12:10am (UTC)";
  const held = (over: Partial<NonNullable<Thread["usageLimit"]>> = {}): Partial<Thread> => ({
    usageLimit: { message, turnId: "x", setAt: "", dueAt: "2099-01-01T00:00:00Z", resetsAt: "2099-01-01T00:00:00Z", firedAt: null, round: 1, ...over },
  });
  assert.deepEqual(threadNews(running(held()), failed(held())),
    { mark: null, lead: "waiting on the usage limit", wants: false });
  // Covey gave up on the chain and cleared the record, so the failure is the
  // reader's in the ordinary way.
  assert.deepEqual(threadNews(running(held()), failed()), { mark: "error", lead: "failed", wants: true });

  // The wait fires. Nothing is said: covey has sent the work and the thread is
  // about to run again.
  const fired = held({ firedAt: "2026-11-16T00:11:00Z" });
  assert.equal(threadNews(failed(held()), failed(fired)), null);
  // And then it turns out there was nothing to send.
  assert.deepEqual(threadNews(failed(fired), failed({ ...fired, status: "error", lastError: message })),
    { mark: "error", lead: "failed", wants: true });
  // Said once. The row stays in that state until the reader writes.
  assert.equal(threadNews(failed({ ...fired, status: "error" }), failed({ ...fired, status: "error" })), null);
});
