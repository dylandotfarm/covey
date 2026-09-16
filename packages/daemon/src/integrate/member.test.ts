import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunMember } from "@covey/protocol";
import { emptyReview, evidenceMap, evidenceOf, memberLabel, memberRef, withReview } from "./member.js";

function runMember(over: Partial<RunMember> = {}): RunMember {
  return {
    id: "m1",
    task: { key: "#20", title: "wheel scroll", issue: 20, url: "u", requires: [] },
    machineId: "mac",
    projectId: "p1",
    threadId: "t1",
    branch: "issue-20-wheel-scroll",
    worktreePath: null,
    pullRequest: null,
    state: "review",
    note: null,
    resources: { port: 3812, coveyHome: "/tmp/h", coveyConfig: "/tmp/c" },
    brief: null,
    dispatchedAt: null,
    updatedAt: "2026-09-16T17:00:00Z",
    ...over,
  };
}

test("a member ref is a view of the run's member, not a second model", () => {
  const ref = memberRef(runMember({ pullRequest: { number: 60, title: "t", url: "u", state: "OPEN", isDraft: false, headRefName: "b", readAt: "x" } }), false);
  assert.equal(ref.memberId, "m1");
  assert.equal(ref.branch, "issue-20-wheel-scroll");
  assert.equal(ref.pullRequest, 60);
  assert.equal(ref.state, "review");
  assert.equal(ref.turnRunning, false);
});

test("turnRunning is the caller's to pass, and the caller is the daemon that owns the thread", () => {
  assert.equal(memberRef(runMember(), true).turnRunning, true);
});

test("the label is the issue number and the title, which is what a brief names", () => {
  assert.equal(memberLabel(runMember()), "#20 wheel scroll");
  assert.equal(memberLabel(runMember({ task: { key: "t3", title: "tidy the readme", issue: null, url: null, requires: [] } })), "tidy the readme");
  assert.equal(memberLabel(runMember({ task: { key: "t3", title: "  ", issue: null, url: null, requires: [] } })), "t3");
});

test("a member with no branch yet refs the empty string rather than null", () => {
  assert.equal(memberRef(runMember({ branch: null }), false).branch, "");
  assert.equal(memberRef(runMember({ pullRequest: null }), false).pullRequest, null);
});

test("a review keeps the fields it is not given, and stamps when it was read", () => {
  const first = withReview(null, { evidence: null });
  assert.deepEqual(Object.keys(first).sort(), Object.keys(emptyReview()).sort());
  assert.ok(first.checkedAt, "every read is stamped, so a stale verdict is visible");
  const second = withReview(first, { queue: null });
  assert.equal(second.gate, null);
  const evidence = { reverted: "x", test: "y", failure: "z", recordedAt: "now" };
  const third = withReview(second, { evidence });
  assert.equal(third.evidence, evidence);
  const fourth = withReview(third, { gate: null });
  assert.equal(fourth.evidence, evidence, "a later read does not drop the evidence");
});

test("evidence is read off the review, and the map is what planMerges wants", () => {
  const evidence = { reverted: "x", test: "y", failure: "z", recordedAt: "now" };
  assert.equal(evidenceOf(runMember()), null);
  assert.equal(evidenceOf(runMember({ review: withReview(null, { evidence }) })), evidence);
  const map = evidenceMap([runMember({ id: "a" }), runMember({ id: "b", review: withReview(null, { evidence }) })]);
  assert.equal(map.get("a"), null);
  assert.equal(map.get("b"), evidence);
});
