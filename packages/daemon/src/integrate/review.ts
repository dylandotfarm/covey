/**
 * The automated review: the words a reviewer writes, and the gate it holds.
 *
 * A thread that opens a pull request gets a reviewer of its own — a second
 * covey thread, with a worktree at the pull request's head, a watch on the
 * same number, and one job. It reads the change, comments on the pull request,
 * and signs off or asks for changes. Only then does covey call the pull
 * request ready, and only then does an `auto` watch merge it.
 *
 * Everything here is pure. The engine starts the threads and talks to `gh`;
 * this module decides what the words say and what the verdict means, so every
 * rule below has a test that needs no network and no subprocess.
 *
 * Three rules shape it:
 *
 *  - **A review's words go on the pull request; its verdict goes in the
 *    database.** The reviewer runs under the same `gh` login as the author, and
 *    GitHub refuses an approval on your own pull request. So the sign-off
 *    cannot be a GitHub review, and covey keeps its own record
 *    (`ReviewRequirement`). The comment is still the artefact a person reads,
 *    which is why the verdict is written into it as well, in the tagline.
 *  - **The tagline is covey's, never the model's.** A reader has to be able to
 *    tell a machine's review from a person's, and a reviewer asked to write its
 *    own marker would eventually write a different one. `tagComment` appends it
 *    and `reviewVerdictOf` reads it back, so the two can never drift.
 *  - **The author owns the build; the reviewer owns the code.** A reviewer
 *    hears about a push to the branch and hears nothing about the checks. A red
 *    build is the author's work, already in hand, and a reviewer woken by it
 *    would spend a round of its budget on somebody else's job.
 */
import { reviewStanding, type ReviewRequirement, type ReviewerRecord } from "@covey/protocol";

/**
 * The words that mark a comment as a machine's.
 *
 * Exact, and matched exactly: `reviewVerdictOf` reads a comment back by this
 * phrase, and the author's watch decides from it whether a comment asks for
 * work. Change the phrase and every comment already on a pull request stops
 * being readable, so do not.
 */
export const REVIEW_TAGLINE = "from an automated covey review";

/**
 * How many reviewers a pull request gets when the caller says nothing.
 *
 * One. A reviewer is a thread, which is a worktree and a session of about
 * 300 MB, so the number that is safe to spend on every pull request is the
 * smallest one that still reads the change. A caller that wants two says two.
 */
export const DEFAULT_REVIEWS = 1;

/**
 * The most reviewers one pull request may have at once. Each is a session under
 * the machine's own `maxLiveSessions` ceiling, so a typo in `--reviews` must not
 * be able to spend the whole machine on one change.
 */
export const MAX_REVIEWS = 5;

/**
 * How many comment URLs a cursor remembers as its own. Enough for every comment
 * of a long review, and bounded, because the cursor is stored on the thread row
 * and a list that only grows is a row that only grows.
 */
export const POSTED_KEPT = 200;

/** What one review comment says it is. */
export type ReviewVerdict = "approved" | "changes" | "comment";

/** Which reviewer of the set wrote a comment, for the tagline to name. */
export interface ReviewerSeat {
  index: number;
  of: number;
}

/**
 * Put the tagline on a comment, and the verdict in it.
 *
 * The body the model wrote is left alone above a rule, so the tagline is never
 * read as part of the review. A reviewer that has nothing to add still gets a
 * sentence, because a comment of nothing but a tagline reads as a bug.
 */
export function tagComment(body: string, verdict: ReviewVerdict, seat: ReviewerSeat): string {
  const words = body.trim() || defaultWords(verdict);
  const lead = verdict === "approved" ? "Approved — " : verdict === "changes" ? "Changes requested — " : "";
  const who = seat.of > 1 ? ` (reviewer ${seat.index} of ${seat.of})` : "";
  return `${words}\n\n---\n*${lead}${lead ? REVIEW_TAGLINE : capitalise(REVIEW_TAGLINE)}${who}.*`;
}

function defaultWords(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "approved": return "I read the change and found nothing that should hold it up.";
    case "changes": return "This needs a change before it lands.";
    case "comment": return "A note on this change.";
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What a comment says it is, or null when no machine wrote it.
 *
 * The marker has to start its own line, so a comment that *quotes* a review —
 * which every answer to one does, because `describeEvent` quotes with `> ` —
 * is not read as a review itself. That is the whole reason this is anchored.
 */
export function reviewVerdictOf(body: string): ReviewVerdict | null {
  const m = new RegExp(`^\\s*\\*\\s*(approved|changes requested)?\\s*(?:—\\s*)?${REVIEW_TAGLINE}\\b`, "im").exec(body);
  if (!m) return null;
  const word = (m[1] ?? "").toLowerCase();
  return word === "approved" ? "approved" : word === "changes requested" ? "changes" : "comment";
}

/**
 * Whether the review lets the pull request through, and why not when it does
 * not. One short sentence: it lands on `PullRequestWatch.readiness`, which a
 * phone's cover screen shows with room for nothing else.
 */
export function reviewGate(review: ReviewRequirement | null | undefined): { ready: true } | { ready: false; why: string } {
  if (!review || review.required <= 0) return { ready: true };
  const s = reviewStanding(review);
  if (s.asking > 0) {
    return { ready: false, why: s.asking === 1 ? "an automated covey review asks for changes" : `${s.asking} automated covey reviews ask for changes` };
  }
  if (s.signedOff >= s.required) return { ready: true };
  if (s.waiting === 0) {
    return { ready: false, why: `no automated review is left to sign off: ${s.dropped} of ${s.required} was dropped` };
  }
  return { ready: false, why: `${s.signedOff} of ${s.required} automated reviews have signed off` };
}

/** What a review thread needs to know about the pull request it reviews. */
export interface ReviewBrief {
  number: number;
  url: string;
  title: string;
  /** The branch under review, and the branch it merges into. */
  branch: string;
  base: string;
  /** The thread that opened the pull request. */
  authorThreadId: string;
  seat: ReviewerSeat;
  /** The issue the author took, when it took one. */
  issue: number | null;
}

/**
 * The first turn of a review thread.
 *
 * It is the whole of what the reviewer is told, so it has to carry the job, the
 * two commands that end it, and the three things it must not do. The thread has
 * the `/covey` skill like any other, and this says to read it rather than
 * repeating it: the skill is the one copy of the loop.
 */
export function reviewBrief(b: ReviewBrief): string {
  const seat = b.seat.of > 1 ? `reviewer ${b.seat.index} of ${b.seat.of}` : "the reviewer";
  return [
    `covey review: you are ${seat} on pull request #${b.number}.`,
    "",
    `  #${b.number} ${b.title}`,
    `  ${b.url}`,
    `  ${b.branch} into ${b.base}${b.issue ? `, for issue #${b.issue}` : ""}`,
    "",
    `Thread ${b.authorThreadId} wrote this change and is waiting on your verdict.`,
    "Covey will not call the pull request ready, and will not merge it, until you",
    "sign off. Your worktree is a checkout of the branch under review, so the code",
    "in front of you is the code on the pull request.",
    "",
    "Read the change:",
    "",
    "```",
    `gh pr view ${b.number}`,
    `git diff origin/${b.base}...HEAD`,
    `git log --oneline origin/${b.base}..HEAD`,
    "```",
    "",
    "Review it as a careful colleague would. Does it do what the pull request says?",
    "Is it correct at the edges — an empty list, a failure, a second caller? Does it",
    "repeat a decision the project already made somewhere else? Read the project's",
    "own notes for agents, and hold the change to them.",
    "",
    "Then say one of two things, and nothing else:",
    "",
    "```",
    'covey review changes --body "…"     ask the author for changes',
    'covey review approve [--body "…"]   sign off, and end this review',
    "```",
    "",
    "The rules of this thread:",
    "",
    "- Covey puts the comment on the pull request and adds the tagline that says a",
    "  machine wrote it. Do not write that tagline yourself, and do not use",
    "  `gh pr comment` or `gh pr review`.",
    "- Never commit to this branch, never push it, and never merge. The author makes",
    "  every change. You read and you say.",
    "- Name the file and the line for each thing you want changed, and say why it",
    "  matters. One comment that covers the change beats ten that each cover a line.",
    "- Ask for changes only for something that should hold the change up: a bug, a",
    "  missing case, a rule of the project the change breaks. A matter of taste is a",
    "  remark inside your comment, not a reason to block.",
    "- The checks are the author's work, not yours, so covey sends you none of them.",
    "  When the author pushes, covey sends you a turn; run `git pull` and read the",
    "  change again from there.",
    "- Stop the turn after you comment. Covey wakes you when there is something new.",
  ].join("\n");
}

/** What the author is told when a reviewer ends with no verdict. */
export function describeDropped(p: { seat: ReviewerSeat; number: number; url: string; why: string; review: ReviewRequirement }): string {
  const gate = reviewGate(p.review);
  const then = gate.ready
    ? "The pull request still has the sign-offs it needs."
    : `${gate.why}. Covey will not call the pull request ready, so a person has to look: they can ask for another reviewer with \`covey pr review\`, or merge it themselves.`;
  return [
    `covey watch: news on pull request #${p.number} (${p.url}).`,
    "",
    `- The automated review by reviewer ${p.seat.index} of ${p.seat.of} ended with no verdict: ${p.why} ${then} Do not start a reviewer yourself; say what happened and stop the turn.`,
  ].join("\n");
}
