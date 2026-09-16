/**
 * The gate that no machine can judge, and the little of it a machine can.
 *
 * A test that exists proves nothing. In the run of 2026-09-16 the operator
 * asked every agent to revert its fix and run its test again, and three of the
 * five already-merged agents found their own tests proved nothing:
 *
 *  - one matched a message against `/pngpaste|wl-clipboard|xclip/`, which the
 *    broken output also matched;
 *  - one built a fresh `Store` and looked for a cached view in it, which is
 *    empty whatever the code does;
 *  - one shipped four fixes covered by two tests that shared a single case.
 *
 * So the gate is the record: the member reverted the fix, watched the test
 * fail, and kept the failure. A machine cannot read that record and know the
 * test is good. It can refuse a record that is empty, that names nothing, or
 * that holds the output of a test run which passed. Those three refusals catch
 * the cheapest way to fake the gate, and the run shows the rest to a person.
 */
import type { GateRefusal, RegressionEvidence } from "@covey/protocol";

/**
 * The summary line of a test runner that passed. `# fail 0` is what the node
 * test runner prints. These are machine output, not prose, so a member who
 * writes about a pass in its own words is not caught by them.
 */
const CLAIMS_NO_FAILURE = [
  // `# fail 0` (tap reporter) and `ℹ fail 0` (spec reporter) are the same line.
  /(?:^|[#ℹ\s])fail\s+0\b/im,
  /\b0\s+(?:failing|failures|failed)\b/i,
  /\bfail(?:ed|ures?)?\s*[:=]\s*0\b/i,
];

/** A mark that some test run actually failed. A record without one holds no failure. */
const FAILURE_MARK = /(not ok\b|\bfail|\berror\b|assert|expect|✖|✗|✘|✕|×)/i;

function blank(text: string | undefined): boolean {
  return !text || text.trim().length === 0;
}

/**
 * Judge the record, not the test. Returns every refusal, so a member fixes the
 * record in one round instead of three.
 */
export function checkEvidence(evidence: RegressionEvidence | null | undefined): GateRefusal[] {
  if (!evidence) {
    return [{
      code: "no-evidence",
      message: "no regression evidence: the member did not record a revert, a test and the failure it produced",
    }];
  }
  const refusals: GateRefusal[] = [];
  const say = (message: string) => refusals.push({ code: "evidence-proves-nothing", message });

  if (blank(evidence.reverted)) say("the evidence does not say which fix was reverted");
  if (blank(evidence.test)) say("the evidence does not name the test that was run");

  if (blank(evidence.failure)) {
    say("the evidence keeps no failure output, which is the only part that proves the test bites");
    return refusals;
  }
  const failure = evidence.failure;
  for (const claim of CLAIMS_NO_FAILURE) {
    if (claim.test(failure)) {
      say(`the recorded output reports no failing test (\`${firstMatch(failure, claim)}\`), so it is a pass, not a failure`);
      return refusals;
    }
  }
  if (!FAILURE_MARK.test(failure)) {
    say("the recorded output holds no failure — no failed assertion, no error, no failing test");
  }
  return refusals;
}

function firstMatch(text: string, re: RegExp): string {
  return (text.match(re)?.[0] ?? "").trim();
}

/**
 * One line for the per-member view. The operator reads this beside the diff,
 * so it names the revert and the test and keeps the first line of the failure.
 */
export function evidenceSummary(evidence: RegressionEvidence | null | undefined): string {
  if (!evidence) return "no regression evidence recorded";
  const first = (evidence.failure ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "(no failure recorded)";
  return `reverted ${evidence.reverted.trim()} → ${evidence.test.trim()} failed: ${first}`;
}
