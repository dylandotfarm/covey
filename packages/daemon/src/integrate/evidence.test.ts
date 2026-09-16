import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegressionEvidence } from "@covey/protocol";
import { checkEvidence, evidenceSummary } from "./evidence.js";

/** A real failure from the node test runner, spec reporter, trimmed. */
const REAL_FAILURE = `✖ sidebar rows skip the blank line above a machine (1.03ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1

✖ failing tests:

  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  3 !== 4

      at TestContext.<anonymous> (packages/tui/src/sidebar.test.ts:4:10)`;

/** The same run with the fix in place. Nothing in it failed. */
const REAL_PASS = `✔ sidebar rows skip the blank line above a machine (0.35ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ duration_ms 104.39`;

function good(over: Partial<RegressionEvidence> = {}): RegressionEvidence {
  return {
    reverted: "the `+1` in sidebarRows, packages/tui/src/sidebar.ts:112",
    test: "packages/tui/src/sidebar.test.ts → sidebar rows skip the blank line above a machine",
    failure: REAL_FAILURE,
    recordedAt: "2026-09-16T17:00:00Z",
    recordedBy: "thread-7",
    ...over,
  };
}

test("a complete record passes the gate", () => {
  assert.deepEqual(checkEvidence(good()), []);
});

test("no record at all is the refusal the run was built for", () => {
  const refusals = checkEvidence(null);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.code, "no-evidence");
  assert.deepEqual(checkEvidence(undefined).map((r) => r.code), ["no-evidence"]);
});

test("the output of a test run that passed is not evidence that a test failed", () => {
  const refusals = checkEvidence(good({ failure: REAL_PASS }));
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.code, "evidence-proves-nothing");
  assert.match(refusals[0]!.message, /reports no failing test/);
});

test("every reporter spells the same pass the same way to this gate", () => {
  for (const line of ["# fail 0", "ℹ fail 0", "0 failing", "Tests: 0 failed, 3 passed", "failures: 0"]) {
    const refusals = checkEvidence(good({ failure: `some output\n${line}\n` }));
    assert.equal(refusals.length, 1, line);
    assert.equal(refusals[0]!.code, "evidence-proves-nothing", line);
  }
});

test("a record with no failure output keeps nothing worth having", () => {
  for (const failure of ["", "   \n  "]) {
    const refusals = checkEvidence(good({ failure }));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.message, /keeps no failure output/);
  }
});

test("`it failed` is a claim, not a failure", () => {
  const refusals = checkEvidence(good({ failure: "I reverted it and the test went red." }));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!.message, /holds no failure/);
});

test("a record that names neither the revert nor the test is refused for both", () => {
  const refusals = checkEvidence(good({ reverted: "  ", test: "" }));
  assert.deepEqual(refusals.map((r) => r.code), ["evidence-proves-nothing", "evidence-proves-nothing"]);
  assert.match(refusals[0]!.message, /which fix was reverted/);
  assert.match(refusals[1]!.message, /name the test/);
});

test("refusals come back together, so a member fixes the record in one round", () => {
  const refusals = checkEvidence(good({ reverted: "", test: "", failure: REAL_PASS }));
  assert.equal(refusals.length, 3, "two missing fields and the pass transcript, at once");
});

test("a TAP failure is a failure", () => {
  const tap = "not ok 1 - sidebar rows skip the blank line above a machine\n# fail 1\n";
  assert.deepEqual(checkEvidence(good({ failure: tap })), []);
});

test("the summary line names the revert, the test and the first line of the failure", () => {
  const line = evidenceSummary(good());
  assert.match(line, /reverted the `\+1` in sidebarRows/);
  assert.match(line, /sidebar\.test\.ts/);
  assert.match(line, /✖ sidebar rows skip the blank line above a machine/);
  assert.equal(evidenceSummary(null), "no regression evidence recorded");
});
