/**
 * The one sentence three clients say about a thread held on the plan's usage
 * limit. A reader with covey open on a laptop and a phone must not meet two
 * different answers about one wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadUsageLimit } from "@covey/protocol";
import { limitLabel, limitLeftLabel, limitLine, limitSpanLabel } from "./limit.js";

const NOW = Date.parse("2026-11-15T16:08:00Z");

const limit = (over: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit => ({
  message: "You've hit your session limit · resets 12:10am (UTC)",
  turnId: "turn-1",
  setAt: "2026-11-15T16:08:00Z",
  dueAt: "2026-11-16T00:11:00Z",
  resetsAt: "2026-11-16T00:10:00Z",
  firedAt: null,
  round: 1,
  ...over,
});

test("a wait is said in the fewest words, and days once there are days", () => {
  assert.equal(limitSpanLabel(15 * 60_000), "15m");
  assert.equal(limitSpanLabel(8 * 3_600_000), "8h");
  assert.equal(limitSpanLabel(7.5 * 3_600_000), "7h 30m");
  // A week is the longest window a plan has, and `164h` is a number a reader
  // would have to do arithmetic on.
  assert.equal(limitSpanLabel(6.5 * 86_400_000), "6d 12h");
  assert.equal(limitSpanLabel(7 * 86_400_000), "7d");
  assert.equal(limitSpanLabel(86_400_000 - 60_000), "23h 59m", "under a day it is still hours");
  // A remainder that rounds up to a whole day is that day, never `2d 24h`.
  assert.equal(limitSpanLabel(2 * 86_400_000 - 60_000), "2d");
  assert.equal(limitSpanLabel(-5), "0s", "a time already past is not a negative one");
});

test("the label is the limit the reader met, and never the whole sentence", () => {
  assert.equal(limitLabel("You've hit your session limit · resets 12:10am (UTC)"), "session limit");
  assert.equal(limitLabel("You've hit your weekly limit · resets Nov 21, 9am (UTC)"), "weekly limit");
  assert.equal(limitLabel("You're out of usage credits · resets 5pm (UTC)"), "out of usage credits");
  assert.equal(limitLabel("Your org is out of usage · add funds to continue"), "Your org is out of usage");
  assert.equal(limitLabel(""), "usage limit", "a refusal with nothing in it still has a name");
  assert.ok(limitLabel(`You've hit your ${"very ".repeat(20)}long limit`).length <= 40, "a sidebar row is not a paragraph");
});

test("the line says which limit and when covey tries again, never a clock time", () => {
  assert.equal(limitLine(limit(), NOW), "session limit · covey retries in 8h 3m");
  // A zone the reader would have to translate is the one thing this line does
  // not say: the wait is the fact they act on.
  assert.doesNotMatch(limitLine(limit(), NOW), /UTC|12:10/);
});

test("a wait that is up reads as due, and never as zero", () => {
  const up = limit({ dueAt: "2026-11-15T16:08:00Z" });
  assert.equal(limitLeftLabel(up, NOW), "due");
  assert.equal(limitLine(up, NOW), "session limit · covey retries now");
  assert.equal(limitLeftLabel(limit({ dueAt: "2026-11-15T16:08:30Z" }), NOW), "<1m");
});
