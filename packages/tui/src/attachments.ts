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
