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
import { REVIEW_TAGLINE, reviewBrief, reviewGate, reviewVerdictOf, tagComment, describeDropped } from "./review.js";

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
