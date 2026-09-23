/**
 * What the page does with a file the reader picked (#135).
 *
 * The browser hands over the bytes, which is the one thing a terminal never
 * does: `<input type="file">` opens the photo roll and the camera on a phone,
 * and a paste or a drag on a desktop gives the same `File`. So the page needs
 * none of the path parsing the TUI does — it reads, it shrinks, it packs, and
 * the wire shape is the one the TUI already sends.
 *
 * There is no DOM in this file and no browser API either, so node tests it.
 * A `File` comes in behind `PickedFile`, and the one thing only a browser can
 * do — decode an image and draw it smaller — comes in behind `Shrinker`.
 * `shrink.ts` holds the real one.
 */
import {
  IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, isImageMime, type Attachment,
} from "@covey/protocol";
import { megabytes, type FailedDrop } from "@covey/client";

/** A file the reader picked, as much of it as this file needs. */
export interface PickedFile {
  name: string;
  /** What the browser calls it. Empty for a file whose type it cannot name. */
  type: string;
  size: number;
  bytes(): Promise<Uint8Array>;
}

/**
 * Bring an image under `MAX_IMAGE_BYTES`, or into a media type the model
 * accepts, or answer null when the browser cannot decode it.
 */
export type Shrinker = (file: PickedFile) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface ReadResult {
  attachments: Attachment[];
  /** The files the page could not attach, in the order they were picked. */
  failed: FailedDrop[];
  /** What attached, but not the way the reader meant. */
  warnings: string[];
}

/**
 * Media types by extension, for a browser that names none. A phone always
 * names the type of a photograph; a file from a cloud drive often has none.
 */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown",
  ".txt": "text/plain", ".csv": "text/csv", ".log": "text/plain",
  ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/plain", ".jsx": "text/plain",
  ".py": "text/plain", ".sh": "text/plain", ".html": "text/html", ".css": "text/css",
};

/** The extension of a name, lowercase, with its dot. Empty when it has none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The media type to send with a picked file. Never empty: unknown is generic. */
export function fileMime(file: { name: string; type: string }): string {
  return file.type || EXT_MIME[extensionOf(file.name)] || "application/octet-stream";
}

/**
 * True when the file is a picture, whatever its media type is called. An iPhone
 * hands over `image/heic`, which is a picture the model cannot read, so "is it
 * an image" and "may the model see it" are two questions (`isImageMime` is the
 * second).
 */
export function isPicture(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

/**
 * Base64 for the wire.
 *
 * `btoa` takes a string of bytes, and a 5 MB photograph is longer than the
 * argument list a spread of it would build, so the string is made a chunk at a
 * time. 8192 is under every engine's limit and few enough iterations to be
 * unmeasurable beside the decode that came before it.
 */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

/**
 * The name a converted image takes: the same name, with the extension of what
 * it now is. `shot.png` shrunk to JPEG becomes `shot.jpg`.
 */
export function renamed(name: string, mimeType: string): string {
  const ext = Object.entries(EXT_MIME).find(([, m]) => m === mimeType)?.[0];
  if (!ext || extensionOf(name) === ext) return name;
  const had = extensionOf(name);
  return `${had ? name.slice(0, name.length - had.length) : name}${ext}`;
}

/** A file that is over what covey carries, in the reader's words. */
function tooBig(name: string, size: number, room: number): FailedDrop {
  const chip = `${megabytes(size)} MB, over the limit`;
  const message = room < MAX_ATTACHMENT_BYTES
    ? `${name} is ${megabytes(size)} MB and only ${megabytes(room)} MB of the ${megabytes(MAX_ATTACHMENT_BYTES)} MB a message carries is left. Send it on its own, or send fewer files.`
    : `${name} is ${megabytes(size)} MB, over the ${megabytes(MAX_ATTACHMENT_BYTES)} MB a message carries. Put it on the machine and tell the agent where it is.`;
  return { name, chip, message };
}

/** A file the browser handed over but would not read. */
function unreadable(name: string, e: unknown): FailedDrop {
  const why = (e as Error)?.message ?? String(e);
  return { name, chip: "could not be read", message: `${name} could not be read: ${why}` };
}

/**
 * Read every picked file into an attachment, and say why each failure failed.
 *
 * `already` is what the composer is holding, so the running total is the whole
 * message and not this one drop. The page counts against
 * `MAX_ATTACHMENT_BYTES` itself rather than letting the daemon answer, because
 * on a phone the upload is the cost: a refusal that arrives after 30 MB went
 * over a mobile link is a refusal that arrived too late.
 */
export async function readPicked(files: PickedFile[], shrink: Shrinker, already = 0): Promise<ReadResult> {
  const attachments: Attachment[] = [];
  const failed: FailedDrop[] = [];
  const warnings: string[] = [];
  let total = already;
  for (const file of files) {
    let name = file.name || "file";
    let mimeType = fileMime(file);
    let bytes: Uint8Array | null = null;
    // Two limits, not one. An image goes through the canvas when it is over
    // `MAX_IMAGE_BYTES`, and also when its type is one the API refuses — an
    // iPhone photograph is `image/heic`, which only the phone can decode. Both
    // come back as JPEG, which is what the model reads.
    if (isPicture(mimeType) && (file.size > MAX_IMAGE_BYTES || !isImageMime(mimeType))) {
      let smaller: { bytes: Uint8Array; mimeType: string } | null = null;
      try { smaller = await shrink(file); } catch { smaller = null; }
      if (smaller) {
        bytes = smaller.bytes;
        mimeType = smaller.mimeType;
        // The name is what the file is called in the store and what the agent
        // opens, so it has to say what the bytes are: an `IMG_0001.HEIC` that
        // holds JPEG is a file nothing on the machine can read.
        name = renamed(name, mimeType);
      }
      else if (file.size > MAX_IMAGE_BYTES) {
        warnings.push(`${name} is ${megabytes(file.size)} MB and this browser could not scale it down. It goes as a file the agent can open, but the model cannot see an image over ${megabytes(MAX_IMAGE_BYTES)} MB.`);
      } else {
        warnings.push(`${name} is ${mimeType}, which the model cannot read, and this browser could not convert it. It goes as a file the agent can open. The model reads ${IMAGE_MIME_TYPES.join(", ")}.`);
      }
    }
    if (!bytes) {
      try { bytes = await file.bytes(); } catch (e) { failed.push(unreadable(name, e)); continue; }
    }
    if (total + bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      failed.push(tooBig(name, bytes.byteLength, MAX_ATTACHMENT_BYTES - total));
      continue;
    }
    total += bytes.byteLength;
    // `path` is the machine's path in the TUI's drop and there is none here,
    // so the name stands in. The daemon writes the inline bytes into the
    // thread's file store and puts its own path here before it persists
    // anything, so nothing downstream reads this one.
    attachments.push({ name, path: name, mimeType, data: toBase64(bytes) });
  }
  return { attachments, failed, warnings };
}

/** True when the read produced something the composer has to show. */
export function isDrop(r: ReadResult): boolean {
  return r.attachments.length > 0 || r.failed.length > 0;
}

/** What the composer says while a drop is being read, or a message sent. */
export function attachingLabel(files: { name: string }[]): string {
  return files.length === 1 ? `reading ${files[0]!.name}…` : `reading ${files.length} files…`;
}

/** What the composer says while the bytes of a message go over the wire. */
export function sendingLabel(bytes: number): string {
  return bytes === 0 ? "sending…" : `sending ${megabytes(bytes)} MB…`;
}
