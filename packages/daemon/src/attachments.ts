import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync } from "node:fs";
import { extname, join } from "node:path";
import { MAX_ATTACHMENT_BYTES, isImageMime, type Attachment } from "@covey/protocol";
import { dataDir } from "./config.js";

/**
 * Attachments arrive from the TUI with their bytes inline, because the TUI may
 * be driving a daemon on a different machine where the dropped path means
 * nothing. We write them into the daemon's own data dir once and hand back
 * attachments that point at that local copy, with `data` stripped — the
 * timeline item is persisted and re-sent on every snapshot, so it must stay
 * small.
 */
export function attachmentsDir(threadId: string): string {
  return join(dataDir(), "attachments", threadId);
}

export class AttachmentError extends Error {}

/** Bytes as a whole-number MiB string, so limits read as "5 MB" not "5.24288 MB". */
const mb = (n: number) => String(Math.round((n / (1024 * 1024)) * 10) / 10);

export function materialiseAttachments(threadId: string, atts: Attachment[]): Attachment[] {
  if (atts.length === 0) return [];
  const dir = attachmentsDir(threadId);
  mkdirSync(dir, { recursive: true });
  return atts.map((a) => {
    if (!a.data) {
      // No inline bytes: only usable if the path happens to be on this machine.
      if (!existsSync(a.path)) throw new AttachmentError(`attachment ${a.name} has no data and ${a.path} does not exist on this machine`);
      return { ...a };
    }
    const buf = Buffer.from(a.data, "base64");
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`attachment ${a.name} is ${mb(buf.byteLength)} MB, over the ${mb(MAX_ATTACHMENT_BYTES)} MB limit`);
    }
    const ext = extname(a.name) || extname(a.path) || "";
    const dest = join(dir, `${randomUUID()}${ext}`);
    writeFileSync(dest, buf);
    const { data: _drop, ...rest } = a;
    return { ...rest, path: dest };
  });
}

/**
 * Keep a copy of a file the thread put on its pull request (#105), beside the
 * files that were dropped on it. The copy is what a person re-uploads by hand
 * when the attachment URL dies, and the name in the note says which is which.
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
 */
export function attachmentBlocks(atts: Attachment[]): { blocks: unknown[]; noteLines: string[] } {
  const blocks: unknown[] = [];
  const noteLines: string[] = [];
  for (const a of atts) {
    if (isImageMime(a.mimeType) && existsSync(a.path) && statSync(a.path).size <= MAX_ATTACHMENT_BYTES) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mimeType, data: readFileSync(a.path).toString("base64") },
      });
      noteLines.push(`Attached image: ${a.name} (${a.path})`);
    } else {
      // The daemon renamed the file to a uuid when it copied it, so the line
      // has to carry the name the file was dropped under as well as the path.
      noteLines.push(`Attached file: ${a.name} (${a.path})`);
    }
  }
  return { blocks, noteLines };
}
