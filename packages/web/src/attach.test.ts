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
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES } from "@covey/protocol";
import { largeDropPrompt, type ImageSize } from "@covey/client";
import { attachingLabel, extensionOf, fileMime, isDrop, isPicture, readConfirmed, readPicked, renamed, sendingLabel, toBase64, type PickedFile, type Shrinker, type Uploader } from "./attach.js";

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

test("a file over what one message carries inline waits on the reader, and the others still go", async () => {
  const r = await readPicked([
    file("ok.txt", "text/plain", 10),
    file("clip.mp4", "video/mp4", MAX_ATTACHMENT_BYTES + 1),
  ], cannotShrink);
  assert.deepEqual(r.attachments.map((a) => a.name), ["ok.txt"]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.large.map((f) => f.name), ["clip.mp4"]);
  assert.equal(isDrop(r), true);
});

test("a file over the ceiling is refused outright, however willing the reader is", async () => {
  const r = await readPicked([file("film.mov", "video/quicktime", MAX_UPLOAD_BYTES + 1)], cannotShrink);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.large, []);
  assert.equal(r.failed[0]!.name, "film.mov");
  assert.match(r.failed[0]!.message, /512 MB covey carries at all/);
  assert.match(r.failed[0]!.message, /Put it on the machine/);
});

test("nothing of a large file is read: the reported size is what decides", async () => {
  let reads = 0;
  const watched: PickedFile = {
    name: "big.mp4", type: "video/mp4", size: MAX_ATTACHMENT_BYTES + 1,
    bytes: async () => { reads++; return new Uint8Array(0); },
  };
  const r = await readPicked([watched], cannotShrink);
  assert.equal(reads, 0, "a phone cannot hold a video to find out that covey will stream it");
  assert.equal(r.large[0], watched, "the picked file itself, because the upload needs it");
});

test("the cap is the whole message, not one file, and counts what the composer already holds", async () => {
  const half = Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1;
  const r = await readPicked([file("a.bin", "", half), file("b.bin", "", half)], cannotShrink);
  assert.deepEqual(r.attachments.map((a) => a.name), ["a.bin"]);
  assert.deepEqual(r.large.map((f) => f.name), ["b.bin"], "the second one is what takes the message over");

  const already = await readPicked([file("c.bin", "", 1000)], cannotShrink, MAX_ATTACHMENT_BYTES - 10);
  assert.deepEqual(already.attachments, []);
  assert.deepEqual(already.large.map((f) => f.name), ["c.bin"]);
});

test("a picker that reported no size at all is still caught, by the bytes", async () => {
  // A cloud drive hands a browser a file with `size: 0`. The size cannot
  // decide, so the read happens and the old refusal is the net under it.
  const lied: PickedFile = {
    name: "mystery.bin", type: "", size: 0,
    bytes: async () => new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
  };
  const r = await readPicked([lied], cannotShrink);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.large, []);
  assert.match(r.failed[0]!.message, /over the 32 MB a message carries/);
});

test("the question is the shared one, and names every file when there are several", () => {
  const one = largeDropPrompt([{ name: "clip.mp4", size: 90 * 1024 * 1024 }])!;
  assert.equal(one.title, "Send clip.mp4 (90 MB)?");
  assert.equal(one.accept, "Send it");
  const two = largeDropPrompt([
    { name: "a.mp4", size: 40 * 1024 * 1024 },
    { name: "b.mov", size: 60 * 1024 * 1024 },
  ])!;
  assert.equal(two.title, "Send 2 files (100 MB)?", "the size the reader is deciding on stays in the title");
  assert.match(two.detail, /a\.mp4 \(40 MB\), b\.mov \(60 MB\)/, "and the names go in the detail");
  assert.equal(two.accept, "Send them");
});

test("a confirmed file is an attachment with no data, pointing at the copy the daemon made", async () => {
  const clip = file("clip.mp4", "video/mp4", MAX_ATTACHMENT_BYTES + 1);
  const upload: Uploader = async (f) => ({ path: `/w/.covey/threads/t1/files/${f.name}` });
  const r = await readConfirmed([clip], upload);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.attachments, [{
    name: "clip.mp4", path: "/w/.covey/threads/t1/files/clip.mp4", mimeType: "video/mp4",
  }]);
  assert.equal(r.attachments[0]!.data, undefined, "the bytes are on the daemon, not on the wire");
});

test("an upload that failed is a chip saying so, and does not stop the next file", async () => {
  const a = file("a.mp4", "video/mp4", 1);
  const b = file("b.mp4", "video/mp4", 1);
  const upload: Uploader = async (f) => {
    if (f.name === "a.mp4") throw new Error("upload: the machine has no room left for it");
    return { path: `/w/files/${f.name}` };
  };
  const r = await readConfirmed([a, b], upload);
  assert.deepEqual(r.attachments.map((x) => x.name), ["b.mp4"]);
  assert.equal(r.failed[0]!.name, "a.mp4");
  assert.equal(r.failed[0]!.chip, "did not go up");
  assert.match(r.failed[0]!.message, /no room left/);
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

// ---------------------------------------------------------------------------
// The API's other image limit: the shape, not the weight (#236)
// ---------------------------------------------------------------------------

/** A real PNG header of `w` by `h`, padded out to `size` bytes. */
function pngFile(name: string, w: number, h: number, size: number): PickedFile {
  const b = new Uint8Array(Math.max(size, 24));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(b.buffer);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return { name, type: "image/png", size: b.byteLength, bytes: async () => b };
}

test("a phone photograph is scaled for its shape, though its weight is fine (#236)", async () => {
  // The file that started this: 4096x3072 and 1.5 MB. Under MAX_IMAGE_BYTES,
  // so weighing it finds nothing — and refused by the API all the same once
  // the conversation holds a few pictures.
  const photo: PickedFile = {
    name: "1000014121.jpg", type: "image/jpeg", size: 1_572_316, width: 4096, height: 3072,
    bytes: async () => new Uint8Array(1_572_316),
  };
  const r = await readPicked([photo], shrinksTo(400_000));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.failed, []);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]!.mimeType, "image/jpeg");
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 400_000, "the scaled bytes, not the original");
});

test("either edge is enough: a tall picture is as refused as a wide one", async () => {
  const tall: PickedFile = {
    name: "tall.jpg", type: "image/jpeg", size: 900_000, width: 1200, height: 4000,
    bytes: async () => new Uint8Array(900_000),
  };
  const r = await readPicked([tall], shrinksTo(300_000));
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 300_000);
});

test("a picture inside both limits is left alone, and never scaled for nothing", async () => {
  const fine: PickedFile = {
    name: "render.png", type: "image/png", size: 300_000, width: 1500, height: 1050,
    bytes: async () => new Uint8Array(300_000).fill(3),
  };
  const r = await readPicked([fine], shrinksTo(1)); // a shrinker that would ruin it
  assert.equal(r.attachments[0]!.mimeType, "image/png", "not re-encoded");
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 300_000);
});

test("an edge no picker named is read out of the header instead", async () => {
  // A browser's `File` carries a size and no shape, so covey has to find the
  // edges itself — out of bytes it was going to read anyway.
  const r = await readPicked([pngFile("wide.png", 5000, 1200, 2000)], shrinksTo(900));
  assert.deepEqual(r.warnings, []);
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 900, "scaled, with nobody having reported a shape");
});

test("a header covey cannot read leaves the file exactly as it was", async () => {
  const opaque = file("mystery.png", "image/png", 2000, 9);
  const r = await readPicked([opaque], shrinksTo(1));
  assert.deepEqual(r.warnings, [], "covey measured nothing, so it says nothing");
  assert.equal(Buffer.from(r.attachments[0]!.data!, "base64").byteLength, 2000, "and scales nothing");
});

test("a picture too wide that no browser could scale says so in the shape's own words", async () => {
  const photo: PickedFile = {
    name: "big.jpg", type: "image/jpeg", size: 900_000, width: 4096, height: 3072,
    bytes: async () => new Uint8Array(900_000),
  };
  const r = await readPicked([photo], cannotShrink);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /4096x3072/, "the shape, not a size in MB (#132)");
  assert.match(r.warnings[0]!, /3000 px/);
  assert.equal(r.attachments.length, 1, "it still travels, as a file the agent can open");
});

test("one picture is scaled once, whichever limit asked for it", async () => {
  let calls = 0;
  const counting: Shrinker = async () => { calls++; return { bytes: new Uint8Array(500).fill(2), mimeType: "image/jpeg" }; };
  const heavyAndWide: PickedFile = {
    name: "huge.png", type: "image/png", size: MAX_IMAGE_BYTES + 1, width: 9000, height: 9000,
    bytes: async () => new Uint8Array(10),
  };
  const r = await readPicked([heavyAndWide], counting);
  assert.equal(calls, 1, "over both caps is still one scaling");
  assert.equal(r.attachments[0]!.name, "huge.jpg", "and it is called what it now is");
});

test("the shrinker is handed the shape covey measured, not left to guess it", async () => {
  // A phone picking from the photo roll gets the shape from the picker; one
  // picking the same file as a *document* gets nothing, and `readPicked` reads
  // it out of the header. Both have to reach the shrinker, or the two pickers
  // scale one photograph two different ways.
  const seen: (ImageSize | undefined)[] = [];
  const noting: Shrinker = async (_f, shape) => { seen.push(shape); return { bytes: new Uint8Array(10), mimeType: "image/jpeg" }; };

  await readPicked([{
    name: "roll.jpg", type: "image/jpeg", size: 900_000, width: 3072, height: 4096,
    bytes: async () => new Uint8Array(900_000),
  }], noting);
  assert.deepEqual(seen[0], { width: 3072, height: 4096 }, "the picker's own answer");

  await readPicked([pngFile("doc.png", 3072, 4096, 2000)], noting);
  assert.deepEqual(seen[1], { width: 3072, height: 4096 }, "the one read out of the header");
});

test("a picker that names one edge does not describe the other as undefined", async () => {
  // `overImageEdge` refuses from a single edge, so the warning has to be
  // worded from what covey actually knows — "4096xundefined" is #132 again.
  const half: PickedFile = {
    name: "half.jpg", type: "image/jpeg", size: 900_000, width: 4096,
    bytes: async () => new Uint8Array(900_000),
  };
  const r = await readPicked([half], cannotShrink);
  assert.equal(r.warnings.length, 1);
  assert.doesNotMatch(r.warnings[0]!, /undefined/);
  assert.match(r.warnings[0]!, /4096 px on a side/);
});

test("a shape with only one edge is not handed to the shrinker as a shape", async () => {
  const seen: (ImageSize | undefined)[] = [];
  const noting: Shrinker = async (_f, shape) => { seen.push(shape); return null; };
  await readPicked([{
    name: "half.jpg", type: "image/jpeg", size: 900_000, width: 4096,
    bytes: async () => new Uint8Array(900_000),
  }], noting);
  assert.equal(seen[0], undefined, "one edge refuses a picture and cannot scale one");
});
