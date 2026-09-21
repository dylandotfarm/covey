/**
 * The item view of #108, through a whole engine: one number reads as an
 * issue or a pull request, and each act from a client is one write on a
 * host built for it. The `gh` host is `fakeHost`, so nothing reaches GitHub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost, pr, type FakeHostOptions } from "./integrate/testHost.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: `covey/${id}`, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
  };
}

function setup(over: FakeHostOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "covey-item-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: "github.com/o/r",
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const host = fakeHost({
    canReview: true, canClose: true, canComment: true, canMerge: true,
    prs: { "covey/t1": pr({ number: 12, headRefName: "covey/t1", checks: [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] }) },
    issues: { 94: { number: 94, title: "Let a thread take an issue", url: "https://github.com/o/r/issues/94", state: "OPEN" } },
    issueBodies: { 94: { body: "The body.", author: "dylan" } },
    ...over,
  });
  // No turn starts here; a spawn is a mistake.
  const engine = new Engine(db, { ...MACHINE }, { spawn: () => { throw new Error("no session may start"); }, ghHost: () => host });
  const notes = (threadId: string) => engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
  return { db, host, engine, notes, cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("github.item reads a pull request or an issue by its number, and refuses a number that is neither", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const pull = await s.engine.githubItem("p1", 12);
  assert.equal(pull.kind, "pull");
  assert.equal(pull.number, 12);
  if (pull.kind === "pull") {
    assert.deepEqual(pull.checks.map((c) => c.state), ["success"]);
    assert.equal(pull.headRefName, "covey/t1");
  }
  const issue = await s.engine.githubItem("p1", 94);
  assert.equal(issue.kind, "issue");
  assert.equal(issue.title, "Let a thread take an issue");
  assert.equal(issue.body, "The body.");
  assert.equal(issue.viewer, "tester");
  await assert.rejects(s.engine.githubItem("p1", 999), (e: EngineError) => e.code === "not_found");
  await assert.rejects(s.engine.githubItem("p1", 0), (e: EngineError) => e.code === "bad_number");
  await assert.rejects(s.engine.githubItem("nope", 12), (e: EngineError) => e.code === "not_found");
});

test("a review from the client is one write, and the thread that holds the pull request hears about it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.db.putThread(thread("t1", { pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", branch: "covey/t1", base: "main", openedAt: "2026-01-01T00:00:00Z" } }));
  const after = await s.engine.githubAct("p1", 12, { kind: "review", event: "approve" }, "covey-web");
  assert.deepEqual(s.host.reviews, [{ number: 12, event: "approve", body: "" }]);
  assert.equal(after.kind, "pull");
  if (after.kind === "pull") {
    assert.equal(after.reviewDecision, "APPROVED", "the answer is the item read again after the act");
    assert.equal(after.reviews.length, 1);
  }
  assert.deepEqual(s.notes("t1"), ["Approved pull request #12 from covey-web."]);

  await s.engine.githubAct("p1", 12, { kind: "review", event: "request_changes", body: "one more test" }, "covey-web");
  assert.equal(s.host.reviews.at(-1)?.event, "request_changes");
  assert.match(s.notes("t1").at(-1)!, /Requested changes on pull request #12/);
});

test("a review that asks for changes needs a body, and an issue takes no review and no merge", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "review", event: "request_changes" }, "x"), (e: EngineError) => e.code === "bad_body");
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "review", event: "comment", body: "  " }, "x"), (e: EngineError) => e.code === "bad_body");
  await assert.rejects(s.engine.githubAct("p1", 94, { kind: "review", event: "approve" }, "x"), (e: EngineError) => e.code === "bad_action");
  await assert.rejects(s.engine.githubAct("p1", 94, { kind: "merge" }, "x"), (e: EngineError) => e.code === "bad_action");
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "nope" } as never, "x"), (e: EngineError) => e.code === "bad_action");
  await assert.rejects(s.engine.githubAct("p1", 999, { kind: "close" }, "x"), (e: EngineError) => e.code === "not_found");
  assert.deepEqual(s.host.reviews, []);
  assert.deepEqual(s.host.merges, []);
});

test("a comment goes to the pull request or the issue by kind, and needs a body", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.db.putThread(thread("t1", { issue: { number: 94, title: null, url: null, takenAt: "2026-01-01T00:00:00Z" } }));
  const onIssue = await s.engine.githubAct("p1", 94, { kind: "comment", body: "on the issue" }, "covey-web");
  const onPull = await s.engine.githubAct("p1", 12, { kind: "comment", body: "on the pull" }, "covey-web");
  assert.deepEqual(s.host.comments, [{ number: 94, body: "on the issue", kind: "issue" }, { number: 12, body: "on the pull", kind: "pull" }]);
  assert.equal(onIssue.comments.length, 1);
  assert.equal(onPull.comments.length, 1);
  assert.deepEqual(s.notes("t1"), ["Commented on issue #94 from covey-web."], "the thread that took the issue hears about it");
  await assert.rejects(s.engine.githubAct("p1", 94, { kind: "comment", body: " " }, "x"), (e: EngineError) => e.code === "bad_body");
});

test("merge, close and reopen are each one write, with the method the client asked for", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.engine.githubAct("p1", 12, { kind: "merge", method: "squash" }, "covey-web");
  await s.engine.githubAct("p1", 12, { kind: "merge" }, "covey-web");
  assert.deepEqual(s.host.merges, [{ number: 12, method: "squash" }, { number: 12, method: "merge" }]);
  const closed = await s.engine.githubAct("p1", 94, { kind: "close" }, "covey-web");
  assert.equal(closed.state, "CLOSED");
  const open = await s.engine.githubAct("p1", 94, { kind: "reopen" }, "covey-web");
  assert.equal(open.state, "OPEN");
  const closedPull = await s.engine.githubAct("p1", 12, { kind: "close" }, "covey-web");
  assert.equal(closedPull.state, "CLOSED");
  assert.deepEqual(s.host.stateChanges, [{ number: 94, kind: "issue", to: "closed" }, { number: 94, kind: "issue", to: "open" }, { number: 12, kind: "pull", to: "closed" }]);
});

test("a host without the capability refuses the act, and gh's refusal is readable", async (t) => {
  const s = setup({ canReview: false, canClose: false, canMerge: false, canComment: false, mergeFail: null });
  t.after(s.cleanup);
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "review", event: "approve" }, "x"), (e: EngineError) => e.code === "unsupported");
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "close" }, "x"), (e: EngineError) => e.code === "unsupported");
  await assert.rejects(s.engine.githubAct("p1", 12, { kind: "merge" }, "x"), (e: EngineError) => e.code === "unsupported");
  await assert.rejects(s.engine.githubAct("p1", 94, { kind: "comment", body: "b" }, "x"), (e: EngineError) => e.code === "unsupported");
  const refusing = setup({ mergeFail: Object.assign(new Error("exit 1"), { stderr: "X Pull request #12 is not mergeable: the base branch policy prohibits the merge.\n" }) });
  t.after(refusing.cleanup);
  await assert.rejects(refusing.engine.githubAct("p1", 12, { kind: "merge" }, "x"), (e: EngineError) => e.code === "gh" && /not mergeable/.test(e.message));
});
