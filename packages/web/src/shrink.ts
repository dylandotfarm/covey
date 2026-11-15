/**
 * The two things an attachment needs a browser for (#135): shrinking a
 * photograph, and streaming a file too big to carry inline.
 *
 * Bring a photograph under the API's image limit, in the browser.
 *
 * The TUI shells out to `sips`, `magick`, `convert` or `ffmpeg`, whichever the
 * machine has. A browser needs none of them: `createImageBitmap` decodes the
 * file with the same code that paints an `<img>` — which on a phone includes
 * the HEIC a camera writes — and a canvas draws it smaller. So the page can do
 * this on a machine that has no image tool at all, which a phone is.
 *
 * This is the one part of an attachment the page cannot test in node, so it is
 * the whole of this file and nothing else: `attach.ts` takes it as an argument.
 *
 * Two passes at most. The first scales alone, which costs nothing the model
 * would have read. The second is the one that costs quality, and it runs only
 * when scaling was not enough.
 */
import { MAX_IMAGE_BYTES, SHRINK_LONG_EDGE } from "@covey/protocol";
import { readUploadAnswer, uploadUrl } from "@covey/client";
import { fileMime, type PickedFile, type Shrinker, type Uploader } from "./attach.js";

/** The two passes, longest edge and JPEG quality, in the order they are tried. */
const PASSES: [number, number][] = [[SHRINK_LONG_EDGE, 0.85], [Math.round(SHRINK_LONG_EDGE / 2), 0.7]];

/**
 * Draw `bitmap` at `edge` on its long side and encode it as JPEG.
 *
 * JPEG, not WebP or PNG: it is the one encoding every browser writes, it is a
 * media type the API reads, and a photograph is what this scales.
 */
async function encode(bitmap: ImageBitmap, edge: number, quality: number): Promise<Uint8Array | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A photograph has no transparency, and JPEG has none either: the white
  // keeps a PNG with an alpha channel from coming out on a black background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The page's shrinker. Answers null when the browser cannot decode the file,
 * and then the file travels whole and the agent opens it by path.
 */
export const shrinkInBrowser: Shrinker = async (file: PickedFile) => {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([await file.bytes() as BlobPart], { type: file.type || "image/jpeg" }));
  } catch {
    return null;
  }
  try {
    for (const [edge, quality] of PASSES) {
      const bytes = await encode(bitmap, edge, quality);
      if (bytes && bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes, mimeType: "image/jpeg" };
    }
    return null;
  } finally {
    bitmap.close();
  }
};

/**
 * A picked file, and the `File` it came from.
 *
 * `PickedFile` hides the browser's own object on purpose, so the shared reader
 * depends on no platform's idea of one. The uploader does need it — a 200 MB
 * video goes to the daemon as a body the browser streams, never as bytes this
 * page read first — and the one maker of these is below, so the `File` rides
 * along under a name the uploader can ask for. It is `DeviceFile`'s `uri` on
 * the phone, and for the same reason.
 */
export interface BrowserFile extends PickedFile {
  raw: File;
}

/**
 * Stream one large file to the daemon that holds the thread (`POST /upload`).
 *
 * `XMLHttpRequest` and not `fetch`, for the one thing it still does better: it
 * says how much of the body has gone. A `fetch` of a 200 MB video leaves the
 * reader one unchanging line for four minutes, which reads as a page that hung.
 *
 * The `File` goes as the body, so the browser streams it off the disk and this
 * page never holds it — which is the whole reason the ceiling can be as high
 * as it is. `base` is the thread's own machine as an HTTP origin with its
 * token, because an upload from the page carries no header the socket would
 * have carried.
 */
export function uploadInBrowser(base: string, threadId: string, onProgress: (name: string, sent: number, total: number) => void): Uploader {
  return (file) => new Promise((done, fail) => {
    const raw = (file as BrowserFile).raw;
    const name = file.name || "file";
    if (!(raw instanceof Blob)) { fail(new Error("this browser gave covey no file to send")); return; }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl(base, threadId, name));
    xhr.setRequestHeader("content-type", fileMime(file));
    xhr.upload.onprogress = (e) => onProgress(name, e.loaded, e.total || file.size);
    xhr.onload = () => { try { done(readUploadAnswer(xhr.status, xhr.responseText)); } catch (e) { fail(e as Error); } };
    xhr.onerror = () => fail(new Error("the machine could not be reached"));
    xhr.onabort = () => fail(new Error("the upload stopped"));
    xhr.send(raw);
  });
}

/** A `File` from a picker, a paste or a drag, behind the shape `attach.ts` reads. */
export function picked(file: File): BrowserFile {
  return {
    raw: file,
    name: file.name || "file",
    type: file.type,
    size: file.size,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}
