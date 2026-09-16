import { test } from "node:test";
import assert from "node:assert/strict";
import type { BaseHead, RegressionEvidence } from "@covey/protocol";
import { gateMember, refusalReport } from "./gate.js";
import { member, pr } from "./testHost.js";

const BASE: BaseHead = { oid: "21a79da", committedAt: "2026-09-16T16:00:00Z" };
const GREEN = [{ name: "check", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-16T16:30:00Z" }];

const EVIDENCE: RegressionEvidence = {
  reverted: "the guard in sidebar.ts:112",
  test: "packages/tui/src/sidebar.test.ts",
  failure: "✖ sidebar rows (1ms)\nℹ fail 1\nAssertionError: 3 !== 4",
  recordedAt: "2026-09-16T17:00:00Z",
};

function codes(over: Parameters<typeof gateMember>[0]): string[] {
  return gateMember(over).refusals.map((r) => r.code);
}

test("a green, fresh, evidenced, quiet member passes", () => {
  const verdict = gateMember({
    member: member({ branch: "issue-20-wheel-scroll" }),
    pr: pr({ number: 60, checks: GREEN }),
    base: BASE,
    evidence: EVIDENCE,
  });
  assert.deepEqual(verdict.refusals, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ci, "passing");
  assert.equal(refusalReport(verdict), "`issue-20-wheel-scroll` passes the gate.");
});

test("a running turn refuses a merge that is green in every other way", () => {
  const verdict = gateMember({
    member: member({ branch: "issue-20-wheel-scroll", turnRunning: true, label: "#20 wheel scroll" }),
    pr: pr({ number: 60, checks: GREEN }),
    base: BASE,
    evidence: EVIDENCE,
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.refusals.map((r) => r.code), ["turn-running"]);
  assert.match(verdict.refusals[0]!.message, /hide the commits it is about to push/);
});

test("green is not the gate: no evidence is a refusal on its own", () => {
  assert.deepEqual(
    codes({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: GREEN }), base: BASE, evidence: null }),
    ["no-evidence"],
  );
});

test("a pending check is a refusal, and so is a stale green one", () => {
  const pending = [{ name: "check", status: "IN_PROGRESS", startedAt: "2026-09-16T16:30:00Z" }];
  assert.deepEqual(
    codes({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: pending }), base: BASE, evidence: EVIDENCE }),
    ["ci-pending"],
  );
  // The same green checks, against a base head that landed after they started.
  const moved: BaseHead = { oid: "newer", committedAt: "2026-09-16T16:45:00Z" };
  const stale = gateMember({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: GREEN }), base: moved, evidence: EVIDENCE });
  assert.deepEqual(stale.refusals.map((r) => r.code), ["ci-stale"]);
  assert.match(stale.refusals[0]!.message, /Re-run it against the base head/);
});

test("a conflicting pull request is refused, by either signal GitHub gives", () => {
  assert.ok(codes({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: GREEN, mergeable: "CONFLICTING" }), base: BASE, evidence: EVIDENCE }).includes("merge-conflict"));
  assert.ok(codes({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: GREEN, mergeStateStatus: "DIRTY" }), base: BASE, evidence: EVIDENCE }).includes("merge-conflict"));
});

test("a draft is refused", () => {
  assert.ok(codes({ member: member({ branch: "b" }), pr: pr({ number: 1, checks: GREEN, isDraft: true }), base: BASE, evidence: EVIDENCE }).includes("pr-draft"));
});

test("a member with no pull request is refused, and still reports its evidence gap", () => {
  const verdict = gateMember({ member: member({ branch: "issue-15-esc" }), pr: null, base: BASE, evidence: null });
  assert.deepEqual(verdict.refusals.map((r) => r.code), ["pr-missing", "no-evidence"]);
  assert.equal(verdict.ci, "absent");
});

test("a withdrawn member is refused as withdrawn, which is an outcome and not a failure", () => {
  const verdict = gateMember({
    member: member({ branch: "issue-15-esc", state: "withdrawn", label: "#15 rebind esc" }),
    pr: null, base: BASE, evidence: null,
  });
  assert.equal(verdict.refusals[0]!.code, "withdrawn");
  assert.match(verdict.refusals[0]!.message, /cancelled after the work was done/);
});

test("the gate reports every refusal at once, because each round costs a turn", () => {
  const verdict = gateMember({
    member: member({ branch: "b", turnRunning: true }),
    pr: pr({ number: 1, checks: [{ name: "check", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-16T16:30:00Z" }], mergeable: "CONFLICTING", isDraft: true }),
    base: BASE,
    evidence: null,
  });
  assert.deepEqual(verdict.refusals.map((r) => r.code), [
    "turn-running", "pr-draft", "ci-failing", "merge-conflict", "no-evidence",
  ]);
  const report = refusalReport(verdict);
  assert.match(report, /does not pass the gate/);
  assert.equal(report.split("\n").length, 6, "one heading and one line per refusal");
});
