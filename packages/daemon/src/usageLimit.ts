/**
 * The usage limit a turn can die on, and what covey does about it.
 *
 * An account on a plan has a window of usage. A turn that reaches the end of
 * one stops where it stands, and Claude Code says so in a sentence of its own:
 * `You've hit your session limit · resets 12:10am (UTC)`. Nothing about that
 * is a fault of the work, and the one thing that mends it is time.
 *
 * Until this, that was a thread with an error on its row and a reader who had
 * to come back hours later and type the message again — on every thread that
 * had been running, because one account is one limit and a machine of ten busy
 * threads meets it ten times in a minute. So covey holds the work instead,
 * waits for the reset, and sends the turn again. It is the timer's rule
 * (`timer.ts`) with the clock read off the refusal rather than named by an
 * agent.
 *
 * Pure, like `integrate/news.ts` and for the same reason: every decision here
 * has to be readable without a clock, a database or a session.
 */
import { limitSpanLabel } from "@covey/client";
import type { ThreadUsageLimit } from "@covey/protocol";

/**
 * The messages that mean the account ran out of its plan's usage, rather than
 * that the work went wrong.
 *
 * A copy of `USAGE_LIMIT_ERROR_PREFIXES` from the Agent SDK (0.3.280), which
 * is the SDK's own list of what `getLimitReachedText` can write. It is copied
 * and not imported for `KNOWN_MODELS`' reason: `sdk.ts` is the one place that
 * loads the SDK, because the Claude Code a machine runs is the reader's to
 * choose, and a static import here would load the lockfile's copy whatever
 * they chose. A prefix the SDK adds later reads as "not a usage limit", which
 * is the thread stopping with an error on its row — what covey did before this
 * existed, and never something worse.
 *
 * `This service is disabled for your org` is deliberately not here. The SDK
 * keeps it apart as well (`ORG_POLICY_LIMIT_PREFIXES`): it is a policy and not
 * an exhausted window, so no amount of waiting clears it.
 */
const USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
];

/**
 * Did this turn die on a usage limit rather than on the work?
 *
 * The daemon reads only the CLI's own error text with this, never a tool's
 * output — `isAuthFailure` keeps the same rule beside it, and for the same
 * reason: an agent that *printed* one of these sentences must not put its own
 * thread to sleep for five hours.
 *
 * The sentence is Claude Code's whole answer, so it usually stands at the
 * front of the text. It is taken at the start of a line too, and after a
 * `… error: ` that wraps it, because the CLI reports the same refusal that way
 * when it reaches covey through a failure rather than through a reply.
 */
export function isUsageLimit(text: string | null | undefined): boolean {
  const s = (text ?? "").trim();
  if (!s) return false;
  return USAGE_LIMIT_PREFIXES.some((prefix) => {
    for (let at = s.indexOf(prefix); at >= 0; at = s.indexOf(prefix, at + 1)) {
      if (at === 0) return true;
      const before = s.slice(0, at);
      if (before.endsWith("\n") || before.endsWith(": ")) return true;
    }
    return false;
  });
}

/** The short month names Claude Code writes, in `en-US`. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the limit resets, read out of the message, or null when covey cannot
 * read one.
 *
 * Claude Code writes the time in its own local zone and names that zone after
 * it: `· resets 12:10am (UTC)`, `· resets Nov 17, 2:20am (America/New_York)`.
 * The zone is the IANA name, so covey can check it against its own — the
 * session is a subprocess of the daemon and inherits its `TZ`, so the two
 * agree unless something has gone out of its way to make them differ. They
 * must agree, because the hour below is read as a local one: a time covey read
 * in the wrong zone is a thread that wakes hours early and spends a round on
 * a limit that is still refusing it. A zone covey cannot match is no answer at
 * all, which the caller backs off from instead.
 *
 * Two shapes, which are the two the formatter writes. Under a day it is a time
 * alone (`12:10am`, or `5am` on the hour), and the answer is the next time
 * that clock reads so. Over a day it carries the date as well (`Nov 17,
 * 2:20am`), and a year when the year differs.
 *
 * @param nowMs the moment to read a bare time against.
 * @param zone  the reader's zone, for a test; the daemon's own by default.
 */
export function limitResetAt(
  message: string | null | undefined,
  nowMs: number,
  zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): number | null {
  const m = /\bresets\s+([^()]+?)\s*\(([^()]+)\)/i.exec(message ?? "");
  if (!m) return null;
  if (m[2]!.trim() !== zone) return null;
  const when = m[1]!.trim();
  // `Nov 17, 2:20am`, `Jan 15, 2027, 12:20am`, `Nov 17, 5am`.
  const dated = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?,\s*(.+)$/i.exec(when);
  const clock = hourAndMinute(dated ? dated[4]! : when);
  if (!clock) return null;
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    if (month < 0) return null;
    const day = Number(dated[2]);
    // No year written means this year — which is what the formatter means by
    // leaving it out, and it writes one the moment that is not true.
    const year = dated[3] ? Number(dated[3]) : new Date(nowMs).getFullYear();
    const at = new Date(year, month, day, clock.hour, clock.minute, 0, 0).getTime();
    return Number.isFinite(at) ? at : null;
  }
  // A bare time is the next moment the clock reads so. The reset is always
  // ahead of the message, and the message is seconds old, so a few minutes of
  // slack keeps a reset that has just come round from being read as one a
  // whole day away.
  const from = new Date(nowMs - 5 * 60_000);
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate(), clock.hour, clock.minute, 0, 0);
  if (today.getTime() >= from.getTime()) return today.getTime();
  // The day after, built as a date and never as a day of milliseconds: a zone
  // that puts its clocks back has one day of 25 hours in it.
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, clock.hour, clock.minute, 0, 0).getTime();
}

/** `12:10am`, `5am`, `12pm` as an hour of the day and a minute, or null. */
function hourAndMinute(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i.exec(text.replace(/\s+/gu, " ").trim());
  if (!m) return null;
  const twelve = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (twelve < 1 || twelve > 12 || minute > 59) return null;
  const pm = m[3]!.toLowerCase() === "p";
  return { hour: (twelve % 12) + (pm ? 12 : 0), minute };
}

/**
 * How long covey waits past the reset before it sends the work again.
 *
 * The reset is a minute of a clock covey does not own, and a request made on
 * the second it turns is a request the server may still refuse. A minute here
 * costs a reader a minute; getting it wrong costs them a whole round.
 */
export const USAGE_LIMIT_GRACE_MS = 60_000;

/**
 * The furthest ahead covey believes a reset it read.
 *
 * The longest window a plan has is a week, so eight days is a reset plus a
 * margin. Further than that and something has been misread — a date in another
 * year, a clock out by a month — and backing off is the honest answer, because
 * a thread asleep until March is one nobody will ever come back to.
 */
export const USAGE_LIMIT_MAX_WAIT_MS = 8 * 86_400_000;

/**
 * How long covey waits when it could not read a reset at all, by round.
 *
 * Every one of these is a session started and refused, so the early ones are
 * short enough to catch a window that was nearly over and the rest are long
 * enough that an hour of waiting costs one try. The list covers about three
 * hours, which is most of a five-hour window.
 */
export const USAGE_LIMIT_BACKOFF_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000];

/**
 * How many waits in a row covey gives one thread.
 *
 * A limit that is still refusing work after this many is not one more wait
 * away from clearing — an account out of credits refuses every wait there is —
 * and a thread that tried for ever would be a thread nobody was ever told
 * about. The round that passes this writes a warning and stops, which is the
 * one moment the row goes back to needing a person.
 */
export const USAGE_LIMIT_MAX_ROUNDS = 6;

/** When covey tries the work again, and what it read to decide. */
export interface UsageLimitPlan {
  dueAt: number;
  /** The reset covey read, or null when it backed off instead. */
  resetsAt: number | null;
}

/**
 * When to send the work again, or null to stop and tell the reader.
 *
 * The reset read out of the message comes first, and `known` stands behind it:
 * one account is one limit, so a reset another thread on this machine read a
 * moment ago is this thread's reset too, and it beats a guess. A reset already
 * past is a message covey read wrong, or a window that turned while the daemon
 * was off, so it falls to the backoff rather than firing at once.
 */
export function planUsageLimit(opts: { message: string; nowMs: number; round: number; known?: number | null }): UsageLimitPlan | null {
  const { message, nowMs, round } = opts;
  if (round > USAGE_LIMIT_MAX_ROUNDS) return null;
  const read = limitResetAt(message, nowMs) ?? opts.known ?? null;
  if (read !== null && read > nowMs && read - nowMs <= USAGE_LIMIT_MAX_WAIT_MS) {
    return { dueAt: read + USAGE_LIMIT_GRACE_MS, resetsAt: read };
  }
  const back = USAGE_LIMIT_BACKOFF_MS[Math.min(round, USAGE_LIMIT_BACKOFF_MS.length) - 1]!;
  return { dueAt: nowMs + back, resetsAt: null };
}

/**
 * What the reader finds in the transcript where the turn stopped.
 *
 * It says three things in order, because that is the order a reader asks
 * them: which limit stopped the work, that covey is holding the work rather
 * than dropping it, and when the work goes again. The last sentence is the
 * point of the whole feature — a reader who does not read it should still be
 * able to walk away.
 *
 * The reset is named as a clock time *and* as a wait. A clock alone is a
 * number to compare against a timezone; a wait alone is a figure that is wrong
 * the moment the row is read again.
 */
export function usageLimitNote(limit: ThreadUsageLimit, nowMs: number): string {
  const left = limitSpanLabel(Math.max(0, Date.parse(limit.dueAt) - nowMs));
  const when = limit.resetsAt
    ? `The limit resets at ${new Date(Date.parse(limit.resetsAt)).toISOString().slice(11, 16)} UTC, so covey sends this turn again in ${left}.`
    : `Covey could not read when the limit resets, so it tries this turn again in ${left}.`;
  const chain = limit.round > 1 ? ` This is wait ${limit.round} in a row on this thread.` : "";
  return `${limit.message} Covey holds this turn rather than stopping here. ${when}${chain} Nothing is needed from you.`;
}
