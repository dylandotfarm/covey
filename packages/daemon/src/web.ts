/**
 * The web client, served by the daemon.
 *
 * Three roots, one URL prefix each, and nothing else on disk is reachable:
 *
 *   /            → packages/web/static/index.html
 *   /static/*    → packages/web/static/*        the page, its style, its manifest
 *   /app/*       → packages/web/dist/*          the page's own modules, from `tsc -b`
 *   /lib/<pkg>/* → packages/<pkg>/dist/*        `protocol` and `client`, which the
 *                                                page imports by their package names
 *                                                through the import map in index.html
 *
 * No bundler: every file the browser asks for is a file `tsc -b` wrote, and
 * the import map is what turns `@covey/protocol` into a URL. The files carry
 * no secret, so they are served to anyone the listener can hear; the one gate
 * stays on the WebSocket upgrade, in `server.ts`.
 */
import { createRequire } from "node:module";
import { dirname, extname, join, sep } from "node:path";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebRoots {
  static: string;
  app: string;
  lib: Record<string, string>;
}

/**
 * Where the built client lives, found through the package graph so a moved
 * checkout still serves. Null when the web package cannot be found, which is
 * a daemon started from a build that predates it.
 */
export function findWebRoots(): WebRoots | null {
  try {
    const here = createRequire(import.meta.url);
    const web = dirname(here.resolve("@covey/web/package.json"));
    const fromWeb = createRequire(join(web, "package.json"));
    const pkg = (name: string) => join(dirname(fromWeb.resolve(`@covey/${name}/package.json`)), "dist");
    return { static: join(web, "static"), app: join(web, "dist"), lib: { protocol: pkg("protocol"), client: pkg("client") } };
  } catch {
    return null;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * The file a URL path names, or null when it names nothing this daemon serves.
 *
 * Pure, so a test can hand it every shape of hostile path. A segment that is
 * empty, `.` or `..`, or that carries a backslash or a NUL, ends the walk:
 * the file is always `<root>/<segments>` and never above the root.
 */
export function resolveWebFile(pathname: string, roots: WebRoots): { file: string; type: string } | null {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  if (path === "/" || path === "/index.html") return { file: join(roots.static, "index.html"), type: TYPES[".html"]! };
  const m = /^\/(static|app|lib)\/(.+)$/.exec(path);
  if (!m) return null;
  const segments = m[2]!.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\\0]/.test(s))) return null;
  let root: string | undefined;
  if (m[1] === "lib") { root = roots.lib[segments.shift()!]; if (!root || segments.length === 0) return null; }
  else root = m[1] === "static" ? roots.static : roots.app;
  const type = TYPES[extname(segments[segments.length - 1]!)];
  if (!type) return null;
  const file = join(root, ...segments);
  if (!file.startsWith(root + sep)) return null;
  return { file, type };
}

/**
 * Answer a request for the web client. Returns false when the URL is not one
 * of its paths, so the caller can go on to its own routes.
 */
export function serveWeb(req: IncomingMessage, res: ServerResponse, roots: WebRoots | null): boolean {
  const url = new URL(req.url ?? "/", "http://x");
  if (!roots) {
    if (url.pathname !== "/") return false;
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The covey web client is not built on this machine. Run `pnpm run build` in the checkout and restart the daemon.\n");
    return true;
  }
  const hit = resolveWebFile(url.pathname, roots);
  if (!hit) return false;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return true; }
  let size: number;
  try {
    const st = statSync(hit.file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch { return false; }
  res.writeHead(200, { "content-type": hit.type, "content-length": size, "cache-control": "no-cache" });
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(hit.file).pipe(res);
  return true;
}
