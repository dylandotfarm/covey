/**
 * A file a reader sends that is too big to carry inline: `POST /upload`.
 *
 * Every other attachment rides in the `turn.send` frame as base64, which is
 * the right trade up to `MAX_ATTACHMENT_BYTES` and the wrong one after it: the
 * sending client holds the file, its base64 and the whole command in memory at
 * once, and so does the daemon, which is about four times the file on each
 * end. A phone with a video of a bug cannot pay that, and shrinking — covey's
 * answer for a photograph — is no answer for a recording.
 *
 * So the bytes come up on their own, before the message: the client streams
 * them here, the route writes them straight into the thread's own file store,
 * and the `turn.send` that follows carries the path and no `data`. Neither end
 * ever holds the whole file. That is what lets `MAX_UPLOAD_BYTES` be as high
 * as it is — it bounds a worktree's disk and the reader's patience, not a
 * frame.
 *
 * Nothing here is trusted. The thread id must name a thread this daemon holds,
 * the name is cut down to one plain segment before it reaches the filesystem
 * (`reserveUploadPath`, which is `materialiseAttachments`' own rule), and the
 * body is counted as it arrives rather than believed from `content-length` —
 * a client is free to lie about that header, and a route that trusted it would
 * accept any number of bytes a liar wanted to send. A write that is refused or
 * cut short takes its half-written file with it, or a dropped connection would
 * leave the store holding a file the agent reads as whole.
 *
 * `authenticate` in `server.ts` is the whole gate, exactly as it is for
 * `/file` and for `terminal.open`: a client that may open a shell in the
 * thread's working directory may already write every file in it. The web
 * client's own setting has no say, for `/file`'s reason — the daemon that
 * holds the thread is very often not the one that served the page.
 */
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_UPLOAD_BYTES } from "@covey/protocol";

export interface UploadHooks {
  /**
   * Reserve a path in that thread's file store for a file called `name`, or
   * answer null for a thread this daemon does not hold. The store is made if
   * it is not there, and the name is taken, so two uploads of one name never
   * land on each other.
   */
  reserve(threadId: string, name: string): string | null;
  log?: (msg: string) => void;
  /**
   * What one file may weigh. Only a test moves it: the real cap is
   * `MAX_UPLOAD_BYTES`, and a test that had to send half a gigabyte to watch
   * the route refuse it would write that much through a machine's disk.
   */
  cap?: number;
}

/** Bytes as MiB to one decimal, so a limit reads as "512 MB" and a file as "38.1 MB". */
const mb = (n: number) => String(Math.round((n / (1024 * 1024)) * 10) / 10);

/** Say why, in one line, the way every other route here does. */
function refuse(res: ServerResponse, status: number, why: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`upload: ${why}\n`);
}

/** The body went over the ceiling while it was arriving. Its own class, so the catch can tell it from a disk that filled. */
class OverTheCap extends Error {
  constructor(readonly cap: number) { super("over the cap"); }
}

/**
 * Pass the bytes through, and stop the moment they go over `cap`.
 *
 * The count is what decides, never `content-length`: the header is the
 * client's claim about the body and this is the body.
 */
function capped(cap: number, onBytes: (n: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.byteLength;
      if (seen > cap) { cb(new OverTheCap(cap)); return; }
      onBytes(seen);
      cb(null, chunk);
    },
  });
}

/**
 * Answer `POST /upload?thread=…&name=…` with the path the bytes landed at.
 *
 * The caller has authenticated the request. The answer is JSON, because the
 * client has to put that path on the attachment it sends next and the store
 * may have renamed the file to keep it off another one of the same name.
 */
export async function serveThreadUpload(req: IncomingMessage, res: ServerResponse, hooks: UploadHooks): Promise<void> {
  if (req.method !== "POST") { refuse(res, 405, "a file is sent with POST"); return; }
  const url = new URL(req.url ?? "/", "http://x");
  const threadId = url.searchParams.get("thread") ?? "";
  const asked = (url.searchParams.get("name") ?? "").trim();
  if (!threadId) { refuse(res, 400, "name the thread the file belongs to"); return; }
  if (!asked) { refuse(res, 400, "name the file"); return; }
  // A `content-length` over the ceiling is refused before a byte is read, so a
  // reader who picked a 2 GB file hears about it at once rather than after the
  // upload. A courtesy, never the check: the body itself is counted below.
  const cap = hooks.cap ?? MAX_UPLOAD_BYTES;
  const declared = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    refuse(res, 413, `that file is over the ${mb(cap)} MB limit`);
    return;
  }
  const dest = hooks.reserve(threadId, asked);
  if (!dest) { refuse(res, 404, "no such thread on this machine"); return; }

  let written = 0;
  try {
    // `wx`, not the default `w`. `reserveUploadPath` creates nothing — the
    // route streams to the path it answers with — so two clients uploading one
    // name to one thread at the same moment are both handed `clip.mp4`, and
    // under `w` the second write would truncate the first. `EEXIST` lands in
    // the catch below, which already removes the file and says so, and that is
    // cheap insurance for a route whose whole promise is that a file in the
    // store is whole.
    await pipeline(req, capped(cap, (n) => { written = n; }), createWriteStream(dest, { flags: "wx" }));
  } catch (e: any) {
    // A half-written file in the store is worse than no file: the agent would
    // read it as whole, and `/file` would serve it. `EEXIST` is the one failure
    // where this request wrote nothing — `wx` refused because another upload
    // holds that path — so removing it here would take *their* whole file
    // instead, which is the bug the guard was added to prevent.
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") await rm(dest, { force: true }).catch(() => {});
    const { status, why } = uploadFailure(e);
    hooks.log?.(`upload of ${asked} for ${threadId} failed: ${why}`);
    if (!res.headersSent) refuse(res, status, why);
    else res.end();
    return;
  }
  hooks.log?.(`uploaded ${asked} (${mb(written)} MB) for thread ${threadId}`);
  const body = JSON.stringify({ path: dest, name: basename(dest), bytes: written });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * What to tell the reader about a failed upload. Three different problems, and
 * three different answers for the person holding the phone (#132): a file over
 * the cap is one they can do something about, a connection that dropped is one
 * to try again, and a disk that will not take it is the machine's.
 */
export function uploadFailure(e: unknown): { status: number; why: string } {
  if (e instanceof OverTheCap) return { status: 413, why: `that file is over the ${mb(e.cap)} MB limit` };
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || code === "ECONNABORTED") {
    return { status: 400, why: "the upload stopped before the file was whole" };
  }
  if (code === "ENOSPC") return { status: 507, why: "the machine has no room left for it" };
  if (code === "EEXIST") return { status: 409, why: "another upload took that name first; send it again" };
  return { status: 500, why: `could not write the file: ${(e as Error)?.message ?? e}` };
}
