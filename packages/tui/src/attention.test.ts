/**
 * What a thread says when it changes while the reader is somewhere else.
 *
 * A background thread rings a bell, raises a notice, and leaves a mark on its
 * row (`Store.attention`). The mark is the reader's cue that the thread is
 * theirs again, so a turn that ended is not enough to earn it: covey's own
 * reviewers read the change after the author stops, and the next turn comes
 * from them, not from the reader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-attention-"));

import type { MachineInfo, Project, ReviewerState, Thread } from "@covey/protocol";
import { Store, type MachineState } from "./store.js";

const PI = "ws://pi:3790";
const project = { id: "p1", title: "covey", workspaceRoot: "/repos/covey", repositoryIdentity: null, defaultModel: null, createdAt: "", updatedAt: "" } as Project;

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1", projectId: "p1", title: "a thread", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "", updatedAt: "", ...over,
} as Thread);

const running = (over: Partial<Thread> = {}) => thread({ status: "running", latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null }, ...over });
const ended = (over: Partial<Thread> = {}) => thread({ latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" }, ...over });

const underReview = (...states: ReviewerState[]): Partial<Thread> => ({
  watch: {
    number: 7, state: "watching", reason: null, merge: "manual", mergeMethod: "merge", role: "author",
    rounds: 0, maxRounds: 3, quiet: 0, startedAt: "", polledAt: null, endedAt: null, error: null,
    cursor: { head: null, checks: null, conflict: null, mergeTried: null, reviews: [], comments: [] },
    review: { required: states.length, reviewers: states.map((state, i) => ({ threadId: `r${i}`, index: i + 1, state, note: null, startedAt: "", decidedAt: null })) },
  },
} as Partial<Thread>);

/** A store holding one machine with `before` on it, and the reader elsewhere. */
function storeWith(before: Thread) {
  const store = new Store([]);
  // No bell: the cases read what the store recorded, and `\x07` on a test
  // runner's stdout is noise nobody asked for.
  (store as unknown as { config: { prefs: { quiet: boolean } } }).config.prefs.quiet = true;
  const ms = {
    key: PI, saved: { name: "pi", url: PI }, conn: "connected", error: null,
    info: { machineId: "pi", name: "pi", os: "linux", projectsDir: "/p" } as MachineInfo,
    projects: new Map([[project.id, project]]), threads: new Map([[before.id, before]]),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  store.state.machines.set(PI, ms);
  store.state.order.push(PI);
  return {
    store,
    /** The thread changes under a reader who is looking at something else. */
    becomes(next: Thread) {
      (store as unknown as { applyShell(m: MachineState, e: unknown): void }).applyShell(ms, { seq: 1, kind: "thread.upserted", thread: next });
      return { mark: store.state.attention.get(`${PI}:${next.id}`), notice: store.state.notice?.text ?? "" };
    },
  };
}

test("a turn that ended with nothing else running marks the thread done", () => {
  const { becomes } = storeWith(running());
  const { mark, notice } = becomes(ended());
  assert.equal(mark, "done");
  assert.match(notice, /^done: a thread @pi$/);
});

test("a turn that ended into a review marks nothing, and says what is happening", () => {
  // The `✓` says the thread is the reader's again, and the bell says it louder.
  // Neither is true while covey's reviewers still read the change. Saying
  // nothing is not the answer either: a background thread that falls silent
  // with no word reads as stalled.
  for (const state of ["reviewing", "changesRequested"] as ReviewerState[]) {
    const { becomes } = storeWith(running(underReview(state)));
    const { mark, notice } = becomes(ended(underReview(state)));
    assert.equal(mark, undefined, state);
    assert.match(notice, /^under review: a thread @pi$/);
  }
});

test("a review that is over leaves the turn to finish the thread", () => {
  for (const state of ["signedOff", "dropped"] as ReviewerState[]) {
    const { becomes } = storeWith(running(underReview(state)));
    assert.equal(becomes(ended(underReview(state))).mark, "done", state);
  }
});

test("a thread under review that needs the reader still says so", () => {
  // The review is covey's work. An approval and a failure are the reader's, and
  // nothing covey is doing may bury one.
  const asked = storeWith(running(underReview("reviewing")));
  assert.equal(asked.becomes(ended({ ...underReview("reviewing"), pendingApprovals: 1 })).mark, "approval");
  const failed = storeWith(running(underReview("reviewing")));
  const { mark, notice } = failed.becomes(thread({ ...underReview("reviewing"), latestTurn: { turnId: "x", state: "error", startedAt: "", completedAt: "" } }));
  assert.equal(mark, "error");
  assert.match(notice, /^failed: /);
});
