import { basename, extname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@covey/protocol";

/**
 * Terminals do not deliver image *data* on drag-and-drop — they paste a path.
 * What exactly they paste varies:
 *
 *   iTerm2 / Terminal.app   /Users/me/shot\ 1.png      (backslash-escaped)
 *   kitty / ghostty         /Users/me/shot 1.png       (sometimes quoted)
 *   GNOME Terminal          file:///home/me/shot%201.png
 *
 * so the composer has to recognise all three shapes before deciding a paste was
 * really a drop.
 */

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Split a pasted chunk into candidate paths, honouring quotes and escapes. */
export function parseDroppedPaths(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out.map(fromFileUri);
}

function fromFileUri(p: string): string {
  if (!p.startsWith("file://")) return p;
  try { return decodeURIComponent(new URL(p).pathname); } catch { return p; }
}

/** Bytes as a MiB string, so limits read as "5 MB" not "5.24288 MB". */
const mb = (n: number) => String(Math.round((n / (1024 * 1024)) * 10) / 10);

export function imageMime(path: string): string | null {
  return IMAGE_EXT[extname(path).toLowerCase()] ?? null;
}

export interface DropResult {
  attachments: Attachment[];
  errors: string[];
}

/**
 * Interpret a pasted chunk as dropped image files. Returns nothing when the
 * chunk is ordinary text, so the caller can fall back to inserting it.
 */
export function readDroppedImages(raw: string): DropResult {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  const candidates = parseDroppedPaths(raw);
  // Every token has to look like an image path, otherwise this was prose that
  // happened to contain a filename and should be inserted as text.
  if (candidates.length === 0 || !candidates.every((p) => imageMime(p))) return { attachments, errors };
  for (const path of candidates) {
    const mimeType = imageMime(path)!;
    try {
      const size = statSync(path).size;
      if (size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${basename(path)} is ${mb(size)} MB (limit ${mb(MAX_ATTACHMENT_BYTES)} MB)`);
        continue;
      }
      attachments.push({ name: basename(path), path, mimeType, data: readFileSync(path).toString("base64") });
    } catch {
      errors.push(`could not read ${path}`);
    }
  }
  return { attachments, errors };
}

/**
 * A pending attachment and the exact text that stands for it in the draft.
 *
 * The tag is ordinary text. Nothing protects it from an edit, and that is the
 * point: if the user deletes the tag, `keepTagged` drops the file on send. The
 * tag never reaches the wire — `Attachment` on the protocol has no `tag` field.
 */
export interface TaggedAttachment extends Attachment {
  tag: string;
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

/** Give each attachment a tag that is unique against `taken` and the others. */
export function tagAttachments(atts: Attachment[], taken: string): TaggedAttachment[] {
  const out: TaggedAttachment[] = [];
  let seen = taken;
  for (const a of atts) {
    const tag = makeTag(a.name, seen);
    seen += `\n${tag}`;
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
