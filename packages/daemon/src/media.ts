/**
 * Media for the web client, from a private repository (#110).
 *
 * GitHub serves a user attachment, `github.com/user-attachments/assets/<id>`,
 * only to a request that carries the account's token: with none it answers
 * 404, and with one it answers 302 to a signed link on its store, good for
 * five minutes, which then serves to anyone. A phone's browser holds no
 * GitHub token, so an image in an issue of a private repository is a broken
 * image there. The daemon holds a token through `gh`.
 *
 * So the page asks the daemon, `GET /media?url=<attachment>`, and the daemon
 * asks GitHub with the token and answers the phone with the same redirect.
 * The bytes never pass through the daemon, a range request for a video goes
 * straight to the store, and the browser caches the answer for a little less
 * than the link lives.
 *
 * Only the two hosts GitHub uses for an attachment go through here; the
 * daemon is not a proxy for the web. The route is gated by the same
 * authentication as the socket, in `server.ts`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GH_CWD } from "./repos.js";

const run = promisify(execFile);

/** The hosts an attachment lives on. Anything else is refused before any request. */
const MEDIA_HOSTS = new Set(["github.com", "private-user-images.githubusercontent.com", "user-images.githubusercontent.com"]);

/** How long the phone may reuse the redirect. GitHub's link lives five minutes. */
const CACHE_SECONDS = 240;

/**
 * The attachment URL a media request names, or null when it names none this
 * daemon will ask for. Pure, so a test can hand it every shape of URL.
 */
export function mediaTarget(raw: string | null): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || !MEDIA_HOSTS.has(u.hostname)) return null;
  if (u.hostname === "github.com" && !u.pathname.startsWith("/user-attachments/assets/")) return null;
  u.hash = "";
  return u.toString();
}

export interface MediaOptions {
  /** The network. A test hands in a function that reaches nothing. */
  fetch?: typeof fetch;
  /** The token `gh` holds, or null when it holds none. A test hands in a constant. */
  token?: () => Promise<string | null>;
}

/**
 * The `gh` token, read once and kept for a while: a page loads many images at
 * once, and one `gh auth token` per image is one process per image. A login
 * that changes is picked up within the cache time.
 */
let cached: { token: string | null; at: number } | null = null;
const TOKEN_CACHE_MS = 5 * 60_000;
export async function ghToken(): Promise<string | null> {
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
  let token: string | null;
  try {
    token = (await run("gh", ["auth", "token"], { cwd: GH_CWD, timeout: 15_000 })).stdout.trim() || null;
  } catch {
    token = null;
  }
  cached = { token, at: Date.now() };
  return token;
}

/**
 * Where GitHub sends a request for the attachment: the signed link, or the
 * status GitHub answered when it sent it nowhere. Pure but for the network
 * and the token, both of which a test hands in.
 */
export async function resolveMedia(url: string, o: MediaOptions = {}): Promise<{ location: string } | { status: number }> {
  const token = await (o.token ?? ghToken)();
  const res = await (o.fetch ?? fetch)(url, {
    method: "GET",
    redirect: "manual",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // The body is not wanted, whatever it is; let the socket go.
  await res.body?.cancel().catch(() => undefined);
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) return { location };
  return { status: res.status };
}

/**
 * Answer `GET /media?url=…`. The caller has authenticated the request and
 * checked that the web client is on; this reads the target, refuses one that
 * is not an attachment, and forwards GitHub's redirect.
 */
export async function serveMedia(req: IncomingMessage, res: ServerResponse, o: MediaOptions = {}): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url ?? "/", "http://x");
  const target = mediaTarget(url.searchParams.get("url"));
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("media: the url must be a GitHub user attachment\n");
    return;
  }
  let answer: { location: string } | { status: number };
  try {
    answer = await resolveMedia(target, o);
  } catch (e: any) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`media: could not reach GitHub: ${e?.message ?? e}\n`);
    return;
  }
  if ("location" in answer) {
    res.writeHead(302, { location: answer.location, "cache-control": `private, max-age=${CACHE_SECONDS}` });
    res.end();
    return;
  }
  res.writeHead(answer.status === 404 ? 404 : 502, { "content-type": "text/plain; charset=utf-8" });
  res.end(answer.status === 404 ? "media: GitHub has no such attachment for this account; is gh logged in on this machine?\n" : `media: GitHub answered ${answer.status}\n`);
}
