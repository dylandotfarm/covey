/**
 * The join between the run model of #44 and the integration half.
 *
 * `RunMember` says what a member is. `RunMemberRef` is the little of it that a
 * gate, a queue or an audit reads. One function turns the first into the
 * second, so there is one model and not two.
 */
import type {
  AuditFinding, GateVerdict, QueuePosition, RegressionEvidence,
  RunMember, RunMemberRef, RunMemberReview,
} from "@covey/protocol";

/**
 * A member as the integration half reads it.
 *
 * `turnRunning` is the one fact that is not on `RunMember`: it belongs to the
 * member's thread. The daemon that owns the thread reads it, so a client
 * cannot get it wrong and merge under a running turn.
 */
export function memberRef(member: RunMember, turnRunning: boolean): RunMemberRef {
  return {
    memberId: member.id,
    label: memberLabel(member),
    threadId: member.threadId,
    machineId: member.machineId,
    branch: member.branch ?? "",
    pullRequest: member.pullRequest?.number ?? null,
    turnRunning,
    state: member.state,
  };
}

/** `#20 wheel scroll`, or the task title when the task is a plain line. */
export function memberLabel(member: RunMember): string {
  const title = member.task.title.trim();
  return member.task.issue ? `#${member.task.issue} ${title}` : title || member.task.key;
}

/** Start an empty review, so a member always has the shape the panel reads. */
export function emptyReview(): RunMemberReview {
  return { gate: null, evidence: null, queue: null, audit: null, checkedAt: null };
}

/** Fold what the run just read into a member's review, keeping the rest. */
export function withReview(
  review: RunMemberReview | null | undefined,
  next: Partial<RunMemberReview>,
): RunMemberReview {
  return { ...emptyReview(), ...(review ?? {}), ...next, checkedAt: new Date().toISOString() };
}

/** Where a member's evidence lives, for the gate to read. */
export function evidenceOf(member: RunMember): RegressionEvidence | null {
  return member.review?.evidence ?? null;
}

/** Every member's evidence, keyed by member id, as `planMerges` wants it. */
export function evidenceMap(members: RunMember[]): Map<string, RegressionEvidence | null> {
  return new Map(members.map((m) => [m.id, evidenceOf(m)]));
}

export type { GateVerdict, QueuePosition, AuditFinding };
