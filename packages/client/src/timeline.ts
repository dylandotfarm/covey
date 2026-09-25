import { DEFAULT_LOD, MIN_CHAIN, type ItemId, type Lod, type TimelineItem, type ToolCallItem } from "@covey/protocol";

/**
 * The fold that turns a transcript into rows, at one level of detail (#149).
 *
 * A turn reads eight files and runs five commands, and every one of them used
 * to take a row of its own. This folds a *chain* — the run of tool calls and
 * thoughts the agent made between two things it said, which the daemon marks
 * with `groupId` — into a single row that says what the chain was for.
 *
 * Pure, and shared by the TUI and the web client, so both agree on where a
 * chain starts, what its row says and what a tap opens. Node tests it.
 *
 * Three depths, and the reader moves between them one row at a time:
 *
 * 1. a chain row, which opens into the items it holds;
 * 2. an item row, which opens into what went into the call and what came back.
 *
 * The level of detail says which of those are open before anybody taps. It is
 * a preference of the device; see `Lod` in `@covey/protocol`.
 */

/** One row of the transcript. */
export type TimelineRow = ItemRow | ChainRow | SaidRow;

/**
 * One item, on a row of its own.
 *
 * Every row kind carries a `key`, and no two rows ever share one. A chain's
 * key is *not* its head item's id: both rows can be on screen together, and
 * one tap must open one of them.
 */
export interface ItemRow {
  kind: "item";
  item: TimelineItem;
  /** The key the reader taps to open or shut this row. */
  key: string;
  /** True to paint what went into the call and what came back. */
  open: boolean;
  /** True when this row is a call still running under a folded chain. */
  live?: boolean;
}

/** A run of tool calls and thoughts, folded into one row. */
export interface ChainRow {
  kind: "chain";
  /** The key the reader taps. `chain:` and then the chain's id. */
  key: string;
  /** The chain's id, which is the `groupId` of every item it holds. */
  id: ItemId;
  /** The sentence the row says: the model's, else one derived from the calls. */
  label: string;
  /** True once a model wrote `label`, so a client can mark a derived one. */
  written: boolean;
  /** Every item the chain holds, in order. */
  items: TimelineItem[];
  /** True to paint the items under this row as well. */
  open: boolean;
  /** Calls still running. A folded chain paints each of them under itself. */
  running: number;
  /** Calls that failed. A reader must see this without opening the row. */
  failed: number;
  /** The calls' time together, or null while none of them has finished. */
  durationMs: number | null;
}

/**
 * What the agent said in the middle of a turn, folded away by `minimal`.
 *
 * The first thing it said opens the turn and the last one concludes it, so
 * those two keep their rows and everything between them comes here.
 */
export interface SaidRow {
  kind: "said";
  /** The key the reader taps. `said:` and then the first message folded. */
  key: string;
  items: TimelineItem[];
  open: boolean;
}

export interface FoldOpts {
  lod?: Lod;
  /**
   * The rows the reader has changed from what the level of detail gives them.
   *
   * A *toggle*, not a list of open rows: at `full` every item starts open, so
   * an id in here shuts one. This is what lets the level be a default that a
   * tap overrides, rather than a setting that fights the reader's last tap.
   */
  toggled?: ReadonlySet<string>;
}

/** True when the level folds a chain into one row. */
export function foldsChains(lod: Lod): boolean {
  return lod === "minimal" || lod === "compact";
}

/** Whether a row is open, given the level's default and the reader's taps. */
function isOpen(id: string, byDefault: boolean, toggled: ReadonlySet<string>): boolean {
  return toggled.has(id) ? !byDefault : byDefault;
}

/**
 * The rows `items` paints at this level of detail.
 *
 * `items` must be in `seq` order. An item the daemon marked with no `groupId`
 * — everything written before chains existed — simply never folds, so an old
 * transcript reads exactly as it always did.
 */
export function timelineRows(items: TimelineItem[], o: FoldOpts = {}): TimelineRow[] {
  const lod = o.lod ?? DEFAULT_LOD;
  const toggled = o.toggled ?? new Set<string>();
  const openByDefault = lod === "full";
  const rows: TimelineRow[] = [];

  if (!foldsChains(lod)) {
    for (const item of items) rows.push({ kind: "item", item, key: item.id, open: isOpen(item.id, openByDefault, toggled) });
    return rows;
  }

  const chains = chainsOf(items);
  const hidden = lod === "minimal" ? middleMessages(items) : new Map<ItemId, TimelineItem[]>();
  const swallowed = new Set<ItemId>();
  for (const [, group] of hidden) for (const m of group) swallowed.add(m.id);

  for (const item of items) {
    const chain = item.groupId ? chains.get(item.groupId) : undefined;
    if (chain) {
      // One row for the chain, drawn where its first item was. The rest of the
      // chain is already accounted for by it.
      if (chain[0] !== item) continue;
      const row = chainRow(chain, toggled);
      rows.push(row);
      if (row.open) {
        for (const it of chain) rows.push({ kind: "item", item: it, key: it.id, open: isOpen(it.id, false, toggled) });
        continue;
      }
      // A folded chain still shows the call that is running: a reader watching
      // a turn wants to know what it is doing now, and the sentence above
      // cannot say — the chain has not finished happening yet.
      for (const it of chain) {
        if (it.kind === "tool" && it.status === "running") rows.push({ kind: "item", item: it, key: it.id, open: isOpen(it.id, false, toggled), live: true });
      }
      continue;
    }
    // Before the `swallowed` check, never after it: the row that opens the
    // folded messages is the first of them, and that one is swallowed too.
    const group = hidden.get(item.id);
    if (group) {
      const key = `said:${item.id}`;
      const open = isOpen(key, false, toggled);
      rows.push({ kind: "said", key, items: group, open });
      if (open) for (const it of group) rows.push({ kind: "item", item: it, key: it.id, open: true });
      continue;
    }
    if (swallowed.has(item.id)) continue;
    rows.push({ kind: "item", item, key: item.id, open: isOpen(item.id, openByDefault, toggled) });
  }
  return rows;
}

/**
 * The chains worth folding, by their id. A chain of one item is left alone:
 * the row that hid it would be no shorter than the row it hid.
 */
export function chainsOf(items: TimelineItem[]): Map<ItemId, TimelineItem[]> {
  const chains = new Map<ItemId, TimelineItem[]>();
  for (const item of items) {
    if (!item.groupId) continue;
    const g = chains.get(item.groupId) ?? [];
    g.push(item);
    chains.set(item.groupId, g);
  }
  for (const [id, g] of chains) if (g.length < MIN_CHAIN) chains.delete(id);
  return chains;
}

function chainRow(chain: TimelineItem[], toggled: ReadonlySet<string>): ChainRow {
  const head = chain[0]!;
  const calls = chain.filter((i): i is ToolCallItem => i.kind === "tool");
  let running = 0;
  let failed = 0;
  let durationMs: number | null = null;
  for (const c of calls) {
    if (c.background ? c.background.state === "running" : c.status === "running") running += 1;
    if (c.background ? c.background.state === "failed" : c.status === "error") failed += 1;
    if (c.durationMs != null) durationMs = (durationMs ?? 0) + c.durationMs;
  }
  const written = typeof head.groupSummary === "string" && head.groupSummary.length > 0;
  const key = `chain:${head.id}`;
  return {
    kind: "chain",
    key,
    id: head.id,
    label: written ? head.groupSummary! : chainLabel(chain),
    written,
    items: chain,
    open: isOpen(key, false, toggled),
    running,
    failed,
    durationMs,
  };
}

/**
 * The messages `minimal` folds away, keyed by the first of each run.
 *
 * Each turn keeps the first thing the agent said and the last: the one says
 * what it set out to do and the other says how it went. A turn with two
 * messages or fewer hides nothing.
 */
function middleMessages(items: TimelineItem[]): Map<ItemId, TimelineItem[]> {
  const byTurn = new Map<string, TimelineItem[]>();
  for (const item of items) {
    if (item.kind !== "assistant" || item.groupId) continue;
    const key = item.turnId ?? item.id;
    byTurn.set(key, [...(byTurn.get(key) ?? []), item]);
  }
  const hidden = new Map<ItemId, TimelineItem[]>();
  for (const [, said] of byTurn) {
    if (said.length <= 2) continue;
    const middle = said.slice(1, -1);
    hidden.set(middle[0]!.id, middle);
  }
  return hidden;
}

// ---- the derived sentence ---------------------------------------------------

/** How a tool call reads in a derived sentence. */
const VERB: Record<string, string> = {
  Read: "read", Glob: "read", LS: "read", NotebookRead: "read",
  Grep: "searched", WebSearch: "searched",
  Write: "wrote",
  Edit: "edited", MultiEdit: "edited", NotebookEdit: "edited",
  Bash: "ran", BashOutput: "ran", KillShell: "ran",
  WebFetch: "fetched",
  Task: "ran", Agent: "ran",
  TodoWrite: "planned", ExitPlanMode: "planned", EnterPlanMode: "planned",
};

/** The noun each verb counts, singular then plural. */
const NOUN: Record<string, [string, string]> = {
  read: ["file", "files"],
  searched: ["search", "searches"],
  wrote: ["file", "files"],
  edited: ["file", "files"],
  ran: ["command", "commands"],
  fetched: ["page", "pages"],
  planned: ["note", "notes"],
  called: ["tool", "tools"],
};

const MAX_LABEL = 70;

/**
 * The sentence a chain shows until a model writes a better one.
 *
 * It counts the calls rather than reading them, so it costs nothing, it needs
 * no network and it grows with the chain as the turn runs. It is also what a
 * chain keeps for good when `COVEY_ACTIVITY_MODEL=off`, when the model failed,
 * and when the daemon that wrote the transcript was older than chains.
 *
 * A thought is counted by neither this nor the model: its text is never read.
 */
export function chainLabel(items: TimelineItem[]): string {
  const calls = items.filter((i): i is ToolCallItem => i.kind === "tool");
  if (calls.length === 0) return "Thought it through";
  if (calls.length === 1) return calls[0]!.summary || calls[0]!.toolName;
  const counts = new Map<string, number>();
  for (const c of calls) {
    const verb = VERB[c.toolName] ?? "called";
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  // Busiest first: what the run did most of is what it was mostly for.
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([verb, n]) => {
      const [one, many] = NOUN[verb] ?? ["call", "calls"];
      return `${verb} ${n} ${n === 1 ? one : many}`;
    });
  const sentence = parts.join(" and ") + (counts.size > 2 ? ", and more" : "");
  const capped = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return capped.length > MAX_LABEL ? capped.slice(0, MAX_LABEL - 1) + "…" : capped;
}
