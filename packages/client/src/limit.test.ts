/**
 * The one sentence three clients say about a thread held on the plan's usage
 * limit. A reader with covey open on a laptop and a phone must not meet two
 * different answers about one wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadUsageLimit } from "@covey/protocol";
import { limitLabel, limitLeftLabel, limitLine, limitResetLabel, limitSpanLabel } from "./limit.js";

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

test("the reset is said on the clock of the device the reader is holding", () => {
  // The daemon is on a server in UTC and the reader is in New York. Claude
  // Code wrote `resets 12:10am (UTC)`, and neither of those is the hour the
  // reader's own phone shows.
  assert.equal(limitResetLabel(limit(), NOW, "America/New_York"), "7:10pm");
  assert.equal(limitResetLabel(limit(), NOW, "UTC"), "tomorrow 12:10am");
  // The day word is the zone's own calendar and never a count of hours: the
  // same eight-hour wait is tomorrow in London and this morning in Sydney.
  assert.equal(limitResetLabel(limit(), NOW, "Australia/Sydney"), "11:10am");
  // On the hour, the minutes are not a column of zeroes.
  assert.equal(limitResetLabel(limit({ resetsAt: "2026-11-15T21:00:00Z" }), NOW, "UTC"), "9pm");
  // A weekly window resets days away, and `9am` alone reads as this morning.
  assert.equal(limitResetLabel(limit({ resetsAt: "2026-11-21T09:00:00Z" }), NOW, "UTC"), "Nov 21, 9am");
  // A wait covey guessed is a backoff and not a reset, so there is no clock to
  // say — covey never states a time it did not read.
  assert.equal(limitResetLabel(limit({ resetsAt: null }), NOW, "UTC"), null);
  // Nor is a reset already past an answer to "when". Covey sends the work a
  // grace minute and a watch tick after it, and longer when the daemon was
  // switched off, and an hour that has gone is not the one the reader wants.
  assert.equal(limitResetLabel(limit({ resetsAt: "2026-11-15T16:07:00Z" }), NOW, "UTC"), null);
});

test("the line says which limit, when it resets and when covey tries again", () => {
  assert.equal(limitLine(limit(), NOW, "America/New_York"), "session limit · resets 7:10pm · covey retries in 8h 3m");
  // No zone is named, because the clock is already the reader's own.
  assert.doesNotMatch(limitLine(limit(), NOW, "America/New_York"), /UTC/);
  // A guessed wait says the span alone.
  assert.equal(limitLine(limit({ resetsAt: null }), NOW, "UTC"), "session limit · covey retries in 8h 3m");
});

test("a wait that is up reads as due, and never as zero", () => {
  const up = limit({ dueAt: "2026-11-15T16:08:00Z" });
  assert.equal(limitLeftLabel(up, NOW), "due");
  assert.equal(limitLine(up, NOW), "session limit · covey retries now");
  assert.equal(limitLeftLabel(limit({ dueAt: "2026-11-15T16:08:30Z" }), NOW), "<1m");
  // The minute between the reset and the retry: the wait still has time on it
  // and the reset has gone, so the line says the span and no clock at all.
  const grace = limit({ resetsAt: "2026-11-15T16:07:30Z", dueAt: "2026-11-15T16:08:30Z" });
  assert.equal(limitLine(grace, NOW, "UTC"), "session limit · covey retries in <1m");
});
