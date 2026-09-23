import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { parseDroppedPaths, imageMime, fileMime, readDroppedFiles, readSplitDrop, isDrop, isDirectoryDrop, readClipboard, parseUriList, imageMimeOfBytes, makeTag, tagAttachments, spliceTags, keepTagged, applyDrop, cutTag, tagSpanAt, type RunReader } from "./attachments.js";

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

test("a space inside a name that is not a separator stays in the name", () => {
  // macOS writes U+202F NARROW NO-BREAK SPACE before AM and PM in the name of
  // every screenshot it takes. `\s` matches it, so covey used to cut the name
  // there and rejoin the pieces with an ordinary space — a path one invisible
  // character away from the real one, reported as "not on this machine".
  const NB = "\u202f";
  assert.deepEqual(
    parseDroppedPaths(String.raw`/d/Screenshot\ 2026-09-15\ at\ 11.16.27` + NB + "PM.png"),
    [`/d/Screenshot 2026-09-15 at 11.16.27${NB}PM.png`],
  );
  // The same holds for a terminal that escapes nothing: the ordinary spaces
  // split, and `longestRun` puts them back; the narrow one never split.
  assert.deepEqual(
    parseDroppedPaths(`/d/Screenshot 2026-09-15 at 11.16.27${NB}PM.png`),
    ["/d/Screenshot", "2026-09-15", "at", `11.16.27${NB}PM.png`],
  );
  // And a non-breaking space, which is what a name copied off a web page has.
  assert.deepEqual(parseDroppedPaths("/d/a\u00a0b.png"), ["/d/a\u00a0b.png"]);
});

test("a real macOS screenshot attaches, narrow space and all", () => {
  const NB = "\u202f";
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const name = `Screenshot 2026-09-15 at 11.16.27${NB}PM.png`;
  writeFileSync(join(dir, name), Buffer.from("89504e470d0a1a0a", "hex"));
  // What a terminal pastes on the drag: the ordinary spaces escaped, the
  // narrow one left exactly as it is.
  const pasted = join(dir, "Screenshot\\ 2026-09-15\\ at\\ 11.16.27") + NB + "PM.png";
  const { attachments, failed } = readDroppedFiles(pasted);
  assert.deepEqual(failed, [], "this is the file that reported itself missing from the machine it was on");
  assert.deepEqual(attachments.map((a) => a.name), [name]);
});

test("a multi-file drop still splits on the spaces that are separators", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  for (const n of ["one.png", "two.png"]) writeFileSync(join(dir, n), Buffer.from("89504e470d0a1a0a", "hex"));
  const drop = readDroppedFiles(`${join(dir, "one.png")} ${join(dir, "two.png")}`);
  assert.deepEqual(drop.attachments.map((a) => a.name), ["one.png", "two.png"]);
  // A tab and a newline separate too, because a terminal may use either.
  assert.deepEqual(readDroppedFiles(`${join(dir, "one.png")}\t${join(dir, "two.png")}`).attachments.length, 2);
});

test("a split drop joins a path whose name holds a narrow space", () => {
  const NB = "\u202f";
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const name = `Screenshot 2026-09-15 at 11.16.27${NB}PM.png`;
  const png = join(dir, name);
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  // The terminal cut the path right at the narrow space: the head ends with
  // the time and the chunk starts with PM.
  const cut = png.indexOf(NB);
  const split = readSplitDrop(png.slice(0, cut), png.slice(cut));
  assert.ok(split, "the seam has to find the head, which no longer ends at a token boundary");
  assert.deepEqual(split.drop.attachments.map((a) => a.name), [name]);
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
  const { attachments, failed } = readDroppedFiles(`'${png}'`);
  assert.deepEqual(failed, []);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.name, "shot 1.png");
  assert.equal(attachments[0]!.mimeType, "image/png");
  assert.equal(Buffer.from(attachments[0]!.data!, "base64").toString("hex"), "89504e470d0a1a0a");
});

test("a missing file says it is not here rather than attaching", () => {
  const { attachments, failed } = readDroppedFiles("/nope/missing.png");
  assert.equal(attachments.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.chip, "not on this machine");
  assert.match(failed[0]!.message, /covey reads a dropped file where the client runs/);
});

test("a screenshot whose name holds unescaped spaces is one drop, not prose (#85)", () => {
  // The case that made an agent read a path instead of an image: a terminal
  // that pastes the name as it is, and a screenshot name full of spaces.
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "Screenshot from 2026-09-18 at 6.38.45 PM.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const { attachments, failed } = readDroppedFiles(png);
  assert.deepEqual(failed, []);
  assert.deepEqual(attachments.map((a) => a.name), ["Screenshot from 2026-09-18 at 6.38.45 PM.png"]);
});

test("a path the terminal escaped all but one space of is still one drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot 1 of 2.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const escaped = `${join(dir, "shot")}\\ 1\\ of 2.png`;
  assert.ok(parseDroppedPaths(escaped).length > 1, "this case tests nothing unless the paste splits");
  assert.deepEqual(readDroppedFiles(escaped).attachments.map((a) => a.name), ["shot 1 of 2.png"]);
});

test("a drop of two files takes the shorter path first, spaces or not", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const one = join(dir, "shot one.png");
  const two = join(dir, "two.png");
  writeFileSync(one, Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(two, Buffer.from("89504e470d0a1a0a", "hex"));
  assert.deepEqual(readDroppedFiles(`${one} ${two}`).attachments.map((a) => a.name), ["shot one.png", "two.png"]);
});

test("a real path inside a sentence is still prose", () => {
  // The joining rule must not turn a path somebody typed into an attachment:
  // every token has to belong to a file, or the whole chunk is text.
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const drop = readDroppedFiles(`${png} is broken, fix it`);
  assert.deepEqual(drop.attachments, []);
  assert.deepEqual(drop.failed, []);
});

test("a file that cannot be read is named for a chip, with the reason (#132)", () => {
  const { attachments, failed } = readDroppedFiles("/nope/missing shot.png");
  assert.deepEqual(attachments, []);
  // The composer needs the name for the chip, and the reader needs the reason:
  // "unreadable" alone covered four different problems and named none of them.
  assert.deepEqual(failed.map((f) => [f.name, f.chip]), [["missing shot.png", "not on this machine"]]);
});

// --- a drop the terminal wrote in two goes (#130) --------------------------

/** A real PNG on disk, under a name with spaces in it. */
function screenshot(name = "Screenshot 2026-09-22 at 6.36.33 PM.png"): string {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, name);
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  return png;
}

test("half a dropped path is not a drop", () => {
  // The half that arrives second is a bare name. Read on its own it used to
  // pass for a drop and chip itself "unreadable", which is how one file became
  // a path in the draft and an error beside it (#130).
  const drop = readDroppedFiles("Screenshot 2026-09-22 at 6.36.33 PM.png");
  assert.equal(isDrop(drop), false, "a name with no directory names no file");
  assert.deepEqual(drop.failed, []);
});

test("a drop split at the last slash joins back into one file (#130)", () => {
  const png = screenshot();
  const cut = png.lastIndexOf("/") + 1;
  // The terminal wrote the directory, the composer took it for prose, and then
  // the name arrived.
  assert.equal(isDrop(readDroppedFiles(png.slice(0, cut))), false, "this case tests nothing unless the first half is prose");
  const split = readSplitDrop(png.slice(0, cut), png.slice(cut));
  assert.ok(split, "the second half has to find the first in the draft");
  assert.equal(split.start, 0, "the path starts at the start of the draft");
  assert.deepEqual(split.drop.attachments.map((a) => a.name), ["Screenshot 2026-09-22 at 6.36.33 PM.png"]);
  assert.deepEqual(split.drop.failed, []);
});

test("a drop split inside the name joins too, wherever the cut fell", () => {
  const png = screenshot("shot of the bug.png");
  for (let cut = 1; cut < png.length; cut++) {
    const split = readSplitDrop(png.slice(0, cut), png.slice(cut));
    assert.ok(split, `no join at cut ${cut}`);
    assert.deepEqual(split.drop.attachments.map((a) => a.name), ["shot of the bug.png"], `wrong file at cut ${cut}`);
  }
});

test("a split drop takes only its own path out of the sentence", () => {
  const png = screenshot("shot.png");
  const cut = png.lastIndexOf("/") + 1;
  const head = `look at ${png.slice(0, cut)}`;
  const split = readSplitDrop(head, png.slice(cut));
  assert.ok(split);
  assert.equal(head.slice(0, split.start), "look at ", "the words in front of the path are the person's own");
});

test("a split drop of a file this machine has not got is one chip, not a path", () => {
  const split = readSplitDrop("/var/folders/19/T/TemporaryItems/", "Screenshot 2026-09-22 at 6.36.33 PM.png");
  assert.ok(split);
  assert.deepEqual(split.drop.attachments, []);
  // One file, one chip — and the chip now says which of the four it was (#132).
  assert.deepEqual(split.drop.failed.map((f) => [f.name, f.chip]),
    [["Screenshot 2026-09-22 at 6.36.33 PM.png", "not on this machine"]]);
});

test("a split drop joins a file:// URL as readily as a path", () => {
  const png = screenshot("shot.png");
  const cut = png.lastIndexOf("/") + 1;
  const split = readSplitDrop(`file://${png.slice(0, cut)}`, png.slice(cut));
  assert.ok(split);
  assert.deepEqual(split.drop.attachments.map((a) => a.name), ["shot.png"]);
});

test("a draft with no path in it has nothing to join to", () => {
  assert.equal(readSplitDrop("what do you make of ", "this.png"), null);
  assert.equal(readSplitDrop("", "shot.png"), null);
});

test("a join that names no file leaves the paste alone", () => {
  assert.equal(readSplitDrop("/etc/", "hosts, and say why"), null, "prose after a directory is still prose");
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
  const { attachments, failed } = readDroppedFiles(`'${pdf}'`);
  assert.deepEqual(failed, []);
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
  const { attachments, failed } = readDroppedFiles(`${png} ${log}`);
  assert.deepEqual(failed, []);
  assert.deepEqual(attachments.map((a) => a.mimeType), ["image/png", "text/plain"]);
});

test("a non-image path only counts as a drop when the file is really there", () => {
  // An absolute path to nothing is prose, not a drop — unlike a missing image,
  // whose extension says a drop was meant.
  assert.equal(readDroppedFiles("/nope/missing.pdf").attachments.length, 0);
  assert.equal(readDroppedFiles("/nope/missing.pdf").failed.length, 0);
});

test("a dropped directory attaches as its files, each keeping the path it had", () => {
  const root = mkdtempSync(join(tmpdir(), "covey-att-"));
  const shots = join(root, "shots");
  mkdirSync(join(shots, "old"), { recursive: true });
  writeFileSync(join(shots, "after.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(shots, "old", "before.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const { attachments, failed } = readDroppedFiles(shots);
  assert.deepEqual(failed, []);
  assert.deepEqual(attachments.map((a) => a.name), ["after.png", "old/before.png"]);
  assert.deepEqual([...new Set(attachments.map((a) => a.dir))], ["shots"], "every file of one drop names one directory");
  assert.equal(attachments[0]!.mimeType, "image/png");
});

test("a dropped directory is one chip, however many files are under it", () => {
  const root = mkdtempSync(join(tmpdir(), "covey-att-"));
  const shots = join(root, "shots");
  mkdirSync(shots, { recursive: true });
  for (const n of ["a.txt", "b.txt"]) writeFileSync(join(shots, n), n);
  const drop = applyDrop("look at", 7, readDroppedFiles(shots).attachments, []);
  assert.equal(drop.value, "look at [shots/] ");
  assert.deepEqual([...new Set(drop.attachments.map((a) => a.tag))], ["[shots/]"]);
  // Delete the one chip and both files go.
  assert.deepEqual(keepTagged("look at ", drop.attachments), []);
});

test("an empty directory says so rather than attaching nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const { attachments, failed } = readDroppedFiles(dir);
  assert.equal(attachments.length, 0);
  assert.equal(failed[0]!.chip, "no files in it");
});

test("a directory a terminal cut a path at is not a drop of that directory (#130)", () => {
  // The front half of a screenshot path ends at the separator, and the
  // directory it names is real. Taking it as a drop would attach the whole of
  // a temporary folder and leave the file name in the draft as text.
  const png = screenshot();
  const cut = png.lastIndexOf("/") + 1;
  assert.equal(isDrop(readDroppedFiles(png.slice(0, cut))), false);
});

test("a big file goes over the wire packed, and a picture goes as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const log = join(dir, "run.log");
  const body = Buffer.from("the same line, over and over\n".repeat(80_000));
  writeFileSync(log, body);
  const packed = readDroppedFiles(log).attachments[0]!;
  assert.equal(packed.packing, "gzip", "a log deflates to a fraction of itself");
  assert.deepEqual(gunzipSync(Buffer.from(packed.data!, "base64")), body);

  // Random bytes stand in for a photograph: nothing to deflate, so nothing is.
  const jpg = join(dir, "photo.jpg");
  writeFileSync(jpg, randomBytes(2 * 1024 * 1024));
  assert.equal(readDroppedFiles(jpg).attachments[0]!.packing, undefined);
});

test("a relative filename that exists is prose, not a drop", () => {
  // Terminals always paste an absolute path on a drop, so a bare name that
  // happens to match a file in the cwd must still go in as text.
  assert.equal(readDroppedFiles("package.json").attachments.length, 0);
});

test("a file the API would refuse still travels: only covey's own cap turns one away", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const six = join(dir, "run.log");
  writeFileSync(six, Buffer.alloc(6 * 1024 * 1024));
  assert.equal(readDroppedFiles(six).attachments.length, 1, "6 MB is nothing to a file the agent opens by path");

  const big = join(dir, "huge.log");
  writeFileSync(big, Buffer.alloc(33 * 1024 * 1024));
  const { attachments, failed } = readDroppedFiles(big);
  assert.equal(attachments.length, 0);
  assert.equal(failed[0]!.chip, "33 MB, over the 32 MB limit");
  assert.match(failed[0]!.message, /huge\.log is 33 MB, over the 32 MB limit/);
});

// --- clipboard -------------------------------------------------------------

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(16)]);
const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" });

/**
 * A fake clipboard: one answer per command line, keyed by the binary and its
 * arguments joined with spaces. Anything the fake does not name is a program
 * that is not installed, which is the state every Linux box starts in.
 */
function fakeClipboard(
  answers: Record<string, { stdout?: Buffer | string; status?: number; error?: NodeJS.ErrnoException }>,
  /** Bytes for `sips` to write at its `--out` path, the way the real one does. */
  sips?: Buffer,
): { run: RunReader; calls: string[] } {
  const calls: string[] = [];
  const run: RunReader = (bin, args) => {
    const key = [bin, ...args].join(" ");
    calls.push(key);
    if (bin === "sips" && sips) {
      writeFileSync(args[args.indexOf("--out") + 1]!, sips);
      return { stdout: null, status: 0 };
    }
    const a = answers[key];
    // The script that writes the TIFF carries a temporary path, so it cannot
    // be keyed. Any other osascript ran and printed nothing, as the real one
    // does; everything else is a program nobody installed.
    if (!a) return bin === "osascript" ? { stdout: null, status: 0 } : { stdout: null, status: null, error: enoent() };
    const stdout = typeof a.stdout === "string" ? Buffer.from(a.stdout) : a.stdout ?? null;
    return { stdout, status: a.status ?? 0, error: a.error };
  };
  return { run, calls };
}

/** The readers are chosen by platform, so every test names the one it means. */
const LINUX: NodeJS.Platform = "linux";
const MAC: NodeJS.Platform = "darwin";

test("the media type of clipboard bytes comes from the bytes, not from a name", () => {
  assert.equal(imageMimeOfBytes(PNG), "image/png");
  assert.equal(imageMimeOfBytes(JPEG), "image/jpeg");
  assert.equal(imageMimeOfBytes(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(imageMimeOfBytes(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
  assert.equal(imageMimeOfBytes(Buffer.from("Usage: pngpaste")), null);
});

test("a uri list gives up its paths, under GNOME's copy line or without it", () => {
  assert.deepEqual(parseUriList("file:///home/me/shot%201.png\r\nfile:///home/me/b.pdf\r\n"), ["/home/me/shot 1.png", "/home/me/b.pdf"]);
  assert.deepEqual(parseUriList("copy\nfile:///home/me/a.png"), ["/home/me/a.png"], "GNOME puts `copy` or `cut` on the first line");
  assert.deepEqual(parseUriList("#comment\nnot a uri"), []);
});

test("a file copied in a file manager attaches, with its own name (#124)", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const pdf = join(dir, "report 1.pdf");
  writeFileSync(pdf, "%PDF-1.7\n");
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "text/uri-list\ntext/plain" },
    [`wl-paste --no-newline --type text/uri-list`]: { stdout: `file://${encodeURI(pdf)}` },
  });
  const r = readClipboard(run, LINUX);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.attachments.map((a) => a.name), ["report 1.pdf"], "the copied file keeps its name, which a chip needs");
  assert.equal(r.attachments[0]!.mimeType, "application/pdf", "a copied file is not required to be an image");
});

test("a file list is preferred over image bytes for the same copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "shot.png");
  writeFileSync(png, PNG);
  const { run, calls } = fakeClipboard({
    "wl-paste --list-types": { stdout: "text/uri-list\nimage/png" },
    [`wl-paste --no-newline --type text/uri-list`]: { stdout: `file://${encodeURI(png)}` },
    "wl-paste --no-newline --type image/png": { stdout: PNG },
  });
  assert.deepEqual(readClipboard(run, LINUX).attachments.map((a) => a.name), ["shot.png"]);
  assert.ok(!calls.includes("wl-paste --no-newline --type image/png"), "a named file beats bytes called clipboard-<date>");
});

test("clipboard image bytes of any type the model takes are attached", () => {
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "image/jpeg" },
    "wl-paste --no-newline --type image/jpeg": { stdout: JPEG },
  });
  const r = readClipboard(run, LINUX);
  assert.deepEqual(r.errors, []);
  assert.equal(r.attachments[0]!.mimeType, "image/jpeg", "PNG was the only type covey took before #124");
  assert.match(r.attachments[0]!.name, /^clipboard-\d{14}\.jpg$/);
  assert.deepEqual(readFileSync(r.attachments[0]!.path), JPEG, "the path should point at the bytes");
});

test("xclip answers when wl-paste is not installed", () => {
  const { run } = fakeClipboard({
    "xclip -selection clipboard -t TARGETS -o": { stdout: "TARGETS\nimage/png" },
    "xclip -selection clipboard -t image/png -o": { stdout: PNG },
  });
  assert.equal(readClipboard(run, LINUX).attachments[0]!.mimeType, "image/png");
});

test("text on the clipboard comes back for the caller to paste", () => {
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "text/plain;charset=utf-8" },
    "wl-paste --no-newline --type text/plain;charset=utf-8": { stdout: "/home/me/shot.png" },
  });
  const r = readClipboard(run, LINUX);
  assert.deepEqual(r.attachments, []);
  assert.equal(r.text, "/home/me/shot.png", "the composer runs it through the drop parser, so a copied path becomes a chip");
});

test("a missing reader asks for an install, it does not report the spawn failure", () => {
  const { run } = fakeClipboard({});
  const { attachments, errors } = readClipboard(run, LINUX);
  assert.deepEqual(attachments, []);
  // covey depends on no clipboard binary, so "none installed" is an ordinary
  // state. The line has to be an instruction the reader can act on. Matching
  // the binary name alone is not enough: "pngpaste failed: spawnSync ENOENT"
  // contains it too, and that is the degradation this test exists to stop.
  assert.match(errors[0]!, /^to paste an image: /);
  assert.match(errors[0]!, /wl-clipboard|xclip/);
  assert.doesNotMatch(errors[0]!, /ENOENT|spawnSync|failed/);
});

test("a clipboard with neither a file nor an image says what it does hold", () => {
  const { run } = fakeClipboard({ "wl-paste --list-types": { stdout: "text/html\napplication/pdf" } });
  const { errors } = readClipboard(run, LINUX);
  assert.match(errors[0]!, /text\/html/, "`the clipboard has no image` hid what was really on it");
});

test("an oversized clipboard image reports its size", () => {
  const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "image/png" },
    "wl-paste --no-newline --type image/png": { stdout: big },
  });
  assert.match(readClipboard(run, LINUX).errors[0]!, /limit 5 MB/);
});

test("an oversized copied file gets the same chip a dropped one gets", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const big = join(dir, "huge.log");
  writeFileSync(big, Buffer.alloc(33 * 1024 * 1024));
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "text/uri-list" },
    "wl-paste --no-newline --type text/uri-list": { stdout: `file://${encodeURI(big)}` },
  });
  const r = readClipboard(run, LINUX);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.failed.map((f) => f.name), ["huge.log"]);
  assert.match(r.failed[0]!.message, /huge\.log is 33 MB, over the 32 MB limit/);
});

// --- the macOS pasteboard --------------------------------------------------

/**
 * macOS is where most of these pastes happen and is the one platform covey
 * cannot try here, so each branch of its reader is held by a test: a copied
 * file, a screenshot with pngpaste, and the same screenshot without it.
 */

const MAC_FILE_INFO = "«class furl», 78, «class hfs », 122, string, 62";
const MAC_IMAGE_INFO = "«class PNGf», 21358, TIFF picture, 61522";
const FURL = "osascript -e POSIX path of (the clipboard as «class furl»)";

test("a file copied in Finder attaches by its path (#124)", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "Screenshot 2026-09-22 at 1.02.33 PM.png");
  writeFileSync(png, PNG);
  const { run } = fakeClipboard({
    "osascript -e clipboard info": { stdout: MAC_FILE_INFO },
    [FURL]: { stdout: `${png}\n` },
  });
  const r = readClipboard(run, MAC);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.attachments.map((a) => a.name), ["Screenshot 2026-09-22 at 1.02.33 PM.png"]);
});

test("a screenshot on the pasteboard goes through pngpaste when it is there", () => {
  const { run, calls } = fakeClipboard({
    "osascript -e clipboard info": { stdout: MAC_IMAGE_INFO },
    "pngpaste -": { stdout: PNG },
  });
  assert.equal(readClipboard(run, MAC).attachments[0]!.mimeType, "image/png");
  assert.ok(!calls.some((c) => c.startsWith("sips")), "pngpaste answered, so the slower route is never run");
});

test("without pngpaste the system's own osascript and sips do the same job", () => {
  const { run, calls } = fakeClipboard({
    "osascript -e clipboard info": { stdout: MAC_IMAGE_INFO },
    // Every osascript that is not `clipboard info` is the one that writes the
    // TIFF; the fake answers it by exit code alone, and sips writes the PNG.
  }, PNG);
  const answers = (bin: string) => calls.filter((c) => c.startsWith(bin)).length;
  const r = readClipboard(run, MAC);
  assert.deepEqual(r.errors, [], "a Mac with nothing installed must still paste an image");
  assert.equal(r.attachments[0]!.mimeType, "image/png");
  assert.equal(answers("sips"), 1);
  assert.ok(calls.includes("pngpaste -"), "pngpaste is tried first, and was absent here");
});

test("a pasteboard holding only text hands the text back", () => {
  const { run } = fakeClipboard({
    "osascript -e clipboard info": { stdout: "«class utf8», 34, string, 34" },
    "pbpaste": { stdout: "/Users/me/shot.png" },
  });
  assert.equal(readClipboard(run, MAC).text, "/Users/me/shot.png");
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

test("a dropped file lands in the draft as a tag at the caret", () => {
  const drop = applyDrop("look at and say why", 8, [att("shot.png")], []);
  assert.equal(drop.value, "look at [shot.png] and say why", "the file belongs where it was dropped, not on a line of its own");
  assert.equal(drop.caret, 19);
  assert.deepEqual(drop.attachments.map((a) => a.tag), ["[shot.png]"]);
});

test("two files with one name get two tags the user can tell apart", () => {
  const first = applyDrop("compare", 7, [att("shot.png")], []);
  const second = applyDrop(first.value, first.caret, [att("shot.png")], first.attachments);
  const tags = second.attachments.map((a) => a.tag);
  assert.equal(new Set(tags).size, 2, `two files called shot.png need two tags, got ${JSON.stringify(tags)}`);
  assert.equal(second.value, "compare [shot.png] [shot.png 2] ");
});

/** One file that did not attach, for the chip cases. */
const fail = (name: string, chip: string) => ({ name, chip, message: `${name}: ${chip}` });

test("a file that did not attach gets a chip that says why, and no attachment", () => {
  const drop = applyDrop("look at", 7, [], [], [fail("shot.png", "not on this machine")]);
  assert.equal(drop.value, "look at [shot.png — not on this machine] ");
  assert.deepEqual(drop.attachments.filter((a) => !a.failed), [], "a chip in an error state stands for no file");
  assert.deepEqual(drop.attachments.map((a) => a.failed), [true], "it is held only so one key can delete the whole chip");
  assert.doesNotMatch(drop.value, /\//, "the point of the chip is that no path reaches the screen (#85)");
});

test("a failed chip cannot take the tag a real file needs", () => {
  const drop = applyDrop("", 0, [att("shot.png")], [], [fail("shot.png", "no permission")]);
  assert.equal(drop.value, "[shot.png] [shot.png — no permission] ");
  assert.deepEqual(drop.attachments.filter((a) => !a.failed).map((a) => a.tag), ["[shot.png]"]);
});

test("a drop forgets the file whose tag the user already deleted", () => {
  const first = applyDrop("", 0, [att("shot.png")], []);
  // The user selects the tag and deletes it, then drops the same file again.
  const second = applyDrop("", 0, [att("shot.png")], first.attachments);
  assert.deepEqual(second.attachments.map((a) => a.tag), ["[shot.png]"], "the freed name is free to use again");
});

// --- an oversized image is shrunk, not refused (#132) ----------------------

/**
 * A screenshot off a retina display is routinely over the 5 MB cap, and covey
 * used to answer that with the one word "unreadable". It now scales the image
 * down instead — to the long edge past which the API downscales anyway, so
 * nothing the model would have read is lost.
 *
 * These need a shrinker on the PATH. Skipped where there is none, because a
 * machine without one is exactly the case `tooBig` is written for.
 */
const shrinker = ["sips", "magick", "convert", "ffmpeg"]
  .find((c) => spawnSync("sh", ["-c", `command -v ${c}`], { stdio: "ignore" }).status === 0);

test("an oversized image is shrunk under the cap and attaches", { skip: shrinker ? false : "no sips, magick, convert or ffmpeg on this machine" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const big = join(dir, "Screenshot 2026-09-22 at 6.54.34 PM.png");
  writeFileSync(big, hugePng());
  assert.ok(statSync(big).size > 5 * 1024 * 1024, "the fixture has to be over the cap to test the cap");

  const { attachments, failed } = readDroppedFiles(big);
  assert.deepEqual(failed, [], `it should have shrunk with ${shrinker}`);
  assert.equal(attachments.length, 1);
  const a = attachments[0]!;
  // The name the reader dropped survives; the bytes are the smaller ones.
  assert.equal(a.name, "Screenshot 2026-09-22 at 6.54.34 PM.png");
  assert.equal(a.mimeType, "image/jpeg");
  assert.ok(Buffer.from(a.data!, "base64").byteLength <= 5 * 1024 * 1024, "the bytes that go on the wire are under the cap");
});

test("an image no shrinker could take under the API's limit still attaches, and says what that costs", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const big = join(dir, "shot.png");
  writeFileSync(big, Buffer.alloc(6 * 1024 * 1024));
  // Not a real PNG, so every shrinker refuses it — which is the same answer a
  // machine with no shrinker gives, and the branch under test.
  const { attachments, failed, warnings } = readDroppedFiles(big);
  assert.deepEqual(failed, [], "covey carries it: the file is well under covey's own cap");
  assert.equal(attachments.length, 1);
  assert.match(warnings[0]!, /sips, magick, convert or ffmpeg/);
  assert.match(warnings[0]!, /the model cannot see an image over 5 MB/);
});

/** A PNG big enough to break the cap: random pixels do not compress. */
function hugePng(): Buffer {
  const side = 2600;
  const raw = Buffer.alloc(side * side * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
  // A PPM is what every one of the shrinkers reads without a library, and it
  // is uncompressed, so the fixture is reliably over the cap.
  return Buffer.concat([Buffer.from(`P6\n${side} ${side}\n255\n`), raw]);
}


// --- deleting a chip -------------------------------------------------------

/**
 * A chip is one thing on the screen, so it is one key to delete. Without this
 * the reader spells `[Screenshot 2026-09-22 at 8.48.31 PM.png]` out backwards,
 * and a chip half deleted is a file dropped with nothing said.
 */

test("backspace at the end of a chip takes the whole chip, and the space beside it", () => {
  const drop = applyDrop("look at", 7, [att("shot.png")], []);
  assert.equal(drop.value, "look at [shot.png] ");
  const span = tagSpanAt(drop.value, 18, ["[shot.png]"], true);
  assert.deepEqual(span, { start: 8, end: 18 });
  assert.deepEqual(cutTag(drop.value, span!), { value: "look at ", caret: 8 });
});

test("delete at the start of a chip takes it forwards", () => {
  const v = "look at [shot.png] now";
  const span = tagSpanAt(v, 8, ["[shot.png]"], false);
  assert.deepEqual(cutTag(v, span!), { value: "look at now", caret: 8 });
});

test("the caret inside a chip deletes the chip, whichever key asked", () => {
  const v = "[shot.png] now";
  for (const back of [true, false]) {
    assert.deepEqual(tagSpanAt(v, 5, ["[shot.png]"], back), { start: 0, end: 10 });
  }
  assert.deepEqual(cutTag(v, { start: 0, end: 10 }), { value: "now", caret: 0 });
});

test("a caret between two chips takes the one the key points at", () => {
  const v = "[a.png][b.png]";
  assert.deepEqual(tagSpanAt(v, 7, ["[a.png]", "[b.png]"], true), { start: 0, end: 7 });
  assert.deepEqual(tagSpanAt(v, 7, ["[a.png]", "[b.png]"], false), { start: 7, end: 14 });
});

test("ordinary text is deleted a character at a time, as it always was", () => {
  assert.equal(tagSpanAt("look at that", 5, ["[shot.png]"], true), null);
  // The brackets have to be a chip covey knows, not any bracket the user typed.
  assert.equal(tagSpanAt("a [note] here", 8, ["[shot.png]"], true), null);
});

test("cutting a chip never leaves a double space or eats a word", () => {
  assert.deepEqual(cutTag("[a.png] tail", { start: 0, end: 7 }), { value: "tail", caret: 0 });
  assert.deepEqual(cutTag("head [a.png]", { start: 5, end: 12 }), { value: "head", caret: 4 });
  assert.deepEqual(cutTag("head[a.png]tail", { start: 4, end: 11 }), { value: "headtail", caret: 4 });
});

test("a directory drop is one chip and knows it", () => {
  const root = mkdtempSync(join(tmpdir(), "covey-att-"));
  const shots = join(root, "shots");
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "a.txt"), "a");
  const drop = readDroppedFiles(shots);
  assert.equal(isDirectoryDrop(drop), true);
  assert.equal(isDirectoryDrop(readDroppedFiles("/nope/missing.png")), false, "a failure is not a directory drop");
});
