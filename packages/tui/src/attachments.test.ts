import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDroppedPaths, imageMime, readDroppedImages } from "./attachments.js";

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
  assert.equal(readDroppedImages("look at src/app.png and tell me why").attachments.length, 0);
  assert.equal(readDroppedImages("just some text").attachments.length, 0);
});

test("reads a real dropped file into a base64 attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot 1.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const { attachments, errors } = readDroppedImages(`'${png}'`);
  assert.equal(errors.length, 0);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.name, "shot 1.png");
  assert.equal(attachments[0]!.mimeType, "image/png");
  assert.equal(Buffer.from(attachments[0]!.data!, "base64").toString("hex"), "89504e470d0a1a0a");
});

test("a missing file reports an error rather than attaching", () => {
  const { attachments, errors } = readDroppedImages("/nope/missing.png");
  assert.equal(attachments.length, 0);
  assert.equal(errors.length, 1);
});
