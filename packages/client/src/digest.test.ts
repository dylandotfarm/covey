/**
 * What a very small screen says (#172).
 *
 * The rules that matter are about *not lying*: a state the reader cannot act on
 * is worse than a vaguer one they can, and "ready to merge" said about a branch
 * with a red check is the worst of all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread, TimelineItem } from "@covey/protocol";
import { firstSentence, replyLead, threadActivity } from "./digest.js";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1", projectId: "p1", title: "A thread", provider: "claude", sessionId: "s1",
    model: null, permissionMode: "default", branch: null, worktreePath: "/tmp/w",
    status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: null, lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null,
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
    ...over,
  } as Thread;
}

const base = { threadId: "t1", turnId: "u1", seq: 1, createdAt: "", updatedAt: "" };
const tool = (status: string): TimelineItem =>
  ({ ...base, id: `x${Math.random()}`, kind: "tool", toolUseId: "a", toolName: "Bash", input: {}, summary: "ls", status, output: null, isError: false, parentToolUseId: null, durationMs: null }) as TimelineItem;
const said = (text: string, summary?: string): TimelineItem =>
  ({ ...base, id: `s${Math.random()}`, kind: "assistant", text, streaming: false, model: null, ...(summary ? { summary } : {}) }) as TimelineItem;

test("a running call is working; a running turn with no call is thinking", () => {
  const running = thread({ status: "running" });
  assert.equal(threadActivity(running, [tool("running")]).activity, "working");
  assert.equal(threadActivity(running, [tool("completed")]).activity, "thinking");
});

test("with no items it says the general word rather than guessing", () => {
  // The list screen has no transcript. Claiming "thinking" there would be a
  // guess, and a wrong one whenever a call is in flight.
  assert.equal(threadActivity(thread({ status: "running" }), []).activity, "working");
});

test("the reader comes first, even while a call is still running", () => {
  const busy = thread({ status: "running" });
  const asking = { ...base, id: "q", kind: "question", requestId: "r", questions: [], answers: [], status: "pending" } as TimelineItem;
  assert.equal(threadActivity(busy, [tool("running"), asking]).activity, "asking");
  const approving = { ...base, id: "a", kind: "approval", requestId: "r", toolUseId: null, toolName: "Bash", input: {}, summary: "", suggestions: [], status: "pending", decidedAt: null } as TimelineItem;
  assert.equal(threadActivity(busy, [tool("running"), approving]).activity, "approving");
});

test("'ready to merge' is only said when the watch says so", () => {
  const pr = { number: 9, url: "u", branch: "b", base: "main", openedAt: "" };
  // Open, and nothing known about the checks: say it is open, not that it is ready.
  assert.equal(threadActivity(thread({ pullRequest: pr } as Partial<Thread>), []).activity, "idle");
  assert.match(threadActivity(thread({ pullRequest: pr } as Partial<Thread>), []).label, /#9/);
  // Still polling is still not ready.
  // Watching, but the gate says no: say why, and never "ready".
  const polling = thread({ pullRequest: pr, watch: { state: "watching", readiness: { ready: false, why: "a review asks for changes" } } } as Partial<Thread>);
  assert.notEqual(threadActivity(polling, []).activity, "ready");
  assert.match(threadActivity(polling, []).detail ?? "", /review/);
  // Watching with no readiness yet is also not ready.
  const fresh = thread({ pullRequest: pr, watch: { state: "watching" } } as Partial<Thread>);
  assert.notEqual(threadActivity(fresh, []).activity, "ready");
  // Only the daemon's own gate earns the word.
  const ready = thread({ pullRequest: pr, watch: { state: "watching", readiness: { ready: true } } } as Partial<Thread>);
  assert.equal(threadActivity(ready, []).activity, "ready");
  const merged = thread({ pullRequest: pr, watch: { state: "merged" } } as Partial<Thread>);
  assert.equal(threadActivity(merged, []).label, "Merged");
});

test("a failed turn says so, with the reason cut to fit", () => {
  const t = thread({ status: "error", lastError: "Something went wrong in a very long way indeed, far past a chip" });
  const a = threadActivity(t, []);
  assert.equal(a.activity, "failed");
  assert.ok((a.detail ?? "").length <= 41, `detail fits a chip: ${a.detail}`);
});

test("firstSentence drops what a single line cannot carry", () => {
  assert.equal(firstSentence("Done. And then more."), "Done.");
  assert.equal(firstSentence("```js\nconst x = 1\n```\nThe build passes."), "The build passes.");
  assert.equal(firstSentence("# Heading\n- a bullet"), "Heading a bullet");
  assert.equal(firstSentence("Use `npm test` to run it."), "Use npm test to run it.");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence("   \n  "), "");
  assert.ok(firstSentence("x".repeat(400)).length <= 100);
  assert.match(firstSentence("x".repeat(400)), /…$/);
});

test("replyLead prefers the daemon's sentence, then the reply's own opening", () => {
  assert.equal(replyLead([said("The tests pass now.", "Fixed the failing tests")]), "Fixed the failing tests");
  assert.equal(replyLead([said("The tests pass now. More detail follows.")]), "The tests pass now.");
  // The last thing *said*, not the last item: a turn often ends on tool calls.
  assert.equal(replyLead([said("First."), said("Second."), tool("completed")]), "Second.");
  assert.equal(replyLead([tool("completed")]), "");
  assert.equal(replyLead([]), "");
});
