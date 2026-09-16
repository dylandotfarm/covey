/**
 * The gate: every reason a member may not land, gathered at once.
 *
 * A gate that returns the first refusal costs a round per refusal, and a round
 * is an agent turn. So `gateMember` collects them all and the operator sends
 * one message back.
 *
 * Four of the refusals come from the run of 2026-09-16:
 *  - `ci-pending`, because the operator merged on a pending check once;
 *  - `ci-stale`, because two green pull requests broke the base together;
 *  - `turn-running`, because a merge under a running turn hid 211 lines of
 *    work on a branch whose pull request had already closed;
 *  - `no-evidence`, because three of five merged agents had tests that could
 *    not fail.
 */
import type {
  BaseHead, GateRefusal, GateVerdict, RegressionEvidence, RunMemberRef,
} from "@covey/protocol";
import type { PullRequestFacts } from "./gh.js";
import { summariseChecks } from "./checks.js";
import { checkEvidence } from "./evidence.js";

export interface GateInput {
  member: RunMemberRef;
  /** The pull request, or null when the member opened none. */
  pr: PullRequestFacts | null;
  /** The tip of the base branch now, not when the checks ran. */
  base: BaseHead | null;
  evidence: RegressionEvidence | null;
}

/**
 * Decide one member. The verdict holds the checks and the evidence as well as
 * the refusals, because the per-member view shows all three together.
 */
export function gateMember(input: GateInput): GateVerdict {
  const { member, pr, base, evidence } = input;
  const refusals: GateRefusal[] = [];

  if (member.outcome === "withdrawn") {
    refusals.push({
      code: "withdrawn",
      message: `${member.label} is withdrawn: the task was cancelled after the work was done, and there is nothing to merge`,
    });
  }

  // A run owns the map from thread to branch, so it can answer this and refuse.
  if (member.turnRunning) {
    refusals.push({
      code: "turn-running",
      message: `${member.label} still runs a turn; a merge now can hide the commits it is about to push to \`${member.branch}\``,
    });
  }

  if (!pr) {
    refusals.push({
      code: "pr-missing",
      message: `no pull request on \`${member.branch}\``,
    });
    const verdict = summariseChecks([], base);
    return {
      memberId: member.memberId, branch: member.branch, ok: false,
      ci: verdict.ci, checks: verdict.checks, refusals: [...refusals, ...checkEvidence(evidence)], evidence: evidence ?? null,
    };
  }

  if (pr.isDraft) {
    refusals.push({ code: "pr-draft", message: `pull request #${pr.number} is a draft` });
  }

  const checks = summariseChecks(pr.checks, base, pr.mergeStateStatus);
  switch (checks.ci) {
    case "failing":
      refusals.push({ code: "ci-failing", message: `CI failed on #${pr.number}: ${checks.reason}` });
      break;
    case "pending":
      // Pending is a refusal, not a pass. Waiting costs a wait; merging on a
      // pending check costs the next change a whole re-merge round.
      refusals.push({ code: "ci-pending", message: `CI has not finished on #${pr.number}: ${checks.reason}` });
      break;
    case "stale":
      refusals.push({
        code: "ci-stale",
        message: `CI on #${pr.number} is green against an older base: ${checks.reason}. Re-run it against the base head before you merge`,
      });
      break;
    case "absent":
      refusals.push({ code: "ci-absent", message: `#${pr.number} proves nothing: ${checks.reason}` });
      break;
    case "passing":
      break;
  }

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus.toUpperCase() === "DIRTY") {
    refusals.push({
      code: "merge-conflict",
      message: `#${pr.number} conflicts with \`${pr.baseRefName}\`; the member merges the base into its branch first`,
    });
  }

  refusals.push(...checkEvidence(evidence));

  return {
    memberId: member.memberId,
    branch: member.branch,
    ok: refusals.length === 0,
    ci: checks.ci,
    checks: checks.checks,
    refusals,
    evidence: evidence ?? null,
  };
}

/** One line per refusal, for the message a run sends back to a member. */
export function refusalReport(verdict: GateVerdict): string {
  if (verdict.ok) return `\`${verdict.branch}\` passes the gate.`;
  const lines = verdict.refusals.map((r) => `- [${r.code}] ${r.message}`);
  return [`\`${verdict.branch}\` does not pass the gate:`, ...lines].join("\n");
}
