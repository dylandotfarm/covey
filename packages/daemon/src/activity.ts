import { query } from "@anthropic-ai/claude-agent-sdk";
import { MIN_CHAIN, type TimelineItem, type ToolCallItem } from "@covey/protocol";

/**
 * One sentence for a chain of tool calls, written by a weak model (#149).
 *
 * A chain is the run of tool calls and thoughts the agent made between two
 * things it said. The transcript folds one into a single row, and this writes
 * what that row says.
 *
 * This goes through the Agent SDK rather than the Messages API for the reason
 * `title.ts` does: it reuses the credentials Claude Code itself runs on, so a
 * subscription user needs no ANTHROPIC_API_KEY. The query carries nothing but
 * a list of tool calls — no tools, no settings files, no transcript — so it
 * stays cheap and cannot touch the working tree.
 *
 * **Only the tool calls go to the model.** A thought is folded away by the
 * row, but its text is never read and never sent. The model sees the tool
 * names and the one-line summaries `toolSummary.ts` already wrote, and nothing
 * else.
 */

/** Weak model for these sentences. `COVEY_ACTIVITY_MODEL=off` turns them off. */
const MODEL = process.env.COVEY_ACTIVITY_MODEL ?? "claude-sonnet-5";
const TIMEOUT_MS = 20_000;
/** Enough calls to say what the chain was for. A long chain repeats itself. */
const MAX_CALLS = 24;
const MAX_SUMMARY = 80;
/** Longer than this is prose, not a summary — the derived one is better. */
const MAX_PLAUSIBLE = 90;

const SYSTEM = [
  "You describe what a coding assistant just did.",
  "Given the list of tool calls it made, reply with one sentence that names the purpose of the run:",
  "4-10 words, past tense, sentence case, no trailing punctuation, no quotes, no preamble.",
  "Use short, plain words. The sentence goes on one line of a phone screen.",
  'Name the purpose, not the mechanics — "Fixed the failing websocket tests", not "Ran bash three times".',
  "Reply with the sentence alone.",
].join(" ");

/**
 * A sentence for `items`, or null when the model was unavailable, too slow,
 * aborted, or chatty. Never throws: on null the chain keeps no summary of its
 * own and the client paints the one it derives from the calls it holds
 * (`chainLabel` in `@covey/client`), so a folded row always says something.
 */
export async function summariseActivity(items: TimelineItem[], cwd: string, abort = new AbortController()): Promise<string | null> {
  if (!MODEL || MODEL === "off") return null;
  const calls = toolCalls(items);
  if (calls.length === 0) return null;
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: activityPrompt(calls),
      options: {
        cwd,
        model: MODEL,
        systemPrompt: SYSTEM,
        tools: [], // one list in, one line out — nothing to run
        settingSources: [], // no CLAUDE.md, no hooks, no project settings
        maxTurns: 1,
        abortController: abort,
        // Throwaway, as a title is: no transcript on disk, nothing in
        // `claude --resume`, and no mirror into our database.
        persistSession: false,
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") return msg.subtype === "success" ? cleanActivity(msg.result) : null;
    }
    return null;
  } catch {
    return null; // a missing sentence is never worth failing a turn over
  } finally {
    clearTimeout(timer);
  }
}

/** The tool calls of a chain, in order. A thought is not one and never goes. */
export function toolCalls(items: TimelineItem[]): ToolCallItem[] {
  return items.filter((i): i is ToolCallItem => i.kind === "tool");
}

/**
 * The list of calls that carries the chain to the model.
 *
 * One call to a line, as the name and the summary the daemon already wrote.
 * The input of a call does not go: it holds the file a reader dropped and the
 * body of a command, and the summary says what the call was for in less.
 */
export function activityPrompt(calls: ToolCallItem[]): string {
  const lines = calls.slice(0, MAX_CALLS).map((c) => `- ${c.toolName}: ${c.summary || c.toolName}`);
  const more = calls.length > MAX_CALLS ? `\n- … and ${calls.length - MAX_CALLS} more` : "";
  return `The tool calls the assistant made:\n\n${lines.join("\n")}${more}`;
}

/** Strip the decoration models add around a one-line answer. */
export function cleanActivity(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const text = line
    // The bullet comes off first: a model that answers "- Summary: …" wears
    // both, and the label is only at the start once the bullet has gone.
    .replace(/^[-*•]\s+/, "")
    .replace(/^(?:summary|activity|sentence)\s*:\s*/i, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > MAX_PLAUSIBLE) return null;
  return truncate(text);
}

/** Cut at the last whole word: half a word reads as a bug, not as a cut. */
function truncate(s: string): string {
  if (s.length <= MAX_SUMMARY) return s;
  const cut = s.slice(0, MAX_SUMMARY - 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_SUMMARY / 2 ? cut.slice(0, space) : cut) + "…";
}

// ---- which chain an item belongs to -----------------------------------------

/** A chain the daemon is still filing items under. */
export interface OpenChain {
  /** The id of the chain's first item, which is every member's `groupId`. */
  id: string;
  itemIds: string[];
  /** A chain never spans two turns, so the turn it belongs to is part of it. */
  turnId: string | null;
}

/**
 * Which activity chain each item belongs to (#149).
 *
 * Held apart from the engine so node can test it without a daemon: the engine
 * adds only the side effect, which is to have a model name a chain that
 * closed. Held in memory only — the `groupId` of every item is already on
 * disk, so a restart loses nothing but the sentence of a chain still open, and
 * the client derives one of those from the calls it holds.
 */
export class ChainTracker {
  private open = new Map<string, OpenChain>();

  /**
   * File one item, and say which chain it joined and which chain that closed.
   *
   * A tool call and a thought join the chain that is open. Anything else the
   * agent or the reader produced closes it: a reader must not lose a message,
   * a question or an approval to a fold.
   *
   * An item already on disk keeps the chain it was filed under. A streaming
   * item is written many times and must never move between chains.
   */
  file(item: TimelineItem, existing: TimelineItem | null): { groupId?: string; closed: OpenChain | null } {
    if (existing) return { groupId: existing.groupId, closed: null };
    if (item.kind !== "tool" && item.kind !== "thinking") return { closed: this.close(item.threadId) };
    const open = this.open.get(item.threadId);
    if (open && open.turnId === item.turnId) {
      open.itemIds.push(item.id);
      return { groupId: open.id, closed: null };
    }
    const closed = open ? this.close(item.threadId) : null;
    this.open.set(item.threadId, { id: item.id, itemIds: [item.id], turnId: item.turnId });
    return { groupId: item.id, closed };
  }

  /** Close the chain open on a thread, and hand it back when it is worth naming. */
  close(threadId: string): OpenChain | null {
    const open = this.open.get(threadId);
    if (!open) return null;
    this.open.delete(threadId);
    // A chain of one call is never folded, so a sentence for it would be paid
    // for and never painted.
    return open.itemIds.length < MIN_CHAIN ? null : open;
  }

  /** Close every chain, for a daemon that is stopping. */
  closeAll(): OpenChain[] {
    const out: OpenChain[] = [];
    for (const threadId of [...this.open.keys()]) {
      const c = this.close(threadId);
      if (c) out.push(c);
    }
    return out;
  }
}
