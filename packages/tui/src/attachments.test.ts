import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDroppedPaths, imageMime, readDroppedImages, makeTag, tagAttachments, spliceTags, keepTagged } from "./attachments.js";

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
