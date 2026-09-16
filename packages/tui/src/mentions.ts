import type { PathEntry } from "@covey/protocol";
import type { MenuRow } from "./composerMenu.js";

/**
 * The `@` prefix in the composer: name a file for the agent to read.
 *
 * The paths are on the daemon's machine, not the client's, so the entries come
 * over the protocol (`thread.listDir`). This module holds the part that needs
 * no network: which word the caret is in, which directory that word names, and
 * what the draft looks like after the reader takes a row.
 *
 * Unlike `/`, an `@` counts anywhere a word starts, not only at the start of
 * the draft. "read @src/index.ts and say what it does" is the sentence people
 * write, and a mention that only worked as the first character would be a
 * mention nobody could use. The word has to *start* with the `@`, so the one
 * in `dylan@example.com` is still prose.
 */

/** The `@word` the caret is in. Offsets are into the draft. */
export interface Mention {
  /** Offset of the `@` itself. */
  start: number;
  /** Offset one past the end of the word. */
  end: number;
  /** The path so far, without the `@`. */
  text: string;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * The mention the caret sits in, or `null`.
 *
 * The caret matters here, and does not for `/`: a mention can be anywhere in
 * the draft, so the only way to know which one is being typed is to look where
 * the reader is.
 */
export function mentionAt(draft: string, caret: number): Mention | null {
  const at = Math.max(0, Math.min(caret, draft.length));
  let start = at;
  while (start > 0 && !isSpace(draft[start - 1])) start--;
  if (draft[start] !== "@") return null;
  let end = at;
  while (end < draft.length && !isSpace(draft[end])) end++;
  return { start, end, text: draft.slice(start + 1, end) };
}

/** The directory part of a path so far: everything up to the last `/`. */
export function mentionDir(text: string): string {
  const i = text.lastIndexOf("/");
  return i < 0 ? "" : text.slice(0, i + 1);
}

/** The part being typed now: everything after the last `/`. */
export function mentionLeaf(text: string): string {
  const i = text.lastIndexOf("/");
  return i < 0 ? text : text.slice(i + 1);
}

/**
 * The entries of one directory that match what is typed so far.
 *
 * A name that starts with the text beats one that merely holds it. Hidden
 * files stay hidden until the reader asks for them by typing the dot, which is
 * the rule every shell uses.
 */
export function filterEntries(entries: PathEntry[], leaf: string, limit = 50): PathEntry[] {
  const l = leaf.toLowerCase();
  const wantsHidden = leaf.startsWith(".");
  return entries
    .filter((e) => wantsHidden || !e.name.startsWith("."))
    .map((e) => ({ e, rank: rank(e.name.toLowerCase(), l) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.e);
}

/** Lower is better. -1 drops the entry. The daemon's order holds within a rank. */
function rank(name: string, leaf: string): number {
  if (leaf === "") return 0;
  if (name.startsWith(leaf)) return 0;
  if (name.includes(leaf)) return 1;
  return -1;
}

/**
 * The draft after the reader takes a row.
 *
 * A directory ends in `/` and leaves the menu open, so the next keystroke
 * carries on into it. A file ends in a space, which closes the menu and starts
 * the next word — unless the sentence already has a space there, in which case
 * the caret steps over it rather than adding a second one.
 */
export function acceptMention(draft: string, mention: Mention, entry: PathEntry): { value: string; caret: number } {
  const after = draft.slice(mention.end);
  const end = entry.isDir ? "/" : after.startsWith(" ") ? "" : " ";
  const path = mentionDir(mention.text) + entry.name + end;
  return {
    value: draft.slice(0, mention.start) + "@" + path + after,
    // With no space of our own, the caret goes past the one already there, so
    // the finished mention does not hold the menu open.
    caret: mention.start + 1 + path.length + (end === "" ? 1 : 0),
  };
}

/** A row per entry: the name, and whether it is a directory. */
export function entryRows(entries: PathEntry[]): MenuRow[] {
  return entries.map((e) => ({ key: e.name, label: e.isDir ? `${e.name}/` : e.name, hint: e.isDir ? "directory" : "" }));
}
