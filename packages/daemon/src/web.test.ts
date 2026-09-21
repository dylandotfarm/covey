import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findWebRoots, resolveWebFile, type WebRoots } from "./web.js";

const roots: WebRoots = { static: "/srv/static", app: "/srv/app", lib: { protocol: "/srv/protocol", client: "/srv/client" } };

test("each prefix maps to its root and nothing else", () => {
  assert.deepEqual(resolveWebFile("/", roots)?.file, join("/srv/static", "index.html"));
  assert.deepEqual(resolveWebFile("/index.html", roots)?.file, join("/srv/static", "index.html"));
  assert.equal(resolveWebFile("/static/app.css", roots)?.file, "/srv/static/app.css");
  assert.equal(resolveWebFile("/static/app.css", roots)?.type, "text/css; charset=utf-8");
  assert.equal(resolveWebFile("/app/main.js", roots)?.file, "/srv/app/main.js");
  assert.equal(resolveWebFile("/lib/protocol/index.js", roots)?.file, "/srv/protocol/index.js");
  assert.equal(resolveWebFile("/lib/client/client.js.map", roots)?.file, "/srv/client/client.js.map");
  assert.equal(resolveWebFile("/health", roots), null);
  assert.equal(resolveWebFile("/lib/daemon/index.js", roots), null);
  assert.equal(resolveWebFile("/lib/protocol", roots), null);
  assert.equal(resolveWebFile("/lib/protocol/", roots), null);
  assert.equal(resolveWebFile("/other/main.js", roots), null);
});

test("a path cannot leave its root", () => {
  for (const bad of [
    "/static/../../etc/passwd",
    "/app/..%2F..%2Fetc/passwd",
    "/app/%2e%2e/%2e%2e/etc/passwd",
    "/static//app.css",
    "/static/./app.css",
    "/app/a\\..\\..\\x.js",
    "/app/%00.js",
    "/lib/../protocol/index.js",
    "/lib/protocol/../../daemon/dist/index.js",
    "/%zz",
  ]) assert.equal(resolveWebFile(bad, roots), null, bad);
});

test("only file types the page uses are served", () => {
  assert.equal(resolveWebFile("/static/notes.txt", roots), null);
  assert.equal(resolveWebFile("/app/main.ts", roots), null);
  assert.equal(resolveWebFile("/app/main", roots), null);
  assert.ok(resolveWebFile("/static/manifest.webmanifest", roots));
  assert.ok(resolveWebFile("/static/icon.svg", roots));
});

test("the built checkout is found through the package graph", () => {
  const found = findWebRoots();
  assert.ok(found, "web roots");
  assert.match(found.static, /packages\/web\/static$/);
  assert.match(found.app, /packages\/web\/dist$/);
  assert.match(found.lib.protocol!, /packages\/protocol\/dist$/);
  assert.match(found.lib.client!, /packages\/client\/dist$/);
});
