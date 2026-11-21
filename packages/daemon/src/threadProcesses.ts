/**
 * The processes a thread left running, and how covey stops them.
 *
 * An agent starts a server, a watcher or a build, and the work outlives the
 * turn that started it: a background task, a `nohup … &`, a `setsid`. When the
 * reader archives the thread, that work has nobody left to read it, and a dev
 * server holds its port for ever. So the archive stops it, and says so twice:
 * once in the transcript for the reader, and once at the head of the next turn
 * for the agent, which otherwise expects a server that is no longer there.
 *
 * A process belongs to a thread when its environment carries the two names
 * below. The daemon puts `COVEY_THREAD_ID` in the environment of the Claude
 * session, and every process the session starts inherits it, also one that
 * left the process tree. `CLAUDECODE=1` is what Claude Code sets for a tool
 * call and not for itself, so the session process is never on the list: the
 * engine stops that one with the session. The reader's own shell (`terminal.ts`)
 * deletes the thread id, so nothing a person started is on the list either.
 *
 * Linux only: the list is read from `/proc`. On another platform the list is
 * empty and the archive stops nothing more than it did before.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ThreadProcess {
  pid: number;
  ppid: number;
  /** The command line, with the arguments joined by spaces. */
  command: string;
}

/** How long a process has to end after `SIGTERM` before it gets `SIGKILL`. */
export const STOP_GRACE_MS = 3000;
/** The most commands a note names; the rest are a count. */
const MAX_NAMED = 8;
/** The most characters of one command a note shows. */
const MAX_COMMAND = 120;

/** Read one `/proc/<pid>` entry, or null when it went away or is not ours. */
function readProcess(root: string, pid: number): { ppid: number; env: string[]; command: string } | null {
  try {
    const env = readFileSync(join(root, String(pid), "environ"), "utf8").split("\0");
    const command = readFileSync(join(root, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
    // The second field is the name in parentheses, and a name may hold both a
    // space and a parenthesis, so the fields after it are read from the last ")".
    const stat = readFileSync(join(root, String(pid), "stat"), "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return { ppid, env, command };
  } catch {
    return null;
  }
}

/** This process and every process above it, which covey never signals. */
function ancestors(root: string, self: number): Set<number> {
  const out = new Set<number>();
  for (let pid = self; pid > 1 && !out.has(pid); ) {
    out.add(pid);
    try {
      const stat = readFileSync(join(root, String(pid), "stat"), "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return out;
}

/** Every process that a tool call of this thread started and that still runs. */
export function findThreadProcesses(threadId: string, opts: { procRoot?: string; self?: number } = {}): ThreadProcess[] {
  const root = opts.procRoot ?? "/proc";
  if (!opts.procRoot && process.platform !== "linux") return [];
  if (!existsSync(root)) return [];
  const mark = `COVEY_THREAD_ID=${threadId}`;
  const keep = ancestors(root, opts.self ?? process.pid);
  const out: ThreadProcess[] = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (keep.has(pid)) continue;
    const p = readProcess(root, pid);
    if (!p || !p.env.includes(mark) || !p.env.includes("CLAUDECODE=1")) continue;
    out.push({ pid, ppid: p.ppid, command: p.command });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/**
 * The command a reader recognises. Claude Code runs a tool call as
 * `bash -c "source <snapshot> … && eval '<command>' && pwd -P >| <file>"`, and
 * only the part inside `eval` is what the agent wrote.
 */
export function commandLabel(command: string): string {
  const m = /&& eval '((?:[^']|'"'"')*)'(?: < \/dev\/null)? && pwd -P/.exec(command);
  const text = (m?.[1] !== undefined ? m[1].replaceAll(`'"'"'`, "'") : command).replace(/\s+/g, " ").trim();
  return text.length > MAX_COMMAND ? `${text.slice(0, MAX_COMMAND - 1)}…` : text;
}

/**
 * One line per piece of work, not one per process. A process whose parent is
 * also on the list is part of that parent's work — `npm run dev` and the
 * `vite` it starts are one server to the reader.
 */
export function processLabels(ps: ThreadProcess[]): string[] {
  const pids = new Set(ps.map((p) => p.pid));
  const labels = ps.filter((p) => !pids.has(p.ppid)).map((p) => commandLabel(p.command)).filter(Boolean);
  return [...new Set(labels)];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Send `SIGTERM` to each process, and `SIGKILL` to each one still there after
 * the grace period. A process that ended on its own in the meantime is not an
 * error: it is the result this asks for.
 */
export async function stopProcesses(ps: ThreadProcess[], graceMs = STOP_GRACE_MS): Promise<void> {
  for (const p of ps) { try { process.kill(p.pid, "SIGTERM"); } catch { /* already gone */ } }
  const end = Date.now() + graceMs;
  let left = ps.filter((p) => alive(p.pid));
  while (left.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter((p) => alive(p.pid));
  }
  for (const p of left) { try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ } }
}

function named(labels: string[]): string {
  const shown = labels.slice(0, MAX_NAMED).map((l) => `\`${l}\``).join(", ");
  return labels.length > MAX_NAMED ? `${shown}, and ${labels.length - MAX_NAMED} more` : shown;
}

/** The transcript note, for the reader. */
export function stoppedNote(labels: string[]): string {
  return `Archived · stopped ${labels.length === 1 ? "a process" : `${labels.length} processes`} that this thread started: ${named(labels)}`;
}

/**
 * What the agent reads at the head of the first turn after the archive. The
 * model never sees a note, so this is the only way it learns that a server it
 * started is gone — and the reader's next message may need it, or may not.
 */
export function stoppedPreface(labels: string[]): string {
  return [
    "covey: this thread was archived, and covey stopped the processes that it had running then:",
    ...labels.slice(0, MAX_NAMED).map((l) => `- ${l}`),
    ...(labels.length > MAX_NAMED ? [`- and ${labels.length - MAX_NAMED} more`] : []),
    "They do not run now. If the message below needs one of them, start it again. If it does not, do not start them.",
  ].join("\n");
}
