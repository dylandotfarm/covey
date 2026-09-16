import { questionAsks, type QuestionAsk, type QuestionItem } from "@covey/protocol";

/**
 * Stepping through an `AskUserQuestion` call.
 *
 * The tool asks one to four questions at a time and the CLI wants an answer for
 * each one, so the client walks them in order and sends the lot in one command.
 * The walk is here rather than in the key handler because it is the part that
 * has to be right: the CLI drops a question it gets no answer for, and never
 * tells the agent it did.
 */

/** The question the user answers now, or null once they all have an answer. */
export function currentAsk(item: QuestionItem, answered: string[]): QuestionAsk | null {
  const asks = questionAsks(item);
  return answered.length < asks.length ? asks[answered.length]! : null;
}

export interface Taken {
  /** The answers so far, with the new one on the end. */
  answered: string[];
  /**
   * The whole set to send, once every question has an answer. Null while
   * questions remain, which is what keeps a three-question call from being
   * answered by the first choice the user makes.
   */
  send: string[] | null;
}

/** Record one answer and say whether that completes the call. */
export function takeAnswer(item: QuestionItem, answered: string[], answer: string): Taken {
  const asks = questionAsks(item);
  const next = [...answered, answer];
  return { answered: next, send: next.length >= asks.length ? next : null };
}
