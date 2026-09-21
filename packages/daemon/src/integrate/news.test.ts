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
  news, emptyCursor, asksForWork, endsWatch, describeNews, pollDelayMs, checksVerdict,
  NO_CHECKS_GRACE_MS, POLL_MIN_MS, POLL_MAX_MS,
} from "./news.js";
import { pr } from "./testHost.js";

const T0 = "2026-09-21T10:00:00Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const FAILED = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/run/1" }];
const GREEN = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const PENDING = [{ name: "test", workflowName: "ci", status: "IN_PROGRESS" }];
const CTX = { branch: "covey/abc", rounds: 1, maxRounds: 3 };

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
