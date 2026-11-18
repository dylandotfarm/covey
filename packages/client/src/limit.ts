/**
 * The words of a thread's usage limit: what it is, and how long until covey
 * tries the work again.
 *
 * Three callers share this file, and that is the whole reason it exists, as it
 * is for `timerLine` beside it. The TUI paints the line in the sidebar and in
 * the composer's status row, the page paints it under a thread's title, and
 * the app paints it in the list. A reader who keeps covey open on a laptop and
 * a phone must not meet two different sentences about one wait.
 *
 * Pure and node-tested, like `timelineRows` and for the same reason: every
 * caller sits behind a socket, a terminal or a phone.
 */
import type { ThreadUsageLimit } from "@covey/protocol";
import { timerLabel } from "./timer.js";

/**
 * How long a wait is, in the fewest words that say it: `15m`, `7h 50m`,
 * `2d 4h`.
 *
 * `timerLabel` stops at hours, because a timer stops at six of them. A usage
 * limit does not — a weekly window resets days away — and `164h` is a number a
 * reader has to do arithmetic on.
 */
export function limitSpanLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 24 * 60) return timerLabel(ms);
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.round((minutes % (24 * 60)) / 60);
  // A rounded remainder of 24 hours is a day covey would print as `2d 24h`.
  if (h === 24) return `${d + 1}d`;
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/** How long until covey sends the work again, in milliseconds, never below zero. */
export function limitLeftMs(limit: ThreadUsageLimit, nowMs: number): number {
  return Math.max(0, Date.parse(limit.dueAt) - nowMs);
}

/**
 * How long is left, for a row that has a handful of columns: `7h`, or `due`
 * once the time is up.
 *
 * `due` and never `0m`, which is `timerLeftLabel`'s rule and for its reason: a
 * wait that is up is the daemon's next tick away, and a zero reads as a wait
 * that has stopped working.
 */
export function limitLeftLabel(limit: ThreadUsageLimit, nowMs: number): string {
  const left = limitLeftMs(limit, nowMs);
  return left < 60_000 ? (left === 0 ? "due" : "<1m") : limitSpanLabel(left);
}

/**
 * Which limit it was, in as few words as the message gives: `session limit`,
 * `weekly limit`.
 *
 * Claude Code writes `You've hit your session limit · resets 12:10am (UTC)`,
 * and the part a reader needs is the two words in the middle. The rest of the
 * sentence is the time, which the line says for itself in a form the reader
 * can act on. A message covey cannot cut down keeps its own first clause, up
 * to a width a sidebar row can hold; one that is empty reads as `usage limit`,
 * which is what every one of these is.
 */
export function limitLabel(message: string): string {
  const first = (message ?? "").split("·")[0]!.trim();
  const own = first.replace(/^you(?:'|’)ve hit your\s+/i, "").replace(/^you(?:'|’)(?:ve|re)\s+/i, "").trim();
  if (!own) return "usage limit";
  return own.length > 40 ? `${own.slice(0, 39).trimEnd()}…` : own;
}

/**
 * One line for a reader: which limit stopped the thread, and when covey tries
 * the work again.
 *
 * It says the wait and never the reset time, whether covey read one or guessed
 * one. "retries in 7h" is the fact the reader acts on — whether to wait or to
 * go and do the work elsewhere — and it needs no timezone beside it.
 */
export function limitLine(limit: ThreadUsageLimit, nowMs: number): string {
  const left = limitLeftLabel(limit, nowMs);
  const head = limitLabel(limit.message);
  return left === "due" ? `${head} · covey retries now` : `${head} · covey retries in ${left}`;
}
