/**
 * What the phone puts in the shade when a thread stops needing to work and
 * starts needing the reader.
 *
 * This is the reason an app is worth having over the page: a page cannot wake
 * you. An agent works for minutes at a time and the reader is somewhere else
 * for most of it, so the one thing covey owes them is a tap on the shoulder
 * when the thread is theirs again.
 *
 * **What counts as news is not decided here.** `threadNews` in `@covey/client`
 * is that rule and the TUI reads the same one, so a thread the terminal rings a
 * bell for and the phone says nothing about cannot happen. What is here is what
 * only a phone has to decide: whether this reader, on this screen, with these
 * threads, should be interrupted — and the words of the one line Android shows.
 *
 * Pure and node-tested, beside `talk.ts` and for the same reason: every caller
 * sits behind something this loop cannot start.
 */
import { threadNews } from "@covey/client";
import { threadIsHidden, threadNeedsPerson, type Thread } from "@covey/protocol";

/** One notification: a thread's own, replacing whatever stood for it before. */
export interface Note {
  /** `<machine>:<thread>`. One row per conversation, and never a second. */
  id: string;
  /** The conversation's own title — what a reader recognises in the shade. */
  title: string;
  /** What it wants, and which machine it is on. */
  body: string;
  /** Where a tap goes. */
  machine: string;
  threadId: string;
}

/** Post one, take one down, or leave the shade alone. */
export type NoteAct =
  | { act: "post"; note: Note }
  | { act: "dismiss"; id: string }
  | null;

/** Everything the decision needs, and nothing a React Native module owns. */
export interface NoteInput {
  /** The machine's key, and the name the reader gave it. */
  machine: string;
  machineName: string;
  /** The thread the client held, and the one the daemon just sent. */
  prev: Thread;
  next: Thread;
  /** True while the app is the screen in front of the reader. */
  foreground: boolean;
  /** The conversation the reader has open, if any. */
  open: { machine: string; threadId: string } | null;
}

/** The one key a thread's notification is filed under. */
export function noteId(machine: string, threadId: string): string {
  return `${machine}:${threadId}`;
}

/**
 * What one change to one thread does to the shade.
 *
 * Four rules, and each is a notification somebody would otherwise have to turn
 * off:
 *
 *  - **A thread the reader is looking at is never announced.** They can see it.
 *    Only while the app is in front, though: a conversation left open behind a
 *    locked screen is a conversation nobody is reading.
 *  - **Covey's own reviewers are silent** unless they need a person.
 *    `threadIsHidden` is that rule and its third term is the whole safety of
 *    it — a reviewer blocked on an approval would otherwise wait for ever,
 *    off the screen and out of the shade.
 *  - **A reason that has gone takes its row with it.** An approval answered in
 *    the terminal, or a thread the reader set working again, leaves a line in
 *    the shade about something that is no longer true.
 *  - **Nothing is said twice**, which is `threadNews`' own rule: it reads the
 *    change and never the state.
 */
export function noteFor(o: NoteInput): NoteAct {
  const { machine, next, prev } = o;
  const id = noteId(machine, next.id);
  const news = threadNews(prev, next);

  if (news?.wants) {
    if (threadIsHidden(next, false)) return null;
    if (o.foreground && o.open?.machine === machine && o.open.threadId === next.id) return null;
    return {
      act: "post",
      note: {
        id,
        title: next.title,
        // The lead is covey's own word for what happened, in covey's own voice;
        // a notification is a sentence, so it starts with a capital. Writing a
        // second set of words here is what would let the two clients drift.
        body: `${news.lead.charAt(0).toUpperCase()}${news.lead.slice(1)} · ${o.machineName}`,
        machine,
        threadId: next.id,
      },
    };
  }

  // Not news. The row that is already there may have stopped being true, which
  // happens whenever a thread is carried on from somewhere else: a reader who
  // answers in the terminal should not find the question still in their shade.
  const answered = threadNeedsPerson(prev) && !threadNeedsPerson(next);
  const working = prev.latestTurn?.state !== "running" && next.latestTurn?.state === "running";
  if (answered || working) return { act: "dismiss", id };
  return null;
}

/** What the settings row says about itself. */
export interface NotifyPanel {
  label: string;
  hint: string;
  /** What is stopping it, when something is. */
  warn: string | null;
}

/**
 * The words of the one switch, in the one place they live.
 *
 * `hiddenPanel` in `@covey/client` is the pattern and the reason is the same:
 * the sentences are what a reader decides on, so they are tested rather than
 * typed into a component. They are *not* shared with the other clients, unlike
 * that one — a terminal rings a bell it never asked permission for and the page
 * cannot notify anybody at all, so there is no second copy to drift from.
 *
 * `available` is whether this build has the native half. A bundle arrives over
 * the air and a binary does not, so the app painting this screen can be older
 * than the screen.
 */
export function notifyPanel(on: boolean, allowed: boolean, available: boolean): NotifyPanel {
  return {
    label: "Tell me when a thread needs me",
    hint: on
      ? "A notification when a thread asks you something, wants an approval, finishes or fails. covey keeps running in the background to hear it, which is the row in your notification shade."
      : "Off. A conversation only reports itself while this app is open.",
    warn: !available
      ? "This app was built before covey could post a notification. Install the newer app to fix that."
      : on && !allowed
        ? "Android is not allowing covey to show notifications. Turn them on for covey in Android's settings."
        : null,
  };
}
