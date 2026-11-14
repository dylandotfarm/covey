/**
 * The words of a thread's timer.
 *
 * Four clients read this file — the CLI, the TUI, the page and the app — so
 * what it says is what a reader meets on every screen covey has. The cases
 * below hold the two halves: a time an agent wrote is read whole or refused by
 * name, and a timer that runs is said the same way everywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMER_MAX_MS, TIMER_MIN_MS, type ThreadTimer } from "@covey/protocol";
import { parseTimer, timerLabel, timerLeftLabel, timerLeftMs, timerLine } from "./timer.js";

const ok = (text: string): number => {
  const r = parseTimer(text);
  assert.equal(typeof r, "number", `${text} was refused: ${(r as { error: string }).error}`);
  return r as number;
};
const err = (text: string): string => {
  const r = parseTimer(text);
  assert.equal(typeof r, "object", `${text} was accepted as ${r}`);
  return (r as { error: string }).error;
};

test("a time is read in the spellings an agent writes", () => {
  assert.equal(ok("10m"), 600_000);
  assert.equal(ok("90s"), 90_000);
  assert.equal(ok("2h"), 7_200_000);
  assert.equal(ok("1h30m"), 5_400_000);
  assert.equal(ok("1h 30m"), 5_400_000, "a space between the parts is the same time");
  assert.equal(ok("10 m"), 600_000, "and so is a space before the unit");
  assert.equal(ok("45 minutes"), 2_700_000);
  assert.equal(ok("1.5h"), 5_400_000);
  assert.equal(ok("2H"), 7_200_000, "the case of the unit says nothing");
});

/**
 * A bare number is minutes. It is the spelling an agent writes without
 * thinking, and minutes is the unit the whole feature is measured in: a minute
 * is the floor and six hours the ceiling.
 */
test("a bare number is minutes", () => {
  assert.equal(ok("10"), 600_000);
  assert.equal(ok("360"), TIMER_MAX_MS);
});

/**
 * Taken whole or refused. A parser that read `10m` out of `10m junk` would set
 * a timer for a length nobody asked for, and the agent would wait the wrong
 * amount of time with nothing on screen to say so.
 */
test("a spelling with anything left over is refused", () => {
  for (const text of ["10mm", "10m junk", "soon", "m10", "", "   ", "--note", "1h-30m", "1,5h"]) {
    assert.match(err(text), /./, text);
  }
});

/**
 * Four ways to fail and four sentences (#132). "Not a time" about a time covey
 * read perfectly well and will not set is what makes an agent try the same
 * spelling again.
 */
test("the floor and the ceiling are refused by name, and not as a bad spelling", () => {
  assert.match(err("30s"), /shorter than a timer may be/);
  assert.match(err("30s"), /30s/, "the refusal never says what was asked for");
  assert.match(err("0m"), /shorter than a timer may be/, "a time covey read is not a spelling it could not read");
  assert.match(err("7h"), /longer than a timer may be/);
  assert.match(err("7h"), /6h/, "the refusal never says what the ceiling is");
  assert.equal(ok("1m"), TIMER_MIN_MS, "the floor itself is allowed");
  assert.equal(ok("6h"), TIMER_MAX_MS, "and so is the ceiling");
  assert.match(err("6h1m"), /longer than a timer may be/);
});

test("a length of time is said in the fewest words that say it", () => {
  assert.equal(timerLabel(45_000), "45s");
  assert.equal(timerLabel(600_000), "10m");
  assert.equal(timerLabel(3_600_000), "1h");
  assert.equal(timerLabel(5_400_000), "1h 30m");
  assert.equal(timerLabel(TIMER_MAX_MS), "6h");
  assert.equal(timerLabel(-5), "0s", "a time already past is not a negative one");
});

// ---- what a row says -------------------------------------------------------

const NOW = Date.parse("2026-11-14T12:00:00Z");
const timer = (over: Partial<ThreadTimer> = {}): ThreadTimer => ({
  note: null, lengthMs: 600_000, setAt: "2026-11-14T11:55:00Z",
  dueAt: "2026-11-14T12:07:00Z", round: 1, ...over,
});

test("how long is left is read from the time it is due, and never goes below zero", () => {
  assert.equal(timerLeftMs(timer(), NOW), 420_000);
  assert.equal(timerLeftMs(timer({ dueAt: "2026-11-14T11:59:00Z" }), NOW), 0);
});

/**
 * `0m` reads as a timer that has stopped working, and a timer whose time is up
 * is one tick of the daemon away from firing. So the row says what is true.
 */
test("a timer whose time is up says so, rather than counting zero", () => {
  assert.equal(timerLeftLabel(timer(), NOW), "7m");
  assert.equal(timerLeftLabel(timer({ dueAt: "2026-11-14T12:00:30Z" }), NOW), "<1m");
  assert.equal(timerLeftLabel(timer({ dueAt: "2026-11-14T11:30:00Z" }), NOW), "due");
  assert.equal(timerLine(timer({ dueAt: "2026-11-14T11:30:00Z" }), NOW), "timer due");
});

/**
 * The note is the difference between a thread that is stuck and a thread that
 * is waiting on a deploy, so it is on the line — last, because it is the part
 * that can be long and every row cuts this line from the right.
 */
test("the line names what the thread waits for, after how long is left", () => {
  assert.equal(timerLine(timer(), NOW), "on a timer · 7m left");
  assert.equal(timerLine(timer({ note: "the CI run on main" }), NOW), "on a timer · 7m left · the CI run on main");
});
