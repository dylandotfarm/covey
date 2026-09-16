/**
 * `esc` `esc` in the composer — the chord that opens the rewind picker.
 *
 * `esc` has four earlier jobs and this one comes last. The three above the
 * composer are already done by the time this runs: an overlay closes itself
 * (`App.tsx` → `handleOverlayKey`), the diff pane closes itself, and the `/`
 * prefix menu closes itself. The fourth is here: a running turn is interrupted.
 * Only a press that finds nothing to close and nothing to stop can be half of
 * a chord.
 */
export type RewindAction = "interrupt" | "arm" | "open" | "none";

export interface RewindContext {
  /** The thread on screen has a turn in flight. */
  running: boolean;
  /** An approval or a question waits for an answer. */
  pending: boolean;
  /** The time since `esc` last interrupted a turn, in milliseconds. */
  sinceInterruptMs: number;
  /** The time since `esc` last armed the chord, in milliseconds. */
  sinceArmMs: number;
}

/**
 * The window between the two presses of the chord. Long enough for a
 * deliberate two-press chord, an ssh link included, and short enough that two
 * unrelated presses of `esc` do not become one.
 */
export const REWIND_CHORD_MS = 800;

/**
 * How long an interrupt keeps `esc` away from the chord.
 *
 * This is the trap the chord has to miss. A person who presses `esc` a second
 * time to be sure a turn stopped must not be offered a rewind for it. Three
 * seconds covers the person who hits the key several times to be sure, and it
 * covers the daemon: `turn.revert` refuses while the thread is busy, and the
 * thread state needs a moment to settle after an interrupt. The cost is that a
 * rewind directly after an interrupt waits three seconds. That is the safe
 * side of the trade.
 */
export const INTERRUPT_SETTLE_MS = 3000;

export function rewindAction(ctx: RewindContext): RewindAction {
  // One press keeps the meaning it has today. People rely on it.
  if (ctx.running) return "interrupt";
  // An approval or a question is on screen. `esc` must not start something
  // that discards the turn the question belongs to.
  if (ctx.pending) return "none";
  if (ctx.sinceInterruptMs < INTERRUPT_SETTLE_MS) return "none";
  if (ctx.sinceArmMs < REWIND_CHORD_MS) return "open";
  return "arm";
}
