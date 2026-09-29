/**
 * What a very small screen says about a conversation (#172).
 *
 * The cover screen of a closed foldable is a few lines tall. It has no room for
 * a transcript, so it shows three things instead: what the agent is doing now,
 * one sentence about the last thing it said, and the pictures. This file decides
 * the first two, and it is pure and node-tested for the reason `timelineRows`
 * is — the answer must be the same wherever it is asked.
 *
 * Nothing here is a *new* fact. The state is read from the thread the daemon
 * already sends and the items already on screen; the sentence is the one
 * `digest.ts` in the daemon wrote, or the reply's own first sentence until it
 * lands. A small screen that had to wait for a round trip would be a small
 * screen that says nothing for the first second.
 */
import { threadIsBusy, type AssistantMessageItem, type Thread, type TimelineItem } from "@covey/protocol";

/**
 * What the agent is doing, in the order a reader cares about it.
 *
 * Ordered by urgency rather than by lifecycle: a thread that wants an answer
 * says so even while a tool call is still running under it, because the reader
 * is the only one who can clear it.
 */
export type Activity =
  /** It asked the reader something and cannot go on. */
  | "asking"
  /** A tool call wants permission. */
  | "approving"
  /** A tool call is running. */
  | "working"
  /** A turn is running with no call in flight: the model is composing. */
  | "thinking"
  /** A pull request is open and its checks have passed. */
  | "ready"
  /** The last turn ended badly. */
  | "failed"
  /** Nothing is running. */
  | "idle";

export interface ActivityState {
  activity: Activity;
  /** Two or three words for a chip. */
  label: string;
  /** What is running, or what is waiting, when there is something to add. */
  detail: string | null;
}

/** The tool calls still running, newest turn first. */
function runningCalls(items: TimelineItem[]): number {
  return items.filter((i) => i.kind === "tool" && i.status === "running").length;
}

/** A question or an approval nobody has answered. */
function pending(items: TimelineItem[]): { asking: boolean; approving: boolean } {
  let asking = false;
  let approving = false;
  for (const i of items) {
    if (i.kind === "question" && i.status === "pending") asking = true;
    if (i.kind === "approval" && i.status === "pending") approving = true;
  }
  return { asking, approving };
}

/**
 * What one conversation is doing.
 *
 * `items` may be empty — a small screen shows the list before it has watched a
 * thread — and then the answer comes from the thread alone, which is coarser
 * but never wrong: `working` and `thinking` collapse into `working`, because
 * without the items there is no way to tell a running call from a running
 * model, and claiming the wrong one is worse than claiming the general one.
 */
export function threadActivity(thread: Thread, items: TimelineItem[] = []): ActivityState {
  const { asking, approving } = pending(items);
  // The reader first: these are the two states only they can clear.
  if (asking || (!items.length && thread.status === "waiting")) {
    return { activity: "asking", label: "Asking you", detail: null };
  }
  if (approving || thread.pendingApprovals > 0) {
    const n = thread.pendingApprovals;
    return { activity: "approving", label: "Needs approval", detail: n > 1 ? `${n} waiting` : null };
  }

  if (threadIsBusy(thread)) {
    const calls = runningCalls(items);
    const queued = thread.queuedTurns > 0 ? `${thread.queuedTurns} queued` : null;
    if (calls > 0) {
      return { activity: "working", label: "Working", detail: calls > 1 ? `${calls} calls` : queued };
    }
    // A turn is running and nothing is calling out: the model is composing.
    // With no items this is a guess, so it says the general word instead.
    if (!items.length) return { activity: "working", label: "Working", detail: queued };
    return { activity: "thinking", label: "Thinking", detail: queued };
  }

  if (thread.status === "error" || thread.latestTurn?.state === "error") {
    return { activity: "failed", label: "Failed", detail: thread.lastError ? firstSentence(thread.lastError, 40) : null };
  }

  // Nothing is running, so the pull request is the news. `ready` is deliberately
  // narrow: a watch that is still polling says nothing, because a reader told
  // "ready" who then finds a red check has been told a lie.
  const pr = thread.pullRequest;
  if (pr) {
    const watch = thread.watch;
    if (watch?.state === "merged") return { activity: "idle", label: "Merged", detail: `#${pr.number}` };
    // The daemon's own merge gate, as of its last poll — never a guess from the
    // news in the transcript. Without a readiness the answer is "open", because
    // telling a reader "ready" about a branch with a red check is the one thing
    // this must never do.
    if (watch?.readiness?.ready) return { activity: "ready", label: "Ready to merge", detail: `#${pr.number}` };
    if (watch?.readiness && !watch.readiness.ready) {
      return { activity: "idle", label: `#${pr.number} open`, detail: firstSentence(watch.readiness.why, 40) };
    }
    return { activity: "idle", label: `#${pr.number} open`, detail: null };
  }
  return { activity: "idle", label: "Idle", detail: null };
}

/**
 * The first sentence of `text`, capped, for a screen with one line.
 *
 * A fallback and not a summary: it takes what the reply opens with, which is
 * usually but not always what it is about. The daemon's sentence replaces it
 * the moment it lands (`AssistantMessageItem.summary`).
 */
export function firstSentence(text: string, max = 100): string {
  const flat = text
    // A fence says nothing on one line, and its contents say less.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * The line a small screen shows for a conversation: the daemon's sentence for
 * the last reply, else that reply's own opening, else nothing.
 *
 * "Last reply" means the last thing the agent *said*, not the last item. A turn
 * ends with tool calls as often as not, and the reader wants the prose.
 */
export function replyLead(items: TimelineItem[], max = 100): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "assistant") continue;
    const reply = item as AssistantMessageItem;
    if (reply.summary) return reply.summary;
    if (reply.text.trim()) return firstSentence(reply.text, max);
  }
  return "";
}
