/**
 * The audit that one line of shell would have caught.
 *
 * The operator merged one member while its author still worked. The agent then
 * pushed a 211 line test to a branch whose pull request had already merged, and
 * the work was invisible until `git rev-list origin/main..origin/<branch>` went
 * looking for it.
 *
 * So: after any merge, ask that question of every merged member. A run knows
 * every branch it owns, which makes the audit free. It is the cheapest check in
 * this half of the run and it is the one that recovered lost work.
 */
import type { AuditFinding, RunMemberRef } from "@covey/protocol";
import type { BranchCommit, GhHost } from "./gh.js";

/**
 * The finding for one merged member, or null when the branch holds nothing new.
 * Pure, so a test feeds it the output of a real `rev-list`.
 */
export function findingFor(member: RunMemberRef, base: string, commits: BranchCommit[]): AuditFinding | null {
  if (commits.length === 0) return null;
  const n = commits.length;
  const subject = commits[0]!.subject || commits[0]!.sha.slice(0, 7);
  return {
    memberId: member.memberId,
    branch: member.branch,
    commits,
    message:
      `${member.label} is merged, but \`${member.branch}\` holds ${n} commit${n === 1 ? "" : "s"} that \`${base}\` does not ` +
      `(newest: ${subject}). The member pushed after the merge, so the work is on the branch and nowhere else.`,
  };
}

/**
 * Run the audit over every merged member. A member with another outcome is not
 * asked: an open branch is meant to be ahead of the base, and a withdrawn one
 * was never meant to land.
 */
export async function auditMerged(
  host: GhHost,
  base: string,
  members: RunMemberRef[],
): Promise<AuditFinding[]> {
  const merged = members.filter((m) => m.outcome === "merged");
  const found = await Promise.all(
    merged.map(async (m) => findingFor(m, base, await host.revList(base, m.branch))),
  );
  return found.filter((f): f is AuditFinding => f !== null);
}

/** One block for the run's report, or a line saying the audit found nothing. */
export function auditReport(findings: AuditFinding[], checked: number): string {
  if (findings.length === 0) {
    const what = checked === 1 ? "1 merged branch holds" : `${checked} merged branches hold`;
    return `Audit: ${what} no commit that the base branch lacks.`;
  }
  const lines = [`Audit: ${findings.length} merged branch${findings.length === 1 ? " holds" : "es hold"} work that never landed.`];
  for (const f of findings) {
    lines.push("", f.message);
    for (const c of f.commits) lines.push(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  }
  return lines.join("\n");
}
