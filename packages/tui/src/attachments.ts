import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, extname, isAbsolute, join } from "node:path";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import {
  IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, MAX_DIRECTORY_FILES, MAX_IMAGE_BYTES,
  PACK_ATTACHMENT_BYTES, type Attachment,
} from "@covey/protocol";

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
 * A file or a directory that is really on this machine. A drop always pastes
 * an absolute path, so the rule keeps prose such as "see README.md and fix it"
 * as text.
 *
 * A directory counts because a person drags one as readily as a file, and
 * covey now carries the tree (`readDirectoryAttachments`). Only a paste
 * reaches this: a directory path somebody *types* stays text.
 */
function isLocalPath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const s = statSync(path);
    if (s.isFile()) return true;
    // A path that ends at a separator is half of one: a terminal writing a
    // dropped path in two goes cuts it there more often than anywhere else,
    // and the directory it leaves behind is real (#130). A drop of a directory
    // pastes its name without the separator, so this costs that case nothing.
    return s.isDirectory() && !/[\\/]$/.test(path);
  } catch { return false; }
}

/**
 * A name that says a file was meant even though this machine does not hold it.
 * An image extension is the one such promise: the drop then reports "could not
 * read" instead of putting a path in the composer as text.
 *
 * The path must be absolute, like every other drop. A bare `shot.png` is what
 * the *second half* of a split drop looks like, and a half is not a drop: it
 * chipped the name and left the directory in the draft as text. `readSplitDrop`
 * is what puts the two halves back together.
 */
function looksLikeImage(path: string): boolean {
  return isAbsolute(path) && imageMime(path) !== null;
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
  for (const names of [isLocalPath, looksLikeImage]) {
    for (let end = tokens.length; end > i; end--) {
      const path = tokens.slice(i, end).join(" ");
      if (names(path)) return { path, end };
    }
  }
  return null;
}

/**
 * A file the drop could not attach, and why — issue #132.
 *
 * Four different problems used to reach the composer as the one word
 * "unreadable": a file that is not there, a file the terminal may not read, a
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

export interface DropResult {
  attachments: Attachment[];
  /**
   * The files this drop could not attach, in drop order. The composer puts
   * each in the draft as a chip in an error state, because a path on the
   * screen helps nobody (#85).
   */
  failed: FailedDrop[];
  /**
   * What attached, but not the way the reader meant. An image covey could not
   * bring under the API's own limit is the one case: it goes, and the agent
   * opens it as a file, but the model does not see the picture. A drop that
   * quietly changes what the agent gets has to say so (#132).
   */
  warnings: string[];
}

/**
 * Read one file into an attachment. A drop and a clipboard paste both come
 * through here, so the size cap, the media type and the name are one rule and
 * cannot drift apart (#124).
 *
 * An image over the cap is shrunk rather than refused (#132): a screenshot off
 * a retina display carries megabytes the model never sees, because the API
 * scales anything past its long edge down before it reads it.
 */
export function readFileAttachment(path: string): { attachment?: Attachment; failure?: FailedDrop; warning?: string } {
  const name = basename(path);
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e: any) {
    return { failure: statFailure(name, path, e) };
  }
  let read = path;
  let mimeType = fileMime(path);
  let warning: string | undefined;
  // Two limits, not one. An image over `MAX_IMAGE_BYTES` is scaled down,
  // because that is all the model would have read anyway; every other file
  // travels whole up to `MAX_ATTACHMENT_BYTES`, which is what covey carries.
  if (imageMime(path) && size > MAX_IMAGE_BYTES) {
    const smaller = shrinkImage(path);
    if (smaller) { read = smaller.path; mimeType = smaller.mimeType; size = statSync(read).size; }
    else warning = `${name} is ${mb(size)} MB and covey found no tool to shrink it (it looks for sips, magick, convert or ffmpeg on the PATH). It goes as a file the agent can open, but the model cannot see an image over ${mb(MAX_IMAGE_BYTES)} MB.`;
  }
  if (size > MAX_ATTACHMENT_BYTES) return { failure: tooBig(name, path, size) };
  try {
    return { attachment: { name, path: read, mimeType, ...packBytes(readFileSync(read)) }, warning };
  } catch (e: any) {
    return { failure: statFailure(name, path, e) };
  }
}

/**
 * Pack the bytes for the wire.
 *
 * A log, a source tree or a CSV goes over many times smaller deflated, which
 * is most of what makes a big drop bearable on a slow link. An image, a video
 * or an archive is already compressed and gains nothing, so the raw bytes go
 * whenever gzip saved less than a tenth — the unpacking is not worth it, and
 * base64 of a slightly larger buffer is slower than base64 of the file.
 */
export function packBytes(buf: Buffer): { data: string; packing?: "gzip" } {
  if (buf.byteLength < PACK_ATTACHMENT_BYTES) return { data: buf.toString("base64") };
  const packed = gzipSync(buf, { level: 6 });
  if (packed.byteLength > buf.byteLength * 0.9) return { data: buf.toString("base64") };
  return { data: packed.toString("base64"), packing: "gzip" };
}

/**
 * Read a dropped directory: one attachment per file, each carrying the path it
 * had inside the directory, so the daemon can lay the tree down again.
 *
 * covey sends the files rather than an archive because the point is for the
 * agent to *read* them. An archive in the store is one more thing to unpack
 * before anybody can open anything.
 *
 * `.git` never goes: it is large, it is binary, and an agent that wants the
 * history has the repository. A symbolic link never goes either, so a link
 * that points back up the tree cannot make the walk run forever.
 */
export function readDirectoryAttachments(path: string): { attachments: Attachment[]; failure?: FailedDrop } {
  const dir = basename(path) || path;
  const rels = walkDirectory(path, MAX_DIRECTORY_FILES + 1);
  if (rels.length === 0) {
    return { attachments: [], failure: { name: dir, chip: "no files in it", message: `${path} holds no files covey can send.` } };
  }
  if (rels.length > MAX_DIRECTORY_FILES) {
    return {
      attachments: [], failure: {
        name: dir, chip: `over ${MAX_DIRECTORY_FILES} files`,
        message: `${path} holds more than ${MAX_DIRECTORY_FILES} files. Drop the files you mean, or an archive of the directory.`,
      },
    };
  }
  const attachments: Attachment[] = [];
  let total = 0;
  for (const rel of rels) {
    const file = join(path, rel);
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch (e: any) {
      return { attachments: [], failure: statFailure(`${dir}/${rel}`, file, e) };
    }
    total += buf.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) return { attachments: [], failure: tooBigDirectory(dir, path, total) };
    attachments.push({ name: rel, path: file, mimeType: fileMime(file), dir, ...packBytes(buf) });
  }
  return { attachments };
}

/** Every file under `root`, as paths relative to it, sorted, up to `limit`. */
function walkDirectory(root: string, limit: number): string[] {
  const out: string[] = [];
  const todo = [""];
  while (todo.length > 0 && out.length < limit) {
    const rel = todo.shift()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === ".git" || e.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) todo.push(child);
      else if (e.isFile()) { out.push(child); if (out.length >= limit) break; }
    }
  }
  return out.sort();
}

/** The reason a `stat` or a `read` of a dropped path failed, in the reader's words. */
function statFailure(name: string, path: string, e: NodeJS.ErrnoException): FailedDrop {
  if (e?.code === "ENOENT") {
    return { name, chip: "not on this machine", message: `${path} is not on this machine. covey reads a dropped file where the client runs, so the file has to be there too.` };
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") {
    return {
      name, chip: "no permission",
      message: process.platform === "darwin"
        ? `${path} cannot be read: macOS withholds it from this terminal. Grant it the folder under System Settings → Privacy & Security → Files and Folders, then drop the file again.`
        : `${path} cannot be read: this user has no permission for it.`,
    };
  }
  return { name, chip: "unreadable", message: `could not read ${path}: ${e?.message ?? e}` };
}

function tooBig(name: string, path: string, size: number): FailedDrop {
  const limit = `${mb(MAX_ATTACHMENT_BYTES)} MB`;
  return {
    name, chip: `${mb(size)} MB, over the ${limit} limit`,
    message: imageMime(path)
      ? `${name} is ${mb(size)} MB, over the ${limit} limit, and covey found no tool to shrink it (it looks for sips, magick, convert or ffmpeg on the PATH). Scale it down and drop it again.`
      : `${name} is ${mb(size)} MB, over the ${limit} limit.`,
  };
}

function tooBigDirectory(name: string, path: string, size: number): FailedDrop {
  const limit = `${mb(MAX_ATTACHMENT_BYTES)} MB`;
  return {
    name, chip: `over the ${limit} limit`,
    message: `${path} comes to more than ${limit}, the limit on one drop. Drop the files you mean instead.`,
  };
}

/**
 * Read every dropped path into attachments, and say why each failure failed.
 *
 * A directory gives one attachment per file under it, all sharing one `dir`,
 * so the composer shows one chip for it. Two directories of one name in the
 * same drop get told apart here, before the name becomes a folder.
 */
function readFiles(paths: string[]): DropResult {
  const attachments: Attachment[] = [];
  const failed: FailedDrop[] = [];
  const warnings: string[] = [];
  const dirs = new Set<string>();
  for (const path of paths) {
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { /* the read below reports it */ }
    if (!isDir) {
      const { attachment, failure, warning } = readFileAttachment(path);
      if (attachment) attachments.push(attachment);
      else failed.push(failure!);
      if (warning) warnings.push(warning);
      continue;
    }
    const read = readDirectoryAttachments(path);
    if (read.failure) { failed.push(read.failure); continue; }
    const dir = uniqueDir(basename(path) || path, dirs);
    for (const a of read.attachments) attachments.push({ ...a, dir });
  }
  return { attachments, failed, warnings };
}

/** A directory name no other directory in this drop already took. */
function uniqueDir(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name} ${n}`;
  taken.add(out);
  return out;
}

/**
 * The long edge covey shrinks an oversized image to.
 *
 * The model never sees more than this: the API scales an image past its
 * resolution tier down before it reads it — 2576 px on the current models,
 * 1568 px on the standard tier — so taking a 5120 px screenshot down to 2576 px
 * costs nothing the model would have read, and takes a 12 MB PNG under the cap.
 * Scaling comes first and quality second, because heavy JPEG compression is
 * what makes the text in a screenshot hard to read.
 */
export const SHRINK_LONG_EDGE = 2576;

/** One way to shrink an image, in the order covey tries them. */
const SHRINKERS: { cmd: string; args: (src: string, dst: string, edge: number, quality: number) => string[] }[] = [
  // macOS ships `sips`, which covey already uses to read the clipboard.
  { cmd: "sips", args: (src, dst, edge, q) => ["-Z", String(edge), "-s", "format", "jpeg", "-s", "formatOptions", String(q), src, "--out", dst] },
  { cmd: "magick", args: (src, dst, edge, q) => [src, "-resize", `${edge}x${edge}>`, "-quality", String(q), dst] },
  { cmd: "convert", args: (src, dst, edge, q) => [src, "-resize", `${edge}x${edge}>`, "-quality", String(q), dst] },
  { cmd: "ffmpeg", args: (src, dst, edge, q) => ["-y", "-loglevel", "error", "-i", src, "-vf", `scale='min(${edge},iw)':-2`, "-q:v", String(Math.max(2, Math.round((100 - q) / 8))), dst] },
];

/**
 * Bring an oversized image under the cap, or answer null when this machine has
 * nothing to do it with. Two passes at most: the second only runs when scaling
 * alone was not enough, and it is the one that costs quality.
 */
export function shrinkImage(path: string, limit = MAX_IMAGE_BYTES): { path: string; mimeType: string } | null {
  for (const s of SHRINKERS) {
    for (const [edge, quality] of [[SHRINK_LONG_EDGE, 85], [Math.round(SHRINK_LONG_EDGE / 2), 70]] as const) {
      const dst = join(tmpdir(), `covey-shrunk-${randomUUID()}.jpg`);
      const r = spawnSync(s.cmd, s.args(path, dst, edge, quality), { stdio: "ignore" });
      if (r.error || r.status !== 0) break; // this tool is not here, or cannot do it: try the next
      let size: number;
      try { size = statSync(dst).size; } catch { break; }
      if (size <= limit) return { path: dst, mimeType: "image/jpeg" };
    }
  }
  return null;
}

/**
 * Interpret a pasted chunk as dropped files. Returns nothing when the chunk is
 * ordinary text, so the caller can fall back to inserting it.
 */
export function readDroppedFiles(raw: string): DropResult {
  const paths = groupDroppedPaths(parseDroppedPaths(raw));
  if (!paths) return { attachments: [], failed: [], warnings: [] };
  return readFiles(paths);
}

/**
 * True when a drop held nothing but directories.
 *
 * The composer asks because a directory that exists is also what half a
 * dropped path looks like once the terminal has cut it (#130): the seam gets
 * the first say, and the directory is taken only when no join reads better.
 */
export function isDirectoryDrop(d: DropResult): boolean {
  return d.failed.length === 0 && d.attachments.length > 0 && d.attachments.every((a) => !!a.dir);
}

/** True when the drop read nothing at all: no file, and no name to chip. */
export function isDrop(d: DropResult): boolean {
  return d.attachments.length > 0 || d.failed.length > 0;
}

/**
 * The start of the last path in `head`, or -1.
 *
 * A path begins at a token that begins with `/`, with `file://`, or with the
 * quote a terminal wrapped it in. Everything from there to the end of `head`
 * belongs to that path, spaces and all, because a name may hold spaces.
 */
function lastPathStart(head: string): number {
  let start = -1;
  for (const m of head.matchAll(/\S+/g)) {
    if (/^["']?(?:\/|file:\/\/)/.test(m[0])) start = m.index;
  }
  return start;
}

/**
 * A drop the terminal wrote in two goes.
 *
 * A drop is a paste of a path, and nothing makes a terminal write that path in
 * one go: a screenshot dropped on a Mac arrives as `…/TemporaryItems/` and then
 * `Screenshot 2026-09-22 at 6.36.33 PM.png`. Each half on its own is not a
 * drop, so the directory landed in the draft as text and the name became a chip
 * that said "unreadable" — one file, shown as two wrong things.
 *
 * So a chunk that fails to be a drop gets one more try: join it to the tail of
 * the draft that starts a path, and read that. The rule needs no clock and no
 * count of halves, so a drop split three ways joins on the third chunk as
 * readily as on the second. The caller decides how long a seam stays open.
 *
 * @param head the draft in front of the caret
 * @param raw the chunk that just arrived
 * @returns where in `head` the path starts, and what the join reads as
 */
export function readSplitDrop(head: string, raw: string): { start: number; drop: DropResult } | null {
  const start = lastPathStart(head);
  if (start < 0) return null;
  const drop = readDroppedFiles(head.slice(start) + raw);
  return isDrop(drop) ? { start, drop } : null;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * A terminal never tells the TUI what the clipboard holds: cmd+v puts text on
 * the tty, a copied file puts nothing there at all, and an image produces
 * nothing either. So the composer binds its own key and asks the platform.
 *
 * Three things reach the clipboard and all three mean "attach this" (#124):
 *
 *   a file      cmd+c in Finder, ctrl+c in Nautilus  -> a file URL, no bytes
 *   image bytes a screenshot, "Copy image" in a browser
 *   text        a path somebody copied, or prose
 *
 * covey asks what is there before it reads, takes a file over bytes, and takes
 * the bytes of any type the model accepts rather than PNG alone. Text is the
 * last answer, and goes back through the drop parser, so a copied path becomes
 * the file it names.
 *
 * Every platform reader is a small command line program. The macOS pair,
 * `osascript` and `sips`, ships with the system; `pngpaste` is a faster route
 * to the same bytes when somebody has it. On Linux nothing is shipped, so the
 * read stays optional: with no reader installed the result names the one to
 * install, and everything else keeps working.
 */

/** One run of a clipboard reader. Injected so the tests need no binary. */
export type RunReader = (bin: string, args: string[]) => {
  stdout: Buffer | null;
  status: number | null;
  error?: NodeJS.ErrnoException;
};

/** Headroom over the limit, so an oversized image reports a size, not ENOBUFS. */
const CLIPBOARD_BUFFER_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;

const runReader: RunReader = (bin, args) => {
  const r = spawnSync(bin, args, { maxBuffer: CLIPBOARD_BUFFER_BYTES });
  return { stdout: r.stdout, status: r.status, error: r.error as NodeJS.ErrnoException | undefined };
};

/** The first bytes of each image type the model accepts. */
export function imageMimeOfBytes(buf: Buffer): string | null {
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString("latin1");
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * The paths in a `text/uri-list`. GNOME's `x-special/gnome-copied-files` is the
 * same list under a `copy` or `cut` line, and a comment line starts with `#`;
 * both fall out of taking the `file://` lines alone.
 */
export function parseUriList(s: string): string[] {
  return s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("file://")).map(fromFileUri);
}

/** What a reader found on the clipboard. Exactly one of these is set. */
interface Found {
  paths?: string[];
  image?: { buf: Buffer; mime: string };
  text?: string;
}

/**
 * What one reader has to say. `absent` means the program is not installed and
 * the next reader should try; `empty` means the clipboard holds nothing this
 * reader can attach, and names what it does hold, for the line the user sees.
 */
type ReaderResult =
  | { found: Found }
  | { absent: true }
  | { empty: true; holds?: string[] }
  | { error: string };

interface ClipboardReader {
  /** What to tell a user who has none of the readers for this platform. */
  install: string;
  read(run: RunReader): ReaderResult;
}

/** Read image bytes from a command, and type them by their first bytes. */
function readImageBytes(run: RunReader, bin: string, args: string[]): ReaderResult {
  const r = run(bin, args);
  if (r.error?.code === "ENOENT") return { absent: true };
  if (r.error?.code === "ENOBUFS") return { error: `the clipboard image is over the ${mb(MAX_IMAGE_BYTES)} MB limit` };
  if (r.error) return { error: `${bin} failed: ${r.error.message}` };
  const buf = r.stdout;
  // A reader that has no image exits non-zero, or exits 0 with nothing.
  if (r.status !== 0 || !buf || buf.byteLength === 0) return { empty: true };
  const mime = imageMimeOfBytes(buf);
  if (!mime) return { empty: true };
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { error: `the clipboard image is ${mb(buf.byteLength)} MB (limit ${mb(MAX_IMAGE_BYTES)} MB)` };
  }
  return { found: { image: { buf, mime } } };
}

/** Read text from a command, for the last answer. */
function readText(run: RunReader, bin: string, args: string[]): ReaderResult {
  const r = run(bin, args);
  if (r.error?.code === "ENOENT") return { absent: true };
  if (r.error) return { error: `${bin} failed: ${r.error.message}` };
  const text = r.stdout?.toString() ?? "";
  return r.status === 0 && text.trim() ? { found: { text } } : { empty: true };
}

/** The type of a file list, when the clipboard has one. */
const FILE_LIST_TYPES = ["text/uri-list", "x-special/gnome-copied-files"];

/** One Linux reader: list the types, then read the best of them. */
function linuxReader(bin: string, install: string, list: string[], read: (type: string) => string[]): ClipboardReader {
  return {
    install,
    read(run) {
      const listing = run(bin, list);
      if (listing.error?.code === "ENOENT") return { absent: true };
      if (listing.error) return { error: `${bin} failed: ${listing.error.message}` };
      const types = (listing.stdout?.toString() ?? "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
      const fileType = types.find((t) => FILE_LIST_TYPES.includes(t));
      if (fileType) {
        const r = run(bin, read(fileType));
        const paths = parseUriList(r.stdout?.toString() ?? "");
        if (paths.length > 0) return { found: { paths } };
      }
      const imageType = types.find((t) => (IMAGE_MIME_TYPES as readonly string[]).includes(t));
      if (imageType) {
        const r = readImageBytes(run, bin, read(imageType));
        if (!("empty" in r)) return r;
      }
      const textType = types.find((t) => t === "text/plain;charset=utf-8" || t === "text/plain" || t === "UTF8_STRING" || t === "STRING");
      if (textType) {
        const r = readText(run, bin, read(textType));
        if (!("empty" in r)) return r;
      }
      return { empty: true, holds: types };
    },
  };
}

/**
 * macOS names the pasteboard's types in its own words: `«class furl»` for a
 * file, `«class PNGf»` and `TIFF picture` for an image. `clipboard info` lists
 * them, and nothing there needs installing.
 */
function macReader(): ClipboardReader {
  return {
    install: "brew install pngpaste",
    read(run) {
      const info = run("osascript", ["-e", "clipboard info"]);
      if (info.error?.code === "ENOENT") return { absent: true };
      if (info.error) return { error: `osascript failed: ${info.error.message}` };
      const types = (info.stdout?.toString() ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const holds = types.filter((_, i) => i % 2 === 0);
      // A file first: it has a name, and a name makes a better chip than
      // `clipboard-20260922.png`. AppleScript hands back the first file only,
      // so a copy of several files attaches one.
      if (holds.some((t) => t.includes("furl"))) {
        const r = run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
        const path = r.stdout?.toString().trim() ?? "";
        if (r.status === 0 && path) return { found: { paths: [path] } };
      }
      if (holds.some((t) => /PNGf|TIFF|JPEG|GIF/i.test(t))) {
        // pngpaste is one command and gives PNG; without it, the system's own
        // pair does the same job through a temporary file.
        const direct = readImageBytes(run, "pngpaste", ["-"]);
        if (!("absent" in direct) && !("empty" in direct)) return direct;
        const converted = macImageViaSips(run);
        if (!("empty" in converted)) return converted;
        // The pasteboard says it holds a picture and neither route got it.
        // `install` is the only line that helps, so ask for the reader rather
        // than report that there is no image, which is false.
        return { absent: true };
      }
      const text = run("pbpaste", []);
      if (!text.error && text.status === 0 && (text.stdout?.toString() ?? "").trim()) {
        return { found: { text: text.stdout!.toString() } };
      }
      return { empty: true, holds };
    },
  };
}

/**
 * Write the pasteboard's TIFF to a file and convert it with `sips`. Both
 * programs ship with macOS, so `ctrl+v` works on a Mac with nothing installed.
 */
function macImageViaSips(run: RunReader): ReaderResult {
  const tiff = join(tmpdir(), `covey-clipboard-${randomUUID()}.tiff`);
  const png = `${tiff}.png`;
  const script = [
    "set d to (the clipboard as «class TIFF»)",
    `set f to open for access POSIX file "${tiff}" with write permission`,
    "set eof f to 0",
    "write d to f",
    "close access f",
  ].join("\n");
  const wrote = run("osascript", ["-e", script]);
  if (wrote.error || wrote.status !== 0) return { empty: true };
  const made = run("sips", ["-s", "format", "png", tiff, "--out", png]);
  if (made.error || made.status !== 0) return { empty: true };
  try {
    const buf = readFileSync(png);
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return { error: `the clipboard image is ${mb(buf.byteLength)} MB (limit ${mb(MAX_IMAGE_BYTES)} MB)` };
    }
    const mime = imageMimeOfBytes(buf);
    return mime ? { found: { image: { buf, mime } } } : { empty: true };
  } catch {
    return { empty: true };
  }
}

/**
 * The readers to try, in order. The platform is an argument so a test can ask
 * for the macOS pair on any machine: covey is developed on Linux boxes that
 * have no pasteboard at all, and the macOS route is the one most people use.
 */
export function clipboardReadersFor(platform: NodeJS.Platform): ClipboardReader[] {
  if (platform === "darwin") return [macReader()];
  if (platform === "win32") return [];
  return [
    linuxReader("wl-paste", "install wl-clipboard", ["--list-types"], (t) => ["--no-newline", "--type", t]),
    linuxReader("xclip", "install xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], (t) => ["-selection", "clipboard", "-t", t, "-o"]),
  ];
}

export interface ClipboardResult {
  attachments: Attachment[];
  /** The files the clipboard named but covey could not attach, and why. */
  failed: FailedDrop[];
  /** What attached, but not the way the reader meant. See `DropResult`. */
  warnings: string[];
  errors: string[];
  /** Text, when that is all the clipboard held. The caller pastes it. */
  text?: string;
}

/**
 * Read whatever the clipboard holds: a file, an image, or text. Reports an
 * error string in every failure, including "no reader installed", so the
 * composer can say one line and carry on.
 */
export function readClipboard(run: RunReader = runReader, platform: NodeJS.Platform = process.platform): ClipboardResult {
  const nothing = (errors: string[]): ClipboardResult => ({ attachments: [], failed: [], warnings: [], errors });
  const readers = clipboardReadersFor(platform);
  if (readers.length === 0) return nothing([`covey cannot read the clipboard on ${platform}`]);
  const absent: string[] = [];
  let holds: string[] = [];
  for (const reader of readers) {
    const r = reader.read(run);
    if ("absent" in r) { absent.push(reader.install); continue; }
    if ("error" in r) return nothing([r.error]);
    if ("empty" in r) { holds = r.holds ?? holds; continue; }
    if (r.found.paths) return { ...readFiles(r.found.paths), errors: [] };
    if (r.found.image) {
      try {
        return { attachments: [saveClipboardImage(r.found.image.buf, r.found.image.mime)], failed: [], warnings: [], errors: [] };
      } catch {
        return nothing(["could not write the clipboard image to a temporary file"]);
      }
    }
    return { attachments: [], failed: [], warnings: [], errors: [], text: r.found.text };
  }
  if (absent.length === readers.length) return nothing([`to paste an image: ${absent.join(", or ")}`]);
  return nothing([holds.length > 0 ? `the clipboard holds ${holds.join(", ")}, which is not a file or an image` : "the clipboard has no file and no image"]);
}

/**
 * Give the clipboard bytes a real file, so the attachment has a path that
 * points at something. The daemon still copies the bytes into its own data dir.
 */
function saveClipboardImage(buf: Buffer, mime: string): Attachment {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const ext = Object.entries(IMAGE_EXT).find(([, m]) => m === mime)?.[0] ?? ".png";
  const path = join(tmpdir(), `covey-clipboard-${randomUUID()}${ext}`);
  writeFileSync(path, buf);
  return { name: `clipboard-${stamp}${ext}`, path, mimeType: mime, data: buf.toString("base64") };
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
  /**
   * True when the chip stands for a file that did not attach. Nothing goes
   * over the wire for one: it is in the list so that backspace can take the
   * whole chip out in one key, and so that a later drop cannot take its tag.
   */
  failed?: true;
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
 * `failed` names the files the drop recognised but could not attach. Each gets
 * a chip too, carrying the reason it failed, so the reader sees which file did
 * not attach and why (#132). The chip is text alone: no file stands behind it.
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
