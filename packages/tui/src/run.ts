import { createHash } from "node:crypto";
import type { MemberResources, Run, RunMember, RunTask, TaskRequirement } from "@covey/protocol";

/**
 * A run, on the client's side: the task list, where each task goes, and what
 * each member is given that nobody else in the run has.
 *
 * The record itself lives in the daemon the operator started the run from,
 * because a run outlives a client restart. Everything in this file is pure: it
 * decides, and the store acts.
 */

// ---------------------------------------------------------------------------
// The task list
// ---------------------------------------------------------------------------

/**
 * A requirement written on a task: `os=darwin`, `arch=arm64`, `needs=tmux`,
 * `machine=pi`. Two tasks of the run of 2026-09-16 could only be done on
 * macOS and one only on the Pi, so these are not decoration.
 */
const REQUIREMENT = /^(os|arch|needs|tool|machine)=([\w.+-]+)$/i;

/** The requirements at the end of a line, and the line without them. */
export function parseRequirements(line: string): { rest: string; requires: TaskRequirement[] } {
  const words = line.trim().split(/\s+/);
  const requires: TaskRequirement[] = [];
  while (words.length > 0) {
    const m = REQUIREMENT.exec(words[words.length - 1]!);
    if (!m) break;
    words.pop();
    const kind = m[1]!.toLowerCase();
    requires.unshift({ kind: kind === "needs" || kind === "tool" ? "tool" : (kind as TaskRequirement["kind"]), value: m[2]! });
  }
  return { rest: words.join(" "), requires };
}

/**
 * The task list, as the operator typed it.
 *
 * One task per line. A line that is only issue numbers is as many tasks as it
 * has numbers, so `44 45 46` and three lines mean the same thing. A GitHub
 * issue is the source worth building for — it is a durable place for the agent
 * to report, and `Closes #N` closes the loop on merge — but a plain line has to
 * work too.
 */
export function parseTaskList(text: string): RunTask[] {
  const tasks: RunTask[] = [];
  // `;` separates tasks as a newline does, because the prompt that asks for
  // the list is one line tall and a run of plain tasks has to fit in it.
  for (const raw of text.split(/[\n;]/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const { rest, requires } = parseRequirements(line);
    if (!rest) continue;
    const numbers = issueNumbers(rest);
    if (numbers) {
      for (const n of numbers) tasks.push({ key: `#${n}`, title: `Issue #${n}`, issue: n, url: null, requires });
    } else {
      tasks.push({ key: `t${tasks.length + 1}`, title: rest, issue: null, url: null, requires });
    }
  }
  return tasks;
}

/** The issue numbers on a line that holds nothing else, else null. */
function issueNumbers(line: string): number[] | null {
  const words = line.split(/[\s,]+/).filter(Boolean);
  const numbers: number[] = [];
  for (const w of words) {
    const m = /^#?(\d{1,7})$/.exec(w);
    if (!m) return null;
    numbers.push(Number(m[1]));
  }
  return numbers.length > 0 ? numbers : null;
}

/** Put the titles `gh` reported onto the tasks that asked for them. */
export function withIssueTitles(tasks: RunTask[], issues: { number: number; title: string; url: string }[]): RunTask[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  return tasks.map((t) => {
    const i = t.issue === null ? undefined : byNumber.get(t.issue);
    return i ? { ...t, title: i.title, url: i.url } : t;
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * The rule, in one line, so the operator can read it before it runs. Placement
 * that cannot be explained is placement nobody will override, and placement
 * that cannot be overridden will be wrong on the first run that matters.
 */
export const PLACEMENT_RULE =
  "Each task goes to the fastest machine that meets its requirements and still has room; when every machine is full, to the one carrying least for its size.";

/** One machine a run may put work on, as placement sees it. */
export interface PlacementMachine {
  /** The client's key for the machine — its `ws://` url. */
  key: string;
  machineId: string;
  name: string;
  os: string;
  arch: string;
  /** Tool names the daemon resolved, e.g. `gh`, `pnpm`, `tmux`. */
  tools: string[];
  cpuCount: number;
  /** How many members it should take at once, as the daemon worked it out. */
  concurrency: number;
  /** Where a member's throwaway `COVEY_HOME` goes on it. */
  tmpDir: string;
  /** The project there that holds the run's repository; null when it has none. */
  projectId: string | null;
}

export interface Placement {
  task: RunTask;
  /** Null when no machine meets the task's requirements. */
  machineId: string | null;
  /** Why this machine, or why none. One short phrase, for the preview. */
  reason: string;
}

/** Whether a machine meets one requirement. */
export function meets(m: PlacementMachine, req: TaskRequirement): boolean {
  switch (req.kind) {
    case "os": return m.os.toLowerCase() === req.value.toLowerCase();
    case "arch": return m.arch.toLowerCase() === req.value.toLowerCase();
    case "tool": return m.tools.includes(req.value);
    case "machine": return m.machineId === req.value || m.name.toLowerCase() === req.value.toLowerCase();
  }
}

/** The requirement a machine fails first, or null when it meets them all. */
export function firstUnmet(m: PlacementMachine, task: RunTask): TaskRequirement | null {
  return task.requires.find((r) => !meets(m, r)) ?? null;
}

function requirementText(r: TaskRequirement): string {
  return r.kind === "tool" ? `needs=${r.value}` : `${r.kind}=${r.value}`;
}

/**
 * Where each task goes, by `PLACEMENT_RULE`.
 *
 * Tasks are placed in the order they were given, so the preview reads in the
 * order the operator wrote, and a task that no machine can take says so rather
 * than landing somewhere that cannot do it.
 */
export function placeTasks(tasks: RunTask[], machines: PlacementMachine[], carrying?: Map<string, number>): Placement[] {
  // Fastest first, by cores; a stable tiebreak on the name so two runs of the
  // same task list place the same way.
  const fastest = [...machines].sort((a, b) => b.cpuCount - a.cpuCount || a.name.localeCompare(b.name));
  // `carrying` is what the machines already hold, so a task added to a run in
  // flight lands where there is room rather than on top of the full machine.
  const load = new Map<string, number>(fastest.map((m) => [m.machineId, carrying?.get(m.machineId) ?? 0]));
  return tasks.map((task) => {
    const eligible = fastest.filter((m) => firstUnmet(m, task) === null);
    if (eligible.length === 0) {
      const why = task.requires.length === 0
        ? "no machine is connected with a checkout of this project"
        : `no machine has ${task.requires.map(requirementText).join(" ")}`;
      return { task, machineId: null, reason: why };
    }
    const withRoom = eligible.find((m) => load.get(m.machineId)! < m.concurrency);
    // Every machine is at its limit: the overflow goes to the one carrying
    // least for its size, so the big machine takes it and the Pi does not.
    const pick = withRoom
      ?? [...eligible].sort((a, b) => load.get(a.machineId)! / a.concurrency - load.get(b.machineId)! / b.concurrency)[0]!;
    load.set(pick.machineId, load.get(pick.machineId)! + 1);
    const reason = task.requires.length > 0
      ? `${task.requires.map(requirementText).join(" ")} → ${pick.name}`
      : withRoom ? `fastest with room (${pick.cpuCount} cores)` : `over its limit of ${pick.concurrency}, and still the least loaded`;
    return { task, machineId: pick.machineId, reason };
  });
}

// ---------------------------------------------------------------------------
// Resources, one set per member
// ---------------------------------------------------------------------------

/**
 * The port range a run's members may use.
 *
 * It starts above 3790, the port a real daemon listens on, because the point of
 * the whole exercise is that a member's throwaway daemon can never be the one
 * hosting the run.
 */
export const RUN_PORT_MIN = 3800;
export const RUN_PORT_MAX = 3999;

/**
 * The first port of a run's block. Runs are spread over the range by their id,
 * so two runs on one machine are unlikely to meet; inside a run the block is
 * contiguous, so no two members can ever share a port.
 *
 * It depends on the run's id alone, and not on how many members the run has.
 * A run absorbs a task being added, and a base that moved when it did would
 * hand a new member a port that a member already at work is using.
 */
export function runPortBase(runId: string): number {
  const span = RUN_PORT_MAX - RUN_PORT_MIN + 1;
  const h = createHash("sha256").update(runId).digest();
  return RUN_PORT_MIN + (h.readUInt32BE(0) % span);
}

/**
 * One member's own port, `COVEY_HOME` and `COVEY_CONFIG`.
 *
 * This is the defect that made issue #44 necessary. The brief of 2026-09-16
 * gave all fifteen agents the same throwaway port, and one of them ran
 * `covey stop --port 3799` and stopped a daemon another agent had started.
 *
 * `index` is the member's place in the run and is what makes the answer unique.
 * `tmpDir` is the member machine's own, so the paths exist where the agent runs.
 */
export function allocateResources(runId: string, index: number, tmpDir: string, slug: string): MemberResources {
  const span = RUN_PORT_MAX - RUN_PORT_MIN + 1;
  // The block is contiguous, so members 0..n-1 take n ports in a row. A run of
  // more than 200 members wraps and two of them would share a port; a run that
  // large wants a wider range, so it wraps rather than pretending otherwise.
  const port = RUN_PORT_MIN + ((runPortBase(runId) - RUN_PORT_MIN + index) % span);
  const name = `covey-run-${runId.slice(0, 8)}-${slug}`;
  return {
    port,
    coveyHome: join(tmpDir, name),
    coveyConfig: join(tmpDir, `${name}-config`),
  };
}

/** Join without `node:path`, so the answer is the *member* machine's separator. */
function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** A short, safe name for a member's directories. Unique: it carries the index. */
export function memberSlug(task: RunTask, index: number): string {
  const base = task.issue !== null
    ? `i${task.issue}`
    : task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16);
  return `${index + 1}-${base || "task"}`;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/** What a member's brief is written from. */
export interface BriefContext {
  runName: string;
  goal: string;
  task: RunTask;
  machineName: string;
  /** The branch the daemon made the worktree on. Empty before dispatch. */
  branch: string;
  resources: MemberResources;
  /** 1-based. */
  position: number;
  total: number;
}

/**
 * Write one member's brief. Every token in `BRIEF_TOKENS` is replaced, so the
 * brief an agent reads names its own port and its own directories and no other
 * member's. A token the template does not use costs nothing.
 */
export function renderBrief(template: string, c: BriefContext): string {
  const values: Record<string, string> = {
    run: c.runName,
    goal: c.goal,
    task: c.task.title,
    issue: c.task.issue === null ? "" : `#${c.task.issue}`,
    url: c.task.url ?? "",
    machine: c.machineName,
    branch: c.branch,
    port: String(c.resources.port),
    home: c.resources.coveyHome,
    config: c.resources.coveyConfig,
    member: `${c.position} of ${c.total}`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in values ? values[name]! : whole));
}

/**
 * The brief a run starts from.
 *
 * Every paragraph in it is something that went wrong in the run of
 * 2026-09-16: the shared port, the shared broken file, the test that could not
 * fail, the merge nobody owned. It is a template, so the operator edits it.
 */
export const DEFAULT_BRIEF = `Work on {{issue}} — {{task}}

This is member {{member}} of the run "{{run}}".
Goal of the run: {{goal}}

Read CLAUDE.md first. You are on {{machine}}, on branch {{branch}}.

Read the issue in full before you start: \`gh issue view {{issue}}\`.

**Your own resources.** These are yours alone and you must not use any other,
because a second agent in this run has its own:

- port {{port}}
- COVEY_HOME={{home}}
- COVEY_CONFIG={{config}}

A complete second instance, which cannot touch the real one:
\`COVEY_PORT={{port}} COVEY_HOME={{home}} COVEY_CONFIG={{config}} node packages/cli/dist/index.js\`

**Never restart, rebuild or stop the daemon on port 3790.** It hosts the session
you are running in. Stop a throwaway by port, never by pattern:
\`COVEY_HOME={{home}} node packages/cli/dist/index.js stop --port {{port}}\`

**The regression-test gate.** A test that exists is not the gate. The gate is:
you reverted the fix, watched the test fail, and recorded the failure message in
the pull request. Do it before you open the pull request, not after.

**\`pnpm run check\` must be green.**

**Report on the issue as you learn**, with \`gh issue comment\`. The issue is the
durable record; your thread is not.

**Finish with a pull request against \`main\` that says \`Closes {{issue}}\`.** Do
not merge it yourself — one party merges. Before you open it, \`git fetch origin\`
and merge \`origin/main\` into your branch if main has moved.
`;

// ---------------------------------------------------------------------------
// Reading a run back
// ---------------------------------------------------------------------------

/** The member that owns a thread, if a run does. */
export function memberForThread(runs: Run[], machineId: string, threadId: string): { run: Run; member: RunMember } | null {
  for (const run of runs) {
    const member = run.members.find((m) => m.threadId === threadId && m.machineId === machineId);
    if (member) return { run, member };
  }
  return null;
}
