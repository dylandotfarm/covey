/**
 * Get one of a thread's files onto this machine, as a PNG the terminal can
 * paint (#163).
 *
 * This is the impure half of `media.ts`: it reaches the network and it runs
 * other programs. The rules it follows are the ones covey already has.
 *
 * **The bytes come from the daemon, over the route that already exists.**
 * `GET /file?thread=…&path=…` serves a thread's own files, carries the same
 * token as the socket, and refuses a path outside that thread's store. It
 * answers from whichever daemon holds the thread, so a reader on a laptop opens
 * a screenshot made on a machine anywhere — which is the case a `file://` path
 * cannot serve, and the reason no protocol change was needed here.
 *
 * **PNG or nothing.** kitty reads PNG, 24-bit RGB and 32-bit RGBA, and no other
 * format. So a JPEG is converted and a video becomes its first frame, with the
 * same four tools `attachments.ts` already looks for — `sips`, `magick`,
 * `convert`, `ffmpeg`, whichever the machine has. covey adds no decoder and no
 * native dependency for this.
 *
 * **A terminal is not a screen.** Everything is scaled to `PREVIEW_LONG_EDGE`
 * before it is sent, because the pane is a few hundred cells and the picture
 * travels to the terminal as base64. A 12 MB screenshot would be 16 MB of
 * escape on one write for a picture 90 columns wide.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "@covey/protocol";
import { pngSize } from "./media.js";

/**
 * The longest edge, in pixels, of a picture covey sends to the terminal.
 *
 * Not `SHRINK_LONG_EDGE`: that constant is the model's own, and this one is
 * about a pane. 1600 covers a full-width preview on a retina terminal at a
 * fraction of the bytes.
 */
export const PREVIEW_LONG_EDGE = 1600;

/** How long one conversion may take before covey gives up on it. */
const CONVERT_TIMEOUT_MS = 20_000;

/** What a reader may be shown, once it is a PNG. */
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);

/** True when this name is a video, so the preview is its first frame. */
export function isVideoName(name: string): boolean {
  return VIDEO_EXTS.has(extname(name).toLowerCase());
}

/** True when covey will try to paint this name at all. */
export function isPaintableName(name: string): boolean {
  const e = extname(name).toLowerCase();
  return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e);
}

export interface Preview {
  /** The PNG to transmit. */
  png: Buffer;
  /** Its size in pixels, which `mediaBox` needs to keep its shape. */
  width: number;
  height: number;
  /** True when this is one frame of a video and not the whole of a picture. */
  poster: boolean;
}

/**
 * Fetch one file and make a PNG of it.
 *
 * Every failure comes back as a sentence rather than an exception, because
 * every one of them is something the reader has to be told: the daemon is not
 * there, the file is not there, the machine has no tool to convert it. One word
 * for four problems is what made a screenshot read as "unreadable" for weeks
 * (#132).
 */
export async function loadPreview(uri: string, name: string): Promise<Preview | { error: string }> {
  if (!isPaintableName(name)) return { error: `covey cannot paint ${extname(name) || "a file with no extension"}` };
  const got = await fetchFile(uri);
  if ("error" in got) return got;
  const dir = mkdtempSync(join(tmpdir(), "covey-preview-"));
  const src = join(dir, "src" + (extname(name).toLowerCase() || ".bin"));
  try {
    writeFileSync(src, got.bytes);
  } catch (e) {
    return { error: `could not write the file to ${dir}: ${msg(e)}` };
  }
  const poster = isVideoName(name);
  const png = await toPng(src, join(dir, "out.png"), poster);
  if ("error" in png) return png;
  const size = pngSize(png.bytes);
  // A tool that answered 0 and wrote something that is not a PNG is a tool that
  // failed without saying so. Sizing off a guess would paint a stretched
  // picture, which reads as a covey bug rather than a missing converter.
  if (!size) return { error: `${png.by} wrote something that is not a PNG` };
  return { png: png.bytes, width: size.width, height: size.height, poster };
}

/** Read the file off the daemon's `/file` route. */
async function fetchFile(uri: string): Promise<{ bytes: Buffer } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(uri, { redirect: "error" });
  } catch (e) {
    return { error: `could not reach the machine that holds this file: ${msg(e)}` };
  }
  if (!res.ok) {
    // The route answers a refusal as plain text that says which of the four
    // things went wrong. That sentence is better than anything covey could
    // write from the status, so pass it on.
    const said = (await res.text().catch(() => "")).trim();
    return { error: said ? short(said, 160) : `the machine answered ${res.status}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // The same cap the wire carries on one drop. A file over it exists on the
  // daemon and opens in a browser; it is only the preview that is refused.
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
    return { error: `this file is ${mb(buf.byteLength)} MB, over the ${mb(MAX_ATTACHMENT_BYTES)} MB preview limit` };
  }
  if (buf.byteLength === 0) return { error: "the file is empty" };
  return { bytes: buf };
}

/**
 * One way to write a PNG, in the order covey tries them.
 *
 * The same four tools as `SHRINKERS` in `attachments.ts`, and the same rule: a
 * tool that is not on this machine fails to spawn, and the next one is tried.
 * `sips` is first because macOS always has it and covey already uses it.
 */
const PNG_WRITERS: { cmd: string; args: (src: string, dst: string, edge: number) => string[] }[] = [
  { cmd: "sips", args: (src, dst, edge) => ["-Z", String(edge), "-s", "format", "png", src, "--out", dst] },
  { cmd: "magick", args: (src, dst, edge) => [src + "[0]", "-resize", `${edge}x${edge}>`, dst] },
  { cmd: "convert", args: (src, dst, edge) => [src + "[0]", "-resize", `${edge}x${edge}>`, dst] },
  { cmd: "ffmpeg", args: (src, dst, edge) => ["-y", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", `scale='min(${edge},iw)':-2`, dst] },
];

/**
 * One frame of a video, which only `ffmpeg` can do.
 *
 * `-ss` before `-i` seeks, so a long film costs no more than a short one, and
 * one second in rather than at zero because the first frame of a screen
 * recording is very often a blank desktop. A clip shorter than that gets
 * nothing from the seek, so the whole thing is tried again from the start.
 */
const POSTER_WRITERS: { cmd: string; args: (src: string, dst: string, edge: number) => string[] }[] = [
  { cmd: "ffmpeg", args: (src, dst, edge) => ["-y", "-loglevel", "error", "-ss", "1", "-i", src, "-frames:v", "1", "-vf", `scale='min(${edge},iw)':-2`, dst] },
  { cmd: "ffmpeg", args: (src, dst, edge) => ["-y", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", `scale='min(${edge},iw)':-2`, dst] },
];

/** Run each tool in turn until one writes a PNG. */
async function toPng(src: string, dst: string, poster: boolean): Promise<{ bytes: Buffer; by: string } | { error: string }> {
  const writers = poster ? POSTER_WRITERS : PNG_WRITERS;
  let last = "";
  for (const w of writers) {
    const ran = await run(w.cmd, w.args(src, dst, PREVIEW_LONG_EDGE));
    if (!ran.ok) { last = ran.why; continue; }
    try {
      if (statSync(dst).size === 0) { last = `${w.cmd} wrote an empty file`; continue; }
      return { bytes: readFileSync(dst), by: w.cmd };
    } catch (e) {
      last = `${w.cmd} wrote nothing: ${msg(e)}`;
    }
  }
  const tools = poster ? "ffmpeg" : "sips, magick, convert or ffmpeg";
  return { error: `this machine has no tool to make a picture of it (covey looks for ${tools})${last ? ` — ${short(last, 90)}` : ""}` };
}

/**
 * Spawn one tool. Never a shell: the path comes from a timeline item, so it
 * must not be read as a command line.
 */
function run(cmd: string, args: string[]): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true });
      const why = (stderr || "").trim() || err.message;
      resolve({ ok: false, why: `${cmd}: ${why}` });
    });
  });
}

/**
 * The id one picture holds in the terminal for as long as it is open.
 *
 * It starts above the small numbers another program in the same terminal is
 * likely to have used, and it is never 0, which kitty reads as "no id". One id
 * per open rather than one per file: the reader may open the same picture at
 * two sizes, and the second must not paint at the first one's rectangle.
 */
let nextId = 0x0c0000;
export function nextImageId(): number {
  nextId = nextId >= 0xffffff ? 0x0c0000 : nextId + 1;
  return nextId;
}


function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function mb(n: number): string { return (n / (1024 * 1024)).toFixed(1); }
function short(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}
