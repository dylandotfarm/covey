/**
 * What is news about a pull request, and what to tell the thread.
 *
 * Pure. Give it the facts `gh` read and the cursor of what the thread has
 * heard, and it answers with the events the thread has not seen and the
 * cursor to keep. The daemon polls and delivers; nothing here starts a
 * process, so every rule below has a test that needs no network.
 *
 * Three rules come from the loop an agent ran by hand on 2026-09-21, which
 * got all three wrong:
 *
 *  - Every terminal state is news, not only the good one. A failed check
 *    fires exactly as a passed one does. That loop left when the merge state
 *    stopped being `BLOCKED`, and a failure never fired for 95 minutes.
 *  - The checks are read from the check runs, never from the merge state.
 *    GitHub answers `BLOCKED` both while the checks run and after they fail.
 *  - An answer is delivered once. A checks verdict is keyed by the head it
 *    was for, and every review and comment by its id, so a retry, a
 *    reconnect or a restart sends nothing twice.
 *
 * `mergeReadiness` is the fourth rule, for the `auto` policy: the daemon
 * merges only what the gate of #45 would call green against the current
 * base, and never on a review that asks for changes.
 */
import type { BaseHead, CheckSummary, MergeMethod, MergePolicy, WatchCursor } from "@covey/protocol";
import type { CommentEntry, PullRequestFacts, ReviewEntry, RollupEntry } from "./gh.js";
import { summariseCheck, summariseChecks } from "./checks.js";

export type WatchEvent =
  | { kind: "checks"; ci: "passing" | "failing" | "absent" | "stale"; head: string; checks: CheckSummary[]; failed: CheckSummary[] }
  | { kind: "conflict"; head: string }
  | { kind: "review"; review: ReviewEntry }
  | { kind: "comment"; comment: CommentEntry }
  /** `by` is set when the daemon merged under the `auto` policy. */
  | { kind: "merged"; by?: "covey"; method?: MergeMethod }
  | { kind: "closed" }
  /** The daemon tried to merge under `auto`, and `gh` refused. */
  | { kind: "mergeFailed"; error: string };

export function emptyCursor(): WatchCursor {
  return { head: null, checks: null, conflict: null, mergeTried: null, reviews: [], comments: [] };
}

/**
 * How long a head may sit with no check before "no check ran" is the answer.
 * A workflow registers its runs within a minute of a push; a head that is
 * two minutes old with nothing on it has no checks coming.
 */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;

/** The first poll interval, and the longest the back-off reaches. */
export const POLL_MIN_MS = 30_000;
export const POLL_MAX_MS = 5 * 60_000;

/** A watch that runs this long without an end is handed to a person. */
export const WATCH_MAX_MS = 72 * 3_600_000;

/** How many turns a watch may send that ask for more work, unless told otherwise. */
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * How long to wait after a poll that found nothing. Each quiet poll waits
 * half as long again, up to the cap; a poll that found news starts over.
 */
export function pollDelayMs(quiet: number): number {
  return Math.min(POLL_MAX_MS, Math.round(POLL_MIN_MS * 1.5 ** Math.max(0, quiet)));
}

export interface ChecksNews {
  ci: "passing" | "failing" | "pending" | "absent";
  checks: CheckSummary[];
  failed: CheckSummary[];
}

/**
 * The state of the checks as the watch reads it: from the check runs, never
 * from the merge state. A failure beats everything, a pending check beats a
 * pass, and a rollup with no pass in it proves nothing. Staleness is the
 * gate's question, and the watch asks it only under the `auto` policy.
 */
export function checksVerdict(entries: RollupEntry[]): ChecksNews {
  const checks = entries.map(summariseCheck);
  const failed = checks.filter((c) => c.state === "failure");
  if (failed.length > 0) return { ci: "failing", checks, failed };
  if (checks.some((c) => c.state === "pending")) return { ci: "pending", checks, failed: [] };
  if (checks.some((c) => c.state === "success")) return { ci: "passing", checks, failed: [] };
  return { ci: "absent", checks, failed: [] };
}

export interface NewsOptions {
  /** Who merges. Under `auto`, a green check against an older base is news
   *  of its own: it stands between the thread and its merge. */
  merge?: MergePolicy;
  /** The tip of the base branch, for the staleness test. Read only under `auto`. */
  base?: BaseHead | null;
}

/**
 * The events the thread has not seen, and the cursor to keep.
 *
 * `now` is ISO 8601 and comes from the caller, so a test can make two minutes
 * pass in one call.
 */
export function news(
  pr: PullRequestFacts,
  lineComments: CommentEntry[],
  cursor: WatchCursor,
  now: string,
  options: NewsOptions = {},
): { events: WatchEvent[]; cursor: WatchCursor } {
  const next: WatchCursor = { ...emptyCursor(), ...cursor, reviews: [...cursor.reviews], comments: [...cursor.comments] };
  const events: WatchEvent[] = [];
  const sha = pr.headRefOid;
  if (!next.head || next.head.sha !== sha) next.head = { sha, seenAt: now };

  for (const r of pr.reviews) {
    // A pending review is one its author has not submitted. Nobody else can
    // read it, so it is not news yet.
    if (r.state.toUpperCase() === "PENDING") continue;
    if (next.reviews.includes(r.id)) continue;
    next.reviews.push(r.id);
    // A review with no words and no verdict is the shell around its line
    // comments, and those arrive on their own below.
    if (r.state.toUpperCase() === "COMMENTED" && !r.body.trim()) continue;
    events.push({ kind: "review", review: r });
  }
  for (const c of [...pr.comments, ...lineComments]) {
    if (next.comments.includes(c.id)) continue;
    next.comments.push(c.id);
    events.push({ kind: "comment", comment: c });
  }

  if (pr.state === "MERGED") {
    events.push({ kind: "merged" });
    return { events, cursor: next };
  }
  if (pr.state === "CLOSED") {
    events.push({ kind: "closed" });
    return { events, cursor: next };
  }

  const verdict = checksVerdict(pr.checks);
  const old = Date.parse(now) - Date.parse(next.head.seenAt) >= NO_CHECKS_GRACE_MS;
  const settled = verdict.ci === "failing" || verdict.ci === "passing" || (verdict.ci === "absent" && old);
  if (settled && verdict.ci !== "pending") {
    // Under `auto`, a pass that ran against an older base is not a pass the
    // daemon may merge on: the gate of #45 calls it stale, and so does this.
    const stale = verdict.ci === "passing" && options.merge === "auto"
      && summariseChecks(pr.checks, options.base ?? null, pr.mergeStateStatus).ci === "stale";
    const ci = stale ? "stale" : verdict.ci;
    const delivered = next.checks !== null && next.checks.head === sha && next.checks.ci === ci;
    if (!delivered) {
      next.checks = { head: sha, ci };
      events.push({ kind: "checks", ci, head: sha, checks: verdict.checks, failed: verdict.failed });
    }
  }
  if (pr.mergeable === "CONFLICTING" && next.conflict !== sha) {
    next.conflict = sha;
    events.push({ kind: "conflict", head: sha });
  }
  return { events, cursor: next };
}

/** True for an event the agent has to act on. Such an event costs a round. */
export function asksForWork(ev: WatchEvent): boolean {
  if (ev.kind === "checks") return ev.ci === "failing" || ev.ci === "stale";
  if (ev.kind === "conflict") return true;
  if (ev.kind === "review") return ev.review.state.toUpperCase() === "CHANGES_REQUESTED";
  return false;
}

/** True for an event after which there is nothing left to watch. */
export function endsWatch(ev: WatchEvent): ev is Extract<WatchEvent, { kind: "merged" | "closed" }> {
  return ev.kind === "merged" || ev.kind === "closed";
}

/**
 * Whether the daemon may merge now, under the `auto` policy. Every refusal is
 * a fact GitHub reported, in one sentence, so the note that records a wait
 * says what it waits for. A running turn is the engine's question, not this
 * one's: it reads the thread, and this reads the pull request.
 */
export function mergeReadiness(pr: PullRequestFacts, base: BaseHead | null): { ready: true } | { ready: false; why: string } {
  if (pr.state !== "OPEN") return { ready: false, why: `the pull request is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { ready: false, why: "the pull request is a draft" };
  const decision = pr.reviewDecision.toUpperCase();
  if (decision === "CHANGES_REQUESTED") return { ready: false, why: "a review asks for changes" };
  if (decision === "REVIEW_REQUIRED") return { ready: false, why: "the repository requires a review before a merge" };
  if (pr.mergeable === "CONFLICTING") return { ready: false, why: "the branch conflicts with the base" };
  if (pr.mergeable !== "MERGEABLE") return { ready: false, why: "GitHub has not said yet whether the branch is mergeable" };
  const checks = summariseChecks(pr.checks, base, pr.mergeStateStatus);
  if (checks.ci !== "passing") return { ready: false, why: checks.reason };
  return { ready: true };
}

export interface NewsContext {
  /** The branch the thread pushes to, named so the agent pushes to the right one. */
  branch: string;
  /** The round this delivery is, when one of its events asks for work. */
  rounds: number;
  maxRounds: number;
  /** Who merges, so the text after a pass says what happens next. */
  merge: MergePolicy;
}

/** The whole turn: one heading, one line per event. */
export function describeNews(pr: PullRequestFacts, events: WatchEvent[], ctx: NewsContext): string {
  const lines = [`covey watch: news on pull request #${pr.number} (${pr.url}).`, ""];
  for (const ev of events) lines.push(`- ${describeEvent(ev, pr, ctx)}`);
  return lines.join("\n");
}

/** One event in words the agent can act on: what happened, and what to do. */
export function describeEvent(ev: WatchEvent, pr: PullRequestFacts, ctx: NewsContext): string {
  const round = `This is round ${ctx.rounds} of ${ctx.maxRounds}.`;
  switch (ev.kind) {
    case "checks": {
      if (ev.ci === "failing") {
        const names = ev.failed.map((c) => `\`${checkLabel(c)}\`${c.url ? ` (${c.url})` : ""}`).join(", ");
        return `The checks failed on ${short(ev.head)}: ${names}. Read the failure, fix it, commit, and push to ${ctx.branch}. Covey watches the checks again after the push. ${round}`;
      }
      if (ev.ci === "stale") {
        return `The checks passed on ${short(ev.head)}, but against an older ${pr.baseRefName}. Covey merges only a change tested on the current base. Merge ${pr.baseRefName} into ${ctx.branch} and push, so the checks run again. ${round}`;
      }
      if (ev.ci === "passing") {
        const n = ev.checks.filter((c) => c.state === "success").length;
        const then = ctx.merge === "auto"
          ? "Covey merges the pull request on its next poll, unless a review asks for changes or the base has moved."
          : "The merge policy is manual: a person merges the pull request, or switches this thread to auto. Wait; covey sends the next review, comment or merge as a turn.";
        return `The checks passed on ${short(ev.head)}: ${n} check${n === 1 ? "" : "s"} succeeded. There is nothing to fix. ${then}`;
      }
      return `No check ran on ${short(ev.head)} in ${Math.round(NO_CHECKS_GRACE_MS / 60_000)} minutes. The repository may have no checks for this branch. Nothing has tested the change; say so in the pull request if a check was expected.`;
    }
    case "conflict":
      return `The branch conflicts with ${pr.baseRefName} at ${short(ev.head)}. Merge ${pr.baseRefName} into ${ctx.branch}, resolve the conflict, and push. ${round}`;
    case "review": {
      const who = author(ev.review.author, pr);
      const verdict = reviewWord(ev.review.state);
      const body = quote(ev.review.body);
      const ask = ev.review.state.toUpperCase() === "CHANGES_REQUESTED" ? ` Make the change, push, and answer the review. ${round}` : "";
      return `Review by ${who}: ${verdict}.${body ? `\n${body}` : ""}${ask}`;
    }
    case "comment": {
      const who = author(ev.comment.author, pr);
      const where = ev.comment.path ? ` on ${ev.comment.path}${ev.comment.line !== null ? ` line ${ev.comment.line}` : ""}` : "";
      return `Comment by ${who}${where}:\n${quote(ev.comment.body)}`;
    }
    case "merged":
      return ev.by === "covey"
        ? `Covey merged the pull request (${ev.method ?? "merge"}): the checks passed against the current ${pr.baseRefName}, and the merge policy is auto. The loop is done, and covey stops the watch.`
        : "The pull request was merged. The loop is done, and covey stops the watch.";
    case "closed":
      return "The pull request was closed without a merge. The loop is done, and covey stops the watch.";
    case "mergeFailed":
      return `Covey tried to merge the pull request under the auto policy, and GitHub refused: ${ev.error}. Covey does not try again on this head. A person has to look, or a push starts the loop again.`;
  }
}

function checkLabel(c: CheckSummary): string {
  return c.workflow && c.workflow !== c.name ? `${c.workflow} / ${c.name}` : c.name;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The author, and whether that is the account the pull request was opened from. */
function author(login: string, pr: PullRequestFacts): string {
  const name = login || "somebody";
  return pr.author && login === pr.author ? `${name} (the account that opened the pull request)` : name;
}

function reviewWord(state: string): string {
  switch (state.toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "DISMISSED": return "dismissed";
    default: return "commented";
  }
}

/** Long text is cut, so one review cannot fill a turn. */
const QUOTE_MAX = 4000;

function quote(body: string): string {
  const text = body.trim();
  if (!text) return "";
  const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}\n[cut after ${QUOTE_MAX} characters]` : text;
  return cut.split("\n").map((l) => `  > ${l}`).join("\n");
}
