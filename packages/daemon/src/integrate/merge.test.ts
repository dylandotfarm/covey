import { test } from "node:test";
import assert from "node:assert/strict";
import type { BaseHead, MergeParty, RegressionEvidence } from "@covey/protocol";
import { mergeMember, planMerges } from "./merge.js";
import { buildQueue, type QueueEntry } from "./queue.js";
import { parseRevList } from "./gh.js";
import { fakeHost, member, pr } from "./testHost.js";

const BASE: BaseHead = { oid: "21a79da", committedAt: "2026-09-16T16:00:00Z" };
const GREEN = [{ name: "check", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-16T16:30:00Z" }];
const EVIDENCE: RegressionEvidence = {
  reverted: "the guard in sidebar.ts:112",
  test: "packages/tui/src/sidebar.test.ts",
  failure: "✖ sidebar rows (1ms)\nℹ fail 1\nAssertionError: 3 !== 4",
  recordedAt: "2026-09-16T17:00:00Z",
};

const INTEGRATOR: MergeParty = { id: "operator", integrator: true };
const MEMBER_PARTY: MergeParty = { id: "agent-7", integrator: false };

function host(over: Parameters<typeof fakeHost>[0] = {}) {
  return fakeHost({ base: BASE, prs: { good: pr({ number: 60, checks: GREEN }) }, canMerge: true, ...over });
}

test("the integrator merges a member that passes the gate", async () => {
  const h = host();
  const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR });
  assert.equal(result.merged, true);
  assert.deepEqual(h.merges, [{ number: 60, method: "merge" }]);
});

test("a member may not merge, however green it is — one party merges", async () => {
  const h = host();
  const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor: MEMBER_PARTY });
  assert.equal(result.merged, false);
  assert.deepEqual(h.merges, [], "nothing was merged");
  const refusal = result.verdict.refusals.find((r) => r.code === "not-the-merge-party");
  assert.ok(refusal);
  assert.match(refusal.message, /agent-7 may not merge/);
  assert.match(refusal.message, /never gets push rights to `main`/);
});

test("a caller that names no party is refused, not answered with an exception", async () => {
  // `actor` crosses the wire. A client that omits it must read a refusal, the
  // same as a member does, rather than a stack trace from inside the merge.
  for (const actor of [undefined, null, {} as MergeParty]) {
    const h = host();
    const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor });
    assert.equal(result.merged, false, String(actor));
    assert.deepEqual(h.merges, [], "nothing was merged");
    assert.ok(result.verdict.refusals.some((r) => r.code === "not-the-merge-party"), String(actor));
  }
});

test("the gate is read fresh at merge time, not taken from an older verdict", async () => {
  // The same green checks, and a base head that landed after they started.
  const moved: BaseHead = { oid: "newer", committedAt: "2026-09-16T16:45:00Z" };
  const h = host({ base: moved });
  const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR });
  assert.equal(result.merged, false);
  assert.deepEqual(h.merges, []);
  assert.deepEqual(result.verdict.refusals.map((r) => r.code), ["ci-stale"]);
});

test("a running turn stops the merge at the last moment", async () => {
  const h = host();
  const result = await mergeMember(h, { member: member({ branch: "good", turnRunning: true }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR });
  assert.equal(result.merged, false);
  assert.deepEqual(h.merges, []);
});

test("no evidence, no merge", async () => {
  const h = host();
  const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: null, actor: INTEGRATOR });
  assert.equal(result.merged, false);
  assert.deepEqual(h.merges, []);
});

test("a merge out of queue order is refused, and names what lands first", async () => {
  const entries: QueueEntry[] = [
    { member: member({ branch: "good", memberId: "good" }), diff: { branch: "good", additions: 10, deletions: 0, files: ["a.ts"], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
    { member: member({ branch: "big", memberId: "big", label: "#9 composer prefixes" }), diff: { branch: "big", additions: 1222, deletions: 0, files: ["a.ts"], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
  ];
  const queue = buildQueue(entries);
  const h = host();
  const result = await mergeMember(h, { member: member({ branch: "good", memberId: "good" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR, queue });
  assert.equal(result.merged, false);
  assert.deepEqual(h.merges, []);
  const refusal = result.verdict.refusals.find((r) => r.code === "merge-conflict");
  assert.match(refusal!.message, /is 2 of 2 in the queue; #9 composer prefixes lands first/);
});

test("a host with no merge capability refuses rather than pretending to merge", async () => {
  const h = host({ canMerge: false });
  const result = await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR });
  assert.equal(result.merged, false);
  assert.match(result.verdict.refusals.at(-1)!.message, /built without the merge capability/);
});

test("the audit runs straight after a merge, and reports work the branch kept back", async () => {
  const left = parseRevList("9b8a8ec\tAdd a regression test for the wheel scroll offset\n");
  const h = host({ revLists: { good: left } });
  const result = await mergeMember(h, { member: member({ branch: "good", label: "#20 wheel scroll" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR });
  assert.equal(result.merged, true);
  assert.ok(result.merged && result.audit.length === 1, "the merge that hid 211 lines is caught at once");
  assert.match(result.merged ? result.audit[0]!.message : "", /holds 1 commit that `main` does not/);
});

test("the merge method is passed through", async () => {
  const h = host();
  await mergeMember(h, { member: member({ branch: "good" }), base: "main", evidence: EVIDENCE, actor: INTEGRATOR, method: "squash" });
  assert.deepEqual(h.merges, [{ number: 60, method: "squash" }]);
});

test("planMerges reads everything and merges nothing", async () => {
  const entries: QueueEntry[] = [
    { member: member({ branch: "big", memberId: "big", label: "#9 composer" }), diff: { branch: "big", additions: 1222, deletions: 0, files: ["a.ts"], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
    { member: member({ branch: "good", memberId: "good" }), diff: { branch: "good", additions: 10, deletions: 0, files: ["a.ts"], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
  ];
  const h = host({ prs: { good: pr({ number: 60, checks: GREEN }), big: pr({ number: 61, checks: GREEN }) } });
  const plan = await planMerges(h, {
    entries,
    base: "main",
    evidence: new Map([["big", EVIDENCE], ["good", EVIDENCE]]),
  });
  assert.deepEqual(h.merges, [], "a plan is a read");
  assert.deepEqual(plan.queue.map((q) => q.branch), ["big", "good"]);
  assert.equal(plan.next?.branch, "big");
  assert.equal(plan.verdicts.length, 2);
  assert.ok(plan.verdicts.every((v) => v.ok));
});

test("planMerges offers nobody when the first member does not pass the gate", async () => {
  const entries: QueueEntry[] = [
    { member: member({ branch: "big", memberId: "big" }), diff: { branch: "big", additions: 1222, deletions: 0, files: [], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
    { member: member({ branch: "good", memberId: "good" }), diff: { branch: "good", additions: 10, deletions: 0, files: [], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
  ];
  const h = host({ prs: { good: pr({ number: 60, checks: GREEN }), big: pr({ number: 61, checks: GREEN }) } });
  const plan = await planMerges(h, { entries, base: "main", evidence: new Map([["good", EVIDENCE]]) });
  assert.equal(plan.next, null, "the second member is ready, but the queue is serial and holds");
  assert.deepEqual(plan.verdicts.find((v) => v.memberId === "big")!.refusals.map((r) => r.code), ["no-evidence"]);
});
