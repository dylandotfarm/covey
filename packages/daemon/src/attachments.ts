import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync, rmSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, isImageMime, type Attachment } from "@covey/protocol";
import { dataDir } from "./config.js";

/**
 * Attachments arrive from the TUI with their bytes inline, because the TUI may
 * be driving a daemon on a different machine where the dropped path means
 * nothing. The daemon writes them once into the thread's own file store and
 * hands back attachments that point at that copy, with `data` stripped — the
 * timeline item is persisted and re-sent on every snapshot, so it must stay
 * small.
 */

/**
 * The thread's file store: `<cwd>/.covey/threads/<thread id>/files`.
 *
 * It sits in the directory the thread works in, not in the daemon's data dir,
 * so a dropped file is beside the work: the agent opens `.covey/threads/…`
 * with a relative path, and the files go when the worktree goes.
 *
 * `<cwd>/.covey/.gitignore` holds `*`, so the store never reaches
 * `git status`, a diff, or a turn checkpoint.
 */
export function threadFilesDir(cwd: string, threadId: string): string {
  return join(cwd, ".covey", "threads", threadId, "files");
}

/** Where the copies of what a thread put on a pull request live (#105). */
export function attachmentsDir(threadId: string): string {
  return join(dataDir(), "attachments", threadId);
}

export class AttachmentError extends Error {}

/** Bytes as a whole-number MiB string, so limits read as "5 MB" not "5.24288 MB". */
const mb = (n: number) => String(Math.round((n / (1024 * 1024)) * 10) / 10);

/**
 * Write the inline bytes of every attachment into the thread's file store.
 *
 * Everything here came off the wire, so nothing here is trusted: the bytes are
 * counted against the same limit the client applies, and every name is cut
 * down to plain segments before it reaches the filesystem. An attachment must
 * not be able to write outside the store.
 */
export function materialiseAttachments(cwd: string, threadId: string, atts: Attachment[]): Attachment[] {
  if (atts.length === 0) return [];
  const root = threadFilesDir(cwd, threadId);
  mkdirSync(root, { recursive: true });
  ignoreStore(cwd);
  const taken = new Set<string>();
  const dirs = new Map<string, string>();
  let total = 0;
  return atts.map((a) => {
    if (!a.data) {
      // No inline bytes: only usable if the path happens to be on this machine.
      if (!existsSync(a.path)) throw new AttachmentError(`attachment ${a.name} has no data and ${a.path} does not exist on this machine`);
      return { ...a };
    }
    const buf = unpack(a);
    total += buf.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`the attachments on this message come to ${mb(total)} MB, over the ${mb(MAX_ATTACHMENT_BYTES)} MB limit`);
    }
    // A dropped directory is one folder under the store, and every file of it
    // keeps the path it had inside; a dropped file is one name at the top.
    let dest: string;
    if (a.dir) {
      let folder = dirs.get(a.dir);
      if (!folder) { folder = unique(root, safeName(a.dir), taken); dirs.set(a.dir, folder); }
      dest = join(root, folder, ...safeSegments(a.name));
      if (!within(join(root, folder), dest)) throw new AttachmentError(`attachment ${a.name} names a path outside the thread's files`);
    } else {
      dest = join(root, unique(root, safeName(a.name), taken));
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    const { data: _data, packing: _packing, ...rest } = a;
    return { ...rest, path: dest };
  });
}

/** The bytes of an attachment, however the client packed them for the wire. */
function unpack(a: Attachment): Buffer {
  const buf = Buffer.from(a.data!, "base64");
  if (a.packing !== "gzip") return buf;
  try {
    return gunzipSync(buf);
  } catch (e: any) {
    throw new AttachmentError(`attachment ${a.name} did not unpack: ${e?.message ?? e}`);
  }
}

/**
 * The parts of a name that may become directories, with everything that could
 * climb out of the store removed. `..`, a leading `/` and a drive letter all
 * go, so the worst a hostile name can do is land somewhere else inside the
 * thread's own files.
 */
function safeSegments(name: string): string[] {
  return name.split(/[\\/]+/).map((p) => p.trim().replace(/^[A-Za-z]:$/, "")).filter((p) => p && p !== "." && p !== "..");
}

/** One safe segment: a name for a file or a folder at the top of the store. */
function safeName(name: string): string {
  return safeSegments(name).join("-") || "file";
}

/** True when `path` really is inside `root`, symbolic links aside. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A name nothing in the store has yet. The file keeps the name it was dropped
 * under wherever it can — `shot.png`, not a uuid — because that name is what
 * the reader wrote in the message and what the agent goes looking for.
 */
function unique(dir: string, name: string, taken: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    if (!taken.has(candidate) && !existsSync(join(dir, candidate))) { taken.add(candidate); return candidate; }
  }
}

/**
 * Keep `.covey` out of git, wherever the thread works.
 *
 * A worktree in a checkout is already under a `.covey` that ignores itself,
 * but a worktree beside a bare clone is not, and neither is a project a thread
 * works in directly. The file is written once and never again, so a repository
 * that ignores `.covey` its own way is left alone.
 */
function ignoreStore(cwd: string): void {
  try {
    const ignore = join(cwd, ".covey", ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  } catch { /* best effort; the files matter more than the status */ }
}

/** Drop a thread's file store, for a thread being deleted. */
export function removeThreadFiles(cwd: string, threadId: string): void {
  rmSync(join(cwd, ".covey", "threads", threadId), { recursive: true, force: true });
}

/**
 * Keep a copy of a file the thread put on its pull request (#105), in the
 * daemon's own data dir rather than in the thread's file store: the copy is
 * what a person re-uploads by hand when the attachment URL dies, and it has to
 * outlive the worktree to be worth keeping.
 *
 * @returns the path of the copy.
 */
export function keepAttachmentFile(threadId: string, path: string, name: string): string {
  const dir = attachmentsDir(threadId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}${extname(name) || extname(path) || ""}`);
  copyFileSync(path, dest);
  return dest;
}

/**
 * Build the SDK content blocks for a turn. Images become real `image` blocks so
 * the model actually sees them; anything else is referenced by path so the
 * agent can open it with its own tools.
 *
 * A path under `cwd` is named relative to it, because that is the path the
 * agent types. A dropped directory is one line, not one line per file: the
 * agent is told where the tree is and how big it is, and reads what it needs.
 */
export function attachmentBlocks(atts: Attachment[], cwd?: string): { blocks: unknown[]; noteLines: string[] } {
  const blocks: unknown[] = [];
  const noteLines: string[] = [];
  const shown = (p: string) => {
    if (!cwd) return p;
    const rel = relative(cwd, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const dirs = new Set<string>();
  for (const a of atts) {
    if (a.dir) {
      if (dirs.has(a.dir)) continue;
      dirs.add(a.dir);
      const files = atts.filter((x) => x.dir === a.dir);
      // `name` is the path the file had inside the dropped directory, so the
      // folder in the store is that many levels up from the file.
      let at = a.path;
      for (let i = a.name.split("/").filter((x) => x && x !== ".").length; i > 0; i--) at = dirname(at);
      noteLines.push(`Attached directory: ${a.dir} (${shown(at)}, ${files.length} file${files.length === 1 ? "" : "s"})`);
      continue;
    }
    if (isImageMime(a.mimeType) && existsSync(a.path) && statSync(a.path).size <= MAX_IMAGE_BYTES) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mimeType, data: readFileSync(a.path).toString("base64") },
      });
      noteLines.push(`Attached image: ${a.name} (${shown(a.path)})`);
    } else {
      // The store may have renamed the file to keep two drops of one name
      // apart, so the line carries the name it was dropped under as well.
      noteLines.push(`Attached file: ${a.name} (${shown(a.path)})`);
    }
  }
  return { blocks, noteLines };
}
