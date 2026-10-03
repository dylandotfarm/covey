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
 *
 * `mergeBlock` is the fifth, and it is the checks verdict's other half. A
 * green check is not a merge: a branch rule, a draft or a base that has moved
 * all leave the merge button grey with every check passing. A watch that said
 * only "the checks passed" taught the agent to answer "ready for you to
 * merge" about a pull request GitHub refuses, so every verdict now carries
 * what stands between it and the merge.
 *
 * The sixth is the automated review, and it is a `mergeBlock` too — covey's own
 * rather than GitHub's, and the only one of them covey refuses on its own
 * behalf. One watch belongs to the thread that wrote the change and one to each
 * thread that reviews it, and the two hear different things: the author owns the
 * build, so a checks verdict and a conflict are its news; the reviewer owns the
 * code, so a push to the branch is its news and the checks are none of its
 * business. `integrate/review.ts` holds the words and the gate; this file holds
 * what each side hears.
 */
import type { BaseHead, CheckSummary, MergeBlockCode, MergeMethod, MergePolicy, ReviewRequirement, WatchCursor, WatchRole } from "@covey/protocol";
import type { CommentEntry, PullRequestFacts, ReviewEntry, RollupEntry } from "./gh.js";
import { summariseCheck, summariseChecks } from "./checks.js";
import { reviewGate, reviewVerdictOf } from "./review.js";
import { signedBy, unsign } from "./sign.js";

export type WatchEvent =
  | {
      kind: "checks";
      ci: "passing" | "failing" | "absent" | "stale";
      head: string;
      checks: CheckSummary[];
      failed: CheckSummary[];
      /** What stands between the green check and the merge button, or null. */
      block: MergeBlock | null;
    }
  | { kind: "conflict"; head: string }
  /** The branch moved. A reviewer's news, and never an author's: an author's
   *  own push is not something to tell it about. */
  | { kind: "head"; head: string; was: string }
  | { kind: "review"; review: ReviewEntry }
  | { kind: "comment"; comment: CommentEntry }
  /** `by` is set when the daemon merged under the `auto` policy. */
  | { kind: "merged"; by?: "covey"; method?: MergeMethod }
  | { kind: "closed" }
  /** The daemon tried to merge under `auto`, and `gh` refused. */
  | { kind: "mergeFailed"; error: string };

/**
 * Why GitHub will not merge the pull request, apart from its checks. The
 * watch reads the checks from the check runs and the rest from here, and the
 * two together are the whole of "can this merge now".
 */
export interface MergeBlock {
  code: MergeBlockCode;
  /** The fact, as one clause: the sentence reads "GitHub will not merge ... yet: <why>." */
  why: string;
}

/**
 * What stands between this pull request and its merge, or null when nothing
 * but the checks does.
 *
 * Only a settled fact belongs here. GitHub works `mergeable` and
 * `mergeStateStatus` out after the fact, and answers `UNKNOWN` until it has,
 * so neither unknown is a block — a block that flaps would re-send the
 * checks verdict on every poll. `BLOCKED` is read last for the same reason it
 * is never read as a checks verdict: GitHub answers it while the checks run,
 * so it means "a rule you cannot see" only once they have passed.
 */
export function mergeBlock(pr: PullRequestFacts, review?: ReviewRequirement | null): MergeBlock | null {
  if (pr.state !== "OPEN") return null;
  const status = pr.mergeStateStatus.toUpperCase();
  const decision = pr.reviewDecision.toUpperCase();
  if (pr.isDraft) return { code: "draft", why: "the pull request is a draft" };
  // The conflict is an event of its own, with its own cursor. It is named
  // here as well because that event fires once per head: a conflict reported
  // an hour ago must not leave the next green verdict reading as ready.
  if (pr.mergeable === "CONFLICTING" || status === "DIRTY") {
    return { code: "conflict", why: `the branch conflicts with ${pr.baseRefName}` };
  }
  if (status === "BEHIND") {
    return { code: "behind", why: `the branch is out of date with ${pr.baseRefName}, and this repository merges no branch that is behind` };
  }
  if (decision === "CHANGES_REQUESTED") return { code: "changes", why: "a review asks for changes" };
  if (decision === "REVIEW_REQUIRED") return { code: "review", why: "this repository requires a review before a merge" };
  if (status === "BLOCKED") return { code: "blocked", why: "GitHub reports the merge as blocked, so a rule of this repository is not met" };
  // Covey's own block, and the only one here that is not GitHub's, so it is
  // read last: every fact GitHub reported is a nearer answer to "why not".
  const gate = reviewGate(review);
  if (!gate.ready) return { code: "unreviewed", why: gate.why };
  return null;
}

/**
 * Who is refusing. Every block but one is GitHub's, and saying "GitHub will not
 * merge this" about covey's own automated review would send the agent looking
 * for a branch rule that is not there.
 */
export function blockLead(block: MergeBlock): string {
  return block.code === "unreviewed"
    ? "Covey will not call the pull request ready yet"
    : "GitHub will not merge the pull request yet";
}

export function emptyCursor(): WatchCursor {
  return { head: null, checks: null, conflict: null, mergeTried: null, reviews: [], comments: [], posted: [] };
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
  /** Which side of the review this watch is. Omitted reads as `author`. */
  role?: WatchRole;
  /**
   * The automated review the pull request needs, on an `author` watch. The
   * record is the daemon's own and changes between polls, so it is handed in
   * rather than read from the facts: `gh` knows nothing about it.
   */
  review?: ReviewRequirement | null;
  /**
   * The thread this watch belongs to. A comment carrying its signature
   * (`integrate/sign.ts`) is a comment it wrote itself, and never news to it.
   */
  self?: string;
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
  const next: WatchCursor = { ...emptyCursor(), ...cursor, reviews: [...cursor.reviews], comments: [...cursor.comments], posted: [...(cursor.posted ?? [])] };
  const events: WatchEvent[] = [];
  const role = options.role ?? "author";
  const sha = pr.headRefOid;
  const was = next.head?.sha ?? null;
  if (!next.head || next.head.sha !== sha) next.head = { sha, seenAt: now };
  // A reviewer is woken by the push, not by the build. The first poll is not a
  // push: the brief already told the reviewer to read the change, and a `head`
  // event on the head it was briefed about would ask it to read the same diff
  // twice.
  if (role === "reviewer" && was !== null && was !== sha) events.push({ kind: "head", head: sha, was });

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
    // A comment this thread wrote itself is not news to it. The signature is
    // the answer, because it is on the comment rather than in a memory of it:
    // the URL holds only while the cursor does, and GitHub lists a comment with
    // no URL at all. The cursor is still read, for a comment covey posted
    // before it signed them. The id is recorded above whichever matched, so
    // this is safe to get wrong: a miss would cost one turn, once, and never a
    // loop.
    if (options.self && signedBy(c.body) === options.self) continue;
    if (c.url && next.posted!.includes(c.url)) continue;
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

  // The author owns the build. A reviewer hears no checks verdict and no
  // conflict: both are work the author is already doing, and a round of a
  // reviewer's budget spent on them is a round it cannot spend on the code.
  if (role === "reviewer") return { events, cursor: next };

  const verdict = checksVerdict(pr.checks);
  const old = Date.parse(now) - Date.parse(next.head.seenAt) >= NO_CHECKS_GRACE_MS;
  const settled = verdict.ci === "failing" || verdict.ci === "passing" || (verdict.ci === "absent" && old);
  if (settled && verdict.ci !== "pending") {
    // Under `auto`, a pass that ran against an older base is not a pass the
    // daemon may merge on: the gate of #45 calls it stale, and so does this.
    const stale = verdict.ci === "passing" && options.merge === "auto"
      && summariseChecks(pr.checks, options.base ?? null, pr.mergeStateStatus).ci === "stale";
    const ci = stale ? "stale" : verdict.ci;
    // A failure and a stale pass are already work to do, and the block would
    // only crowd out the thing to fix. A pass and an absent check are where
    // the agent needs it: both read as "nothing to do" without it.
    const block = ci === "passing" || ci === "absent" ? mergeBlock(pr, options.review) : null;
    const code = block?.code ?? null;
    // The block is part of the key, not a decoration on it. The base branch
    // moves under a pass the thread has already heard, and that is exactly
    // the case the thread must be told about a second time.
    const delivered = next.checks !== null && next.checks.head === sha && next.checks.ci === ci
      && (next.checks.block ?? null) === code;
    if (!delivered) {
      next.checks = { head: sha, ci, block: code };
      events.push({ kind: "checks", ci, head: sha, checks: verdict.checks, failed: verdict.failed, block });
    }
  }
  if (pr.mergeable === "CONFLICTING" && next.conflict !== sha) {
    next.conflict = sha;
    events.push({ kind: "conflict", head: sha });
  }
  return { events, cursor: next };
}

/**
 * True for an event the agent has to act on. Such an event costs a round.
 *
 * The role decides two of these. A push is work for a reviewer — read the new
 * diff — and never for an author, who made it. And a comment from an automated
 * review that asks for changes is work for the author and for nobody else: a
 * second reviewer reads its colleague's comment as discussion, not as a task,
 * and a reviewer that acted on one would try to fix the change itself.
 */
export function asksForWork(ev: WatchEvent, role: WatchRole = "author"): boolean {
  if (ev.kind === "checks") {
    // A draft, a review and a rule of the repository all wait for a person, so
    // they cost no round: a round spent on a wait is a round the next real
    // failure has lost. An automated review that has not signed off is a wait
    // of that kind, because there is nothing the author can push that makes
    // the reviewer finish sooner.
    //
    // `behind`, and the stale pass it is a sibling of, cost none either, and
    // that is #199's lesson. A branch goes out of date because the *base*
    // moved, not because the change failed: nothing the thread writes prevents
    // the next one, and on a repository several covey threads land on, it
    // fires every few minutes. Every open pull request of that day spent two
    // of its three rounds merging main, and the one real failure met a budget
    // that was already gone. A conflict is the change's own work and still
    // costs a round; `WATCH_MAX_MS` is what bounds a base that never settles.
    if (ev.block) return ev.block.code === "conflict";
    return ev.ci === "failing";
  }
  if (ev.kind === "conflict") return true;
  if (ev.kind === "head") return role === "reviewer";
  if (ev.kind === "review") return ev.review.state.toUpperCase() === "CHANGES_REQUESTED";
  if (ev.kind === "comment") return role === "author" && reviewVerdictOf(ev.comment.body) === "changes";
  return false;
}

/**
 * Split a batch for a thread whose round budget is spent.
 *
 * `tell` is what still reaches the thread as a turn and `hold` is what does
 * not. The budget bounds the work covey asks for, so only the work is held:
 * the sign-off, the checks verdict with nothing left to fix, the merge and the
 * close all go on arriving. That is the whole of the fix for #199, where a
 * watch that ran out of rounds stopped listening as well as stopped asking,
 * and a pull request that turned green an hour later had nobody left to merge
 * it.
 *
 * `hold` is never dropped: the engine writes it in the thread as a note, which
 * a person reads and which costs no round.
 */
export function splitForBudget(events: WatchEvent[], role: WatchRole = "author"): { tell: WatchEvent[]; hold: WatchEvent[] } {
  const tell: WatchEvent[] = [];
  const hold: WatchEvent[] = [];
  for (const ev of events) (asksForWork(ev, role) ? hold : tell).push(ev);
  return { tell, hold };
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
 *
 * The automated review is the one refusal that is not GitHub's. It is covey's
 * own record, because GitHub refuses an approval on your own pull request and
 * every review thread writes from the author's login. The review is checked
 * last: a reader told "the review has not signed off" about a branch with a red
 * check has been told the wrong thing, and the facts GitHub reports are the
 * ones a person can act on.
 */
export function mergeReadiness(pr: PullRequestFacts, base: BaseHead | null, review?: ReviewRequirement | null): { ready: true } | { ready: false; why: string } {
  if (pr.state !== "OPEN") return { ready: false, why: `the pull request is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { ready: false, why: "the pull request is a draft" };
  const decision = pr.reviewDecision.toUpperCase();
  if (decision === "CHANGES_REQUESTED") return { ready: false, why: "a review asks for changes" };
  if (decision === "REVIEW_REQUIRED") return { ready: false, why: "the repository requires a review before a merge" };
  if (pr.mergeable === "CONFLICTING") return { ready: false, why: "the branch conflicts with the base" };
  if (pr.mergeable !== "MERGEABLE") return { ready: false, why: "GitHub has not said yet whether the branch is mergeable" };
  const checks = summariseChecks(pr.checks, base, pr.mergeStateStatus);
  if (checks.ci !== "passing") return { ready: false, why: checks.reason };
  // GitHub's own refusal, read after the checks and not before: it answers
  // `BLOCKED` while they run as well, and "a rule is not met" is the wrong
  // sentence for a check that has not finished. A rule covey cannot name is
  // still a rule, so this is never read as ready.
  if (pr.mergeStateStatus.toUpperCase() === "BLOCKED") {
    return { ready: false, why: "GitHub blocks the merge: a rule of the repository is not met" };
  }
  // Covey's own refusal, last of all, because every fact GitHub reported is a
  // nearer answer to "why not": a reader told "the review has not signed off"
  // about a branch with a red check has been told the wrong thing.
  return reviewGate(review);
}

export interface NewsContext {
  /** The branch the thread pushes to, named so the agent pushes to the right one. */
  branch: string;
  /** The round this delivery is, when one of its events asks for work. */
  rounds: number;
  maxRounds: number;
  /**
   * True for the batch a spent budget held back (#199). It is a note for a
   * person and not a turn, so it names no round: the rounds are gone, and
   * "This is round 3 of 3." under a sentence that says so reads as a countdown
   * that never moves.
   */
  spent?: boolean;
  /** Who merges, so the text after a pass says what happens next. */
  merge: MergePolicy;
  /** Which side of the review reads this. Omitted reads as `author`. */
  role?: WatchRole;
  /** The automated review, so the text after a pass says what it still waits for. */
  review?: ReviewRequirement | null;
  /** The base branch the reviewer compares against, on a `reviewer` watch. */
  base?: string;
}

/** The whole turn: one heading, one line per event. */
export function describeNews(pr: PullRequestFacts, events: WatchEvent[], ctx: NewsContext): string {
  const what = ctx.role === "reviewer" ? "the pull request you review" : "pull request";
  const lines = [`covey watch: news on ${what} #${pr.number} (${pr.url}).`, ""];
  for (const ev of events) lines.push(`- ${describeEvent(ev, pr, ctx)}`);
  return lines.join("\n");
}

/**
 * Which round this is, with the space before it, or nothing at all.
 *
 * It carries its own leading space so that a batch with no round left to name
 * ends at its full stop rather than at a space.
 */
function roundLine(ctx: NewsContext): string {
  return ctx.spent ? "" : ` This is round ${ctx.rounds} of ${ctx.maxRounds}.`;
}

/** One event in words the agent can act on: what happened, and what to do. */
export function describeEvent(ev: WatchEvent, pr: PullRequestFacts, ctx: NewsContext): string {
  const round = roundLine(ctx);
  switch (ev.kind) {
    case "checks": {
      if (ev.ci === "failing") {
        const names = ev.failed.map((c) => `\`${checkLabel(c)}\`${c.url ? ` (${c.url})` : ""}`).join(", ");
        return `The checks failed on ${short(ev.head)}: ${names}. Read the failure, fix it, commit, and push to ${ctx.branch}. Covey watches the checks again after the push.${round}`;
      }
      if (ev.ci === "stale") {
        return `The checks passed on ${short(ev.head)}, but against an older ${pr.baseRefName}. Covey merges only a change tested on the current base. Merge ${pr.baseRefName} into ${ctx.branch} and push, so the checks run again.`;
      }
      if (ev.ci === "passing") {
        const n = ev.checks.filter((c) => c.state === "success").length;
        const passed = `The checks passed on ${short(ev.head)}: ${n} check${n === 1 ? "" : "s"} succeeded.`;
        // A green check is not a merge. Never say "nothing to fix" over a
        // block: that sentence is what the agent answers the reader with.
        if (ev.block) return `${passed} ${blockLead(ev.block)}: ${ev.block.why}. ${describeBlock(ev.block, pr, ctx)}`;
        const then = ctx.merge === "auto"
          ? "Covey merges the pull request on its next poll, unless a review asks for changes or the base has moved."
          : "The merge policy is manual: a person merges the pull request, or switches this thread to auto. Wait; covey sends the next review, comment or merge as a turn.";
        return `${passed} There is nothing to fix. ${then}`;
      }
      const none = `No check ran on ${short(ev.head)} in ${Math.round(NO_CHECKS_GRACE_MS / 60_000)} minutes. The repository may have no checks for this branch. Nothing has tested the change; say so in the pull request if a check was expected.`;
      return ev.block ? `${none} ${blockLead(ev.block)} either: ${ev.block.why}. ${describeBlock(ev.block, pr, ctx)}` : none;
    }
    case "conflict":
      return `The branch conflicts with ${pr.baseRefName} at ${short(ev.head)}. Merge ${pr.baseRefName} into ${ctx.branch}, resolve the conflict, and push.${round}`;
    case "head": {
      const base = ctx.base ?? pr.baseRefName;
      return `The author pushed ${short(ev.head)} to ${pr.headRefName}; it was ${short(ev.was)}. Run \`git pull\` and read the change again: \`git diff ${short(ev.was)}..HEAD\` is what is new, and \`git diff origin/${base}...HEAD\` is the whole change. Then say \`covey review approve\` or \`covey review changes\`.${round}`;
    }
    case "review": {
      const who = author(ev.review.author, pr);
      const verdict = reviewWord(ev.review.state);
      const body = quote(ev.review.body);
      const ask = ev.review.state.toUpperCase() === "CHANGES_REQUESTED" ? ` Make the change, push, and answer the review.${round}` : "";
      return `Review by ${who}: ${verdict}.${body ? `\n${body}` : ""}${ask}`;
    }
    case "comment": {
      const verdict = reviewVerdictOf(ev.comment.body);
      const who = verdict ? reviewerWord(verdict) : author(ev.comment.author, pr);
      const where = ev.comment.path ? ` on ${ev.comment.path}${ev.comment.line !== null ? ` line ${ev.comment.line}` : ""}` : "";
      // A machine asked the author for changes. The author acts; a second
      // reviewer reading the same comment is reading a colleague, not a task.
      const ask = verdict === "changes" && ctx.role !== "reviewer"
        ? `\nMake the change, commit, push to ${ctx.branch}, and answer it with \`covey pr comment\`. Covey tells the reviewer about the push.${round}`
        : "";
      return `Comment by ${who}${where}:\n${quote(ev.comment.body)}${ask}`;
    }
    case "merged":
      if (ctx.role === "reviewer") return `The pull request was merged, so there is nothing left to review. Covey stops the watch. Say so in one line and stop the turn; do not comment.`;
      return ev.by === "covey"
        ? `Covey merged the pull request (${ev.method ?? "merge"}): the checks passed against the current ${pr.baseRefName}, and the merge policy is auto. The loop is done, and covey stops the watch.`
        : "The pull request was merged. The loop is done, and covey stops the watch.";
    case "closed":
      if (ctx.role === "reviewer") return "The pull request was closed without a merge, so there is nothing left to review. Covey stops the watch. Say so in one line and stop the turn; do not comment.";
      return "The pull request was closed without a merge. The loop is done, and covey stops the watch.";
    case "mergeFailed":
      return `Covey tried to merge the pull request under the auto policy, and GitHub refused: ${ev.error}. Covey does not try again on this head. A person has to look, or a push starts the loop again.`;
  }
}

/** What to do about a block: one instruction, or the wait and why. */
function describeBlock(block: MergeBlock, pr: PullRequestFacts, ctx: NewsContext): string {
  const round = roundLine(ctx);
  switch (block.code) {
    case "behind":
      return `Merge ${pr.baseRefName} into ${ctx.branch} and push. The checks run again against the new base.`;
    case "conflict":
      return `Merge ${pr.baseRefName} into ${ctx.branch}, resolve the conflict, and push.${round}`;
    case "draft":
      return "Mark the pull request ready for review when the work is done. Covey does not merge a draft.";
    case "changes":
      return "Answer the review and push the change it asks for. Covey sends the next review as a turn.";
    case "review":
      return "Wait; a person has to review the pull request. Covey sends the review as a turn. Say in your reply that the merge waits for a review.";
    case "blocked":
      return "You cannot clear this one. Say in your reply that the checks passed and GitHub still blocks the merge, so a person can look at the rule.";
    case "unreviewed":
      return "Wait; the automated review is reading the change. Covey sends each of its comments as a turn, and tells you when it signs off. Do not review your own change and do not start a reviewer yourself.";
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

/** Who a comment carrying covey's own tagline is from, and what it decided. */
function reviewerWord(verdict: "approved" | "changes" | "comment"): string {
  switch (verdict) {
    case "approved": return "an automated covey review, which signed off";
    case "changes": return "an automated covey review, which asks for changes";
    case "comment": return "an automated covey review";
  }
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
  // The signature goes with it: the agent reading this never needs the id of
  // the thread that wrote the comment, and a marker it was shown is a marker
  // it may one day copy.
  const text = unsign(body).trim();
  if (!text) return "";
  const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}\n[cut after ${QUOTE_MAX} characters]` : text;
  return cut.split("\n").map((l) => `  > ${l}`).join("\n");
}
