/**
 * What a thread says to a reader who is looking at something else.
 *
 * An agent works for minutes at a time and the reader is somewhere else for
 * most of it. So every client has a way of saying "this one is yours again":
 * the TUI rings the bell, raises a notice and marks the row, and the phone
 * posts a notification. The *words* differ and the rule must not, which is why
 * this file is here rather than in either of them — a thread the terminal calls
 * done and the phone says nothing about is one reader with two answers.
 *
 * It is a rule about a *change* and never about a state. A thread that wants an
 * approval has wanted one since the moment it asked; what is worth telling
 * somebody is that it started wanting one. So every answer here comes from two
 * threads, the one the client held and the one the daemon just sent, and a
 * client with nothing to compare against — a first snapshot, a reconnect — asks
 * nothing and says nothing.
 *
 * Pure and node-tested, like `timelineRows` and for the same reason.
 */
import { threadIsFinished, type Thread } from "@covey/protocol";

/**
 * The mark a row carries once this has fired, and the three things a reader
 * can be told.
 *
 * `approval` covers a question as well. They are one state to a reader — the
 * thread stopped and only they can start it again — and the TUI has painted
 * them with one dot since #49. What differs is the sentence, which is `lead`.
 */
export type AttentionMark = "approval" | "done" | "error";

/** What one change is worth saying, and how loudly. */
export interface ThreadNews {
  /**
   * The mark the thread's row carries from now until the reader opens it, or
   * null for news that marks nothing.
   */
  mark: AttentionMark | null;
  /**
   * The start of a line, in covey's own voice: `done`, `failed`, `needs
   * approval`, `asks you something`, `under review`. A client writes
   * `${lead}: ${title}` and capitalises it if its own style does.
   */
  lead: string;
  /**
   * True when the reader is the only one who can carry this thread further.
   *
   * It is what earns the bell and the notification. News that is merely
   * progress — a turn that ended into a review covey is still running — is
   * worth a line and not an interruption.
   */
  wants: boolean;
}

/**
 * What the change from `prev` to `next` is worth telling a reader, or null.
 *
 * The order is the order of a reader's interest, not the order of a thread's
 * lifecycle: a thread that stopped to ask something says so even if its last
 * turn also ended, because the question is the part only they can clear.
 */
export function threadNews(prev: Thread, next: Thread): ThreadNews | null {
  // A thread that has been put away is not news. The merge archives a thread
  // the moment its last turn ends (`archiveOnMerge`), so without this the end
  // of covey's own loop rings a bell about a conversation no client is painting
  // any more.
  if (next.archivedAt) return null;

  const waiting = (t: Thread) => t.pendingApprovals > 0 || t.status === "waiting";
  const nowWaiting = waiting(next) && !waiting(prev);
  const turnEnded = prev.latestTurn?.state === "running" && next.latestTurn?.state === "completed";
  const nowError = prev.latestTurn?.state === "running" && next.latestTurn?.state === "error";
  // A turn that ended into a review has not finished the thread: covey's own
  // reviewers are still reading the change and the next turn comes from them.
  const nowDone = turnEnded && threadIsFinished(next);

  if (nowWaiting) {
    // An approval is a tool call asking for permission; `waiting` with none is
    // the agent's own question. Both stop the thread dead and the reader wants
    // to know which, because one of them is answered with a word.
    return { mark: "approval", lead: next.pendingApprovals > 0 ? "needs approval" : "asks you something", wants: true };
  }
  if (nowError) return { mark: "error", lead: "failed", wants: true };
  if (nowDone) return { mark: "done", lead: "done", wants: true };
  // Nothing for the reader to do, and silence would be worse: a background
  // thread that stops with no word reads as stalled. So the review is reported
  // and marks nothing — the mark means "yours again", and it is not.
  if (turnEnded) return { mark: null, lead: "under review", wants: false };
  return null;
}
