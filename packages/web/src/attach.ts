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
  IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_UPLOAD_BYTES, isImageMime,
  type Attachment,
} from "@covey/protocol";
import { imageSizeOfBytes, megabytes, overImageEdge, tooLargeToUpload, type FailedDrop, type ImageSize } from "@covey/client";

/** A file the reader picked, as much of it as this file needs. */
export interface PickedFile {
  name: string;
  /** What the browser calls it. Empty for a file whose type it cannot name. */
  type: string;
  size: number;
  /**
   * The two edges, when the picker named them. The phone's photo roll does;
   * a browser's `File` does not, and there `readPicked` reads them out of the
   * header once the bytes are in hand. Either way the answer decides the same
   * thing — whether this picture is over `MAX_IMAGE_EDGE` — so a picker that
   * knows only saves covey a read, and one that does not costs nothing.
   */
  width?: number;
  height?: number;
  bytes(): Promise<Uint8Array>;
}

/**
 * Bring an image under `MAX_IMAGE_BYTES` and `MAX_IMAGE_EDGE`, or into a media
 * type the model accepts, or answer null when the browser cannot decode it.
 *
 * `shape` is what covey measured, when it measured anything: the picker's own
 * answer, or the one `readPicked` read out of the header. A shrinker that has
 * to know which edge is the long one should take it from here rather than
 * guess, or a photograph picked as a *document* is scaled differently from the
 * same photograph picked from the roll.
 */
export type Shrinker = (file: PickedFile, shape?: ImageSize) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface ReadResult {
  attachments: Attachment[];
  /** The files the page could not attach, in the order they were picked. */
  failed: FailedDrop[];
  /** What attached, but not the way the reader meant. */
  warnings: string[];
  /**
   * The files too big to carry inline, which the reader has not been asked
   * about yet (`largeDropPrompt`). Not failures: covey can send one, over
   * `POST /upload`, once they say so — and `readConfirmed` is what does it.
   *
   * The picked files themselves, not a copy of their names, because the upload
   * needs the thing the picker handed over. **Nothing of one has been read**:
   * a video is the one file a phone cannot hold in memory, and finding out
   * that covey will stream it must not cost the whole file first.
   */
  large: PickedFile[];
}

/**
 * Stream one file to the daemon that holds the thread, and answer with the
 * path of the copy it made.
 *
 * Each client's own, like `Shrinker`, because only the platform knows how to
 * send a file it holds without reading it: the page posts the `File` the
 * browser gave it, and the phone hands a `content://` URI to the native
 * uploader. Both end at the same route.
 */
export type Uploader = (file: PickedFile) => Promise<{ path: string; name?: string }>;

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

/**
 * The shape a picker reported, when it reported both edges. One edge alone is
 * enough to *refuse* a picture and not enough to scale one, so this answers
 * undefined and the shrinker falls back to what it can measure itself.
 */
function shapeOf(file: PickedFile): ImageSize | undefined {
  return file.width && file.height ? { width: file.width, height: file.height } : undefined;
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
 *
 * A file over what is left of that cap is neither read nor refused: it goes to
 * `large`, and the caller asks the reader before `readConfirmed` streams it.
 * The size the picker reported is what decides, because deciding from the bytes
 * would mean holding a video in memory to find out that covey will not put one
 * there.
 */
export async function readPicked(files: PickedFile[], shrink: Shrinker, already = 0): Promise<ReadResult> {
  const attachments: Attachment[] = [];
  const failed: FailedDrop[] = [];
  const warnings: string[] = [];
  const large: PickedFile[] = [];
  let total = already;
  for (const file of files) {
    let name = file.name || "file";
    let mimeType = fileMime(file);
    let bytes: Uint8Array | null = null;
    // One picture is scaled at most once, whether or not the scaling worked.
    // A heavy photograph that is also too wide would otherwise be offered to
    // the canvas twice and, when the canvas cannot do it, leave the reader two
    // warnings about one file.
    let tried = false;
    // One picture, one scaling, and three reasons to want it. Over
    // `MAX_IMAGE_BYTES` is the weight the API refuses. Over `MAX_IMAGE_EDGE`
    // on a side is the *shape* it refuses, once a conversation carries a few
    // pictures — a different set of files, because a phone photograph is
    // 1.5 MB and 4096 px wide (#236). And a type the API will not read at all
    // — an iPhone photograph is `image/heic`, which only the phone can decode.
    // All three come back as JPEG, which is what the model reads.
    const scale = async (why: string, shape?: ImageSize) => {
      tried = true;
      let smaller: { bytes: Uint8Array; mimeType: string } | null = null;
      try { smaller = await shrink(file, shape); } catch { smaller = null; }
      if (!smaller) { warnings.push(why); return; }
      bytes = smaller.bytes;
      mimeType = smaller.mimeType;
      // The name is what the file is called in the store and what the agent
      // opens, so it has to say what the bytes are: an `IMG_0001.HEIC` that
      // holds JPEG is a file nothing on the machine can read.
      name = renamed(name, mimeType);
    };
    const heavy = `${name} is ${megabytes(file.size)} MB and this browser could not scale it down. It goes as a file the agent can open, but the model cannot see an image over ${megabytes(MAX_IMAGE_BYTES)} MB.`;
    // Worded from the edges covey has, not from two it assumed: a picker that
    // named a width and no height would otherwise write "4096xundefined",
    // which is #132 in miniature.
    const shapeLabel = (w?: number, h?: number) => (w && h ? `${w}x${h}` : `${w || h} px on a side`);
    const wide = (w?: number, h?: number) => `${name} is ${shapeLabel(w, h)} and this browser could not scale it down. It goes as a file the agent can open, but the model cannot see an image over ${MAX_IMAGE_EDGE} px on a side once a conversation holds a few of them.`;
    const unreadableType = `${name} is ${mimeType}, which the model cannot read, and this browser could not convert it. It goes as a file the agent can open. The model reads ${IMAGE_MIME_TYPES.join(", ")}.`;

    if (isPicture(mimeType)) {
      if (file.size > MAX_IMAGE_BYTES) await scale(heavy);
      else if (overImageEdge(file.width, file.height)) await scale(wide(file.width, file.height), shapeOf(file));
      else if (!isImageMime(mimeType)) await scale(unreadableType);
    }
    // Nothing has been read yet, so this is the one chance to decide from the
    // size alone. A shrunk image already holds its bytes and is small by
    // construction, so it is past this.
    if (!bytes && file.size > MAX_ATTACHMENT_BYTES - total) {
      if (file.size > MAX_UPLOAD_BYTES) failed.push(tooLargeToUpload(name, file.size));
      else large.push(file);
      continue;
    }
    if (!bytes) {
      try { bytes = await file.bytes(); } catch (e) { failed.push(unreadable(name, e)); continue; }
    }
    // The edge the picker never reported. A browser's `File` carries a size
    // and no shape, so this is where covey learns it — out of the header of
    // bytes it was going to read anyway, which is why asking costs nothing.
    if (!tried && isPicture(mimeType)) {
      const edges = imageSizeOfBytes(bytes);
      // The shape goes to the shrinker as well as to the warning: it is the
      // only measurement anybody has for a file whose picker named none.
      if (overImageEdge(edges?.width, edges?.height)) await scale(wide(edges!.width, edges!.height), edges!);
    }
    // The backstop, for a picker that reported no size at all: the bytes are
    // in hand, so there is nothing left to save by uploading them instead.
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
  return { attachments, failed, warnings, large };
}

/**
 * Send the files the reader confirmed, one at a time, and make an attachment
 * for each that arrived.
 *
 * The attachment carries no `data`: the bytes are on the daemon already, and
 * `path` is where that daemon put them. One at a time rather than all at once,
 * because two uploads over one mobile link finish no sooner together and the
 * reader can read one line of progress.
 */
export async function readConfirmed(files: PickedFile[], upload: Uploader): Promise<{ attachments: Attachment[]; failed: FailedDrop[] }> {
  const attachments: Attachment[] = [];
  const failed: FailedDrop[] = [];
  for (const file of files) {
    const name = file.name || "file";
    try {
      const sent = await upload(file);
      attachments.push({ name, path: sent.path, mimeType: fileMime(file) });
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      failed.push({ name, chip: "did not go up", message: `${name} did not reach the machine: ${why}` });
    }
  }
  return { attachments, failed };
}

/** True when the read produced something the composer has to show or ask about. */
export function isDrop(r: ReadResult): boolean {
  return r.attachments.length > 0 || r.failed.length > 0 || r.large.length > 0;
}

/** What the composer says while a drop is being read, or a message sent. */
export function attachingLabel(files: { name: string }[]): string {
  return files.length === 1 ? `reading ${files[0]!.name}…` : `reading ${files.length} files…`;
}

/** What the composer says while the bytes of a message go over the wire. */
export function sendingLabel(bytes: number): string {
  return bytes === 0 ? "sending…" : `sending ${megabytes(bytes)} MB…`;
}
