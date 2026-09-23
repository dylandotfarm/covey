/**
 * A file a thread holds, served to the phone's client (#135).
 *
 * The page can now attach a photograph, and the bytes of it are on the daemon
 * from the moment it is sent: `materialiseAttachments` writes them into the
 * thread's file store and strips them off the timeline item, so what comes
 * back over the socket is a name and a path and nothing to look at.
 *
 * So the page asks for the bytes, `GET /file?thread=<id>&path=<path>`, and the
 * daemon answers with them. A route rather than a copy the page keeps, because
 * a route survives a reload, and it works for a file somebody else dropped from
 * another client — which is the whole reason the store is the daemon's.
 *
 * Nothing here is trusted. The path came off the wire, so it is resolved and
 * checked against that one thread's store, and a path anywhere else is refused
 * before any read. The route is gated by the same authentication as the socket,
 * in `server.ts`, and is on only with the web client.
 */
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Media types the page renders. Anything else is served as bytes to download,
 * because a type the daemon guessed wrong is a script the browser runs.
 */
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
};

/**
 * The file a request names, or null when it names none this thread holds.
 *
 * Pure, so a test can hand it every shape of hostile path. `root` is the
 * thread's own file store; the answer is always inside it.
 */
export function threadFileTarget(root: string, path: string | null): string | null {
  if (!path) return null;
  const file = resolve(path);
  // Strictly inside: the store itself is a directory, and a sibling whose name
  // merely starts with the store's is not the store.
  if (!file.startsWith(resolve(root) + sep)) return null;
  return file;
}

/** What to answer a request for `file` with: its media type, and whether the page may show it. */
export function fileHeaders(file: string): { type: string; inline: boolean } {
  const type = TYPES[extname(file).toLowerCase()];
  // An SVG is a document the browser runs scripts in, so it downloads rather
  // than renders: the bytes came from whoever dropped it.
  if (!type || type === "image/svg+xml") return { type: "application/octet-stream", inline: false };
  return { type, inline: true };
}

/** The one byte range a request asks for, or null when it asks for the whole file. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || size === 0) return null;
  const [, from, to] = m;
  // `bytes=-500` is the last 500 bytes, which is how a player reads an index.
  let start = from ? Number(from) : size - Number(to || size);
  let end = from ? (to ? Number(to) : size - 1) : size - 1;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end };
}

/**
 * Answer `GET /file?thread=…&path=…`. The caller has authenticated the request
 * and checked that the web client is on; `rootOf` says where that thread keeps
 * its files, and answers null for a thread this daemon does not hold.
 */
export function serveThreadFile(req: IncomingMessage, res: ServerResponse, rootOf: (threadId: string) => string | null): void {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url ?? "/", "http://x");
  const threadId = url.searchParams.get("thread");
  const root = threadId ? rootOf(threadId) : null;
  if (!root) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("file: no such thread on this machine\n");
    return;
  }
  const file = threadFileTarget(root, url.searchParams.get("path"));
  if (!file) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("file: the path must be one of that thread's own files\n");
    return;
  }
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("file: the thread no longer holds that file\n");
    return;
  }
  const { type, inline } = fileHeaders(file);
  // The bytes never change under a path — the store gives a second drop of one
  // name a name of its own — so the page may keep them for as long as it likes.
  const headers: Record<string, string | number> = {
    "content-type": type,
    "cache-control": "private, max-age=86400",
    "accept-ranges": "bytes",
    ...(inline ? {} : { "content-disposition": "attachment" }),
  };
  // A video seeks by asking for a range, and Safari will not play one at all
  // from a source that answers the whole file to such a request.
  const range = byteRange(req.headers.range, size);
  if (range) {
    res.writeHead(206, { ...headers, "content-length": range.end - range.start + 1, "content-range": `bytes ${range.start}-${range.end}/${size}` });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}
