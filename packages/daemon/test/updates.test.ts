/**
 * The over-the-air update route (#168).
 *
 * The Expo Updates protocol is not ours, and an app rejects a reply it cannot
 * verify without saying much about why, so every rule the protocol states is
 * checked here against bytes rather than against intent:
 *
 *  - an asset is named by the base64url SHA-256 of its own bytes;
 *  - the signature signs the exact manifest bytes that go out, and a real
 *    public key verifies it — which is what the app does;
 *  - a runtime version that does not match gets a directive, never a manifest;
 *  - the asset route never escapes the export directory.
 *
 * `readExport`, `buildManifest`, `manifestReply` and `resolveAssetFile` touch
 * neither the network nor the database, so this builds an export directory by
 * hand and reads what the daemon would have written.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, stopAll } from "./daemons.js";
import {
  buildManifest, hashToUuid, manifestReply, multipart, readExport, resolveAssetFile, signManifest,
  type UpdateRequest,
} from "../src/updates.js";

after(stopAll);

const BUNDLE = "_expo/static/js/android/index-deadbeef.hbc";
const BUNDLE_BYTES = "// the bundle\n";
const ICON = "assets/9f8e7d.png";
const ICON_BYTES = "\x89PNG\r\n\x1a\nnot really a png";

/** An export directory exactly as `expo export` plus `scripts/export.mjs` leave one. */
function makeExport(opts: { runtimeVersion?: string; assets?: boolean; stamp?: boolean; version?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "covey-updates-"));
  mkdirSync(join(dir, "_expo/static/js/android"), { recursive: true });
  writeFileSync(join(dir, BUNDLE), BUNDLE_BYTES);
  if (opts.assets) {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, ICON), ICON_BYTES);
  }
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({
    version: opts.version ?? 0,
    bundler: "metro",
    fileMetadata: { android: { bundle: BUNDLE, assets: opts.assets ? [{ path: ICON, ext: "png" }] : [] } },
  }));
  if (opts.stamp !== false) {
    writeFileSync(join(dir, "covey-update.json"), JSON.stringify({
      runtimeVersion: opts.runtimeVersion ?? "0.1.0",
      createdAt: "2026-09-28T00:00:00.000Z",
    }));
  }
  return dir;
}

const base64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function req(over: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    platform: "android",
    runtimeVersion: "0.1.0",
    currentUpdateId: undefined,
    expectSignature: false,
    base: "http://pi.tail1234.ts.net:3790",
    token: undefined,
    ...over,
  };
}

/** The parts of a multipart body, by name, with their headers. */
function parts(body: string, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  assert.ok(boundary, "the content type names a boundary");
  const out = new Map<string, { headers: Record<string, string>; body: string }>();
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    const split = trimmed.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of trimmed.slice(0, split).split("\r\n")) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
    const name = /name="([^"]+)"/.exec(headers["content-disposition"] ?? "")?.[1];
    if (name) out.set(name, { headers, body: trimmed.slice(split + 4).replace(/\r\n$/, "") });
  }
  return out;
}

test("hashToUuid lays a hex digest out as a UUID", () => {
  const hex = createHash("sha256").update("x").digest("hex");
  const uuid = hashToUuid(hex);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("readExport reads a real export, and refuses one it cannot trust", () => {
  const ok = readExport(makeExport());
  assert.ok(ok);
  assert.equal(ok.stamp.runtimeVersion, "0.1.0");
  assert.equal(ok.metadata.fileMetadata.android?.bundle, BUNDLE);

  // No runtime version is no update: the daemon would have nothing to match an
  // app against, and matching is the whole safety of this.
  assert.equal(readExport(makeExport({ stamp: false })), null);
  // A metadata version covey has never seen is not one to guess at.
  assert.equal(readExport(makeExport({ version: 1 })), null);
  assert.equal(readExport(mkdtempSync(join(tmpdir(), "covey-empty-"))), null);
});

test("an asset is named by the base64url SHA-256 of its own bytes", () => {
  const ex = readExport(makeExport({ assets: true }))!;
  const m = buildManifest(ex, "android", "http://host:3790", undefined)!;
  assert.ok(m);
  assert.equal(m.launchAsset.hash, base64url(createHash("sha256").update(BUNDLE_BYTES).digest()));
  assert.equal(m.launchAsset.contentType, "application/javascript");
  assert.equal(m.launchAsset.fileExtension, ".hbc");
  assert.equal(m.assets.length, 1);
  assert.equal(m.assets[0]!.hash, base64url(createHash("sha256").update(ICON_BYTES).digest()));
  assert.equal(m.assets[0]!.contentType, "image/png");
  assert.equal(m.runtimeVersion, "0.1.0");
  assert.equal(m.createdAt, "2026-09-28T00:00:00.000Z");
  // The URL is one the phone can fetch, on the address it used.
  assert.equal(m.launchAsset.url, `http://host:3790/updates/assets/${BUNDLE.split("/").join("/")}`);
});

test("the asset URL carries the token, because native code sets no header", () => {
  const ex = readExport(makeExport())!;
  const m = buildManifest(ex, "android", "http://host:3790", "s3cr et/+")!;
  assert.match(m.launchAsset.url, /\?token=s3cr%20et%2F%2B$/);
});

test("two platforms out of one export are two different updates", () => {
  const ex = readExport(makeExport())!;
  const android = buildManifest(ex, "android", "http://h", undefined)!;
  // The export holds nothing for ios, so there is no manifest to confuse.
  assert.equal(buildManifest(ex, "ios", "http://h", undefined), null);
  // Same export, same id every time: an app that holds it is told so.
  assert.equal(buildManifest(readExport(ex.dir)!, "android", "http://h", undefined)!.id, android.id);
});

test("a manifest whose asset bytes are gone is refused, not served thin", () => {
  const dir = makeExport({ assets: true });
  // The metadata names an asset the directory does not hold.
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({
    version: 0, bundler: "metro",
    fileMetadata: { android: { bundle: BUNDLE, assets: [{ path: "assets/missing", ext: "png" }] } },
  }));
  assert.equal(buildManifest(readExport(dir)!, "android", "http://h", undefined), null);
});

test("the happy path is a multipart reply with a manifest part", () => {
  const ex = readExport(makeExport({ assets: true }))!;
  const reply = manifestReply(ex, req(), null);
  assert.equal(reply.kind, "manifest");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["expo-protocol-version"], "1");
  assert.equal(reply.headers["expo-sfv-version"], "0");
  assert.equal(reply.headers["cache-control"], "private, max-age=0");
  assert.match(reply.headers["content-type"]!, /^multipart\/mixed; boundary=/);
  const found = parts(reply.body, reply.headers["content-type"]!);
  const manifest = found.get("manifest");
  assert.ok(manifest, "there is a part named manifest");
  assert.match(manifest.headers["content-type"]!, /^application\/json/);
  const parsed = JSON.parse(manifest.body);
  assert.equal(parsed.runtimeVersion, "0.1.0");
  assert.ok(parsed.launchAsset.url);
});

test("a runtime version that does not match gets a directive, never a manifest", () => {
  const ex = readExport(makeExport())!;
  const reply = manifestReply(ex, req({ runtimeVersion: "0.2.0" }), null);
  assert.equal(reply.kind, "directive");
  const found = parts(reply.body, (reply as { headers: Record<string, string> }).headers["content-type"]!);
  assert.equal(JSON.parse(found.get("directive")!.body).type, "noUpdateAvailable");
  assert.equal(found.has("manifest"), false);
});

test("an app that already holds this update is told so", () => {
  const ex = readExport(makeExport())!;
  const first = manifestReply(ex, req(), null);
  const id = JSON.parse(parts(first.body as string, (first as { headers: Record<string, string> }).headers["content-type"]!).get("manifest")!.body).id;
  const again = manifestReply(ex, req({ currentUpdateId: id }), null);
  assert.equal(again.kind, "directive");
});

test("no export is a 404, and a missing platform header is a 400", () => {
  assert.deepEqual(
    { ...manifestReply(null, req(), null), message: "" },
    { kind: "error", status: 404, message: "" },
  );
  const ex = readExport(makeExport())!;
  const bad = manifestReply(ex, req({ platform: undefined }), null);
  assert.equal(bad.status, 400);
});

test("the signature signs the exact bytes that go out, and a real key verifies it", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ex = readExport(makeExport({ assets: true }))!;
  const reply = manifestReply(ex, req({ expectSignature: true }), pem);
  assert.equal(reply.kind, "manifest");
  const manifest = parts(reply.body as string, (reply as { headers: Record<string, string> }).headers["content-type"]!).get("manifest")!;

  const header = manifest.headers["expo-signature"];
  assert.ok(header, "the signature is a header on the manifest part, not on the response");
  assert.equal((reply as { headers: Record<string, string> }).headers["expo-signature"], undefined);
  assert.match(header, /keyid="main"/);
  assert.match(header, /alg="rsa-v1_5-sha256"/);
  const sig = /sig="([^"]+)"/.exec(header)![1]!;

  // Exactly what the app does with the certificate built into it.
  const verify = createVerify("RSA-SHA256");
  verify.update(manifest.body, "utf8");
  verify.end();
  assert.equal(verify.verify(publicKey, sig, "base64"), true, "the public key verifies the manifest part's bytes");
});

test("a directive is signed too, so 'nothing for you' cannot be forged", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ex = readExport(makeExport())!;
  const reply = manifestReply(ex, req({ runtimeVersion: "9.9.9", expectSignature: true }), pem);
  const part = parts(reply.body as string, (reply as { headers: Record<string, string> }).headers["content-type"]!).get("directive")!;
  const sig = /sig="([^"]+)"/.exec(part.headers["expo-signature"]!)![1]!;
  const verify = createVerify("RSA-SHA256");
  verify.update(part.body, "utf8");
  verify.end();
  assert.equal(verify.verify(publicKey, sig, "base64"), true);
});

test("an app that expects a signature and a machine with no key is an error, not an unsigned reply", () => {
  const ex = readExport(makeExport())!;
  const reply = manifestReply(ex, req({ expectSignature: true }), null);
  assert.equal(reply.kind, "error");
  assert.equal(reply.status, 500);
  assert.match((reply as { message: string }).message, /signing key/);
});

test("multipart moves the boundary off a body that contains it", () => {
  const seed = "aaa";
  const first = multipart([{ name: "manifest", type: "application/json", body: "{}" }], seed);
  // A body that holds the boundary the seed would have produced.
  const second = multipart([{ name: "manifest", type: "application/json", body: first.boundary }], seed);
  assert.notEqual(second.boundary, first.boundary);
  assert.equal(second.body.includes(`--${second.boundary}`), true);
  // The body still holds the old boundary as content, and that is now harmless.
  assert.equal(second.body.split(`--${second.boundary}`).length, 3);
});

test("the asset route never escapes the export directory", () => {
  const dir = makeExport({ assets: true });
  assert.ok(resolveAssetFile(`/updates/assets/${ICON}`, dir));
  assert.equal(resolveAssetFile(`/updates/assets/${ICON}`, dir)!.type, "image/png");
  for (const hostile of [
    "/updates/assets/../../etc/passwd",
    "/updates/assets/%2e%2e/%2e%2e/etc/passwd",
    "/updates/assets/a//b",
    "/updates/assets/./x",
    "/updates/assets/a\\b",
    "/updates/assets/a\0b",
    "/updates/assets/",
    "/updates",
    "/file?path=x",
  ]) {
    assert.equal(resolveAssetFile(hostile, dir), null, `refused ${JSON.stringify(hostile)}`);
  }
});

test("signManifest escapes a structured-field string rather than trusting base64", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = signManifest("{}", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  // Three members, each a quoted string, and the signature is not broken up.
  assert.match(header, /^sig="[A-Za-z0-9+/=]+", keyid="main", alg="rsa-v1_5-sha256"$/);
});

// ---- against a real daemon -------------------------------------------------

/**
 * The route, as the app reaches it.
 *
 * `mobile/dist` is a build artifact of a second client, so `pnpm test` cannot
 * require one: a fresh clone and CI both have none. But a 404 must never be
 * allowed to stand in for a working route — that is exactly the bug this test
 * failed to catch once already. So the test reads the directory itself and
 * *decides which answer is correct* before it asks, rather than accepting
 * either.
 */
test("a real daemon answers /updates, gated like the socket", async () => {
  // What this machine actually holds decides what the daemon owes us.
  const exportDir = join(import.meta.dirname, "..", "..", "..", "mobile", "dist");
  const exported = existsSync(join(exportDir, "metadata.json")) && existsSync(join(exportDir, "covey-update.json"));
  const stamp = exported ? JSON.parse(readFileSync(join(exportDir, "covey-update.json"), "utf8")) as { runtimeVersion: string } : null;

  const d = await startDaemon({ name: "updates" });
  const base = `http://127.0.0.1:${d.port}`;
  const res = await fetch(`${base}/updates`, {
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": "android",
      ...(stamp ? { "expo-runtime-version": stamp.runtimeVersion } : {}),
    },
  });

  if (!exported) {
    assert.equal(res.status, 404, "with no export the daemon says so");
    assert.match(await res.text(), /pnpm run export/);
    return;
  }

  const type = res.headers.get("content-type") ?? "";
  assert.equal(res.status, 200, "with an export the daemon serves a manifest");
  assert.match(type, /^multipart\/mixed; boundary=/);
  assert.equal(res.headers.get("expo-protocol-version"), "1");
  assert.equal(res.headers.get("expo-sfv-version"), "0");
  const found = parts(await res.text(), type);
  const manifest = found.get("manifest");
  assert.ok(manifest, "a real export gives a real manifest");
  const parsed = JSON.parse(manifest.body);
  assert.equal(parsed.runtimeVersion, stamp!.runtimeVersion);
  assert.match(parsed.id, /^[0-9a-f-]{36}$/);

  // The launch asset is a URL on this daemon, and it serves the bytes whose
  // hash the manifest just promised. This is the whole contract: an app checks
  // the hash and refuses the bundle if it does not match.
  const asset = await fetch(parsed.launchAsset.url.replace(/^http:\/\/[^/]+/, base));
  assert.equal(asset.status, 200);
  const bytes = Buffer.from(await asset.arrayBuffer());
  assert.equal(base64url(createHash("sha256").update(bytes).digest()), parsed.launchAsset.hash);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  // An app that says it holds this one is told there is nothing new.
  const again = await fetch(`${base}/updates`, {
    headers: { "expo-platform": "android", "expo-runtime-version": stamp!.runtimeVersion, "expo-current-update-id": parsed.id },
  });
  const directive = parts(await again.text(), again.headers.get("content-type") ?? "");
  assert.equal(JSON.parse(directive.get("directive")!.body).type, "noUpdateAvailable");
  assert.equal(directive.has("manifest"), false);
});

test("the asset route refuses a path that climbs out, on a real daemon", async () => {
  const d = await startDaemon({ name: "updates-escape" });
  const base = `http://127.0.0.1:${d.port}`;
  for (const hostile of ["/updates/assets/../../../../etc/passwd", "/updates/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
    const res = await fetch(`${base}${hostile}`);
    assert.equal(res.status, 404, `refused ${hostile}`);
  }
  // Not a GET is not an update.
  const post = await fetch(`${base}/updates`, { method: "POST" });
  assert.equal(post.status, 405);
});
