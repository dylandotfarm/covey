/**
 * The React Native client, served over the air by the daemon (issue #168).
 *
 * The phone runs a bundle, not a page, so it cannot be served the way
 * `web.ts` serves the web client — a browser re-reads the page on every visit
 * and an installed app does not. Instead the app asks this daemon, on every
 * cold start, whether there is a newer bundle than the one it holds, and takes
 * it if there is, so a change reaches the phone without anybody sideloading
 * anything.
 *
 * What it does *not* do is rebuild that bundle. A machine update runs
 * `git pull`, `pnpm install` and `pnpm run build` (`update.ts`), and none of
 * those touch `mobile/`: `tsc -b` never sees it and Metro is not part of that
 * build. So an updated machine serves the bundle it last exported until somebody
 * runs `pnpm run export` in `mobile/`. Deliberate for now — a bundler in the
 * daemon's own update path is a step that can fail and block the update — but it
 * does mean the export is a second act, and `docs/MOBILE.md` says so.
 *
 * The answer is the Expo Updates protocol, version 1. Three facts shape the
 * implementation and none of them are ours to choose:
 *
 *  1. The reply is `multipart/mixed`, with a part named `manifest`. Not a
 *     JSON body — the protocol reserves the other parts for directives.
 *  2. The signature goes in a header *on the manifest part*, never on the
 *     response, and it signs the exact bytes of that part. So the manifest is
 *     serialised once and both signed and sent from the same string; build it
 *     twice and a stray key order breaks verification.
 *  3. Every asset is named by a hash the client checks: base64url of its
 *     SHA-256. A byte that changes without the hash changing is an update the
 *     client rejects, which is the property worth having.
 *
 * What the daemon adds is its own gate. The manifest route and the asset route
 * both run through `authenticate()` in `server.ts`, the same gate as the
 * socket. The asset URLs carry the token as a query parameter rather than a
 * header, for the reason `/file` and `/media` already do: the fetch is native
 * code inside `expo-updates` and covey sets no header on it.
 *
 * Nothing here reaches the network or the database, so `updates.test.ts` can
 * hand it a real export directory and read every byte it would send.
 */
import { createHash, createSign } from "node:crypto";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** What `expo export` writes beside the bundle. Version 0 is the only one there has been. */
interface ExportMetadata {
  version: number;
  bundler: string;
  fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }>;
}

/**
 * What `mobile/scripts/export.mjs` writes that `expo export` does not.
 *
 * The runtime version is the whole safety of an over-the-air update: a bundle
 * built against one set of native modules must never land in an app built
 * against another. Expo decides it from the app's configuration at build time
 * and records it nowhere in `dist/`, so the export step writes it here and
 * this daemon serves an update only to an app that asks for the same one.
 */
interface ExportStamp {
  runtimeVersion: string;
  createdAt: string;
}

/** One asset of a manifest, as the protocol names its fields. */
export interface UpdateAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension: string;
  url: string;
}

/** The manifest, as the protocol names its fields. */
export interface UpdateManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: UpdateAsset;
  assets: UpdateAsset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

/** An export on disk, read once per request. */
export interface UpdateExport {
  dir: string;
  metadata: ExportMetadata;
  stamp: ExportStamp;
  /** The SHA-256 of `metadata.json`, which is what names this export. */
  digest: string;
}

/**
 * Where the exported bundle lives, or null when this machine holds none — which
 * is every daemon whose owner has not run `pnpm run export` in `mobile/`. That
 * is the ordinary case and not an error.
 *
 * Found from this module's own path rather than through the package graph:
 * `mobile/` is not a package of the pnpm workspace, so there is no name to
 * resolve. This file sits at `packages/daemon/{src,dist}/updates.{ts,js}`, and
 * both are three directories under the checkout, so one walk serves the built
 * daemon and the one `tsx` runs in a test.
 */
export function findUpdateDir(): string | null {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mobile", "dist");
  try {
    statSync(join(dir, "metadata.json"));
    return dir;
  } catch {
    return null;
  }
}

/** Base64, in the URL alphabet and without padding, as the protocol asks for hashes. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A hex SHA-256 laid out as a UUID, which is what the protocol wants an id to look like. */
export function hashToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ASSET_TYPES: Record<string, string> = {
  ".hbc": "application/javascript",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/** Read an export directory, or null when it holds no usable export. */
export function readExport(dir: string): UpdateExport | null {
  try {
    const raw = readFileSync(join(dir, "metadata.json"));
    const metadata = JSON.parse(raw.toString("utf8")) as ExportMetadata;
    if (metadata.version !== 0 || !metadata.fileMetadata) return null;
    const stamp = JSON.parse(readFileSync(join(dir, "covey-update.json"), "utf8")) as ExportStamp;
    if (!stamp?.runtimeVersion) return null;
    return { dir, metadata, stamp, digest: createHash("sha256").update(raw).digest("hex") };
  } catch {
    return null;
  }
}

/**
 * One asset's entry in a manifest.
 *
 * The `key` is what the client files the asset under and what the URL names, so
 * it has to be stable for the same bytes and different for different ones — it
 * is the hash, and the file's own name on disk never enters it. `expo export`
 * already names assets by content, but the bundle it writes is named by content
 * too and neither promise is ours.
 */
function assetOf(dir: string, rel: string, ext: string, base: string, token: string | undefined): UpdateAsset | null {
  let bytes: Buffer;
  try { bytes = readFileSync(join(dir, rel)); } catch { return null; }
  const fileExtension = ext.startsWith(".") ? ext : `.${ext}`;
  const key = createHash("sha256").update(bytes).digest("hex");
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return {
    hash: base64url(createHash("sha256").update(bytes).digest()),
    key,
    contentType: ASSET_TYPES[fileExtension] ?? "application/octet-stream",
    fileExtension,
    // The path is the asset's own place in the export, so the route can find
    // the bytes again without a map from key to file.
    url: `${base}/updates/assets/${rel.split("/").map(encodeURIComponent).join("/")}${query}`,
  };
}

/**
 * The manifest for one platform, or null when the export holds nothing for it.
 *
 * `base` is the origin the phone reached this daemon on, so the asset URLs it
 * gets back are ones it can actually fetch. A daemon has several addresses and
 * cannot know which one is the reader's route, so it echoes the one that was
 * used instead of naming a favourite.
 */
export function buildManifest(ex: UpdateExport, platform: string, base: string, token: string | undefined): UpdateManifest | null {
  const files = ex.metadata.fileMetadata[platform];
  if (!files?.bundle) return null;
  const launchAsset = assetOf(ex.dir, files.bundle, ".hbc", base, token);
  if (!launchAsset) return null;
  const assets: UpdateAsset[] = [];
  for (const a of files.assets ?? []) {
    const asset = assetOf(ex.dir, a.path, a.ext, base, token);
    // A named asset whose bytes are gone is a broken export, not a thin one:
    // the client would fetch a URL this daemon cannot answer.
    if (!asset) return null;
    assets.push(asset);
  }
  return {
    // The export names the update, and the platform is part of it: two
    // platforms out of one export are two updates, and an app must never be
    // told it already holds the other one's.
    id: hashToUuid(createHash("sha256").update(`${ex.digest}:${platform}`).digest("hex")),
    createdAt: ex.stamp.createdAt,
    runtimeVersion: ex.stamp.runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: {},
  };
}

/** A string as a structured-field value, which is what the signature header is made of. */
function sfvString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The `expo-signature` header for one manifest, signed with the key that
 * matches the certificate built into the app.
 *
 * It signs the serialised manifest, so the caller passes the same string it
 * puts in the part. `keyid` is `main` because that is what
 * `expo-updates codesigning:generate` writes into the app's configuration.
 */
export function signManifest(body: string, privateKey: string): string {
  const sign = createSign("RSA-SHA256");
  sign.update(body, "utf8");
  sign.end();
  const sig = sign.sign(privateKey, "base64");
  return `sig=${sfvString(sig)}, keyid=${sfvString("main")}, alg=${sfvString("rsa-v1_5-sha256")}`;
}

/** One part of the reply: a name, a content type, the body, and any extra headers. */
export interface UpdatePart {
  name: string;
  type: string;
  body: string;
  headers?: Record<string, string>;
}

/**
 * The parts as one `multipart/mixed` body.
 *
 * The boundary is checked against every part rather than assumed: a boundary
 * that appears inside a body is a reply the client reads as truncated, and a
 * manifest carries base64 and URLs that are not ours to bound.
 */
export function multipart(parts: UpdatePart[], seed = "covey"): { body: string; boundary: string } {
  let boundary = `${seed}${createHash("sha256").update(parts.map((p) => p.body).join("")).digest("hex").slice(0, 24)}`;
  while (parts.some((p) => p.body.includes(boundary))) boundary = `x${boundary}`;
  let body = "";
  for (const p of parts) {
    body += `--${boundary}\r\n`;
    body += `content-disposition: form-data; name="${p.name}"\r\n`;
    body += `content-type: ${p.type}\r\n`;
    for (const [k, v] of Object.entries(p.headers ?? {})) body += `${k}: ${v}\r\n`;
    body += `\r\n${p.body}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, boundary };
}

/**
 * The file an asset URL names, or null when it names nothing in this export.
 *
 * The same walk `resolveWebFile` does, and pure for the same reason: a test can
 * hand it every hostile path there is. A segment that is empty, `.` or `..`, or
 * that carries a backslash or a NUL, ends the walk, and the file is always
 * under the export directory.
 */
export function resolveAssetFile(pathname: string, dir: string): { file: string; type: string } | null {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  const m = /^\/updates\/assets\/(.+)$/.exec(path);
  if (!m) return null;
  const segments = m[1]!.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\\0]/.test(s))) return null;
  const file = join(dir, ...segments);
  if (!file.startsWith(dir + sep)) return null;
  return { file, type: ASSET_TYPES[extname(file)] ?? "application/octet-stream" };
}

/** What the manifest route decided, for the caller to write out. */
export type UpdateReply =
  | { kind: "manifest"; status: 200; headers: Record<string, string>; body: string }
  | { kind: "directive"; status: 200; headers: Record<string, string>; body: string }
  | { kind: "error"; status: number; message: string };

/** What the request asked for, read off its headers. */
export interface UpdateRequest {
  platform: string | undefined;
  runtimeVersion: string | undefined;
  currentUpdateId: string | undefined;
  expectSignature: boolean;
  /** The origin the phone used, `http://host:port`. */
  base: string;
  /** The token the asset URLs must carry, or undefined when this daemon needs none. */
  token: string | undefined;
}

const COMMON = { "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" };

/**
 * The reply to one manifest request.
 *
 * `privateKey` is read by the caller, not here, so this stays pure. A request
 * that asks for a signature when the machine holds no key is an error and not
 * an unsigned reply: the app would reject it, and a rejection the daemon could
 * have explained is a morning lost to a silent failure.
 */
export function manifestReply(ex: UpdateExport | null, req: UpdateRequest, privateKey: string | null): UpdateReply {
  if (!ex) return { kind: "error", status: 404, message: "no exported bundle on this machine: run `pnpm run export` in mobile/" };
  const platform = req.platform;
  if (!platform) return { kind: "error", status: 400, message: "expo-platform header missing" };
  // Checked once, before either answer is built. An app that verifies a manifest
  // verifies a directive too, so a machine with no key can answer neither — and
  // saying so is the whole point: the app would reject an unsigned reply without
  // explaining why, and a rejection this daemon could have named is a morning
  // lost to a silent failure.
  if (req.expectSignature && !privateKey) {
    return { kind: "error", status: 500, message: "this app expects a signed update and this machine holds no signing key" };
  }
  const manifest = buildManifest(ex, platform, req.base, req.token);
  if (!manifest) return { kind: "error", status: 404, message: `the exported bundle holds nothing for ${platform}` };
  // An app built against other native modules must not take this bundle. The
  // app names the runtime it can run and the daemon answers "nothing for you"
  // rather than a manifest it would have to refuse.
  if (req.runtimeVersion && req.runtimeVersion !== manifest.runtimeVersion) {
    return directive("noUpdateAvailable", req, privateKey);
  }
  // It already holds this one. Saying so costs the phone one request instead
  // of the whole bundle again.
  if (req.currentUpdateId && req.currentUpdateId === manifest.id) {
    return directive("noUpdateAvailable", req, privateKey);
  }
  const body = JSON.stringify(manifest);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (req.expectSignature && privateKey) headers["expo-signature"] = signManifest(body, privateKey);
  const { body: multi, boundary } = multipart([{ name: "manifest", type: "application/json; charset=utf-8", body, headers }]);
  return { kind: "manifest", status: 200, headers: { ...COMMON, "content-type": `multipart/mixed; boundary=${boundary}` }, body: multi };
}

/** A directive part: what the protocol says instead of a manifest. */
function directive(type: "noUpdateAvailable" | "rollBackToEmbedded", req: UpdateRequest, privateKey: string | null): UpdateReply {
  const body = JSON.stringify({ type });
  const headers: Record<string, string> = {};
  // A directive is signed exactly as a manifest is: an unsigned "nothing for
  // you" is a downgrade anybody on the path could send. `manifestReply` has
  // already refused the request if a signature was wanted and there is no key,
  // so reaching here without one means none was asked for.
  if (req.expectSignature && privateKey) headers["expo-signature"] = signManifest(body, privateKey);
  const { body: multi, boundary } = multipart([{ name: "directive", type: "application/json; charset=utf-8", body, headers }]);
  return { kind: "directive", status: 200, headers: { ...COMMON, "content-type": `multipart/mixed; boundary=${boundary}` }, body: multi };
}

// ---- the routes ------------------------------------------------------------

/**
 * Where the private key lives: outside the checkout, beside the daemon's own
 * state, so no rule about what is committed has to hold it back.
 * `mobile/scripts/codesign.mjs` writes it there.
 */
export function signingKeyFile(): string {
  const home = process.env.COVEY_HOME || join(process.env.HOME ?? ".", ".covey");
  return join(home, "mobile-signing-key.pem");
}

/** The signing key, or null when this machine holds none. */
function readSigningKey(): string | null {
  try { return readFileSync(signingKeyFile(), "utf8"); } catch { return null; }
}

/** What `serveUpdates` needs of the daemon. */
export interface UpdateOptions {
  dir: string | null;
  /** The daemon's shared token, put on the asset URLs. */
  token: string | undefined;
  log: (msg: string) => void;
}

/**
 * Answer the update routes, or say this request was not one of them.
 *
 * Two paths, and nothing else:
 *
 *   GET /updates                  the manifest, or a directive
 *   GET /updates/assets/<path>    one file of the export, by its path in it
 *
 * The caller has already authenticated the request. That gate is the whole
 * gate, exactly as it is for `/file`, and this route is deliberately *not*
 * behind the web client's own setting: the machine that serves the app's
 * bundles is chosen when the app is built and is very often not the machine
 * that serves the page. A reader who turns the web client off has said nothing
 * about their phone.
 */
export function serveUpdates(req: IncomingMessage, res: ServerResponse, o: UpdateOptions): boolean {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path !== "/updates" && !path.startsWith("/updates/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("updates: GET only\n");
    return true;
  }
  if (!o.dir) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("updates: no exported bundle on this machine: run `pnpm run export` in mobile/\n");
    return true;
  }

  if (path === "/updates") {
    const h = req.headers;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const reply = manifestReply(readExport(o.dir), {
      platform: one(h["expo-platform"]),
      runtimeVersion: one(h["expo-runtime-version"]),
      currentUpdateId: one(h["expo-current-update-id"]),
      expectSignature: Boolean(one(h["expo-expect-signature"])),
      // The address the phone actually reached, so the asset URLs it gets back
      // are ones it can fetch. A daemon has several and cannot know the route.
      base: `http://${one(h.host) ?? "localhost"}`,
      token: o.token,
    }, readSigningKey());
    if (reply.kind === "error") {
      o.log(`updates: ${reply.status} ${reply.message}`);
      res.writeHead(reply.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(`updates: ${reply.message}\n`);
      return true;
    }
    res.writeHead(reply.status, { ...reply.headers, "content-length": Buffer.byteLength(reply.body) });
    res.end(req.method === "HEAD" ? undefined : reply.body);
    return true;
  }

  const found = resolveAssetFile(path, o.dir);
  if (!found) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("updates: no such asset\n"); return true; }
  let size: number;
  try { size = statSync(found.file).size; } catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("updates: no such asset\n"); return true; }
  // An asset is named by the hash of its bytes, so the bytes at a URL never
  // change and the phone may keep them for as long as it likes.
  res.writeHead(200, { "content-type": found.type, "content-length": size, "cache-control": "public, max-age=31536000, immutable" });
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(found.file).pipe(res);
  return true;
}
