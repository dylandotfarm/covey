/**
 * The automated review's words and its gate.
 *
 * Everything here is pure, so each case is a fact about the text or about the
 * arithmetic and needs no daemon. The engine half — a second thread, a worktree
 * at the head under review, the verdict on the author's watch — is
 * `reviewLoop.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewRequirement, ReviewerRecord } from "@covey/protocol";
import { reviewSatisfied, reviewStanding } from "@covey/protocol";
import { REVIEW_TAGLINE, reconcileReview, reviewBrief, reviewGate, reviewVerdictOf, tagComment, describeDropped } from "./review.js";
import { signComment } from "./sign.js";

function reviewer(over: Partial<ReviewerRecord> & { index: number }): ReviewerRecord {
  return {
    threadId: `thread-${over.index}`, state: "reviewing",
    note: null, startedAt: "2026-10-02T00:00:00Z", decidedAt: null, ...over,
  };
}

const requirement = (required: number, ...reviewers: ReviewerRecord[]): ReviewRequirement => ({ required, reviewers });

test("a tagged comment keeps the review's own words and adds the tagline last", () => {
  const out = tagComment("`lines.ts` line 20 drops the last row.", "changes", { index: 1, of: 1 });
  assert.match(out, /^`lines\.ts` line 20 drops the last row\./, "the review's words come first, untouched");
  assert.match(out, /\n---\n\*Changes requested — from an automated covey review\.\*$/);
  assert.equal(out.trimEnd().split("\n").at(-1)!.includes(REVIEW_TAGLINE), true, "the tagline is the last line");
});

test("the seat is named only when there is more than one reviewer", () => {
  assert.match(tagComment("Fine.", "approved", { index: 2, of: 3 }), /\(reviewer 2 of 3\)/);
  assert.doesNotMatch(tagComment("Fine.", "approved", { index: 1, of: 1 }), /reviewer 1 of 1/);
});

test("a reviewer with nothing to add still writes a sentence", () => {
  // A comment of nothing but a tagline reads as a bug in covey.
  const out = tagComment("   ", "approved", { index: 1, of: 1 });
  assert.match(out.split("\n")[0]!, /\w/);
  assert.equal(reviewVerdictOf(out), "approved");
});

test("every tagged comment reads back as the verdict it was written with", () => {
  for (const verdict of ["approved", "changes", "comment"] as const) {
    assert.equal(reviewVerdictOf(tagComment("Words.", verdict, { index: 1, of: 2 })), verdict, verdict);
  }
});

test("a comment nobody tagged is nobody's review", () => {
  assert.equal(reviewVerdictOf("I pushed the fix."), null);
  assert.equal(reviewVerdictOf(""), null);
});

test("a comment that quotes a review is not read as one", () => {
  // The author answers a review, and `describeEvent` quoted it with `> `. Were
  // the marker not anchored to its own line, the answer would hold the
  // reviewer's verdict and the gate would read the author as the reviewer.
  const quoted = ["Fixed, thanks.", "", "> Changes requested — from an automated covey review.", ""].join("\n");
  assert.equal(reviewVerdictOf(quoted), null);
});

test("no review required is a gate that is open", () => {
  assert.equal(reviewGate(null).ready, true);
  assert.equal(reviewGate(undefined).ready, true);
  assert.equal(reviewGate(requirement(0)).ready, true, "`--no-review` asks for none, and none is satisfied");
  assert.equal(reviewSatisfied(requirement(0)), true);
});

test("a review that has not signed off holds the pull request, and says how far it got", () => {
  const gate = reviewGate(requirement(2, reviewer({ index: 1, state: "signedOff" }), reviewer({ index: 2 })));
  assert.equal(gate.ready, false);
  assert.equal(gate.ready === false && gate.why, "1 of 2 automated reviews have signed off");
});

test("a reviewer that asks for changes beats every sign-off beside it", () => {
  const review = requirement(2, reviewer({ index: 1, state: "signedOff" }), reviewer({ index: 2, state: "changesRequested" }));
  const gate = reviewGate(review);
  assert.equal(gate.ready, false);
  assert.equal(gate.ready === false && gate.why, "an automated covey review asks for changes");
  assert.equal(reviewSatisfied(review), false);
});

test("enough sign-offs opens the gate", () => {
  const review = requirement(2, reviewer({ index: 1, state: "signedOff" }), reviewer({ index: 2, state: "signedOff" }));
  assert.equal(reviewGate(review).ready, true);
  assert.equal(reviewSatisfied(review), true);
});

test("a review with nobody left to sign off says so, rather than waiting for ever", () => {
  const gate = reviewGate(requirement(1, reviewer({ index: 1, state: "dropped" })));
  assert.equal(gate.ready, false);
  assert.match(gate.ready === false ? gate.why : "", /no automated review is left to sign off/);
});

test("reviewStanding counts each state once", () => {
  const s = reviewStanding(requirement(3,
    reviewer({ index: 1, state: "signedOff" }),
    reviewer({ index: 2, state: "changesRequested" }),
    reviewer({ index: 3, state: "dropped" }),
    reviewer({ index: 4 }),
  ));
  assert.deepEqual(s, { required: 3, signedOff: 1, asking: 1, dropped: 1, waiting: 1 });
});

test("the brief names the pull request, the two commands, and the three rules", () => {
  const brief = reviewBrief({
    number: 7, url: "https://github.com/o/r/pull/7", title: "Fold a chain away",
    branch: "covey/abc", base: "main", authorThreadId: "t-author", seat: { index: 2, of: 2 }, issue: 94,
  });
  assert.match(brief, /reviewer 2 of 2 on pull request #7/);
  assert.match(brief, /#7 Fold a chain away/);
  assert.match(brief, /covey\/abc into main, for issue #94/);
  assert.match(brief, /t-author/, "the reviewer is told whose change it reads");
  assert.match(brief, /git diff origin\/main\.\.\.HEAD/, "it is told how to read the whole change");
  assert.match(brief, /covey review changes --body/);
  assert.match(brief, /covey review approve/);
  assert.match(brief, /never merge/i);
  assert.match(brief, /Do not write either marker yourself/, "the tagline and the signature are both covey's");
  assert.match(brief, /signs it with this thread's id/, "it is told why its own review never comes back to it");
  assert.match(brief, /covey sends you none of them/, "the checks are the author's work");
});

test("a brief with no issue and one reviewer leaves both out", () => {
  const brief = reviewBrief({
    number: 7, url: "u", title: "t", branch: "b", base: "main",
    authorThreadId: "a", seat: { index: 1, of: 1 }, issue: null,
  });
  assert.match(brief, /you are the reviewer on pull request #7/);
  assert.doesNotMatch(brief, /for issue #/);
});

test("a dropped reviewer tells the author what it means for the merge", () => {
  const text = describeDropped({
    seat: { index: 1, of: 1 }, number: 7, url: "u", why: "its own watch ran out of rounds",
    review: requirement(1, reviewer({ index: 1, state: "dropped" })),
  });
  assert.match(text, /covey watch: news on pull request #7/);
  assert.match(text, /ended with no verdict: its own watch ran out of rounds/);
  assert.match(text, /a person has to look/);
  assert.match(text, /Do not start a reviewer yourself/);
});

test("a reviewer dropped when the sign-offs were already in changes nothing", () => {
  const text = describeDropped({
    seat: { index: 2, of: 2 }, number: 7, url: "u", why: "the pull request was merged",
    review: requirement(1, reviewer({ index: 1, state: "signedOff" }), reviewer({ index: 2, state: "dropped" })),
  });
  assert.match(text, /still has the sign-offs it needs/);
});

// ---- reading the seats back off the pull request (#237) -------------------
//
// Covey signs every comment it posts and writes the verdict into the tagline,
// so the pull request is a second copy of the whole review. A seat that lost a
// write is repaired from it.

/** A comment as the pull request carries it: tagged, then signed. */
function posted(threadId: string, verdict: "approved" | "changes" | "comment", words: string, createdAt: string) {
  return { body: signComment(tagComment(words, verdict, { index: 1, of: 1 }), threadId), createdAt };
}

test("a sign-off on the pull request repairs a seat that lost the write", () => {
  const review = requirement(1, reviewer({ index: 1, state: "changesRequested", note: "One item holds this up.", decidedAt: "2026-11-20T21:25:12Z" }));
  const out = reconcileReview(review, [
    posted("thread-1", "changes", "One item holds this up.", "2026-11-20T21:25:12Z"),
    posted("thread-1", "approved", "2f34ff8 fixes the blocking item.", "2026-11-20T21:27:15Z"),
  ]);
  assert.ok(out, "the pull request disagreed with the row");
  assert.equal(out.reviewers[0]!.state, "signedOff");
  assert.equal(out.reviewers[0]!.note, "2f34ff8 fixes the blocking item.");
  assert.equal(out.reviewers[0]!.decidedAt, "2026-11-20T21:27:15Z");
  assert.equal(reviewSatisfied(out), true, "and the merge gate opens");
});

test("a record that already agrees with the pull request is not rewritten", () => {
  const review = requirement(1, reviewer({ index: 1, state: "signedOff", note: "Fine.", decidedAt: "2026-11-20T21:27:16Z" }));
  assert.equal(reconcileReview(review, [posted("thread-1", "approved", "Fine.", "2026-11-20T21:27:15Z")]), null);
});

test("an older comment never undoes a verdict the daemon has just written", () => {
  // The seat is what `reviewDecide` wrote a second ago and the comments are
  // what `gh` answered a second before that. Newer, never merely different.
  const review = requirement(1, reviewer({ index: 1, state: "signedOff", note: "Fine.", decidedAt: "2026-11-20T21:27:16Z" }));
  assert.equal(reconcileReview(review, [posted("thread-1", "changes", "One item holds this up.", "2026-11-20T21:25:12Z")]), null);
});

test("a reviewer that never decided takes the verdict its comment carries", () => {
  const out = reconcileReview(requirement(1, reviewer({ index: 1 })), [posted("thread-1", "changes", "Line 20 drops a row.", "2026-11-20T21:25:12Z")]);
  assert.equal(out?.reviewers[0]!.state, "changesRequested");
  assert.equal(out?.reviewers[0]!.decidedAt, "2026-11-20T21:25:12Z");
});

test("a dropped seat stands, whatever the thread said before it went", () => {
  // It can no longer stand behind the words, which is why the author was told.
  const review = requirement(1, reviewer({ index: 1, state: "dropped", note: "somebody deleted the review thread", decidedAt: "2026-11-20T21:20:00Z" }));
  assert.equal(reconcileReview(review, [posted("thread-1", "approved", "Fine.", "2026-11-20T21:27:15Z")]), null);
});

test("an ordinary comment from a reviewer decides nothing", () => {
  const review = requirement(1, reviewer({ index: 1, state: "changesRequested", note: "One item.", decidedAt: "2026-11-20T21:25:12Z" }));
  assert.equal(reconcileReview(review, [posted("thread-1", "comment", "One more thought.", "2026-11-20T21:30:00Z")]), null);
});

test("a comment from another thread moves no seat", () => {
  const review = requirement(2, reviewer({ index: 1 }), reviewer({ index: 2 }));
  const out = reconcileReview(review, [posted("thread-2", "approved", "Fine.", "2026-11-20T21:33:53Z")]);
  assert.equal(out?.reviewers[0]!.state, "reviewing", "reviewer 1 said nothing");
  assert.equal(out?.reviewers[1]!.state, "signedOff");
});

test("an unsigned comment, and a comment with no date, move nothing", () => {
  const review = requirement(1, reviewer({ index: 1 }));
  const words = tagComment("Fine.", "approved", { index: 1, of: 1 });
  assert.equal(reconcileReview(review, [{ body: words, createdAt: "2026-11-20T21:27:15Z" }]), null, "nobody signed it");
  assert.equal(reconcileReview(review, [{ body: signComment(words, "thread-1"), createdAt: null }]), null, "and nothing can be compared");
});

test("a review nobody asked for is left alone", () => {
  assert.equal(reconcileReview(null, [posted("thread-1", "approved", "Fine.", "2026-11-20T21:27:15Z")]), null);
  assert.equal(reconcileReview(requirement(0), []), null);
});
