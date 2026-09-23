import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dataDir() reads COVEY_HOME at call time, so point it at a throwaway dir
// before importing the module under test.
process.env.COVEY_HOME = mkdtempSync(join(tmpdir(), "covey-daemon-att-"));
const { materialiseAttachments, attachmentBlocks, threadFilesDir, removeThreadFiles } = await import("./attachments.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const b64 = (b: Buffer) => b.toString("base64");

/** A throwaway working directory, standing in for a thread's worktree. */
const cwd = () => mkdtempSync(join(tmpdir(), "covey-cwd-"));

test("inline bytes land in the thread's file store, under the name they were dropped with", () => {
  const dir = cwd();
  const [a] = materialiseAttachments(dir, "thread-1", [
    { name: "shot.png", path: "/somewhere/on/the/tui/machine/shot.png", mimeType: "image/png", data: b64(PNG) },
  ]);
  assert.ok(a, "expected an attachment back");
  assert.equal(a!.data, undefined, "base64 must not survive onto the timeline item");
  assert.equal(a!.path, join(threadFilesDir(dir, "thread-1"), "shot.png"));
  assert.deepEqual(readFileSync(a!.path), PNG);
});

test("the store ignores itself, so a dropped file never reaches git", () => {
  const dir = cwd();
  materialiseAttachments(dir, "t", [{ name: "a.txt", path: "/x", mimeType: "text/plain", data: b64(Buffer.from("hi")) }]);
  assert.equal(readFileSync(join(dir, ".covey", ".gitignore"), "utf8"), "*\n");
});

test("two files of one name are told apart rather than overwriting each other", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "t", [
    { name: "shot.png", path: "/a/shot.png", mimeType: "image/png", data: b64(PNG) },
    { name: "shot.png", path: "/b/shot.png", mimeType: "image/png", data: b64(Buffer.from("second")) },
  ]);
  assert.equal(stored[0]!.path.endsWith("/shot.png"), true);
  assert.equal(stored[1]!.path.endsWith("/shot-2.png"), true);
  assert.deepEqual(readFileSync(stored[1]!.path).toString(), "second");
});

test("gzipped bytes are unpacked before they are written", () => {
  const dir = cwd();
  const body = Buffer.from("log line\n".repeat(1000));
  const [a] = materialiseAttachments(dir, "t", [
    { name: "big.log", path: "/a/big.log", mimeType: "text/plain", data: b64(gzipSync(body)), packing: "gzip" },
  ]);
  assert.deepEqual(readFileSync(a!.path), body);
  assert.equal((a as any).packing, undefined, "packing is transport only");
});

test("a dropped directory arrives as a folder, with the tree it had", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "t", [
    { name: "a.txt", path: "/src/a.txt", mimeType: "text/plain", dir: "src", data: b64(Buffer.from("A")) },
    { name: "deep/b.txt", path: "/src/deep/b.txt", mimeType: "text/plain", dir: "src", data: b64(Buffer.from("B")) },
  ]);
  const root = threadFilesDir(dir, "t");
  assert.equal(stored[0]!.path, join(root, "src", "a.txt"));
  assert.equal(stored[1]!.path, join(root, "src", "deep", "b.txt"));
  assert.equal(readFileSync(stored[1]!.path, "utf8"), "B");
});

test("a name from the wire cannot write outside the thread's own files", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "t", [
    { name: "../../../escape.txt", path: "/x", mimeType: "text/plain", data: b64(Buffer.from("no")) },
    { name: "../../up.txt", path: "/y", mimeType: "text/plain", dir: "../..", data: b64(Buffer.from("no")) },
  ]);
  const root = threadFilesDir(dir, "t");
  for (const a of stored) assert.ok(a.path.startsWith(root), `${a.path} escaped ${root}`);
  assert.equal(existsSync(join(dir, "escape.txt")), false);
});

test("an image attachment becomes a real image content block", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "thread-2", [
    { name: "shot.png", path: "/ignored.png", mimeType: "image/png", data: b64(PNG) },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored, dir);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: b64(PNG) },
  });
  // The path the agent is given is the one it can type, relative to its own cwd.
  assert.equal(noteLines[0], `Attached image: shot.png (.covey/threads/thread-2/files/shot.png)`);
});

test("a non-image is referenced by path instead of inlined", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "thread-3", [
    { name: "notes.txt", path: "/ignored.txt", mimeType: "text/plain", data: b64(Buffer.from("hi")) },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored, dir);
  assert.equal(blocks.length, 0);
  assert.equal(noteLines[0], `Attached file: notes.txt (.covey/threads/thread-3/files/notes.txt)`);
});

test("a dropped directory is one line for the agent, not one line per file", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "t", [
    { name: "a.txt", path: "/src/a.txt", mimeType: "text/plain", dir: "src", data: b64(Buffer.from("A")) },
    { name: "deep/b.txt", path: "/src/deep/b.txt", mimeType: "text/plain", dir: "src", data: b64(Buffer.from("B")) },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored, dir);
  assert.equal(blocks.length, 0);
  assert.deepEqual(noteLines, ["Attached directory: src (.covey/threads/t/files/src, 2 files)"]);
});

test("a dropped pdf keeps its extension and reaches the agent by path", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "thread-6", [
    { name: "report 1.pdf", path: "/on/the/tui/machine/report 1.pdf", mimeType: "application/pdf", data: b64(Buffer.from("%PDF-1.7\n")) },
  ]);
  assert.ok(existsSync(stored[0]!.path));
  assert.match(stored[0]!.path, /report 1\.pdf$/);
  const { blocks, noteLines } = attachmentBlocks(stored, dir);
  assert.equal(blocks.length, 0, "a pdf is not an image block");
  assert.match(noteLines[0]!, /^Attached file: report 1\.pdf \(.*report 1\.pdf\)$/);
});

test("an image over the API's own limit reaches the agent as a file, not as a block", () => {
  const dir = cwd();
  const stored = materialiseAttachments(dir, "t", [
    { name: "huge.png", path: "/ignored.png", mimeType: "image/png", data: b64(Buffer.alloc(6 * 1024 * 1024)) },
  ]);
  const { blocks, noteLines } = attachmentBlocks(stored, dir);
  assert.equal(blocks.length, 0, "6 MB is over the 5 MB the API takes");
  assert.match(noteLines[0]!, /^Attached file: huge\.png/);
});

test("a drop over the limit is refused, counting every file in it", () => {
  const dir = cwd();
  const half = { name: "a.bin", path: "/a.bin", mimeType: "application/octet-stream", data: b64(Buffer.alloc(20 * 1024 * 1024)) };
  assert.throws(() => materialiseAttachments(dir, "t", [half, { ...half, name: "b.bin" }]), /over the 32 MB limit/);
});

test("an attachment with no data and no local file is rejected", () => {
  assert.throws(() => materialiseAttachments(cwd(), "thread-5", [
    { name: "gone.png", path: "/definitely/not/here.png", mimeType: "image/png" },
  ]), /does not exist on this machine/);
});

test("deleting a thread takes its file store with it", () => {
  const dir = cwd();
  materialiseAttachments(dir, "t", [{ name: "a.txt", path: "/x", mimeType: "text/plain", data: b64(Buffer.from("hi")) }]);
  assert.equal(existsSync(threadFilesDir(dir, "t")), true);
  removeThreadFiles(dir, "t");
  assert.equal(existsSync(threadFilesDir(dir, "t")), false);
});

test("a file already on this machine is left where it is", () => {
  const dir = cwd();
  const here = join(dir, "already.txt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(here, "here");
  const [a] = materialiseAttachments(dir, "t", [{ name: "already.txt", path: here, mimeType: "text/plain" }]);
  assert.equal(a!.path, here);
});
