/**
 * The words three clients ask the reader with, and the URL they ask against.
 *
 * All of it is pure, which is the point: the terminal, the page and the phone
 * each put the question their own way, and this is what stops them putting
 * three different questions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES } from "@covey/protocol";
import { inFlightNotice, largeDropPrompt, readUploadAnswer, splitInFlight, tooLargeToUpload, uploadUrl, uploadingLabel } from "./upload.js";

test("nothing to ask about is no question", () => {
  assert.equal(largeDropPrompt([]), null);
});

test("one file: the name and the size are the question", () => {
  const p = largeDropPrompt([{ name: "clip.mp4", size: 90 * 1024 * 1024 }])!;
  assert.equal(p.title, "Send clip.mp4 (90 MB)?");
  assert.equal(p.accept, "Send it");
  assert.match(p.detail, /A message carries 32 MB without asking and this one is over that/);
  assert.match(p.detail, /it stays in the thread's working directory/, "a yes leaves the bytes somewhere");
  assert.match(p.detail, /not to commit one/, "and the reader is told the agent is warned");
  assert.doesNotMatch(p.detail, /^clip\.mp4 \(/, "one file is already named in the title");
});

test("the sentence is about the message and never about one file", () => {
  // A client counts the whole message against the cap, so a 20 MB file picked
  // beside another one takes this route while being under the cap itself. A
  // detail that said "that file is over 32 MB" would be saying something false
  // about a 20 MB file.
  const p = largeDropPrompt([{ name: "b.bin", size: 20 * 1024 * 1024 }])!;
  assert.match(p.detail, /A message carries 32 MB without asking and this one is over that/);
  assert.doesNotMatch(p.detail, /that file is over/);
  assert.equal(p.title, "Send b.bin (20 MB)?", "and the title carries the honest number");
});

test("several files: the total is in the title and the names are in the detail", () => {
  const p = largeDropPrompt([
    { name: "a.mp4", size: 40 * 1024 * 1024 },
    { name: "b.mov", size: 60 * 1024 * 1024 },
  ])!;
  // The number the reader is deciding on must survive a one-row title, so the
  // names are not allowed to push it off the end.
  assert.equal(p.title, "Send 2 files (100 MB)?");
  assert.match(p.detail, /^a\.mp4 \(40 MB\), b\.mov \(60 MB\)\. /);
  assert.match(p.detail, /they go to the machine/, "several files are not an it");
  assert.equal(p.accept, "Send them");
});

test("the one-line form keeps what a reader cannot work out for themselves", () => {
  const p = largeDropPrompt([{ name: "clip.mp4", size: 90 * 1024 * 1024 }])!;
  assert.match(p.short, /uploaded to the machine/);
  assert.match(p.short, /not to commit it/);
  assert.ok(p.short.length <= 70, `a pick hint longer than its row truncates the label away: ${p.short.length}`);
});

test("a file already going up is not a new drop", () => {
  const clip = { name: "clip.mp4", path: "/a/clip.mp4" };
  const other = { name: "demo.mov", path: "/a/demo.mov" };
  // Between the yes and the answer there is no chip, so `revealDrop` has
  // nothing to match and a second paste of the path reads as a fresh drop —
  // at this size, the whole file over the link twice.
  const held = new Set(["/a/clip.mp4"]);
  assert.deepEqual(splitInFlight([clip], held), { waiting: [], already: [clip] });
  // A drop of one that is going and one that is not asks about the second.
  assert.deepEqual(splitInFlight([clip, other], held), { waiting: [other], already: [clip] });
  assert.deepEqual(splitInFlight([other], held), { waiting: [other], already: [] });
  assert.deepEqual(splitInFlight([], held), { waiting: [], already: [] });
  // The *path* is the identity and never the chunk the reader pasted: one file
  // reaches the composer whole, cut in two, and copied in a file manager.
  assert.deepEqual(splitInFlight([{ name: "clip.mp4", path: "/b/clip.mp4" }], held).already, []);
});

test("what a reader is told about a file already going up", () => {
  assert.equal(inFlightNotice([{ name: "clip.mp4" }]), "clip.mp4 is already on its way to the machine");
  assert.equal(inFlightNotice([{ name: "a" }, { name: "b" }]), "2 of those files are already on their way to the machine");
});

test("a file over the ceiling says the ceiling, and says what to do instead", () => {
  const f = tooLargeToUpload("film.mov", MAX_UPLOAD_BYTES + 1);
  assert.equal(f.name, "film.mov");
  assert.match(f.chip, /over the 512 MB limit/);
  assert.match(f.message, /512 MB covey carries at all/);
  assert.match(f.message, /Put it on the machine the thread runs on/);
  // The two caps bound different things, so the refusal must not name the
  // other one: a reader told "32 MB" would shrink a file that already fits.
  assert.doesNotMatch(f.message, new RegExp(`${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`));
});

test("the upload URL keeps the token the client already dials with", () => {
  assert.equal(uploadUrl("http://box:3790", "t-1", "clip.mp4"), "http://box:3790/upload?thread=t-1&name=clip.mp4");
  assert.equal(
    uploadUrl("http://box:3790?token=se+cret", "t-1", "a b.mp4"),
    "http://box:3790/upload?token=se+cret&thread=t-1&name=a+b.mp4",
  );
  assert.equal(uploadUrl("http://box:3790/", "t", "a"), "http://box:3790/upload?thread=t&name=a");
});

test("what the composer says while a file goes up", () => {
  assert.equal(uploadingLabel("clip.mp4"), "uploading clip.mp4…");
  assert.equal(uploadingLabel("clip.mp4", 50, 200), "uploading clip.mp4 — 25%");
  // A total of zero is a platform that could not say; a percentage of a number
  // nobody has is worse than no percentage.
  assert.equal(uploadingLabel("clip.mp4", 50, 0), "uploading clip.mp4…");
  assert.equal(uploadingLabel("clip.mp4", 300, 200), "uploading clip.mp4 — 100%");
});

test("the route's answer is the path the attachment then carries", () => {
  const a = readUploadAnswer(200, JSON.stringify({ path: "/w/.covey/threads/t/files/clip.mp4", name: "clip.mp4" }));
  assert.deepEqual(a, { path: "/w/.covey/threads/t/files/clip.mp4", name: "clip.mp4" });
});

test("a refusal reaches the reader in the route's own words", () => {
  // The route writes "upload: <why>" and a newline; the first line is the
  // sentence, because it was written for a person.
  assert.throws(() => readUploadAnswer(413, "upload: that file is over the 512 MB limit\n"), /over the 512 MB limit/);
  assert.throws(() => readUploadAnswer(404, "upload: no such thread on this machine\n"), /no such thread/);
  assert.throws(() => readUploadAnswer(502, ""), /answered 502/, "a proxy that said nothing still gets a sentence");
  assert.throws(() => readUploadAnswer(200, "<html>"), /not readable/);
  assert.throws(() => readUploadAnswer(200, "{}"), /named no file/);
});
