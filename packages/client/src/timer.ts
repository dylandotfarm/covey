/**
 * The words of a thread's timer: how a time is read, and how one is
 * said back.
 *
 * Four callers share this file, and that is the whole reason it exists. The
 * CLI reads `10m` off an agent's command line. The TUI paints the time left in
 * the composer's status row. The page and the app paint it beside the title of
 * a thread in the list. A reader who keeps covey open on a laptop and a phone
 * must not meet two different sentences about one timer, which is the rule
 * `hiddenPanel` is here for as well.
 *
 * Pure and node-tested, like `timelineRows` and for the same reason: every
 * caller sits behind a socket, a terminal or a phone.
 */
import { TIMER_MAX_MS, TIMER_MIN_MS, type ThreadTimer } from "@covey/protocol";

/** How many milliseconds one spelling of a unit is worth. */
const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

/**
 * Read a time an agent wrote: `10m`, `90s`, `2h`, `1h30m`, or a bare `10`.
 *
 * A bare number is **minutes**. That is the unit this feature is about — a
 * minute is the floor and six hours the ceiling — and a number with no unit is
 * the one spelling an agent will write without thinking.
 *
 * An error is a sentence for the shell, never a throw, and the four ways this
 * can fail are four sentences (#132): nothing to read, not a time at all, too
 * short, too long. One word for four problems is what makes an agent try the
 * same spelling again.
 */
export function parseTimer(text: string): number | { error: string } {
  const src = (text ?? "").trim().toLowerCase();
  if (!src) return { error: "covey timer needs a time, for example `covey timer 10m`" };
  const bad = { error: `${text} is not a time. Write a number and a unit — 90s, 10m, 2h or 1h30m — or a bare number for minutes` };
  // One number and its unit, read from the front of the text and on to the
  // end of it: a spelling is taken whole or not at all, because `10mm` and
  // `10m junk` both leave characters over and a parser that took the part it
  // liked would set a timer for a length nobody asked for.
  //
  // Built here rather than kept as a module constant: an expression with `g`
  // carries its own cursor, and a shared one is a parser whose answer depends
  // on the call before it.
  const part = /\s*(\d+(?:\.\d+)?)\s*([a-z]*)/gu;
  let ms = 0;
  let at = 0;
  for (let m = part.exec(src); m; m = part.exec(src)) {
    if (m.index !== at) return bad;
    const unit = m[2] ? UNITS[m[2]] : 60_000;
    if (unit === undefined) return bad;
    ms += Number(m[1]) * unit;
    at = m.index + m[0].length;
  }
  if (at !== src.length) return bad;
  // `0m` is a time covey read and will not set, not a spelling it could not
  // read, so it falls to the floor below and gets that sentence.
  ms = Math.round(ms);
  if (ms < TIMER_MIN_MS) {
    return { error: `${timerLabel(ms)} is shorter than a timer may be. A timer wakes this thread with a whole new turn, so one minute is the floor; a shorter wait belongs inside the turn you are in` };
  }
  if (ms > TIMER_MAX_MS) {
    return { error: `${timerLabel(ms)} is longer than a timer may be. ${timerLabel(TIMER_MAX_MS)} is the ceiling: set a shorter timer, and set another one when it fires and the work is still running` };
  }
  return ms;
}

/**
 * A length of time in the fewest words that say it: `45s`, `10m`, `2h`,
 * `1h 30m`.
 *
 * Seconds are only ever reached by a refusal — the floor is a minute — so they
 * are here for the sentence that says so and for nothing else.
 */
export function timerLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** How long a timer has left, in milliseconds, and never below zero. */
export function timerLeftMs(timer: ThreadTimer, nowMs: number): number {
  return Math.max(0, Date.parse(timer.dueAt) - nowMs);
}

/**
 * How long is left, for a row that has a handful of columns: `7m`, or `due`
 * once the time is up.
 *
 * A timer that is up and has not fired yet is the daemon's next tick away, and
 * `0m` reads as a timer that has stopped working. `due` says what is true.
 */
export function timerLeftLabel(timer: ThreadTimer, nowMs: number): string {
  const left = timerLeftMs(timer, nowMs);
  return left < 60_000 ? (left === 0 ? "due" : "<1m") : timerLabel(left);
}

/**
 * One line for a reader: what the thread is waiting on, and for how much
 * longer.
 *
 * The note comes last because it is the part that can be long, and every row
 * that paints this line cuts it from the right.
 */
export function timerLine(timer: ThreadTimer, nowMs: number): string {
  const left = timerLeftLabel(timer, nowMs);
  const head = left === "due" ? "timer due" : `on a timer · ${left} left`;
  return timer.note ? `${head} · ${timer.note}` : head;
}
