import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dataDir() reads COVEY_HOME at call time, so point it at a throwaway dir
// before importing the module under test.
process.env.COVEY_HOME = mkdtempSync(join(tmpdir(), "covey-daemon-att-"));
const { materialiseAttachments, attachmentBlocks } = await import("./attachments.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("inline bytes are written to disk and stripped from the stored attachment", () => {
  const [a] = materialiseAttachments("thread-1", [
    { name: "shot.png", path: "/somewhere/on/the/tui/machine/shot.png", mimeType: "image/png", data: PNG.toString("base64") },
  ]);
  assert.ok(a, "expected an attachment back");
  assert.equal(a!.data, undefined, "base64 must not survive onto the timeline item");
  assert.notEqual(a!.path, "/somewhere/on/the/tui/machine/shot.png", "path should be rewritten to the daemon's copy");
  assert.ok(existsSync(a!.path), "bytes should be on disk");
  assert.deepEqual(readFileSync(a!.path), PNG);
  assert.match(a!.path, /\.png$/, "extension should be preserved");
});

test("an image attachment becomes a real image content block", () => {
  const stored = materialiseAttachments("thread-2", [
    { name: "shot.png", path: "/ignored.png", mimeType: "image/png", data: PNG.toString("base64") },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
  });
  assert.match(noteLines[0]!, /Attached image: shot\.png/);
});

test("a non-image is referenced by path instead of inlined", () => {
  const stored = materialiseAttachments("thread-3", [
    { name: "notes.txt", path: "/ignored.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored);
  assert.equal(blocks.length, 0);
  assert.match(noteLines[0]!, /^Attached file: /);
});

test("oversized attachments are rejected", () => {
  assert.throws(() => materialiseAttachments("thread-4", [
    { name: "huge.png", path: "/ignored.png", mimeType: "image/png", data: Buffer.alloc(6 * 1024 * 1024).toString("base64") },
  ]), /over the 5 MB limit/);
});

test("an attachment with no data and no local file is rejected", () => {
  assert.throws(() => materialiseAttachments("thread-5", [
    { name: "gone.png", path: "/definitely/not/here.png", mimeType: "image/png" },
  ]), /does not exist on this machine/);
});
