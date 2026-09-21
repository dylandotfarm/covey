/**
 * The conflict queue.
 *
 * Six of seven open pull requests conflicted at one moment in the run of
 * 2026-09-16. What worked was to serialise and to merge the largest diff
 * first, so the cheapest change pays the re-merge tax: a 235 line change that
 * re-merges three times costs less than a 1222 line change that re-merges once.
 * The operator broke the rule once, took a green +1213 ahead of a pending
 * +1222, and gained nothing.
 *
 * The other half is the brief. "You conflict" wastes a round. "`Composer.tsx`
 * moved, and you change it too" does not, because the member knows where to
 * look before it starts.
 *
 * One caution is built into the text this module writes: **file overlap does
 * not predict the real conflict.** The operator predicted a collision in
 * `lines.ts`; the collision was in `Composer.tsx`, and the dangerous part was
 * not the merge but a behaviour question. Overlap is a hint. Only a build
 * against the real base is an answer.
 */
import { isFinalMemberState, type MemberDiff, type QueueCollision, type QueuePosition, type RunMemberRef } from "@covey/protocol";

/** A member and the change it carries, as the queue reads it. */
export interface QueueEntry {
  member: RunMemberRef;
  diff: MemberDiff;
}

/** additions + deletions: what the member pays again on every re-merge. */
export function diffSize(diff: MemberDiff): number {
  return diff.additions + diff.deletions;
}

/** The files two branches both touch. Sorted, so a brief reads the same twice. */
export function fileOverlap(a: MemberDiff, b: MemberDiff): string[] {
  const other = new Set(b.files);
  return a.files.filter((f) => other.has(f)).sort();
}

/**
 * The merge order: serial, largest diff first.
 *
 * Ties break on the branch name so the order is stable. An unstable order
 * would change the brief that every member already read.
 */
export function mergeOrder(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => {
    const size = diffSize(b.diff) - diffSize(a.diff);
    return size !== 0 ? size : a.member.branch.localeCompare(b.member.branch);
  });
}

/** How many shared files one brief names before it counts the rest. */
const MAX_LISTED_FILES = 6;

/**
 * Build the queue: an order, the overlap each member meets ahead of it, and
 * the brief to send it.
 *
 * A withdrawn or merged member is not in the queue. A withdrawn task is an
 * ordinary outcome and has no change to land.
 */
export function buildQueue(entries: QueueEntry[]): QueuePosition[] {
  const queued = mergeOrder(entries.filter((e) => !isFinalMemberState(e.member.state)));
  return queued.map((entry, index) => {
    const meets: QueueCollision[] = [];
    for (const ahead of queued.slice(0, index)) {
      const files = fileOverlap(entry.diff, ahead.diff);
      if (files.length > 0) meets.push({ branch: ahead.member.branch, label: ahead.member.label, files });
    }
    const position: QueuePosition = {
      memberId: entry.member.memberId,
      branch: entry.member.branch,
      label: entry.member.label,
      position: index + 1,
      total: queued.length,
      size: diffSize(entry.diff),
      meets,
      brief: "",
    };
    position.brief = queueBrief(position, entry.diff);
    return position;
  });
}

/** The message a run sends to one member about its place in the queue. */
export function queueBrief(position: QueuePosition, diff: MemberDiff, base = "main"): string {
  const lines: string[] = [];
  lines.push(
    `You are ${position.position} of ${position.total} in the merge queue. ` +
    `The queue is serial and the largest change merges first, so the smallest change pays the re-merge cost. ` +
    `Your change is ${position.size} lines (+${diff.additions} −${diff.deletions}).`,
  );
  lines.push("");

  if (position.position === 1) {
    lines.push("Nothing lands before you. Keep your branch ready and do not merge it yourself.");
  } else if (position.meets.length === 0) {
    const ahead = position.position - 1;
    lines.push(
      ahead === 1
        ? "1 change lands before yours, and it touches no file you touch."
        : `${ahead} changes land before yours, and none of them touches a file you touch.`,
    );
  } else {
    lines.push("These land before yours and touch files you also change:");
    for (const meet of position.meets) {
      const shown = meet.files.slice(0, MAX_LISTED_FILES).map((f) => `\`${f}\``).join(", ");
      const rest = meet.files.length - MAX_LISTED_FILES;
      lines.push(`  - ${meet.label} (\`${meet.branch}\`): ${shown}${rest > 0 ? `, and ${rest} more` : ""}`);
    }
  }

  lines.push("");
  lines.push(
    "A shared file is a hint, not the answer. In the run this queue comes from, the predicted collision " +
    "never happened and the real one was in a file nobody listed — and the hard part was a behaviour " +
    "question, not a merge. Read what landed, not only the file names.",
  );
  lines.push("");
  lines.push(
    `When the change ahead of you lands: \`git fetch origin\`, merge \`origin/${base}\` into \`${position.branch}\`, ` +
    "run `pnpm run check`, and push. Do not merge your own pull request — one party merges.",
  );
  return lines.join("\n");
}

/**
 * The message for every member when the base branch is broken.
 *
 * Nobody was told in the real batch, so an agent and the operator diagnosed the
 * same break and wrote the same two-line fix. One member repairs it; the rest
 * leave the file alone.
 */
export function baseBrokenBrief(what: string, owner: string, files: string[], base = "main"): string {
  const list = files.map((f) => `\`${f}\``).join(", ");
  return [
    `\`${base}\` is broken: ${what}`,
    "",
    `${owner} repairs it. Leave ${list || "the file"} alone — fifteen agents that each fix the same line produce fifteen pull requests that each conflict with the other fourteen.`,
    "",
    `Your own checks may fail against the broken base until the repair lands. Wait for it, then merge \`origin/${base}\` into your branch and run \`pnpm run check\` again.`,
  ].join("\n");
}
