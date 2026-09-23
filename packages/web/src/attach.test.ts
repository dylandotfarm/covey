/**
 * What the page does with a file the reader picked (#135).
 *
 * The browser half — decoding an image and drawing it smaller — comes in as an
 * argument, so every rule here is a node test. The fake shrinker below says
 * what a canvas would have said, and the tests are about what covey does with
 * that answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES } from "@covey/protocol";
import { attachingLabel, extensionOf, fileMime, isDrop, isPicture, readPicked, renamed, sendingLabel, toBase64, type PickedFile, type Shrinker } from "./attach.js";

/** A file the reader picked, of `size` bytes that are all `fill`. */
function file(name: string, type: string, size: number, fill = 7): PickedFile {
  return { name, type, size, bytes: async () => new Uint8Array(size).fill(fill) };
}

/** A canvas that always works, and gives back `size` bytes of JPEG. */
const shrinksTo = (size: number): Shrinker => async () => ({ bytes: new Uint8Array(size).fill(1), mimeType: "image/jpeg" });
/** A browser that cannot decode the file. */
const cannotShrink: Shrinker = async () => null;

test("the media type comes from the browser, then from the extension, then from nothing", () => {
  assert.equal(fileMime({ name: "a.png", type: "image/png" }), "image/png");
  assert.equal(fileMime({ name: "a.HEIC", type: "" }), "image/heic");
  assert.equal(fileMime({ name: "notes.md", type: "" }), "text/markdown");
  assert.equal(fileMime({ name: "thing.qqq", type: "" }), "application/octet-stream");
  assert.equal(fileMime({ name: "noext", type: "" }), "application/octet-stream");
  assert.equal(extensionOf("/a/b/c.TAR.GZ"), ".gz");
  assert.equal(extensionOf(".bashrc"), "", "a dotfile has no extension");
});

test("a picture is not the same question as an image the model may read", () => {
  assert.equal(isPicture("image/heic"), true);
  assert.equal(isPicture("image/png"), true);
  assert.equal(isPicture("image/svg+xml"), false, "an SVG is a document, not a photograph");
  assert.equal(isPicture("video/mp4"), false);
});

test("base64 of a buffer longer than an argument list", () => {
  const bytes = new Uint8Array(70_000).fill(65);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(toBase64(new Uint8Array(0)), "");
});

test("a small photograph goes as it is, with its bytes inline", async () => {
  const r = await readPicked([file("shot.png", "image/png", 1000)], cannotShrink);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.attachments.length, 1);
  const a = r.attachments[0]!;
  assert.equal(a.name, "shot.png");
  assert.equal(a.mimeType, "image/png");
  assert.equal(Buffer.from(a.data!, "base64").byteLength, 1000);
  assert.equal(a.packing, undefined, "a photograph does not deflate; nothing is packed");
  assert.equal(isDrop(r), true);
});

test("an image over the model's limit goes through the canvas and comes back as JPEG", async () => {
  const r = await readPicked([file("big.png", "image/png", MAX_IMAGE_BYTES + 1)], shrinksTo(400_000));
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.attachments[0]!.mimeType, "image/jpeg");
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 400_000);
});

test("a photograph in a type the model cannot read is converted even when it is small", async () => {
  const r = await readPicked([file("IMG_0001.HEIC", "image/heic", 900_000)], shrinksTo(300_000));
  assert.equal(r.attachments[0]!.mimeType, "image/jpeg", "an iPhone photograph reaches the model as JPEG");
  assert.deepEqual(r.warnings, []);
});

test("an image no browser could scale still travels, and says the model will not see it", async () => {
  const r = await readPicked([file("huge.png", "image/png", MAX_IMAGE_BYTES + 1)], cannotShrink);
  assert.equal(r.attachments.length, 1, "it goes as a file the agent can open");
  assert.equal(r.attachments[0]!.mimeType, "image/png");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /could not scale it down/);
  assert.match(r.warnings[0]!, /5 MB/);
});

test("a type the model refuses that the browser could not convert says so in its own words", async () => {
  const r = await readPicked([file("IMG_0002.HEIC", "image/heic", 900_000)], cannotShrink);
  assert.equal(r.attachments.length, 1);
  assert.match(r.warnings[0]!, /image\/heic/);
  assert.match(r.warnings[0]!, /image\/jpeg/, "it names what the model does read");
});

test("a file over what one message carries is refused with its size, and the others still go", async () => {
  const r = await readPicked([
    file("ok.txt", "text/plain", 10),
    file("enormous.bin", "application/octet-stream", MAX_ATTACHMENT_BYTES + 1),
  ], cannotShrink);
  assert.deepEqual(r.attachments.map((a) => a.name), ["ok.txt"]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.name, "enormous.bin");
  assert.match(r.failed[0]!.chip, /over the limit/);
  assert.match(r.failed[0]!.message, /32 MB/);
});

test("the cap is the whole message, not one file, and counts what the composer already holds", async () => {
  const half = Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1;
  const r = await readPicked([file("a.bin", "", half), file("b.bin", "", half)], cannotShrink);
  assert.deepEqual(r.attachments.map((a) => a.name), ["a.bin"]);
  assert.equal(r.failed.length, 1, "the second one is what takes the message over");
  assert.match(r.failed[0]!.message, /is left/);

  const already = await readPicked([file("c.bin", "", 1000)], cannotShrink, MAX_ATTACHMENT_BYTES - 10);
  assert.deepEqual(already.attachments, []);
  assert.equal(already.failed.length, 1);
});

test("a file the browser would not read is named, and does not stop the rest", async () => {
  const bad: PickedFile = { name: "gone.png", type: "image/png", size: 5, bytes: async () => { throw new Error("NotReadableError"); } };
  const r = await readPicked([bad, file("fine.txt", "text/plain", 3)], cannotShrink);
  assert.deepEqual(r.attachments.map((a) => a.name), ["fine.txt"]);
  assert.equal(r.failed[0]!.chip, "could not be read");
  assert.match(r.failed[0]!.message, /NotReadableError/);
});

test("a canvas that throws is a canvas that could not do it, not a failed attachment", async () => {
  const angry: Shrinker = async () => { throw new Error("tainted"); };
  const r = await readPicked([file("x.heic", "image/heic", 100)], angry);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.failed.length, 0);
});

test("a file of no bytes still carries a data field, so the daemon does not look for a path", async () => {
  const r = await readPicked([file("empty.txt", "text/plain", 0)], cannotShrink);
  assert.equal(r.attachments[0]!.data, "");
  assert.notEqual(r.attachments[0]!.data, undefined);
});

test("nothing picked is not a drop", async () => {
  const r = await readPicked([], cannotShrink);
  assert.equal(isDrop(r), false);
});

test("what the composer says while it works", () => {
  assert.equal(attachingLabel([{ name: "shot.png" }]), "reading shot.png…");
  assert.equal(attachingLabel([{ name: "a" }, { name: "b" }]), "reading 2 files…");
  assert.equal(sendingLabel(0), "sending…");
  assert.equal(sendingLabel(4 * 1024 * 1024), "sending 4 MB…");
});

test("a converted image is called what it now is, so the agent can open it", async () => {
  assert.equal(renamed("IMG_0001.HEIC", "image/jpeg"), "IMG_0001.jpg");
  assert.equal(renamed("shot.png", "image/jpeg"), "shot.jpg");
  assert.equal(renamed("shot.jpg", "image/jpeg"), "shot.jpg");
  assert.equal(renamed("noext", "image/jpeg"), "noext.jpg");
  assert.equal(renamed("shot.png", "image/png"), "shot.png");
  const r = await readPicked([file("IMG_0003.HEIC", "image/heic", 900_000)], shrinksTo(100));
  assert.equal(r.attachments[0]!.name, "IMG_0003.jpg");
  assert.equal(r.attachments[0]!.path, "IMG_0003.jpg");
});
