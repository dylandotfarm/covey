import type { SessionBudget } from "@covey/protocol";

/**
 * What a machine spends on live Claude sessions, said in a way a reader can act
 * on.
 *
 * A thread's session is a subprocess of about 300 MB, so `maxLiveSessions` and
 * `sessionIdleMinutes` are the memory dial of a covey machine. The ceiling is
 * the one that bounds the memory: the daemon releases the least recently used
 * session that is not busy as soon as the machine holds more than the ceiling
 * allows. The idle limit gives memory back *under* that ceiling, and it charges
 * for it — a session covey resumes cannot refresh its own token, so it has a
 * deadline a fresh one does not. The hints below say so, because that is the
 * one thing a reader who shortens the idle limit does not already know.
 *
 * `null` in either setting means "the daemon's own default", and no client can
 * work out what that is: the ceiling's default is read from the machine's
 * memory. So the numbers come from `MachineInfo.sessionBudget`, which the
 * daemon fills in and re-sends with every `machine.updated`. A daemon built
 * before that field says nothing, and the labels then read "default" with no
 * number rather than a guess.
 *
 * Pure, and both clients read it: the TUI's machine control panel and the web
 * client's machine sheet offer one list, so the same setting has the same words
 * on a phone and in a terminal.
 */

/**
 * One choice of a session-limit picker. `id` is the number to send, as a
 * string, and `""` clears the setting back to the daemon's default. `hint`
 * stays a description of the choice even when the choice is the one in force;
 * each client writes "current" its own way.
 */
export interface BudgetChoice {
  id: string;
  label: string;
  hint: string;
  current: boolean;
}

/** The idle limits covey offers, in minutes. `0` keeps every session. */
export const IDLE_CHOICES = [15, 30, 60, 120, 240, 480] as const;

/** The live-session ceilings covey offers. */
export const LIVE_CHOICES = [1, 2, 3, 4, 6, 8, 12] as const;

/** Bytes as one decimal of a gigabyte: `1.2 GB`. */
function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1e9) * 10) / 10} GB`;
}

/** What `n` live sessions cost on a machine, or `""` when the cost is unknown. */
export function sessionMemoryLabel(n: number, budget?: SessionBudget): string {
  return budget && n > 0 ? `about ${gigabytes(n * budget.sessionMemoryBytes)}` : "";
}

/** `never`, `30 minutes`, `2 hours`. A whole number of hours reads as hours. */
export function idleLabel(minutes: number): string {
  if (minutes <= 0) return "never";
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = minutes / 60;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/**
 * What the idle-limit row says now. A setting of its own reads as itself; no
 * setting names the daemon's default and, when the daemon said what that
 * resolves to, the value with it — "default (2 hours)" answers both questions
 * at once, and a reader never has to open the picker to find out.
 */
export function idleValueLabel(setting: number | null | undefined, budget?: SessionBudget): string {
  if (setting !== null && setting !== undefined) return idleLabel(setting);
  return budget ? `default (${idleLabel(budget.idleMinutes)})` : "default";
}

/** What the live-session row says now. Reads like `idleValueLabel`. */
export function liveValueLabel(setting: number | null | undefined, budget?: SessionBudget): string {
  if (setting !== null && setting !== undefined) return `${setting}`;
  return budget ? `from memory (${budget.liveLimit})` : "from memory";
}

/**
 * The idle-limit picker.
 *
 * "Never" comes second, straight after the default, because it is the only
 * choice with another shape: not a longer wait but the absence of one. Its hint
 * names the ceiling that still applies, so nobody reads "never" as "no limit".
 */
export function idleChoices(setting: number | null | undefined, budget?: SessionBudget): BudgetChoice[] {
  const current = setting ?? null;
  return [
    // The number goes in the *label*, not the hint: a client marks the row in
    // force by writing "current" where the hint was, and the reader would then
    // lose the one figure this row exists to tell them.
    { id: "", label: budget ? `Default (${idleLabel(budget.idleMinutes)})` : "Default", hint: "what covey's own limit is", current: current === null },
    { id: "0", label: "Never", hint: "only the live-session limit releases one", current: current === 0 },
    ...IDLE_CHOICES.map((m) => ({
      id: String(m),
      label: idleLabel(m),
      // The price of a release, on the rows short enough for it to bite: a
      // resumed session cannot refresh its token, so a thread let go every
      // quarter of an hour spends the day on tokens it cannot renew. Short,
      // because a client gives the label whatever the hint leaves of the row.
      hint: m <= 30 ? "a resume cannot refresh its token" : "",
      current: current === m,
    })),
  ];
}

/**
 * The live-session picker. Every row carries what it costs, because the count
 * of sessions is not what a reader is choosing — the memory is.
 */
export function liveChoices(setting: number | null | undefined, budget?: SessionBudget): BudgetChoice[] {
  const current = setting ?? null;
  return [
    // The resolved ceiling goes in the label, for the reason `idleChoices`
    // gives: the hint is where a client writes "current".
    {
      id: "",
      label: budget ? `From memory (${budget.liveLimit})` : "From memory",
      hint: "15% of this machine's memory",
      current: current === null,
    },
    ...LIVE_CHOICES.map((n) => ({
      id: String(n),
      label: `${n} session${n === 1 ? "" : "s"}`,
      hint: sessionMemoryLabel(n, budget),
      current: current === n,
    })),
  ];
}

/** The number a choice id stands for: `null` for the daemon's default. */
export function budgetValue(id: string): number | null {
  return id === "" ? null : Number(id);
}
