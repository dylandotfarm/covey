import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AttachError, ATTACHMENT_EXTENSIONS, IMAGE_CAP_BYTES, VIDEO_CAP_FREE_BYTES, VIDEO_CAP_PAID_BYTES,
  capFor, contentTypeOf, describeUploadFailure, placeAttachments, planAttachments,
} from "./attach.js";

test("the media type comes from the extension, and only what GitHub renders is allowed", () => {
  assert.equal(contentTypeOf("demo.mp4"), "video/mp4");
  assert.equal(contentTypeOf("Shot.PNG"), "image/png");
  assert.equal(contentTypeOf("a.b.jpeg"), "image/jpeg");
  assert.equal(contentTypeOf("notes.txt"), null);
  assert.equal(contentTypeOf("noext"), null);
  assert.equal(contentTypeOf("archive.tar.gz"), null);
  assert.deepEqual(ATTACHMENT_EXTENSIONS, ["mp4", "mov", "webm", "png", "jpg", "jpeg", "gif", "webp", "svg"]);
});

test("a file GitHub would not render is refused with the list, before anything else", () => {
  assert.throws(() => planAttachments([{ name: "notes.txt", bytes: 10 }], "free"), (e: unknown) => {
    assert.ok(e instanceof AttachError);
    assert.match(e.message, /cannot attach notes\.txt/);
    for (const ext of ATTACHMENT_EXTENSIONS) assert.ok(e.message.includes(`.${ext}`), `names .${ext}`);
    return true;
  });
});

test("the cap is 10 MB for an image on any plan, and 10 or 100 MB for a video by plan", () => {
  assert.equal(capFor("image/png", "paid"), IMAGE_CAP_BYTES);
  assert.equal(capFor("video/mp4", "free"), VIDEO_CAP_FREE_BYTES);
  assert.equal(capFor("video/mp4", "unknown"), VIDEO_CAP_FREE_BYTES);
  assert.equal(capFor("video/mp4", "paid"), VIDEO_CAP_PAID_BYTES);
});

test("a file over the cap is refused with both numbers", () => {
  const big = { name: "demo.mp4", bytes: 12.4 * 1024 * 1024 };
  assert.throws(() => planAttachments([big], "free"), /demo\.mp4: it is 12\.4 MB, over 10 MB, the cap for a video on the free plan/);
  assert.throws(() => planAttachments([big], "unknown"), /over 10 MB, the cap for a video on the free plan, which applies because the plan could not be read/);
  assert.deepEqual(planAttachments([big], "paid"), [{ ...big, contentType: "video/mp4", kind: "video" }]);
  assert.throws(() => planAttachments([{ name: "shot.png", bytes: 11 * 1024 * 1024 }], "paid"), /shot\.png: it is 11 MB, over 10 MB, the cap for an image/);
});

test("the first refusal stops the whole request, so nothing is half done", () => {
  assert.throws(() => planAttachments([{ name: "ok.png", bytes: 1 }, { name: "no.txt", bytes: 1 }], "free"), /no\.txt/);
});

test("uploads go at the end of the body in the order given, a video as a bare URL and an image as an image", () => {
  const body = placeAttachments("What changed.\n", [
    { name: "demo.mp4", kind: "video", url: "https://github.com/user-attachments/assets/1" },
    { name: "shot.png", kind: "image", url: "https://github.com/user-attachments/assets/2" },
  ]);
  assert.equal(body, "What changed.\n\nhttps://github.com/user-attachments/assets/1\n\n![shot.png](https://github.com/user-attachments/assets/2)");
  assert.equal(placeAttachments("", [{ name: "a.png", kind: "image", url: "u" }]), "![a.png](u)");
  assert.equal(placeAttachments("Body.", []), "Body.");
});

test("a placeholder puts the upload where the body wants it", () => {
  const body = placeAttachments("Before.\n\n{{attach:demo.mp4}}\n\nAfter. {{ attach: shot.png }}", [
    { name: "demo.mp4", kind: "video", url: "V" },
    { name: "shot.png", kind: "image", url: "I" },
    { name: "extra.gif", kind: "image", url: "G" },
  ]);
  assert.equal(body, "Before.\n\nV\n\nAfter. {{ attach: shot.png }}\n\n![shot.png](I)\n\n![extra.gif](G)");
});

test("a placeholder that names no file is refused, so the reader never sees braces", () => {
  assert.throws(() => placeAttachments("{{attach:missing.png}}", [{ name: "a.png", kind: "image", url: "u" }]), /names \{\{attach:missing\.png\}\}, but no --attach gives a file called missing\.png/);
});

test("a refused upload is described with its status, its answer and the by-hand fallback", () => {
  const m = describeUploadFailure("demo.mp4", 403, "{\"message\":\"Forbidden\"}\n", "/data/attachments/t/x.mp4");
  assert.match(m, /^GitHub refused the upload of demo\.mp4: HTTP 403 \{"message":"Forbidden"\}\./);
  assert.match(m, /kept at \/data\/attachments\/t\/x\.mp4; a person can drag it into the pull request by hand/);
  assert.match(m, /Nothing was pushed and nothing was opened$/);
  assert.match(describeUploadFailure("a.png", 500, "", null), /HTTP 500\. {2}a person can drag/);
});
