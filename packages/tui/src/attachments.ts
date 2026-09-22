import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, extname, isAbsolute, join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@covey/protocol";

/**
 * Terminals do not deliver file *data* on drag-and-drop — they paste a path.
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

/**
 * Media types for the files people drop that are not images. The daemon sends
 * anything outside `IMAGE_EXT` to the agent by path, so this table only has to
 * label the file; an unknown extension gets the generic type.
 */
const FILE_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".zip": "application/zip",
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

/** The media type to send with a dropped file. Never null: unknown is generic. */
export function fileMime(path: string): string {
  return imageMime(path) ?? FILE_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A file that is really on this machine. A drop always pastes an absolute
 * path, so the rule keeps prose such as "see README.md and fix it" as text.
 */
function isLocalFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * A name that says a file was meant even though this machine does not hold it.
 * An image extension is the one such promise: the drop then reports "could not
 * read" instead of putting a path in the composer as text.
 */
function looksLikeImage(path: string): boolean {
  return imageMime(path) !== null;
}

/**
 * Join the tokens back into the paths they came from.
 *
 * A terminal that escapes or quotes every space gives one token per file, but
 * one missed space — which is what a real screenshot name gets — breaks a path
 * into several tokens, and then the whole drop used to land in the draft as
 * text (#85). So each position takes the *longest* run of tokens that names a
 * file on this machine, and, failing that, the longest run that names an
 * image. A position that matches neither makes the whole chunk prose.
 *
 * @returns the paths, or null when the chunk is not a drop.
 */
export function groupDroppedPaths(tokens: string[]): string[] | null {
  const paths: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const run = longestRun(tokens, i);
    if (!run) return null;
    paths.push(run.path);
    i = run.end;
  }
  return paths.length > 0 ? paths : null;
}

/** The longest run of tokens from `i` that names a file. */
function longestRun(tokens: string[], i: number): { path: string; end: number } | null {
  // A file that is there beats a longer run that only promises to be one, so a
  // missing `/a/one.png` after a real `/a/two.png` cannot swallow both.
  for (const names of [isLocalFile, looksLikeImage]) {
    for (let end = tokens.length; end > i; end--) {
      const path = tokens.slice(i, end).join(" ");
      if (names(path)) return { path, end };
    }
  }
  return null;
}

export interface DropResult {
  attachments: Attachment[];
  /**
   * The names of the files this drop could not read, in drop order. The
   * composer puts each in the draft as a chip in an error state, because a
   * path on the screen helps nobody (#85).
   */
  unreadable: string[];
  errors: string[];
}

/**
 * Interpret a pasted chunk as dropped files. Returns nothing when the chunk is
 * ordinary text, so the caller can fall back to inserting it.
 */
export function readDroppedFiles(raw: string): DropResult {
  const attachments: Attachment[] = [];
  const unreadable: string[] = [];
  const errors: string[] = [];
  const paths = groupDroppedPaths(parseDroppedPaths(raw));
  if (!paths) return { attachments, unreadable, errors };
  for (const path of paths) {
    try {
      const size = statSync(path).size;
      if (size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${basename(path)} is ${mb(size)} MB (limit ${mb(MAX_ATTACHMENT_BYTES)} MB)`);
        unreadable.push(basename(path));
        continue;
      }
      attachments.push({ name: basename(path), path, mimeType: fileMime(path), data: readFileSync(path).toString("base64") });
    } catch {
      errors.push(`could not read ${path}`);
      unreadable.push(basename(path));
    }
  }
  return { attachments, unreadable, errors };
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * A terminal never tells the TUI that a copied *image* was pasted: cmd+v puts
 * text on the tty and an image produces nothing at all. So the composer binds
 * its own key and asks the platform instead.
 *
 * Every platform reader is a small command line program that covey does not
 * ship and does not depend on. The read stays optional: when no reader is
 * installed the result names the one to install, and everything else keeps
 * working.
 */
interface ClipboardReader {
  bin: string;
  args: string[];
  /** What to tell a user who has none of the readers for this platform. */
  install: string;
}

function clipboardReaders(): ClipboardReader[] {
  if (process.platform === "darwin") return [{ bin: "pngpaste", args: ["-"], install: "brew install pngpaste" }];
  if (process.platform === "win32") return [];
  return [
    { bin: "wl-paste", args: ["--no-newline", "--type", "image/png"], install: "install wl-clipboard" },
    { bin: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], install: "install xclip" },
  ];
}

/** The first 8 bytes of every PNG file. */
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

/** Headroom over the limit, so an oversized image reports a size, not ENOBUFS. */
const CLIPBOARD_BUFFER_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024;

/** One run of a clipboard reader. Injected so the tests need no binary. */
export type RunReader = (bin: string, args: string[]) => {
  stdout: Buffer | null;
  status: number | null;
  error?: NodeJS.ErrnoException;
};

const runReader: RunReader = (bin, args) => {
  const r = spawnSync(bin, args, { maxBuffer: CLIPBOARD_BUFFER_BYTES });
  return { stdout: r.stdout, status: r.status, error: r.error as NodeJS.ErrnoException | undefined };
};

export interface ClipboardResult {
  attachment?: Attachment;
  error?: string;
}

/**
 * Read an image from the system clipboard. Reports an error string in every
 * failure, including "no reader installed", so the composer can say one line
 * and carry on.
 */
export function readClipboardImage(run: RunReader = runReader): ClipboardResult {
  const readers = clipboardReaders();
  if (readers.length === 0) return { error: `covey cannot read the clipboard on ${process.platform}` };
  const absent: string[] = [];
  for (const reader of readers) {
    const r = run(reader.bin, reader.args);
    if (r.error?.code === "ENOENT") { absent.push(reader.install); continue; }
    if (r.error?.code === "ENOBUFS") return { error: `the clipboard image is over the ${mb(MAX_ATTACHMENT_BYTES)} MB limit` };
    if (r.error) return { error: `${reader.bin} failed: ${r.error.message}` };
    const buf = r.stdout;
    // pngpaste and xclip both exit non-zero when the clipboard holds no image;
    // wl-paste can exit 0 with nothing on stdout.
    if (r.status !== 0 || !buf || buf.byteLength === 0) return { error: "the clipboard has no image" };
    if (!buf.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC)) return { error: "the clipboard has no image" };
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      return { error: `the clipboard image is ${mb(buf.byteLength)} MB (limit ${mb(MAX_ATTACHMENT_BYTES)} MB)` };
    }
    try {
      return { attachment: saveClipboardImage(buf) };
    } catch {
      return { error: "could not write the clipboard image to a temporary file" };
    }
  }
  return { error: `to paste an image: ${absent.join(", or ")}` };
}

/**
 * Give the clipboard bytes a real file, so the attachment has a path that
 * points at something. The daemon still copies the bytes into its own data dir.
 */
function saveClipboardImage(buf: Buffer): Attachment {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const path = join(tmpdir(), `covey-clipboard-${randomUUID()}.png`);
  writeFileSync(path, buf);
  return { name: `clipboard-${stamp}.png`, path, mimeType: "image/png", data: buf.toString("base64") };
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

/** What a chip says about a file the drop could not read. */
export const UNREADABLE_SUFFIX = " — unreadable";

/**
 * Work out what a drop does to the composer: the tags go into the draft at the
 * caret, and the pending list comes back with the new files on the end.
 *
 * A drop first forgets the files whose tag the user already deleted, so a name
 * that is free again is free to use, and the count the composer holds matches
 * what the draft says.
 *
 * `unreadable` names the files the drop recognised but could not read. Each
 * gets a chip too, marked as the failure it is, so the reader sees which file
 * did not attach. The chip is text alone: no file stands behind it.
 */
export function applyDrop(draft: string, caret: number, dropped: Attachment[], pending: TaggedAttachment[], unreadable: string[] = []): { value: string; caret: number; attachments: TaggedAttachment[] } {
  const live = keepTagged(draft, pending);
  const tagged = tagAttachments(dropped, [draft, ...live.map((a) => a.tag)].join("\n"));
  let taken = [draft, ...live.map((a) => a.tag), ...tagged.map((a) => a.tag)].join("\n");
  const failed = unreadable.map((name) => {
    const tag = makeTag(`${name}${UNREADABLE_SUFFIX}`, taken);
    taken += `\n${tag}`;
    return tag;
  });
  const text = spliceTags(draft, caret, [...tagged.map((a) => a.tag), ...failed]);
  return { ...text, attachments: [...live, ...tagged] };
}
