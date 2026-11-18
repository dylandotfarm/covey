/**
 * The plan's usage limit: what covey reads out of the refusal, and what it
 * decides to do about it.
 *
 * The sentences here are Claude Code's own, taken from a thread that met the
 * limit on 2026-11-15 (`You've hit your session limit · resets 12:10am
 * (UTC)`), and from the formatter that writes them
 * (`rateLimitMessages.ts`, read out of the bundled CLI of SDK 0.3.280).
 *
 * The zone is the machine's own, because that is the one thing this parser
 * must get right: Claude Code writes a local time and names the zone it wrote
 * it in, and a time read in the wrong zone is a thread that wakes hours early
 * and spends a whole round on a limit that is still refusing it. So the tests
 * build their messages with the zone this process runs in and their
 * expectations with local-time arithmetic, and pass wherever they run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_LIMIT_BACKOFF_MS, USAGE_LIMIT_GRACE_MS, USAGE_LIMIT_MAX_ROUNDS, USAGE_LIMIT_MAX_WAIT_MS,
  isUsageLimit, limitResetAt, planUsageLimit, usageLimitNote,
} from "./usageLimit.js";
import type { ThreadUsageLimit } from "@covey/protocol";

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MINUTE = 60_000;

/** Four in the afternoon, local, on the day the reader met this. */
const NOW = new Date(2026, 10, 15, 16, 8, 0, 0).getTime();

/** A message in this machine's own zone, the way Claude Code writes one. */
const says = (when: string, what = "You've hit your session limit") => `${what} · resets ${when} (${ZONE})`;

// ---- is it the limit at all? ------------------------------------------------

test("the refusals Claude Code writes for a spent plan are read as the limit", () => {
  for (const text of [
    says("12:10am"),
    "You've hit your weekly limit · resets Nov 21, 9am (UTC)",
    "You've reached your usage limit",
    "You're out of usage credits · resets 5pm (UTC)",
    "Your org is out of usage · add funds to continue",
    "Your seat type doesn't include usage credits",
    "Your group's usage limit is set to $0",
    "Fable 5 requires usage credits",
  ]) {
    assert.equal(isUsageLimit(text), true, text);
  }
});

/**
 * The daemon reads only the CLI's own error text with this, never a tool's
 * output, which is `isAuthFailure`'s rule beside it. These are the things that
 * come down the same channel and are not the limit.
 */
test("work that merely failed is not the limit", () => {
  for (const text of [
    "",
    null,
    undefined,
    "Error: the test suite failed",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    // An org policy is not an exhausted window: no amount of waiting clears
    // it, and the SDK keeps it in a list of its own for that reason.
    "This service is disabled for your org",
  ]) {
    assert.equal(isUsageLimit(text), false, String(text));
  }
});

/**
 * The same refusal reaches covey wrapped, when it comes back through a failure
 * rather than through a reply. The sentence is taken at the start of a line
 * and after a `… error: ` as well as at the front of the text.
 */
test("the refusal is read where the CLI wraps it", () => {
  assert.equal(isUsageLimit(`Agent terminated early due to an API error: ${says("12:10am")}`), true);
  assert.equal(isUsageLimit(`something happened\n${says("12:10am")}`), true);
  // Not inside a sentence somebody wrote. An agent that quotes this must not
  // put its own thread to sleep for five hours.
  assert.equal(isUsageLimit("the docs say You've hit your session limit when the plan runs out"), false);
});

// ---- when does it reset? ----------------------------------------------------

test("a time of day is the next moment the clock reads so", () => {
  // 12:10am is eight hours after four in the afternoon, so it is tomorrow.
  const tomorrow = new Date(2026, 10, 16, 0, 10, 0, 0).getTime();
  assert.equal(limitResetAt(says("12:10am"), NOW), tomorrow);
  // Later the same afternoon.
  assert.equal(limitResetAt(says("5:30pm"), NOW), new Date(2026, 10, 15, 17, 30, 0, 0).getTime());
  // On the hour, which is how the formatter writes a reset with no minutes.
  assert.equal(limitResetAt(says("9pm"), NOW), new Date(2026, 10, 15, 21, 0, 0, 0).getTime());
  // Noon has gone by four in the afternoon, so `12pm` is tomorrow's.
  assert.equal(limitResetAt(says("12pm"), NOW), new Date(2026, 10, 16, 12, 0, 0, 0).getTime());
});

/**
 * A reset that has just come round is minutes old, not a day away. The message
 * is written before covey reads it, and a clock that has turned in between
 * would otherwise send the thread to sleep until tomorrow.
 */
test("a reset that has only just passed is still this one", () => {
  const justGone = new Date(2026, 10, 15, 16, 6, 0, 0).getTime();
  assert.equal(limitResetAt(says("4:06pm"), NOW), justGone);
  assert.equal(limitResetAt(says("4:02pm"), NOW), new Date(2026, 10, 16, 16, 2, 0, 0).getTime(), "and one that went six minutes ago is tomorrow's");
});

test("a reset more than a day off carries its date", () => {
  assert.equal(limitResetAt(says("Nov 21, 9am"), NOW), new Date(2026, 10, 21, 9, 0, 0, 0).getTime());
  assert.equal(limitResetAt(says("Nov 21, 2:20am"), NOW), new Date(2026, 10, 21, 2, 20, 0, 0).getTime());
  assert.equal(limitResetAt(says("Jan 15, 2027, 12:20am"), NOW), new Date(2027, 0, 15, 0, 20, 0, 0).getTime());
});

/**
 * The zone is the whole safety of reading a local time. Claude Code names the
 * zone it wrote the time in; covey reads the hour as one of its own, so a zone
 * that is not covey's own is no answer at all.
 */
test("a time written in another zone is not read", () => {
  assert.equal(limitResetAt("You've hit your session limit · resets 12:10am (Pacific/Kiritimati)", NOW), null);
  assert.equal(limitResetAt("You've hit your session limit", NOW), null, "a refusal with no time in it");
  assert.equal(limitResetAt(says("soon"), NOW), null, "and one covey cannot read");
  assert.equal(limitResetAt(says("25:99am"), NOW), null);
});

// ---- what covey does about it -----------------------------------------------

test("a reset covey read is what it waits for, with a minute of grace", () => {
  const plan = planUsageLimit({ message: says("12:10am"), nowMs: NOW, round: 1 })!;
  const reset = new Date(2026, 10, 16, 0, 10, 0, 0).getTime();
  assert.equal(plan.resetsAt, reset);
  assert.equal(plan.dueAt, reset + USAGE_LIMIT_GRACE_MS);
});

/**
 * One account is one limit, so a reset another thread on this machine read a
 * moment ago is this thread's reset too. It beats a guess and loses to a time
 * the refusal names for itself.
 */
test("a reset another thread read stands in, and never over, the message's own", () => {
  const known = NOW + 3 * 3_600_000;
  assert.equal(planUsageLimit({ message: "You've reached your usage limit", nowMs: NOW, round: 1, known })!.resetsAt, known);
  const own = planUsageLimit({ message: says("5:30pm"), nowMs: NOW, round: 1, known })!;
  assert.equal(own.resetsAt, new Date(2026, 10, 15, 17, 30, 0, 0).getTime(), "the message is the better fact");
  assert.equal(planUsageLimit({ message: "You've reached your usage limit", nowMs: NOW, round: 1, known: NOW - MINUTE })!.resetsAt, null, "a reset already gone is no hint");
});

test("a reset covey could not read becomes a backoff that grows", () => {
  const waits = [];
  for (let round = 1; round <= USAGE_LIMIT_MAX_ROUNDS; round++) {
    const plan = planUsageLimit({ message: "You've reached your usage limit", nowMs: NOW, round })!;
    assert.equal(plan.resetsAt, null);
    waits.push(plan.dueAt - NOW);
  }
  assert.deepEqual(waits, [...USAGE_LIMIT_BACKOFF_MS]);
});

/**
 * A thread that tried for ever would be a thread nobody was ever told about.
 * The round past the last is where covey stops and the row goes back to
 * needing a person.
 */
test("covey gives up after the last round", () => {
  assert.notEqual(planUsageLimit({ message: says("12:10am"), nowMs: NOW, round: USAGE_LIMIT_MAX_ROUNDS }), null, "the last round is still a wait");
  assert.equal(planUsageLimit({ message: says("12:10am"), nowMs: NOW, round: USAGE_LIMIT_MAX_ROUNDS + 1 }), null);
});

/**
 * Further off than a plan's longest window and something has been misread. A
 * thread asleep until March is one nobody will ever come back to, so covey
 * backs off instead and meets the limit again in five minutes.
 */
test("a reset further off than any window is not believed", () => {
  const far = NOW + USAGE_LIMIT_MAX_WAIT_MS + 3_600_000;
  const plan = planUsageLimit({ message: "You've reached your usage limit", nowMs: NOW, round: 1, known: far })!;
  assert.equal(plan.resetsAt, null);
  assert.equal(plan.dueAt, NOW + USAGE_LIMIT_BACKOFF_MS[0]!);
});

// ---- what the reader finds in the transcript --------------------------------

const limit = (over: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit => ({
  message: "You've hit your session limit · resets 12:10am (UTC)",
  turnId: "turn-1",
  setAt: new Date(NOW).toISOString(),
  dueAt: new Date(NOW + 8 * 3_600_000).toISOString(),
  resetsAt: new Date(NOW + 8 * 3_600_000 - USAGE_LIMIT_GRACE_MS).toISOString(),
  firedAt: null,
  round: 1,
  ...over,
});

test("the note says which limit, that covey holds the work, and when it goes again", () => {
  const note = usageLimitNote(limit(), NOW);
  assert.match(note, /You've hit your session limit/, "the limit the reader met");
  assert.match(note, /holds this turn/, "that nothing is lost");
  assert.match(note, /in 8h/, "and when it goes again");
  assert.match(note, /Nothing is needed from you/);
  assert.doesNotMatch(note, /wait \d in a row/, "the first wait is not a chain");
});

/**
 * A note is written on the daemon's machine and read somewhere else, so the
 * only clock it could write is a server's. The reader's own clock is on the
 * thread's row, painted live by every client.
 */
test("the note names no clock time, in the daemon's zone or any other", () => {
  const note = usageLimitNote(limit(), NOW);
  assert.doesNotMatch(note, /UTC|12:10am/, "a zone the reader has to translate");
  assert.match(note, /^You've hit your session limit\. /, "the refusal keeps its own words, less the reset");
  // A tail that is not a clock is the reader's to act on and stays whole.
  const funds = usageLimitNote(limit({ message: "Your org is out of usage · add funds to continue" }), NOW);
  assert.match(funds, /add funds to continue/);
});

test("a note for a guessed wait names no reset, and a repeated one counts", () => {
  const note = usageLimitNote(limit({ resetsAt: null, dueAt: new Date(NOW + 15 * MINUTE).toISOString(), round: 3 }), NOW);
  assert.match(note, /could not read when the limit resets/);
  assert.match(note, /in 15m/);
  assert.match(note, /wait 3 in a row/);
});
