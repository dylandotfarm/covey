import { test } from "node:test";
import assert from "node:assert/strict";
import type { BaseHead } from "@covey/protocol";
import { isStale, summariseCheck, summariseChecks } from "./checks.js";
import type { RollupEntry } from "./gh.js";

/**
 * The real rollup of pull request #64 of this repository, as
 * `gh pr view 64 --json statusCheckRollup` returned it on 2026-09-16.
 */
const PR64: RollupEntry[] = [
  {
    __typename: "CheckRun", name: "close", workflowName: "no external prs",
    status: "COMPLETED", conclusion: "SKIPPED",
    startedAt: "2026-09-16T16:33:11Z", completedAt: "2026-09-16T16:33:10Z",
    detailsUrl: "https://github.com/dylandotfarm/covey/actions/runs/35122624656/job/104883882849",
  },
  {
    __typename: "CheckRun", name: "check", workflowName: "ci",
    status: "COMPLETED", conclusion: "SUCCESS",
    startedAt: "2026-09-16T16:33:12Z", completedAt: "2026-09-16T16:33:45Z",
    detailsUrl: "https://github.com/dylandotfarm/covey/actions/runs/35122624445/job/104883880331",
  },
  {
    __typename: "CheckRun", name: "check", workflowName: "ci",
    status: "COMPLETED", conclusion: "SUCCESS",
    startedAt: "2026-09-16T16:33:04Z", completedAt: "2026-09-16T16:33:47Z",
    detailsUrl: "https://github.com/dylandotfarm/covey/actions/runs/35122604437/job/104883819023",
  },
];

/** The real head of `main` at the same moment, which landed after those checks. */
const MAIN_AFTER: BaseHead = { oid: "21a79da9f499dcfbadc1f900901a668747c926b4", committedAt: "2026-09-16T16:36:17Z" };
/** A base head that landed before them. */
const MAIN_BEFORE: BaseHead = { oid: "21a79da", committedAt: "2026-09-16T16:30:00Z" };

test("a green check against a base that has since moved is stale, not passing", () => {
  const v = summariseChecks(PR64, MAIN_AFTER);
  assert.equal(v.ci, "stale", "every check succeeded, but not one of them saw 21a79da");
  assert.equal(v.stale.length, 2, "both ci runs are stale; the skipped one proves nothing either way");
  assert.match(v.reason, /started before the base head landed at 2026-09-16T16:36:17Z/);
});

test("the same green checks pass once the base head is older than they are", () => {
  const v = summariseChecks(PR64, MAIN_BEFORE);
  assert.equal(v.ci, "passing");
  assert.equal(v.stale.length, 0);
  assert.match(v.reason, /passed against the current base head/);
});

test("a pending check is a refusal, not a pass", () => {
  const pending: RollupEntry[] = [
    { __typename: "CheckRun", name: "check", workflowName: "ci", status: "IN_PROGRESS", startedAt: "2026-09-16T17:00:00Z" },
    { __typename: "CheckRun", name: "other", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-16T17:00:00Z" },
  ];
  const v = summariseChecks(pending, MAIN_BEFORE);
  assert.equal(v.ci, "pending");
  assert.match(v.reason, /has not finished/);
});

test("queued and waiting are pending too", () => {
  for (const status of ["QUEUED", "WAITING", "PENDING"]) {
    const v = summariseChecks([{ name: "check", status, startedAt: "2026-09-16T17:00:00Z" }], MAIN_BEFORE);
    assert.equal(v.ci, "pending", status);
  }
});

test("one failure beats every success", () => {
  const mixed: RollupEntry[] = [
    { name: "check", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-16T17:00:00Z" },
    { name: "check", workflowName: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-16T17:00:00Z" },
    { name: "slow", status: "IN_PROGRESS", startedAt: "2026-09-16T17:00:00Z" },
  ];
  const v = summariseChecks(mixed, MAIN_BEFORE);
  assert.equal(v.ci, "failing", "a failure outranks the pending one as well");
  assert.match(v.reason, /failed/);
});

test("a rollup with nothing but skipped checks proves nothing", () => {
  const v = summariseChecks([PR64[0]!], MAIN_BEFORE);
  assert.equal(v.ci, "absent");
  assert.match(v.reason, /skipped or cancelled/);
});

test("a pull request with no checks at all proves nothing", () => {
  const v = summariseChecks([], MAIN_BEFORE);
  assert.equal(v.ci, "absent");
  assert.match(v.reason, /no checks/);
});

test("an unknown base head cannot prove a check fresh, so the check is stale", () => {
  const v = summariseChecks(PR64, null);
  assert.equal(v.ci, "stale");
  assert.match(v.reason, /base head is unknown/);
});

test("GitHub's own BEHIND is stale, whatever the timestamps say", () => {
  const v = summariseChecks(PR64, MAIN_BEFORE, "BEHIND");
  assert.equal(v.ci, "stale", "the timestamps look fresh; BEHIND says the branch has not seen the base");
  assert.ok(v.stale.length > 0, "the report names the checks that cannot be trusted");
  assert.match(v.reason, /BEHIND/);
});

test("isStale refuses on doubt: no start time is not a fresh check", () => {
  assert.equal(isStale({ name: "c", workflow: null, state: "success", startedAt: null, url: null }, MAIN_BEFORE), true);
  assert.equal(isStale({ name: "c", workflow: null, state: "success", startedAt: "nonsense", url: null }, MAIN_BEFORE), true);
  assert.equal(isStale({ name: "c", workflow: null, state: "success", startedAt: "2026-09-16T17:00:00Z", url: null }, null), true);
});

test("a status context spells its state differently and is read the same way", () => {
  assert.equal(summariseCheck({ __typename: "StatusContext", context: "buildkite", state: "PENDING", createdAt: "2026-09-16T17:00:00Z", targetUrl: "u" }).state, "pending");
  assert.equal(summariseCheck({ __typename: "StatusContext", context: "buildkite", state: "SUCCESS", createdAt: "2026-09-16T17:00:00Z" }).state, "success");
  assert.equal(summariseCheck({ __typename: "StatusContext", context: "buildkite", state: "ERROR", createdAt: "2026-09-16T17:00:00Z" }).state, "failure");
  const c = summariseCheck({ __typename: "StatusContext", context: "buildkite", state: "SUCCESS", createdAt: "2026-09-16T17:00:00Z", targetUrl: "u" });
  assert.equal(c.name, "buildkite");
  assert.equal(c.startedAt, "2026-09-16T17:00:00Z", "createdAt is the start time a status context has");
  assert.equal(c.url, "u");
});

test("a timed-out or action-required check is a failure", () => {
  for (const conclusion of ["TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
    const v = summariseChecks([{ name: "c", status: "COMPLETED", conclusion, startedAt: "2026-09-16T17:00:00Z" }], MAIN_BEFORE);
    assert.equal(v.ci, "failing", conclusion);
  }
});
