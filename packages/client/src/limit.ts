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
 * When the limit resets, on the clock of the device the reader is holding:
 * `10:50pm`, `tomorrow 12:10am`, `Nov 21, 9am`. Null when covey read no reset
 * and backed off instead, because a guess is not a clock time.
 *
 * Claude Code writes the reset in the zone of the machine it runs on and names
 * that zone after it — `resets 3:50am (UTC)` from a daemon on a server — and
 * the reader is very often somewhere else, with a phone in one hand. A clock
 * the reader has to translate is a clock they do not read, so covey keeps the
 * reset as an instant (`ThreadUsageLimit.resetsAt`) and every client paints it
 * in its own zone. No zone is named here for exactly that reason: it is the
 * reader's own, and naming it would put the sum back.
 *
 * The day comes with it once the reset is not today, because a weekly window
 * resets days away and `9am` alone reads as this morning.
 *
 * @param zone the reader's zone, for a test; the device's own by default.
 */
export function limitResetLabel(limit: ThreadUsageLimit, nowMs: number, zone?: string): string | null {
  if (!limit.resetsAt) return null;
  const at = Date.parse(limit.resetsAt);
  if (!Number.isFinite(at)) return null;
  const days = daysApart(nowMs, at, zone);
  const clock = clockLabel(at, zone);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${dateLabel(at, zone)}, ${clock}`;
}

/** `10:50pm`, `9am` — the hour as that zone's clock reads it. */
function clockLabel(ms: number, zone?: string): string {
  const text = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(ms);
  // The formatter puts a space before `AM` and some platforms make it a narrow
  // no-break one, which `\s` covers.
  return text.replace(/\s+/gu, "").toLowerCase().replace(/:00(?=[ap]m$)/u, "");
}

/** `Nov 21` — the day, for a reset that is not today or tomorrow. */
function dateLabel(ms: number, zone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(ms);
}

/**
 * How many days apart two instants are *on that zone's calendar*, which is the
 * question `tomorrow` asks and is not the same as a count of 24-hour spans: a
 * reset eight hours away is tomorrow at 10pm and today at 2pm.
 */
function daysApart(fromMs: number, toMs: number, zone?: string): number {
  const day = (ms: number): number => {
    // `en-CA` writes `2026-11-18`, which is the one locale shape that parses
    // back without a second formatter.
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(ms).split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((day(toMs) - day(fromMs)) / 86_400_000);
}

/**
 * One line for a reader: which limit stopped the thread, when it resets, and
 * when covey tries the work again.
 *
 * The reset is a clock and the retry is a wait, because the two answer
 * different questions and each is wrong on its own: a clock alone is a figure
 * the reader has to subtract, and a wait alone is wrong the moment the row is
 * read again. The clock is the reader's own (`limitResetLabel`), never the
 * daemon's, and covey says none at all for a wait it guessed.
 */
export function limitLine(limit: ThreadUsageLimit, nowMs: number, zone?: string): string {
  const left = limitLeftLabel(limit, nowMs);
  const head = limitLabel(limit.message);
  if (left === "due") return `${head} · covey retries now`;
  const at = limitResetLabel(limit, nowMs, zone);
  return at ? `${head} · resets ${at} · covey retries in ${left}` : `${head} · covey retries in ${left}`;
}
