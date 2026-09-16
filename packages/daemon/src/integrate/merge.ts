/**
 * One party merges.
 *
 * In the run of 2026-09-16 the operator merged and no agent ever touched
 * `main`, and that rule is the reason nothing was lost to a race. Fifteen
 * agents with push rights to one branch is a different and much worse problem
 * than the one a run solves. So this module holds the only path to a merge,
 * and the path refuses unless:
 *
 *  1. the actor is the run's integrator;
 *  2. the gate passes, read fresh — not the verdict from a minute ago;
 *  3. the member's thread runs no turn at that moment;
 *  4. the member is first in the merge queue.
 *
 * Rule 2 matters most. A verdict goes stale the moment the base head moves,
 * which in a run of fifteen members is every few minutes.
 */
import type {
  AuditFinding, GateVerdict, MergeParty, QueuePosition, RegressionEvidence, RunMemberRef,
} from "@covey/protocol";
import type { GhHost } from "./gh.js";
import { gateMember } from "./gate.js";
import { auditMerged } from "./audit.js";
import { buildQueue, type QueueEntry } from "./queue.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeRequest {
  member: RunMemberRef;
  base: string;
  /** The record that the test fails without the fix. The gate reads it. */
  evidence: RegressionEvidence | null;
  /** Who asks. A member is refused whatever its gate says, and so is a caller that sends none. */
  actor: MergeParty | null | undefined;
  method?: MergeMethod;
  /** The queue, so a merge out of order is refused rather than taken. */
  queue?: QueuePosition[];
}

export type MergeResult =
  | { merged: true; verdict: GateVerdict; audit: AuditFinding[] }
  | { merged: false; verdict: GateVerdict };

/**
 * Read the gate fresh and merge, or refuse and say why.
 *
 * The verdict comes back either way, so a refusal is a message the operator can
 * forward to the member without writing anything.
 */
export async function mergeMember(host: GhHost, request: MergeRequest): Promise<MergeResult> {
  const { member, base, evidence, actor } = request;

  const pr = await host.pullRequest(member.branch);
  const head = await host.baseHead(base);
  const verdict = gateMember({ member, pr, base: head, evidence });

  // `actor` crosses the wire, so it may be missing or half-built. A caller that
  // names no party is not the integrator; it is refused like any other member,
  // and never with an exception the operator has to read as a stack trace.
  if (!actor?.integrator) {
    verdict.refusals.push({
      code: "not-the-merge-party",
      message: `${actor?.id || "a caller that names no party"} may not merge: one party merges, and a member never gets push rights to \`${base}\``,
    });
    verdict.ok = false;
  }

  const ahead = outOfOrder(request.queue, member);
  if (ahead) {
    verdict.refusals.push({
      code: "merge-conflict",
      message: `${member.label} is ${ahead.position} of ${ahead.total} in the queue; ${ahead.blockedBy} lands first, because the largest change merges first`,
    });
    verdict.ok = false;
  }

  if (!verdict.ok || !pr) return { merged: false, verdict };

  if (!host.mergePullRequest) {
    verdict.refusals.push({
      code: "not-the-merge-party",
      message: "this host cannot merge: it was built without the merge capability",
    });
    verdict.ok = false;
    return { merged: false, verdict };
  }

  await host.mergePullRequest(pr.number, request.method ?? "merge");

  // Straight after any merge, ask every merged branch whether it holds work
  // the base branch does not. This is the check that found the lost 211 lines.
  const merged: RunMemberRef = { ...member, state: "merged" };
  const audit = await auditMerged(host, base, [merged]);
  return { merged: true, verdict, audit };
}

function outOfOrder(
  queue: QueuePosition[] | undefined,
  member: RunMemberRef,
): { position: number; total: number; blockedBy: string } | null {
  if (!queue || queue.length === 0) return null;
  const mine = queue.find((q) => q.memberId === member.memberId);
  if (!mine || mine.position === 1) return null;
  const first = queue.find((q) => q.position === 1);
  return { position: mine.position, total: mine.total, blockedBy: first ? first.label : "the change ahead of it" };
}

export interface PlanInput {
  entries: QueueEntry[];
  base: string;
  /** The evidence each member recorded, keyed by `memberId`. */
  evidence: Map<string, RegressionEvidence | null>;
}

export interface MergePlan {
  base: string;
  queue: QueuePosition[];
  verdicts: GateVerdict[];
  /** The one member that may merge now, or null when none passes the gate. */
  next: QueuePosition | null;
}

/**
 * What the operator sees before anything moves: the order, the gate for every
 * member, and the one member that may go now. It reads and merges nothing.
 */
export async function planMerges(host: GhHost, input: PlanInput): Promise<MergePlan> {
  const queue = buildQueue(input.entries);
  const head = await host.baseHead(input.base);
  const verdicts = await Promise.all(
    input.entries.map(async ({ member }) => gateMember({
      member,
      pr: await host.pullRequest(member.branch),
      base: head,
      evidence: input.evidence.get(member.memberId) ?? null,
    })),
  );
  const first = queue.find((q) => q.position === 1) ?? null;
  const firstOk = first ? verdicts.find((v) => v.memberId === first.memberId)?.ok === true : false;
  return { base: input.base, queue, verdicts, next: firstOk ? first : null };
}
