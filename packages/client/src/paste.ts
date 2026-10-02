/**
 * A block of text pasted into a composer, held aside and shown as one chip.
 *
 * A person who pastes a stack trace, a log or a file wants the agent to read
 * it; they do not want to look at it. Two hundred lines in the draft push the
 * transcript off the screen, and the composer's own window scrolls, so the
 * sentence the person was writing is no longer on the screen either. So a
 * paste of more than two lines goes aside and the draft gets `[pasted 200
 * lines]` in its place. The chip is the text: `expandPastes` puts the lines
 * back at send, exactly where the chip stood.
 *
 * These are the same rules as a dropped file's chip, and for the same reason
 * (`attach.ts`): the tag is ordinary text, nothing protects it, and the tag is
 * the only record of what it stands for. Delete the chip and the text goes.
 * Nothing here touches a file or a DOM, so every client can share it.
 */
import { keepTagged, makeTag, spliceTags } from "./attach.js";

/**
 * A held paste and the exact text that stands for it in the draft.
 *
 * `text` is already normalised — the draft and the turn carry the same string,
 * so what the chip expands to is what the composer would have held.
 */
export interface PastedText {
  tag: string;
  text: string;
}

/**
 * The shortest paste that becomes a chip, in lines.
 *
 * Three, because one line and two lines read as part of the sentence: a person
 * who pastes a path, a branch name or a two-line error is writing with it, and
 * a chip there hides text they want to see and edit.
 */
export const PASTE_CHIP_LINES = 3;

/**
 * The lines in a pasted block.
 *
 * One trailing newline does not count: a copy of three lines out of an editor
 * usually carries the newline that ends the third, and `4 lines` for it reads
 * as a miscount.
 */
export function pasteLines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/** True when a paste is big enough to go aside as a chip. */
export function chipsPaste(text: string): boolean {
  return pasteLines(text) >= PASTE_CHIP_LINES;
}

/** What the chip says: the one fact a reader needs to recognise their paste. */
export function pasteLabel(text: string): string {
  const n = pasteLines(text);
  return `pasted ${n} line${n === 1 ? "" : "s"}`;
}

/**
 * Put a pasted block into the draft as a chip, and hold its text.
 *
 * `held` first forgets the pastes whose chip the person already deleted, so a
 * label that is free again is free to use and the list matches the draft.
 */
export function applyPaste(draft: string, caret: number, text: string, held: PastedText[]): { value: string; caret: number; pastes: PastedText[] } {
  const live = keepTagged(draft, held);
  const tag = makeTag(pasteLabel(text), [draft, ...live.map((p) => p.tag)].join("\n"));
  const next = spliceTags(draft, caret, [tag]);
  return { ...next, pastes: [...live, { tag, text }] };
}

/**
 * The held paste this block was already pasted as, or null.
 *
 * A person who pastes the same thing twice is asking to see it (`revealPaste`),
 * not asking for a second copy of it.
 */
export function pastedAlready(draft: string, text: string, held: PastedText[]): PastedText | null {
  return keepTagged(draft, held).find((p) => p.text === text) ?? null;
}

/**
 * Show a held paste: its chip becomes the text it stands for, where it stands.
 *
 * In place, and not at the caret, because the text is already in the sentence
 * once. The caret lands at the end of it, which is where the second paste
 * would have put it.
 */
export function revealPaste(draft: string, p: PastedText): { value: string; caret: number } | null {
  const at = draft.indexOf(p.tag);
  if (at < 0) return null;
  return { value: draft.slice(0, at) + p.text + draft.slice(at + p.tag.length), caret: at + p.text.length };
}

/**
 * The turn's real text: every chip back to the lines it stands for.
 *
 * One pass left to right, never a replace per paste, because a block of pasted
 * text may itself hold the words `[pasted 3 lines]` — a second pass would read
 * the text it just wrote and expand a chip the person never made.
 */
export function expandPastes(draft: string, held: PastedText[]): string {
  if (held.length === 0) return draft;
  let out = "";
  let from = 0;
  for (;;) {
    let next: { at: number; p: PastedText } | null = null;
    for (const p of held) {
      const at = draft.indexOf(p.tag, from);
      if (at >= 0 && (!next || at < next.at)) next = { at, p };
    }
    if (!next) return out + draft.slice(from);
    out += draft.slice(from, next.at) + next.p.text;
    from = next.at + next.p.tag.length;
  }
}
