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
 * Is this token a file that somebody dropped, rather than a word in a sentence?
 *
 * An image extension is enough on its own, so a dropped image that has since
 * moved still reports "could not read" instead of landing in the composer as
 * text. Every other file has to be an absolute path to a file that is really
 * there. Terminals always paste an absolute path on a drop, so that costs
 * nothing, and it keeps prose such as "see README.md and fix it" as text.
 */
function isDroppedFile(path: string): boolean {
  if (imageMime(path)) return true;
  if (!isAbsolute(path)) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

export interface DropResult {
  attachments: Attachment[];
  errors: string[];
}

/**
 * Interpret a pasted chunk as dropped files. Returns nothing when the chunk is
 * ordinary text, so the caller can fall back to inserting it.
 */
export function readDroppedFiles(raw: string): DropResult {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  const candidates = parseDroppedPaths(raw);
  // Every token has to look like a dropped file, otherwise this was prose that
  // happened to contain a filename and should be inserted as text.
  if (candidates.length === 0 || !candidates.every(isDroppedFile)) return { attachments, errors };
  for (const path of candidates) {
    try {
      const size = statSync(path).size;
      if (size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${basename(path)} is ${mb(size)} MB (limit ${mb(MAX_ATTACHMENT_BYTES)} MB)`);
        continue;
      }
      attachments.push({ name: basename(path), path, mimeType: fileMime(path), data: readFileSync(path).toString("base64") });
    } catch {
      errors.push(`could not read ${path}`);
    }
  }
  return { attachments, errors };
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
