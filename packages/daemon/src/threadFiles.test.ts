/**
 * The route that serves a thread's own files to the page (#135).
 *
 * Everything the route decides before it opens anything is pure, and this is
 * where a hostile path is caught. `packages/daemon/test/web.test.ts` drives the
 * whole route against a real daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { byteRange, fileHeaders, threadFileTarget } from "./threadFiles.js";

const ROOT = "/work/.covey/threads/t1/files";

test("a path inside the thread's own store is served, and nothing else is", () => {
  assert.equal(threadFileTarget(ROOT, join(ROOT, "shot.png")), join(ROOT, "shot.png"));
  assert.equal(threadFileTarget(ROOT, join(ROOT, "tree", "src", "a.ts")), join(ROOT, "tree/src/a.ts"));
  // A path that climbs out, however it spells it.
  assert.equal(threadFileTarget(ROOT, `${ROOT}/../../../../etc/passwd`), null);
  assert.equal(threadFileTarget(ROOT, "/etc/passwd"), null);
  assert.equal(threadFileTarget(ROOT, "relative.png"), null, "the path the item carries is the daemon's own, and absolute");
  // Another thread's store under the same worktree.
  assert.equal(threadFileTarget(ROOT, "/work/.covey/threads/t2/files/secret.png"), null);
  // A sibling directory whose name starts with the root's.
  assert.equal(threadFileTarget(ROOT, "/work/.covey/threads/t1/files-old/x.png"), null);
  assert.equal(threadFileTarget(ROOT, ROOT), null, "the store itself is a directory, not a file");
  assert.equal(threadFileTarget(ROOT, null), null);
  assert.equal(threadFileTarget(ROOT, ""), null);
});

test("the page is shown what it renders and downloads everything else", () => {
  assert.deepEqual(fileHeaders("/f/shot.PNG"), { type: "image/png", inline: true });
  assert.deepEqual(fileHeaders("/f/clip.mov"), { type: "video/quicktime", inline: true });
  assert.deepEqual(fileHeaders("/f/notes.txt"), { type: "application/octet-stream", inline: false });
  assert.deepEqual(fileHeaders("/f/none"), { type: "application/octet-stream", inline: false });
  // An SVG is a document the browser runs scripts in, and these bytes came
  // from whoever dropped them.
  assert.deepEqual(fileHeaders("/f/logo.svg"), { type: "application/octet-stream", inline: false });
});

test("a video seeks by asking for a range", () => {
  assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(byteRange("bytes=-200", 1000), { start: 800, end: 999 }, "the last 200 bytes: how a player reads an index");
  assert.deepEqual(byteRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "past the end is clamped, not refused");
  assert.equal(byteRange(undefined, 1000), null);
  assert.equal(byteRange("bytes=800-700", 1000), null);
  assert.equal(byteRange("bytes=0-1", 0), null);
  assert.equal(byteRange("items=0-1", 1000), null);
  assert.equal(byteRange("bytes=0-0,50-60", 1000), null, "one range only");
});
