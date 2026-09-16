import type { TimelineItem, UserMessageItem } from "@covey/protocol";
import { caretToVisual, type VisualLine } from "./editor.js";

/**
 * The up arrow walks back through the messages this thread has sent and puts
 * one in the draft. It changes the draft and nothing else: no command goes to
 * the daemon, no item leaves the conversation and no file is touched. A
 * rewind is the other mechanism (`rewind.ts`) and they must not be confused.
 */
export interface HistoryWalk {
  /** Index into the entries. 0 is the newest message. */
  at: number;
  /** The draft the composer held when the walk started. */
  kept: string;
  /**
   * The text the walk put in the draft. Any other text means the person has
   * edited it, and an edit ends the walk — see `stepHistory`.
   */
  shown: string;
}

export type HistoryStep =
  | { kind: "move-caret" }
  | { kind: "recall"; draft: string; caret: number; walk: HistoryWalk | null };

/**
 * The messages this thread has sent, newest first.
 *
 * Queued and folded messages are in the list: the person typed them and sent
 * them, which is all this walk is about. That makes the list deliberately
 * different from the one the revert picker builds, which leaves them out
 * because they have no checkpoint of their own. A message with no text is an
 * image on its own, and recalling an empty draft would look like a fault.
 */
export function sentMessages(items: Iterable<TimelineItem>): string[] {
  return [...items]
    .filter((i): i is UserMessageItem => i.kind === "user" && i.text.trim().length > 0)
    .sort((a, b) => b.seq - a.seq)
    .map((i) => i.text);
}

/**
 * One press of up (`dir` −1) or down (+1) in the composer.
 *
 * The keys keep their usual job — move the caret one visual row — until the
 * caret is already on the first row, or on the last row. Only then do they
 * step through `entries`. The test is the row, not the offset: a wrapped first
 * row is the top row even when the caret is not at zero.
 *
 * Nothing typed is lost. The draft in the composer when the walk starts is
 * kept, and a step forward past the newest entry puts it back. An edit ends
 * the walk, thus the edited text becomes the draft that the next walk keeps.
 */
export function stepHistory(
  entries: string[],
  walk: HistoryWalk | null,
  draft: string,
  caret: number,
  lines: VisualLine[],
  dir: -1 | 1,
): HistoryStep {
  // The draft is not what the walk put there: the person has edited it, so the
  // draft is theirs again and the walk is over.
  const w = walk && walk.shown === draft ? walk : null;
  const { row } = caretToVisual(lines, caret);
  const move: HistoryStep = { kind: "move-caret" };
  const recall = (at: number, text: string, kept: string): HistoryStep =>
    ({ kind: "recall", draft: text, caret: text.length, walk: { at, kept, shown: text } });

  if (dir === -1) {
    if (row !== 0) return move;
    const at = (w ? w.at : -1) + 1;
    const text = entries[at];
    // The oldest message is the end of the walk. The caret parks, as it does
    // today at the top of a draft.
    if (text === undefined) return move;
    return recall(at, text, w ? w.kept : draft);
  }
  if (row !== lines.length - 1) return move;
  // Down with no walk in progress has nothing newer to reach.
  if (!w) return move;
  const at = w.at - 1;
  if (at < 0) return { kind: "recall", draft: w.kept, caret: w.kept.length, walk: null };
  return recall(at, entries[at]!, w.kept);
}
