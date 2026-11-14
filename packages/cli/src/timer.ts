/**
 * `covey timer`: the turn an agent asks for later.
 *
 * An agent starts work it cannot watch. A build runs for twenty minutes, a
 * deploy settles, a test suite runs on another machine. The turn has to end,
 * because holding it open is a session held open and a reader left looking at
 * a spinner. So the agent asks covey to wake it: one time, one line saying
 * what it waits for, and a turn when the time is up.
 *
 * Every other way of arranging that was a guess. A watcher put on a process
 * that turned out to be the wrong one. A poll inside the turn, which is the
 * turn spent. A background task whose end is the task's end and not the work's.
 * This is the covey watch's own rule — the daemon holds the record and sends a
 * turn — with a clock in place of a pull request.
 *
 * The daemon does the waiting. This file only asks, so `parseTimerArgs` is
 * pure and a test can prove what each spelling asks for without a daemon.
 */
import { PROTOCOL_VERSION, type Thread } from "@covey/protocol";
import { parseTimer, timerLabel, timerLeftLabel } from "@covey/client";
import { LOOP_CLIENT, openRpc, type LoopEnv, type LoopOutcome, type Rpc } from "./loop.js";

/** What one `covey timer …` asks for. */
export type TimerRequest =
  /** Wake this thread in `ms`. `note` is one line for the reader. */
  | { kind: "set"; ms: number; note: string | null }
  | { kind: "stop" }
  | { kind: "status" };

export const TIMER_USAGE = `  covey timer <time> [--note "…"]
                             wake this thread with a turn when <time> is up, and stop the
                             turn now. For work you cannot watch: a build, a deploy, a test
                             run on another machine. <time> is 10m, 90s, 2h, 1h30m, or a bare
                             number of minutes; one minute at the shortest and 6h at the
                             longest. --note says what you are waiting for, in one line, so
                             the reader knows why the thread is asleep.
                             A timer fires once: if the work is still running when it does,
                             set another one
  covey timer                what this thread's timer says, and how long is left
  covey timer stop           clear it. Nothing will wake the thread until somebody writes`;

/**
 * Read `covey timer …`. An error is a sentence for the shell, never a throw:
 * the caller prints it and exits 2.
 */
export function parseTimerArgs(argv: string[]): { request: TimerRequest } | { error: string } {
  // argv is the whole command line: `timer`, then the rest.
  const rest = argv.slice(1);
  const flags = new Set(["--note", "--thread", "--port"]);
  const words = rest.filter((a, i) => !a.startsWith("--") && !flags.has(rest[i - 1] ?? ""));
  const noteAt = rest.indexOf("--note");
  const note = noteAt >= 0 ? (rest[noteAt + 1] ?? "") : null;
  if (noteAt >= 0 && (!note || note.startsWith("--"))) {
    return { error: "--note needs one line saying what you are waiting for, for example --note \"the CI run on main\"" };
  }
  const first = words[0];
  if (first === undefined) return { request: { kind: "status" } };
  if (first === "stop" || first === "clear") {
    return words.length > 1 ? { error: `covey timer stop takes nothing after it, not ${words[1]}` } : { request: { kind: "stop" } };
  }
  if (first === "status") {
    return words.length > 1 ? { error: `covey timer status takes nothing after it, not ${words[1]}` } : { request: { kind: "status" } };
  }
  // `covey timer 1h 30m` is one time in two words, because a shell splits on
  // the space and an agent writes it that way. Joined with the space it was
  // written with, so a spelling `parseTimer` refuses is quoted back as the
  // agent typed it.
  const ms = parseTimer(words.join(" "));
  if (typeof ms !== "number") return ms;
  return { request: { kind: "set", ms, note } };
}

/**
 * Ask the local daemon. Every failure is a sentence, so the agent reads why in
 * its tool output and nothing in its transcript is a stack.
 */
export async function runTimer(request: TimerRequest, env: LoopEnv, connect: (url: string) => Promise<Rpc> = openRpc): Promise<LoopOutcome> {
  if (!env.threadId) return { ok: false, lines: ["this command speaks for a covey thread: run it inside one (COVEY_THREAD_ID is set there), or pass --thread <id>"] };
  const threadId = env.threadId;
  let rpc: Rpc;
  try {
    rpc = await connect(`ws://127.0.0.1:${env.port}`);
  } catch (e: any) {
    return { ok: false, lines: [`no covey daemon answers on port ${env.port}: ${e?.message ?? e}`] };
  }
  try {
    await rpc.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT, threadId });
    const read = async (): Promise<Thread> => ((await rpc.call("thread.snapshot", { threadId, limit: 1 })) as { thread: Thread }).thread;
    switch (request.kind) {
      case "status":
        return { ok: true, lines: describeTimer(await read(), Date.now()) };
      case "stop":
        await rpc.call("command", { commandId: crypto.randomUUID(), threadId, type: "thread.timer", ms: null });
        return { ok: true, lines: ["the timer is cleared. Nothing will wake this thread until somebody writes to it"] };
      case "set": {
        await rpc.call("command", {
          commandId: crypto.randomUUID(), threadId, type: "thread.timer",
          ms: request.ms, ...(request.note ? { note: request.note } : {}),
        });
        // The last line is the one that matters, and it is an instruction: a
        // timer is for ending the turn, and an agent that set one and then went
        // on polling has paid for the feature and used none of it.
        return { ok: true, lines: [
          `covey wakes this thread with a turn in ${timerLabel(request.ms)}${request.note ? `, to come back to: ${request.note}` : ""}`,
          "the turn will say the timer is up. A timer fires once, so set another one if the work is still running then",
          "stop the turn now. Say what you started and that you are waiting on the timer; do not poll and do not sleep",
        ] };
      }
    }
  } catch (e: any) {
    return { ok: false, lines: [String(e?.message ?? e)] };
  } finally {
    rpc.close();
  }
}

/**
 * This thread's timer, in lines the agent can read. Pure.
 *
 * A timer that has already fired is still named. The agent reading this is
 * very often the one the timer woke, and "no timer" would read as covey having
 * lost the thing that woke it.
 */
export function describeTimer(t: Thread, nowMs: number): string[] {
  const timer = t.timer;
  if (!timer) {
    return [
      "no timer: nothing will wake this thread until somebody writes to it.",
      "Set one with `covey timer 10m --note \"what you are waiting for\"` when you start work you cannot watch.",
    ];
  }
  if (timer.firedAt) {
    const ago = timerLabel(Math.max(0, nowMs - Date.parse(timer.firedAt)));
    return [
      `the ${timerLabel(timer.lengthMs)} timer fired ${ago} ago, and no timer is running now.`,
      ...(timer.note ? [`it was set for: ${timer.note}`] : []),
      "Set another one if the work you were waiting for is still running.",
    ];
  }
  return [
    `a timer is running: ${timerLeftLabel(timer, nowMs)} left of ${timerLabel(timer.lengthMs)}, due at ${timer.dueAt}.`,
    ...(timer.note ? [`waiting for: ${timer.note}`] : []),
    ...(timer.round > 1 ? [`this is timer ${timer.round} in a row on this thread.`] : []),
    "Stop the turn: covey sends a turn when it is up.",
  ];
}
