import type { BuildInfo } from "@covey/protocol";

/**
 * How a machine's build compares with the client's.
 *
 *  - `same`     — the same commit.
 *  - `behind`   — the machine runs an older commit than the client.
 *  - `ahead`    — the machine runs a newer commit than the client.
 *  - `unknown`  — one side does not say, or the two commits do not order.
 */
export type BuildSkew = "same" | "behind" | "ahead" | "unknown";

/**
 * Compare two builds by the commit date of `HEAD`.
 *
 * The date comes from the git history, so it means the same thing on a laptop
 * and on a Raspberry Pi. A file mtime does not: the two machines keep their own
 * clocks, and a checkout that compiled last week can hold newer code than one
 * that compiled this morning.
 *
 * Two commits with the same date, or a date that either side does not report,
 * give `unknown`. That covers a daemon built before the field existed and two
 * branches that forked from the same commit. A guess there is worse than
 * silence, because the reader acts on the answer.
 */
export function buildSkew(client: BuildInfo | null | undefined, machine: BuildInfo | null | undefined): BuildSkew {
  if (!client || !machine) return "unknown";
  if (client.commit && machine.commit && client.commit === machine.commit) return "same";
  if (!client.committedAt || !machine.committedAt) return "unknown";
  const a = Date.parse(client.committedAt);
  const b = Date.parse(machine.committedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return "unknown";
  return b < a ? "behind" : "ahead";
}

/** One line about a build, for the machine summary: `b9a8b01 on main, 2026-09-15`. */
export function buildLine(b: BuildInfo | null | undefined): string {
  if (!b) return "build unknown";
  const commit = b.commit ? `${b.commit}${b.dirty ? "-dirty" : ""}` : "no checkout";
  const where = b.branch ? ` on ${b.branch}` : "";
  const when = b.committedAt ? `, ${b.committedAt.slice(0, 10)}` : "";
  return `${commit}${where}${when}`;
}
