import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDroppedPaths, imageMime, fileMime, readDroppedFiles, readClipboardImage, makeTag, tagAttachments, spliceTags, keepTagged, applyDrop, type RunReader } from "./attachments.js";

test("parses the path shapes terminals actually paste on drop", () => {
  assert.deepEqual(parseDroppedPaths("/home/me/shot.png"), ["/home/me/shot.png"]);
  // iTerm2 / Terminal.app escape spaces with backslashes
  assert.deepEqual(parseDroppedPaths("/home/me/shot\\ 1.png"), ["/home/me/shot 1.png"]);
  // some terminals quote instead
  assert.deepEqual(parseDroppedPaths("'/home/me/shot 1.png'"), ["/home/me/shot 1.png"]);
  assert.deepEqual(parseDroppedPaths('"/home/me/shot 1.png"'), ["/home/me/shot 1.png"]);
  // GNOME Terminal pastes a percent-encoded URI
  assert.deepEqual(parseDroppedPaths("file:///home/me/shot%201.png"), ["/home/me/shot 1.png"]);
});

test("parses a multi-file drop", () => {
  assert.deepEqual(parseDroppedPaths("/a/one.png /a/two.png"), ["/a/one.png", "/a/two.png"]);
});

test("recognises the image types the model accepts", () => {
  assert.equal(imageMime("/a/b.PNG"), "image/png");
  assert.equal(imageMime("/a/b.jpeg"), "image/jpeg");
  assert.equal(imageMime("/a/b.webp"), "image/webp");
  assert.equal(imageMime("/a/b.txt"), null);
});

test("ordinary pasted prose is not mistaken for a drop", () => {
  assert.equal(readDroppedFiles("look at src/app.png and tell me why").attachments.length, 0);
  assert.equal(readDroppedFiles("just some text").attachments.length, 0);
});

test("reads a real dropped file into a base64 attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot 1.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const { attachments, errors } = readDroppedFiles(`'${png}'`);
  assert.equal(errors.length, 0);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.name, "shot 1.png");
  assert.equal(attachments[0]!.mimeType, "image/png");
  assert.equal(Buffer.from(attachments[0]!.data!, "base64").toString("hex"), "89504e470d0a1a0a");
});

test("a missing file reports an error rather than attaching", () => {
  const { attachments, errors } = readDroppedFiles("/nope/missing.png");
  assert.equal(attachments.length, 0);
  assert.equal(errors.length, 1);
});

test("labels a non-image by extension, and anything unknown generically", () => {
  assert.equal(fileMime("/a/b.PDF"), "application/pdf");
  assert.equal(fileMime("/a/b.log"), "text/plain");
  assert.equal(fileMime("/a/b.png"), "image/png");
  assert.equal(fileMime("/a/b.sqlite3"), "application/octet-stream");
});

test("a dropped non-image attaches too", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const pdf = join(dir, "report 1.pdf");
  writeFileSync(pdf, "%PDF-1.7\n");
  const { attachments, errors } = readDroppedFiles(`'${pdf}'`);
  assert.equal(errors.length, 0);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.name, "report 1.pdf");
  assert.equal(attachments[0]!.mimeType, "application/pdf");
  assert.equal(Buffer.from(attachments[0]!.data!, "base64").toString(), "%PDF-1.7\n");
});

test("a drop of an image and a non-image together attaches both", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot.png");
  const log = join(dir, "run.log");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(log, "boom\n");
  const { attachments, errors } = readDroppedFiles(`${png} ${log}`);
  assert.equal(errors.length, 0);
  assert.deepEqual(attachments.map((a) => a.mimeType), ["image/png", "text/plain"]);
});

test("a non-image path only counts as a drop when the file is really there", () => {
  // An absolute path to nothing is prose, not a drop — unlike a missing image,
  // whose extension says a drop was meant.
  assert.equal(readDroppedFiles("/nope/missing.pdf").attachments.length, 0);
  assert.equal(readDroppedFiles("/nope/missing.pdf").errors.length, 0);
});

test("a dropped directory stays text", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const { attachments, errors } = readDroppedFiles(dir);
  assert.equal(attachments.length, 0);
  assert.equal(errors.length, 0);
});

test("a relative filename that exists is prose, not a drop", () => {
  // Terminals always paste an absolute path on a drop, so a bare name that
  // happens to match a file in the cwd must still go in as text.
  assert.equal(readDroppedFiles("package.json").attachments.length, 0);
});

test("an oversized drop reports its size instead of attaching", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const big = join(dir, "huge.log");
  writeFileSync(big, Buffer.alloc(6 * 1024 * 1024));
  const { attachments, errors } = readDroppedFiles(big);
  assert.equal(attachments.length, 0);
  assert.match(errors[0]!, /huge\.log is 6 MB \(limit 5 MB\)/);
});

// --- clipboard -------------------------------------------------------------

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const reader = (r: { stdout?: Buffer; status?: number; error?: NodeJS.ErrnoException }): RunReader =>
  () => ({ stdout: r.stdout ?? null, status: r.status ?? 0, error: r.error });
const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" });

test("a clipboard image becomes an attachment with real bytes on disk", () => {
  const { attachment, error } = readClipboardImage(reader({ stdout: PNG }));
  assert.equal(error, undefined);
  assert.ok(attachment);
  assert.equal(attachment!.mimeType, "image/png");
  assert.match(attachment!.name, /^clipboard-\d{14}\.png$/);
  assert.equal(Buffer.from(attachment!.data!, "base64").toString("hex"), PNG.toString("hex"));
  assert.deepEqual(readFileSync(attachment!.path), PNG, "the path should point at the bytes");
});

test("a missing reader names the one to install rather than failing", () => {
  const { attachment, error } = readClipboardImage(() => ({ stdout: null, status: null, error: enoent() }));
  assert.equal(attachment, undefined);
  assert.match(error!, /pngpaste|wl-clipboard|xclip/);
});

test("an empty clipboard says so", () => {
  assert.match(readClipboardImage(reader({ stdout: Buffer.alloc(0) })).error!, /no image/);
  assert.match(readClipboardImage(reader({ status: 1 })).error!, /no image/);
});

test("output that is not a PNG is not attached", () => {
  // pngpaste writes its usage line to stdout on some failures.
  assert.match(readClipboardImage(reader({ stdout: Buffer.from("Usage: pngpaste") })).error!, /no image/);
});

test("an oversized clipboard image reports its size", () => {
  const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
  assert.match(readClipboardImage(reader({ stdout: big })).error!, /limit 5 MB/);
});

const att = (name: string) => ({ name, path: `/a/${name}`, mimeType: "image/png" });

test("a file becomes a tag named after the file", () => {
  assert.equal(makeTag("shot.png", ""), "[shot.png]");
});

test("two files with one name get two tags", () => {
  const tags = tagAttachments([att("shot.png"), att("shot.png"), att("shot.png")], "").map((a) => a.tag);
  assert.deepEqual(tags, ["[shot.png]", "[shot.png 2]", "[shot.png 3]"]);
});

test("a tag the user typed by hand does not collide", () => {
  assert.equal(makeTag("shot.png", "why is [shot.png] red?"), "[shot.png 2]");
});

test("a bracket in the name cannot split the tag", () => {
  assert.equal(makeTag("a[1].png", ""), "[a_1_.png]");
});

test("the tag lands at the caret, spaced off the words around it", () => {
  assert.deepEqual(spliceTags("look at and say why", 8, ["[shot.png]"]), { value: "look at [shot.png] and say why", caret: 19 });
  // At the end of the draft the trailing space still goes in, so the next word
  // the user types does not touch the tag.
  assert.deepEqual(spliceTags("look at this", 12, ["[shot.png]"]), { value: "look at this [shot.png] ", caret: 24 });
  assert.deepEqual(spliceTags("", 0, ["[shot.png]"]), { value: "[shot.png] ", caret: 11 });
  // The draft already has the space, so do not add a second one.
  assert.deepEqual(spliceTags("look at  rest", 8, ["[one.png]", "[two.png]"]), { value: "look at [one.png] [two.png] rest", caret: 27 });
});

test("an attachment goes when the user deletes its tag", () => {
  const atts = tagAttachments([att("shot.png"), att("shot.png")], "");
  assert.deepEqual(keepTagged("compare [shot.png] with [shot.png 2]", atts).length, 2);
  assert.deepEqual(keepTagged("compare [shot.png] with nothing", atts).map((a) => a.tag), ["[shot.png]"]);
  assert.deepEqual(keepTagged("", atts), []);
});
