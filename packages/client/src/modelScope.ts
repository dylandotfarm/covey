/**
 * Where a model applies, in the words every client shows.
 *
 * A reader picks a model first and a scope second: this thread, this
 * project, this fleet, or all of covey. The scopes offered depend on the row
 * the reader is on, and the narrowest choice wins when a session starts
 * (`threadModel` in `@covey/protocol`). A wider choice takes the narrower
 * ones inside it back, so the choice made last is the one in force.
 *
 * A thread is `thread.setModel`. A project is `model.apply` with scope
 * `project` on each machine of its pool. A fleet and all of covey are
 * `model.apply` with scope `machine` on each of their machines: the daemon
 * holds one default for the machine, and the client decides which machines
 * get it.
 */
import type { ModelSource } from "@covey/protocol";

export type ModelScope = "thread" | "project" | "fleet" | "covey";

/** The kind of row the reader is on when they ask for a model. */
export type ModelHover = "thread" | "project" | "fleet" | "machine";

/**
 * The scopes a row offers, narrowest first. All of covey is always there.
 *
 * A reader with one fleet is offered no fleet: it reaches exactly the
 * machines all of covey reaches, and the default fleet is named `covey`, so
 * the two rows would read as the same choice twice. The sidebar paints no
 * fleet row for one fleet either.
 */
export function modelScopes(hover: ModelHover, fleets = 2): ModelScope[] {
  const all: ModelScope[] = hover === "thread" ? ["thread", "project", "fleet", "covey"]
    : hover === "project" ? ["project", "fleet", "covey"]
    : ["fleet", "covey"];
  return fleets > 1 ? all : all.filter((x) => x !== "fleet");
}

/** The id of the first-screen row that makes no choice at a scope. */
export const CLEAR_MODEL = "";

/** That row's words. Which wider choice then decides is said on the second screen. */
export const CLEAR_MODEL_ROW = { label: "No choice here", hint: "a wider choice decides" } as const;

/** What a client knows about the scopes of one row. */
export interface ScopeFacts {
  thread?: string;
  project?: string;
  /** The fleet's name, as the sidebar paints it. */
  fleet?: string;
  /** How many machines each scope writes to. */
  machines: Partial<Record<ModelScope, number>>;
  /** How many narrower choices each scope takes back. */
  clears: Partial<Record<ModelScope, number>>;
  /**
   * Where the model would come from if the thread or the project made no
   * choice of its own. A fleet or all of covey with no choice is always
   * Claude Code's own default.
   */
  inherits?: { thread?: ModelSource; project?: ModelSource };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * One row of the second screen: what the scope is, and what it will change.
 * With `clearing`, the row also says where the model then comes from, in the
 * words the palette row will show for it.
 */
export function modelScopeOption(scope: ModelScope, f: ScopeFacts, clearing = false): { label: string; hint: string } {
  const label = scope === "thread" ? `This thread${f.thread ? ` — ${f.thread}` : ""}`
    : scope === "project" ? `This project${f.project ? ` — ${f.project}` : ""}`
    : scope === "fleet" ? `This fleet${f.fleet ? ` — ${f.fleet}` : ""}`
    : "All of covey";
  const parts: string[] = [];
  const machines = f.machines[scope];
  // Making no choice says what then decides, in place of the reach: the
  // row is one line, and the label must not be the part that gets cut.
  if (clearing) {
    const then = scope === "thread" ? f.inherits?.thread : scope === "project" ? f.inherits?.project : null;
    parts.push(`then ${modelSourceLabel(then ?? null)}`);
  } else if (scope === "thread") parts.push("this thread only");
  else if (machines !== undefined) parts.push(scope === "covey" ? `every machine (${machines})` : `on ${plural(machines, "machine")}`);
  const clears = f.clears[scope] ?? 0;
  if (clears > 0) parts.push(`replaces ${plural(clears, "narrower choice")}`);
  return { label, hint: parts.join(" · ") };
}

/** Where the model in force came from, for the line beside it. */
export function modelSourceLabel(from: ModelSource): string {
  switch (from) {
    case "thread": return "set on this thread";
    case "project": return "from the project";
    case "machine": return "from the fleet or covey";
    case null: return "Claude Code's default";
  }
}

/** The title of the second screen. `null` is the row that makes no choice. */
export function modelScopeTitle(modelName: string | null): string {
  return modelName === null ? "Make no choice for" : `Apply ${modelName} to`;
}

/**
 * The sentence after an apply. A machine that did not take it is named with
 * its reason, because "some machines failed" says neither which nor why.
 */
export function modelApplyNotice(
  modelName: string | null,
  scope: ModelScope,
  f: ScopeFacts,
  missed: { machine: string; why: string }[],
): { text: string; level: "success" | "warning" } {
  const where = modelScopeOption(scope, f).label.replace(/^This/, "this").replace(/^All of covey/, "all of covey");
  const done = modelName === null ? `no model chosen for ${where} now` : `${modelName} now applies to ${where}`;
  if (missed.length === 0) return { text: done, level: "success" };
  const who = missed.map((m) => `${m.machine} (${m.why})`).join(", ");
  return { text: `${done}, except on ${who}`, level: "warning" };
}
