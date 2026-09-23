/**
 * What an attachment looks like in a composer, for every client that has one.
 *
 * The rules here are text rules, and nothing in them touches a file or a DOM,
 * so the TUI and the page share them: a pending file reads as a word in the
 * draft, `[shot.png]`, and that word is the only record of the file. Delete the
 * word and the file does not go. Both clients had to agree on this, because a
 * thread is one conversation whichever client is looking at it.
 *
 * Reading the bytes is each client's own problem — a terminal is handed a path
 * and a browser is handed a `File` — and so is painting the chip. This file is
 * the part between them.
 */
import type { Attachment } from "@covey/protocol";

/**
 * A pending attachment and the exact text that stands for it in the draft.
 *
 * The tag is ordinary text. Nothing protects it from an edit, and that is the
 * point: if the user deletes the tag, `keepTagged` drops the file on send. The
 * tag never reaches the wire — `Attachment` on the protocol has no `tag` field.
 */
export interface TaggedAttachment extends Attachment {
  tag: string;
  /**
   * True when the chip stands for a file that did not attach. Nothing goes
   * over the wire for one: it is in the list so that backspace can take the
   * whole chip out in one key, and so that a later drop cannot take its tag.
   */
  failed?: true;
}

/**
 * A file the client could not attach, and why — issue #132.
 *
 * Four different problems used to reach the composer as the one word
 * "unreadable": a file that is not there, a file the client may not read, a
 * file over the size cap, and everything else. They want four different
 * answers from the reader, so the chip carries the reason and the notice
 * carries the path and what to do about it.
 */
export interface FailedDrop {
  name: string;
  /** What the chip says after the name. Short: it sits in the draft. */
  chip: string;
  /** The notice line: the path, the reason, and the way out. */
  message: string;
}

/** Bytes as a whole-number MiB string, so a limit reads as "5 MB" not "5.24288 MB". */
export function megabytes(n: number): string {
  return String(Math.round((n / (1024 * 1024)) * 10) / 10);
}

/**
 * Build the tag for a file. `taken` is the text the tag must not appear in:
 * the draft, plus the tags already in use. A second `shot.png` therefore gets
 * `[shot.png 2]`, and so does a first one when the user typed `[shot.png]`
 * into the draft by hand.
 */
export function makeTag(name: string, taken: string): string {
  // A bracket or a newline in the name would break the tag into two pieces of
  // text, and then no exact match can find it again.
  const safe = name.replace(/[[\]\r\n]/g, "_").trim() || "file";
  let tag = `[${safe}]`;
  for (let n = 2; taken.includes(tag); n++) tag = `[${safe} ${n}]`;
  return tag;
}

/**
 * Give each attachment a tag that is unique against `taken` and the others.
 *
 * Every file of one dropped directory shares one tag, and that tag names the
 * directory: a person dropped one thing, so the draft shows one chip and
 * deleting it drops the whole tree.
 */
export function tagAttachments(atts: Attachment[], taken: string): TaggedAttachment[] {
  const out: TaggedAttachment[] = [];
  const byDir = new Map<string, string>();
  let seen = taken;
  for (const a of atts) {
    let tag = a.dir ? byDir.get(a.dir) : undefined;
    if (!tag) {
      tag = makeTag(a.dir ? `${a.dir}/` : a.name, seen);
      seen += `\n${tag}`;
      if (a.dir) byDir.set(a.dir, tag);
    }
    out.push({ ...a, tag });
  }
  return out;
}

/**
 * Put the tags into `value` at `caret`, so the file reads as a word in the
 * sentence. Adds the space on each side only when the draft lacks one. The
 * trailing space goes in at the end of the draft too, because the user types
 * the next word there and it must not touch the tag.
 */
export function spliceTags(value: string, caret: number, tags: string[]): { value: string; caret: number } {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const chunk = lead + tags.join(" ") + trail;
  return { value: before + chunk + after, caret: caret + chunk.length };
}

/** Keep the attachments whose tag is still in the text. */
export function keepTagged<T extends TaggedAttachment>(text: string, atts: T[]): T[] {
  return atts.filter((a) => text.includes(a.tag));
}

/** What a chip says about a file that did not attach: the name, then why. */
export const chipLabel = (f: FailedDrop): string => `${f.name} — ${f.chip}`;

/**
 * Work out what a drop does to the composer: the tags go into the draft at the
 * caret, and the pending list comes back with the new files on the end.
 *
 * A drop first forgets the files whose tag the user already deleted, so a name
 * that is free again is free to use, and the count the composer holds matches
 * what the draft says.
 *
 * `failed` names the files the client recognised but could not attach. Each
 * gets a chip too, carrying the reason it failed, so the reader sees which file
 * did not attach and why (#132). The chip is text alone: no file stands behind
 * it.
 */
export function applyDrop(draft: string, caret: number, dropped: Attachment[], pending: TaggedAttachment[], unattached: FailedDrop[] = []): { value: string; caret: number; attachments: TaggedAttachment[] } {
  const live = keepTagged(draft, pending);
  const tagged = tagAttachments(dropped, [draft, ...live.map((a) => a.tag)].join("\n"));
  let taken = [draft, ...live.map((a) => a.tag), ...tagged.map((a) => a.tag)].join("\n");
  const failed: TaggedAttachment[] = unattached.map((f) => {
    const tag = makeTag(chipLabel(f), taken);
    taken += `\n${tag}`;
    return { name: f.name, path: "", mimeType: "", tag, failed: true };
  });
  // One tag per chip: a directory gave every file under it the same one.
  const tags = [...new Set([...tagged, ...failed].map((a) => a.tag))];
  const text = spliceTags(draft, caret, tags);
  return { ...text, attachments: [...live, ...tagged, ...failed] };
}

/**
 * The chip that covers `caret`, or null.
 *
 * A chip is ordinary text and nothing protects it, so the caret can sit inside
 * one. `back` says which key asked: backspace owns the end of a chip and the
 * inside of it, delete owns the start and the inside, so a caret between two
 * chips takes the one the key points at.
 */
export function tagSpanAt(text: string, caret: number, tags: string[], back: boolean): { start: number; end: number } | null {
  for (const tag of tags) {
    for (let from = 0; from <= text.length;) {
      const start = text.indexOf(tag, from);
      if (start < 0) break;
      const end = start + tag.length;
      if (back ? caret > start && caret <= end : caret >= start && caret < end) return { start, end };
      from = start + 1;
    }
  }
  return null;
}

/**
 * Take a chip out of the draft in one edit, with the space the drop put beside
 * it, so `see [shot.png] this` becomes `see this` and not `see  this`.
 */
export function cutTag(value: string, span: { start: number; end: number }): { value: string; caret: number } {
  let { start, end } = span;
  if (value[end] === " " && (start === 0 || /\s/.test(value[start - 1]!))) end++;
  else if (value[start - 1] === " " && (end === value.length || /\s/.test(value[end]!))) start--;
  return { value: value.slice(0, start) + value.slice(end), caret: start };
}
