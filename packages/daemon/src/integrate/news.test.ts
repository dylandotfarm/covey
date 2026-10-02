/**
 * What a pull request watch delivers, and what it never delivers twice.
 *
 * Each case is a property of the loop an agent ran by hand on 2026-09-21,
 * which a covey primitive must not repeat: a failure that never fired, a
 * merge state read as a checks verdict, and a watch with no end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  news, emptyCursor, asksForWork, endsWatch, describeNews, pollDelayMs, checksVerdict, mergeReadiness,
  NO_CHECKS_GRACE_MS, POLL_MIN_MS, POLL_MAX_MS,
} from "./news.js";
import { pr } from "./testHost.js";

const T0 = "2026-09-21T10:00:00Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const FAILED = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/run/1" }];
const GREEN = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const PENDING = [{ name: "test", workflowName: "ci", status: "IN_PROGRESS" }];
const CTX = { branch: "covey/abc", rounds: 1, maxRounds: 3, merge: "manual" as const };

test("a failed check fires, however the merge state reads", () => {
  // GitHub answers BLOCKED while the checks run and after they fail. The hand
  // loop left on the merge state, so a failure read as work in progress.
  const facts = pr({ number: 7, checks: FAILED, mergeStateStatus: "BLOCKED", headRefOid: "abc1234def" });
  const r = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["checks"]);
  const ev = r.events[0]!;
  assert.equal(ev.kind === "checks" && ev.ci, "failing");
  assert.equal(asksForWork(ev), true, "a failure asks for work, so it costs a round");
  const text = describeNews(facts, r.events, CTX);
  assert.match(text, /pull request #7/);
  assert.match(text, /The checks failed on abc1234: `ci \/ test` \(https:\/\/ci\/run\/1\)/);
  assert.match(text, /push to covey\/abc/);
  assert.match(text, /round 1 of 3/);
});

test("a pending check is not news, and BLOCKED beside it says nothing", () => {
  const facts = pr({ number: 7, checks: PENDING, mergeStateStatus: "BLOCKED" });
  assert.deepEqual(news(facts, [], emptyCursor(), T0).events, []);
});

test("the same failure is delivered once; a new head, or a rerun that passes, is delivered again", () => {
  const failed = pr({ number: 7, checks: FAILED, headRefOid: "aaa" });
  const first = news(failed, [], emptyCursor(), T0);
  assert.equal(first.events.length, 1);
  const again = news(failed, [], first.cursor, later(60_000));
  assert.deepEqual(again.events, [], "a retry or a reconnect must not send the failure twice");

  const pushed = pr({ number: 7, checks: FAILED, headRefOid: "bbb" });
  const second = news(pushed, [], again.cursor, later(120_000));
  assert.deepEqual(second.events.map((e) => e.kind), ["checks"], "a new head is a new verdict");

  const rerun = pr({ number: 7, checks: GREEN, headRefOid: "bbb" });
  const third = news(rerun, [], second.cursor, later(180_000));
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0]!.kind === "checks" && third.events[0]!.ci, "passing", "a rerun that turns green at the same head is news");
});

test("a passing verdict fires too, and asks for no work", () => {
  const facts = pr({ number: 7, checks: GREEN, headRefOid: "abc1234def" });
  const r = news(facts, [], emptyCursor(), T0);
  assert.equal(r.events.length, 1);
  assert.equal(asksForWork(r.events[0]!), false);
  assert.match(describeNews(facts, r.events, CTX), /The checks passed on abc1234: 1 check succeeded/);
});

test("no check at all is an answer, after the grace and not before", () => {
  const facts = pr({ number: 7, checks: [] });
  const early = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(early.events, [], "a check may still register");
  const late = news(facts, [], early.cursor, later(NO_CHECKS_GRACE_MS));
  assert.equal(late.events.length, 1);
  assert.equal(late.events[0]!.kind === "checks" && late.events[0]!.ci, "absent");
  assert.match(describeNews(facts, late.events, CTX), /No check ran on deadbee in 2 minutes/);
  assert.deepEqual(news(facts, [], late.cursor, later(NO_CHECKS_GRACE_MS * 2)).events, [], "and once only");
});

test("a review arrives with its words; a request for changes asks for work", () => {
  const facts = pr({
    number: 7, checks: GREEN, author: "agent",
    reviews: [
      { id: "r1", author: "dylan", state: "CHANGES_REQUESTED", body: "Rename the flag.\nIt reads wrong.", submittedAt: T0, url: null },
      { id: "r2", author: "dylan", state: "PENDING", body: "not submitted", submittedAt: null, url: null },
      { id: "r3", author: "dylan", state: "COMMENTED", body: "", submittedAt: T0, url: null },
    ],
  });
  const r = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["review", "checks"]);
  assert.equal(asksForWork(r.events[0]!), true);
  const text = describeNews(facts, r.events, CTX);
  assert.match(text, /Review by dylan: changes requested\.\n  > Rename the flag\.\n  > It reads wrong\./);
  assert.match(text, /Make the change, push, and answer the review/);
  assert.doesNotMatch(text, /not submitted/, "a pending review is not submitted, so nobody else can read it");
  assert.deepEqual(news(facts, [], r.cursor, later(60_000)).events, [], "delivered once");
});

test("a line comment names the file, the line and the words", () => {
  const facts = pr({
    number: 7, checks: GREEN, author: "agent",
    comments: [{ id: "c1", author: "agent", body: "pushed a fix", createdAt: T0, url: null, path: null, line: null }],
  });
  const line = [{ id: "c2", author: "dylan", body: "Why not a Set?", createdAt: T0, url: "https://github.com/o/r/pull/7#discussion_r2", path: "packages/x.ts", line: 12 }];
  const r = news(facts, line, emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["comment", "comment", "checks"]);
  const text = describeNews(facts, r.events, CTX);
  assert.match(text, /Comment by dylan on packages\/x\.ts line 12:\n  > Why not a Set\?/);
  assert.match(text, /Comment by agent \(the account that opened the pull request\):\n  > pushed a fix/);
  assert.deepEqual(news(facts, line, r.cursor, later(60_000)).events, []);
});

test("a merge and a close each end the watch, and each is said in words", () => {
  const merged = news(pr({ number: 7, state: "MERGED", checks: GREEN }), [], emptyCursor(), T0);
  assert.deepEqual(merged.events.map((e) => e.kind), ["merged"], "a merged pull request has no checks verdict to deliver");
  assert.ok(endsWatch(merged.events[0]!));
  assert.match(describeNews(pr({ number: 7, state: "MERGED" }), merged.events, CTX), /was merged\. The loop is done/);

  const closed = news(pr({ number: 7, state: "CLOSED" }), [], emptyCursor(), T0);
  assert.deepEqual(closed.events.map((e) => e.kind), ["closed"]);
  assert.match(describeNews(pr({ number: 7, state: "CLOSED" }), closed.events, CTX), /closed without a merge/);
});

test("a conflict is reported once per head, and asks for work", () => {
  const facts = pr({ number: 7, checks: GREEN, mergeable: "CONFLICTING", headRefOid: "aaa" });
  const r = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["checks", "conflict"]);
  assert.equal(asksForWork(r.events[1]!), true);
  assert.match(describeNews(facts, r.events, CTX), /conflicts with main at aaa\. Merge main into covey\/abc/);
  assert.deepEqual(news(facts, [], r.cursor, later(60_000)).events, []);
  const pushed = pr({ number: 7, checks: GREEN, mergeable: "CONFLICTING", headRefOid: "bbb" });
  assert.deepEqual(news(pushed, [], r.cursor, later(120_000)).events.map((e) => e.kind), ["checks", "conflict"]);
});

test("the back-off starts at half a minute and stops at five", () => {
  assert.equal(pollDelayMs(0), POLL_MIN_MS);
  assert.ok(pollDelayMs(1) > pollDelayMs(0));
  assert.ok(pollDelayMs(2) > pollDelayMs(1));
  assert.equal(pollDelayMs(20), POLL_MAX_MS);
  assert.equal(pollDelayMs(1000), POLL_MAX_MS, "a watch quiet for a day polls no less often than every five minutes");
});

test("the verdict reads the check runs: a failure beats a pass, a pending check beats a pass", () => {
  assert.equal(checksVerdict([...GREEN, ...FAILED]).ci, "failing");
  assert.equal(checksVerdict([...GREEN, ...PENDING]).ci, "pending");
  assert.equal(checksVerdict(GREEN).ci, "passing");
  assert.equal(checksVerdict([]).ci, "absent");
  const skipped = [{ name: "close", status: "COMPLETED", conclusion: "SKIPPED" }];
  assert.equal(checksVerdict(skipped).ci, "absent", "a skipped check proves nothing");
});

// ---- the merge policy ----------------------------------------------------------

const STARTED = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-21T09:30:00Z" }];

test("under manual, a pass waits for a person; under auto, the text says covey merges next", () => {
  const facts = pr({ number: 7, checks: STARTED });
  const manual = news(facts, [], emptyCursor(), T0);
  assert.match(describeNews(facts, manual.events, CTX), /merge policy is manual: a person merges/);
  const auto = news(facts, [], emptyCursor(), T0, { merge: "auto", base: { oid: "b", committedAt: "2026-09-21T09:00:00Z" } });
  assert.equal(auto.events[0]!.kind === "checks" && auto.events[0]!.ci, "passing");
  assert.match(describeNews(facts, auto.events, { ...CTX, merge: "auto" }), /Covey merges the pull request on its next poll/);
});

test("under auto, a pass against an older base is stale, and asks the agent to update the branch", () => {
  const facts = pr({ number: 7, checks: STARTED, headRefOid: "abc1234def" });
  const moved = { oid: "newer", committedAt: "2026-09-21T09:45:00Z" };
  const auto = news(facts, [], emptyCursor(), T0, { merge: "auto", base: moved });
  assert.equal(auto.events[0]!.kind === "checks" && auto.events[0]!.ci, "stale");
  assert.equal(asksForWork(auto.events[0]!), true, "the agent has to merge the base in and push");
  assert.match(describeNews(facts, auto.events, { ...CTX, merge: "auto" }), /passed on abc1234, but against an older main.*Merge main into covey\/abc and push/);
  assert.deepEqual(news(facts, [], auto.cursor, later(60_000), { merge: "auto", base: moved }).events, [], "delivered once");
  // The same facts under manual are a plain pass: staleness is the person's question there.
  const manual = news(facts, [], emptyCursor(), T0, { merge: "manual", base: moved });
  assert.equal(manual.events[0]!.kind === "checks" && manual.events[0]!.ci, "passing");
});

test("the daemon merges only what is green against the current base, mergeable, and not asked to change", () => {
  const base = { oid: "b", committedAt: "2026-09-21T09:00:00Z" };
  assert.deepEqual(mergeReadiness(pr({ number: 7, checks: STARTED }), base), { ready: true });
  const why = (over: Parameters<typeof pr>[0], b = base) => { const r = mergeReadiness(pr(over), b); return r.ready ? "ready" : r.why; };
  assert.match(why({ number: 7, checks: STARTED, isDraft: true }), /draft/);
  assert.match(why({ number: 7, checks: STARTED, reviewDecision: "CHANGES_REQUESTED" }), /review asks for changes/);
  assert.match(why({ number: 7, checks: STARTED, reviewDecision: "REVIEW_REQUIRED" }), /requires a review/);
  assert.match(why({ number: 7, checks: STARTED, mergeable: "CONFLICTING" }), /conflicts/);
  assert.match(why({ number: 7, checks: STARTED, mergeable: "UNKNOWN" }), /not said yet/);
  assert.match(why({ number: 7, checks: PENDING }), /has not finished/);
  assert.match(why({ number: 7, checks: FAILED }), /failed/);
  assert.match(why({ number: 7, checks: [] }), /no checks/);
  assert.match(why({ number: 7, checks: STARTED }, { oid: "n", committedAt: "2026-09-21T09:45:00Z" }), /started before/);
  assert.match(why({ number: 7, checks: STARTED, mergeStateStatus: "BEHIND" }), /BEHIND/);
  assert.match(why({ number: 7, checks: STARTED, state: "MERGED" }), /is merged/);
  assert.equal(asksForWork({ kind: "mergeFailed", error: "x" }), false, "a refused merge is a person's question, not a round");
});

// ---- the two sides of the automated review ----
//
// One watch belongs to the thread that wrote the change and one to each thread
// that reads it. These cases hold the line between what the two hear: the
// author owns the build, the reviewer owns the code, and neither is woken by
// its own words.

const REVIEWER = { role: "reviewer" as const };
const RCTX = { ...CTX, role: "reviewer" as const, base: "main" };
const tagged = (verdict: "Approved" | "Changes requested") => `Line 20 is wrong.\n\n---\n*${verdict} — from an automated covey review.*`;

test("a reviewer hears the push and the author never does", () => {
  const first = pr({ number: 7, headRefOid: "aaaaaaa1", checks: GREEN });
  const seen = news(first, [], emptyCursor(), T0, REVIEWER);
  assert.deepEqual(seen.events.map((e) => e.kind), [], "the first poll is not a push: the brief named this head");

  const pushed = pr({ number: 7, headRefOid: "bbbbbbb2", checks: GREEN });
  const r = news(pushed, [], seen.cursor, later(60_000), REVIEWER);
  assert.deepEqual(r.events.map((e) => e.kind), ["head"]);
  assert.equal(asksForWork(r.events[0]!, "reviewer"), true, "reading the new diff is work, so it costs a round");
  assert.equal(asksForWork(r.events[0]!, "author"), false, "an author pushed it: telling it so would cost a round for nothing");
  const text = describeNews(pushed, r.events, RCTX);
  assert.match(text, /the pull request you review #7/);
  assert.match(text, /The author pushed bbbbbbb to branch; it was aaaaaaa/);
  assert.match(text, /git pull/);
  assert.match(text, /git diff origin\/main\.\.\.HEAD/);
  assert.match(text, /covey review approve/);
});

test("a reviewer hears no checks verdict and no conflict", () => {
  // Both are the author's work, already in hand. A reviewer woken by a red
  // build spends a round of its budget on somebody else's job.
  const facts = pr({ number: 7, checks: FAILED, mergeable: "CONFLICTING" });
  assert.deepEqual(news(facts, [], emptyCursor(), T0, REVIEWER).events.map((e) => e.kind), []);
  assert.deepEqual(news(facts, [], emptyCursor(), T0).events.map((e) => e.kind), ["checks", "conflict"], "the author hears both");
});

test("a reviewer still hears a merge and a close: there is nothing left to review", () => {
  const merged = news(pr({ number: 7, state: "MERGED" }), [], emptyCursor(), T0, REVIEWER);
  assert.deepEqual(merged.events.map((e) => e.kind), ["merged"]);
  assert.match(describeNews(pr({ number: 7, state: "MERGED" }), merged.events, RCTX), /nothing left to review/);
  assert.match(describeNews(pr({ number: 7, state: "MERGED" }), merged.events, RCTX), /do not comment/);
});

test("a thread never hears a comment it wrote itself", () => {
  // Every thread of one pull request writes from one GitHub account, so no
  // author login can tell a reviewer's comment from the author's. Without this
  // a reviewer is woken by its own review and asked to answer itself.
  const mine = { id: "c1", author: "agent", body: tagged("Changes requested"), createdAt: T0, url: "https://github.com/o/r/pull/7#issuecomment-1", path: null, line: null };
  const theirs = { id: "c2", author: "agent", body: "I pushed the fix.", createdAt: T0, url: "https://github.com/o/r/pull/7#issuecomment-2", path: null, line: null };
  const cursor = { ...emptyCursor(), posted: [mine.url] };
  const r = news(pr({ number: 7, comments: [mine, theirs] }), [], cursor, T0, REVIEWER);
  assert.deepEqual(r.events.map((e) => (e.kind === "comment" ? e.comment.id : e.kind)), ["c2"]);
  assert.deepEqual(r.cursor.comments, ["c1", "c2"], "the one it wrote is still recorded, so the match runs once");
});

test("a tagged comment reads as a machine's, and asks the author for the change", () => {
  const comment = { id: "c1", author: "agent", body: tagged("Changes requested"), createdAt: T0, url: "u", path: null, line: null };
  const facts = pr({ number: 7, comments: [comment] });
  const r = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["comment"]);
  assert.equal(asksForWork(r.events[0]!, "author"), true, "a machine that asks for changes is work for the author");
  assert.equal(asksForWork(r.events[0]!, "reviewer"), false, "and discussion for a second reviewer");
  const text = describeNews(facts, r.events, CTX);
  assert.match(text, /Comment by an automated covey review, which asks for changes/);
  assert.match(text, /Make the change, commit, push to covey\/abc/);
  assert.match(text, /round 1 of 3/);
  assert.doesNotMatch(describeNews(facts, r.events, RCTX), /Make the change/, "a reviewer is told nothing to do about it");
});

test("a sign-off comment is labelled and costs no round", () => {
  const comment = { id: "c1", author: "agent", body: tagged("Approved"), createdAt: T0, url: "u", path: null, line: null };
  const facts = pr({ number: 7, comments: [comment] });
  const r = news(facts, [], emptyCursor(), T0);
  assert.equal(asksForWork(r.events[0]!, "author"), false);
  assert.match(describeNews(facts, r.events, CTX), /which signed off/);
});

const needing = (signedOff: number, required: number) => ({
  required,
  reviewers: Array.from({ length: required }, (_, i) => ({
    threadId: `r${i}`, index: i + 1, state: i < signedOff ? ("signedOff" as const) : ("reviewing" as const),
    note: null, startedAt: T0, decidedAt: null,
  })),
});

test("the sign-off that completes the review is news, once", () => {
  const facts = pr({ number: 7, checks: GREEN });
  const pending = news(facts, [], emptyCursor(), T0, { review: needing(0, 1) });
  assert.deepEqual(pending.events.map((e) => e.kind), ["checks"], "nothing to say while the review is out");

  const done = news(facts, [], pending.cursor, later(60_000), { review: needing(1, 1) });
  assert.deepEqual(done.events.map((e) => e.kind), ["reviewed"]);
  assert.equal(asksForWork(done.events[0]!), false, "a sign-off asks the author for nothing");
  assert.match(describeNews(facts, done.events, CTX), /Every automated review has signed off \(1 of 1\)/);
  assert.match(describeNews(facts, done.events, CTX), /ready for a person to merge/);

  const again = news(facts, [], done.cursor, later(120_000), { review: needing(1, 1) });
  assert.deepEqual(again.events.map((e) => e.kind), [], "and never a second time");
});

test("asking for another reviewer makes the next sign-off news again", () => {
  const facts = pr({ number: 7, checks: GREEN });
  const done = news(facts, [], { ...emptyCursor(), checks: { head: facts.headRefOid, ci: "passing" } }, T0, { review: needing(1, 1) });
  assert.deepEqual(done.events.map((e) => e.kind), ["reviewed"]);
  // A second reviewer joins: the review is out again, and the cursor says so.
  const reopened = news(facts, [], done.cursor, later(60_000), { review: needing(1, 2) });
  assert.deepEqual(reopened.events.map((e) => e.kind), []);
  assert.equal(reopened.cursor.reviewed, false);
  const closed = news(facts, [], reopened.cursor, later(120_000), { review: needing(2, 2) });
  assert.deepEqual(closed.events.map((e) => e.kind), ["reviewed"]);
});

test("a watch with no review requirement says nothing about one", () => {
  // Every pull request opened before this existed, and every `--no-review` one.
  const facts = pr({ number: 7, checks: GREEN });
  const r = news(facts, [], emptyCursor(), T0);
  assert.deepEqual(r.events.map((e) => e.kind), ["checks"]);
  assert.equal(r.cursor.reviewed, false, "nothing to remember");
  assert.doesNotMatch(describeNews(facts, r.events, CTX), /automated review/);
});

test("a green check with the review still out says what it is waiting for", () => {
  const facts = pr({ number: 7, checks: GREEN });
  const r = news(facts, [], emptyCursor(), T0, { review: needing(0, 2) });
  const text = describeNews(facts, r.events, { ...CTX, review: needing(0, 2) });
  assert.match(text, /The checks passed/);
  assert.match(text, /The automated review has not signed off yet — 0 of 2/);
  assert.doesNotMatch(text, /merge policy is manual/, "the review is the nearer answer to 'what now'");
});

test("mergeReadiness holds a green pull request until the review signs off", () => {
  const base = { oid: "b", committedAt: "2026-09-21T09:00:00Z" };
  const facts = pr({ number: 7, checks: STARTED, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  assert.deepEqual(mergeReadiness(facts, base), { ready: true }, "no review asked for, so nothing to wait on");
  assert.deepEqual(mergeReadiness(facts, base, needing(0, 1)), { ready: false, why: "0 of 1 automated reviews have signed off" });
  assert.deepEqual(mergeReadiness(facts, base, needing(1, 1)), { ready: true });
  assert.deepEqual(mergeReadiness(facts, base, needing(0, 0)), { ready: true }, "`--no-review` waits on nobody");
});

test("a red check is the reason a reader is given, not the review", () => {
  // A reader told "the review has not signed off" about a branch with a red
  // check has been told the wrong thing: the review is checked last.
  const base = { oid: "b", committedAt: "2026-09-21T09:00:00Z" };
  const r = mergeReadiness(pr({ number: 7, checks: FAILED, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }), base, needing(0, 1));
  assert.equal(r.ready, false);
  assert.doesNotMatch(r.ready === false ? r.why : "", /automated review/);
});
