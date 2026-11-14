/**
 * The turn a timer sends, and the one sentence a note needs.
 *
 * Pure, like `integrate/news.ts` and for the same reason: what covey says to
 * an agent is the whole of this feature, and a test must be able to read it
 * without a clock, a database or a session.
 *
 * The turn has one job. An agent set a timer because it started work it could
 * not watch — a build, a deploy, a test run on another machine — and stopped
 * its turn. What it needs on the way back is what it was waiting for, how long
 * it has been, and the two moves open to it: the work is done, or it is not
 * and the timer goes again. The last of those is the one covey has to spell
 * out: a timer fires **once**, so an agent that reads this, finds the work
 * still running and stops the turn without setting another one is a thread
 * nothing will ever wake.
 */
import { timerLabel } from "@covey/client";
import type { ThreadTimer } from "@covey/protocol";

/** The heading every timer turn starts with, as `covey watch:` is the watch's. */
export const TIMER_PREFIX = "covey timer:";

/**
 * What the agent reads when its timer is up.
 *
 * `round` is named from the second timer on. Covey bounds nothing by it — a
 * four-hour build is a four-hour build — but an agent that has waited eleven
 * times in a row for a thing that was never going to finish cannot see that it
 * has, and the count is the one fact that tells it.
 */
export function timerTurn(timer: ThreadTimer, nowMs: number): string {
  const waited = timerLabel(Math.max(0, nowMs - Date.parse(timer.setAt)));
  const asked = timerLabel(timer.lengthMs);
  // The length asked for and the length waited are usually the same, and
  // saying both would read as a correction. They differ when the daemon was
  // off or busy, and then the second one is the fact that matters.
  const length = waited === asked ? asked : `${asked} (${waited} has passed)`;
  const lines = [
    `${TIMER_PREFIX} the ${length} timer you set on this thread is up.`,
    "",
    timer.note
      ? `You set it to come back to this: ${timer.note}`
      : "You set it with no note, so look back at what you were waiting for.",
    "",
    "Check that work now, and then do one of two things.",
    "",
    "- **It has finished.** Go on with it. Say what you found. Nothing has to be cleared: the timer has already fired.",
    `- **It is still running.** Set another timer — \`covey timer ${timerCommandArg(timer.lengthMs)}\` — and stop the turn. A timer fires once, so a turn that ends without one is a thread nothing will wake again.`,
    "",
    "Do not poll in a loop and do not sleep inside this turn. The timer is how covey waits for you.",
  ];
  if (timer.round > 1) {
    lines.push(
      "",
      `This is timer ${timer.round} in a row on this thread. If the work has not moved over those ${timer.round}, tell the reader rather than setting another one: work that never finishes is a person's to look at.`,
    );
  }
  return lines.join("\n");
}

/**
 * The same length as an argument the agent can paste back: `10m`, `90s`,
 * `1h30m`. `timerLabel` puts a space in the compound form, which reads well in
 * a row and is two arguments in a shell.
 */
export function timerCommandArg(ms: number): string {
  return timerLabel(ms).replace(/\s+/g, "");
}

/**
 * The longest a note may be.
 *
 * It is one line beside a thread's title on three screens, and it rides on
 * every snapshot of the thread. A paragraph pasted in here would push the time
 * left off a phone's row, which is the one part of the line a reader cannot
 * work out for themselves.
 */
export const MAX_TIMER_NOTE = 200;

/** The note as covey keeps it: one line, trimmed, bounded, or nothing. */
export function timerNoteText(text: string | null | undefined): string | null {
  const one = (text ?? "").replace(/\s+/gu, " ").trim();
  return one ? one.slice(0, MAX_TIMER_NOTE) : null;
}

/** The note on the row when a timer is set, or cleared. */
export function timerNote(timer: ThreadTimer | null): string {
  if (!timer) return "Timer cleared. Nothing will wake this thread until somebody writes to it.";
  const when = new Date(Date.parse(timer.dueAt)).toISOString().slice(11, 16);
  const why = timer.note ? `: ${timer.note}` : "";
  return `Timer set for ${timerLabel(timer.lengthMs)}, due at ${when} UTC${why}. Covey wakes this thread with a turn then.`;
}
