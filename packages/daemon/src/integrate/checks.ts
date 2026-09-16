/**
 * Read the check rollup of a pull request and say what it proves.
 *
 * Green is not the gate, for two reasons that both cost a real merge:
 *
 *  - A pending check is not a pass. The operator merged on one once, gained
 *    nothing, and cost the larger change a full re-merge round.
 *  - A green check is green against the base it ran on. Two pull requests were
 *    each green and each `MERGEABLE`, shared no line, and broke the base when
 *    both landed: the second one's checks ran before the first one existed.
 *    GitHub reported no conflict, because there was none. Only a build against
 *    the real base finds this, so a check that started before the current base
 *    head landed counts as no check at all.
 *
 * The second rule also has a cure: a merge queue runs the checks on the queued
 * merge result. The rule stays because the queue is a repository setting that
 * a run cannot assume.
 */
import type { BaseHead, CheckState, CheckSummary, CiState } from "@covey/protocol";
import type { RollupEntry } from "./gh.js";

/** Flatten one rollup entry. A `CheckRun` and a `StatusContext` spell state differently. */
export function summariseCheck(entry: RollupEntry): CheckSummary {
  const name = entry.name ?? entry.context ?? "check";
  const url = entry.detailsUrl ?? entry.targetUrl ?? null;
  const startedAt = entry.startedAt ?? entry.createdAt ?? null;
  const workflow = entry.workflowName ?? null;
  return { name, workflow, state: checkState(entry), startedAt, url };
}

function checkState(entry: RollupEntry): CheckState {
  // A status context carries `state` and nothing else.
  if (entry.state && !entry.status && !entry.conclusion) {
    switch (entry.state.toUpperCase()) {
      case "SUCCESS": return "success";
      case "PENDING":
      case "EXPECTED": return "pending";
      default: return "failure"; // FAILURE, ERROR
    }
  }
  const status = (entry.status ?? "").toUpperCase();
  if (status && status !== "COMPLETED") return "pending"; // QUEUED, IN_PROGRESS, WAITING, PENDING
  switch ((entry.conclusion ?? "").toUpperCase()) {
    case "SUCCESS": return "success";
    case "SKIPPED":
    case "NEUTRAL":
    case "CANCELLED": return "neutral";
    case "": return "pending"; // completed with no conclusion yet
    default: return "failure"; // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
  }
}

/**
 * True when `check` cannot have tested `base`, because the base head landed
 * after the check started.
 *
 * A check with no start time proves nothing about its base, so it is stale
 * too. The gate refuses on doubt; it is the cheaper mistake.
 */
export function isStale(check: CheckSummary, base: BaseHead | null): boolean {
  if (!base) return true;
  if (!check.startedAt) return true;
  const started = Date.parse(check.startedAt);
  const landed = Date.parse(base.committedAt);
  if (Number.isNaN(started) || Number.isNaN(landed)) return true;
  return started < landed;
}

export interface ChecksVerdict {
  ci: CiState;
  checks: CheckSummary[];
  /** The successful checks that ran against an older base. */
  stale: CheckSummary[];
  /** One sentence naming the fact that decided `ci`. */
  reason: string;
}

/**
 * Reduce the whole rollup to one state.
 *
 * The order is a refusal order, not a count: one failure beats every success,
 * one pending check beats every finished one, and a stale pass beats a fresh
 * one. `mergeStateStatus` of `BEHIND` is GitHub's own word for the stale case,
 * so it counts as stale whatever the timestamps say.
 */
export function summariseChecks(
  entries: RollupEntry[],
  base: BaseHead | null,
  mergeStateStatus = "UNKNOWN",
): ChecksVerdict {
  const checks = entries.map(summariseCheck);

  const failing = checks.filter((c) => c.state === "failure");
  if (failing.length > 0) {
    return { ci: "failing", checks, stale: [], reason: `${describe(failing)} failed` };
  }

  const pending = checks.filter((c) => c.state === "pending");
  if (pending.length > 0) {
    return { ci: "pending", checks, stale: [], reason: `${describe(pending)} has not finished` };
  }

  const passing = checks.filter((c) => c.state === "success");
  if (passing.length === 0) {
    const why = checks.length === 0 ? "the pull request has no checks" : "every check was skipped or cancelled";
    return { ci: "absent", checks, stale: [], reason: why };
  }

  const stale = passing.filter((c) => isStale(c, base));
  if (mergeStateStatus.toUpperCase() === "BEHIND") {
    return {
      ci: "stale",
      checks,
      stale: stale.length > 0 ? stale : passing,
      reason: "GitHub reports the branch as BEHIND, so the checks ran against an older base",
    };
  }
  if (stale.length > 0) {
    const when = base ? `the base head landed at ${base.committedAt}` : "the base head is unknown";
    return { ci: "stale", checks, stale, reason: `${describe(stale)} started before ${when}` };
  }

  return { ci: "passing", checks, stale: [], reason: `${describe(passing)} passed against the current base head` };
}

/** Name one check, or count several, so a refusal message stays one sentence. */
function describe(checks: CheckSummary[]): string {
  if (checks.length === 1) {
    const c = checks[0]!;
    return c.workflow && c.workflow !== c.name ? `check \`${c.workflow} / ${c.name}\`` : `check \`${c.name}\``;
  }
  return `${checks.length} checks`;
}
