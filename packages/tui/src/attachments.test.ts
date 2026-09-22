import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDroppedPaths, imageMime, fileMime, readDroppedFiles, readClipboard, parseUriList, imageMimeOfBytes, makeTag, tagAttachments, spliceTags, keepTagged, applyDrop, type RunReader } from "./attachments.js";

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

test("a screenshot whose name holds unescaped spaces is one drop, not prose (#85)", () => {
  // The case that made an agent read a path instead of an image: a terminal
  // that pastes the name as it is, and a screenshot name full of spaces.
  const dir = mkdtempSync(join(tmpdir(), "covey-att-"));
  const png = join(dir, "Screenshot from 2026-09-18 at 6.38.45 PM.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const { attachments, unreadable, errors } = readDroppedFiles(png);
  assert.deepEqual(errors, []);
  assert.deepEqual(unreadable, []);
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
  assert.deepEqual(drop.errors, []);
});

test("a file that cannot be read is named for a chip, not left to the path", () => {
  const { attachments, unreadable, errors } = readDroppedFiles("/nope/missing shot.png");
  assert.deepEqual(attachments, []);
  assert.deepEqual(unreadable, ["missing shot.png"], "the composer needs the name to put a chip in the draft");
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
  writeFileSync(big, Buffer.alloc(6 * 1024 * 1024));
  const { run } = fakeClipboard({
    "wl-paste --list-types": { stdout: "text/uri-list" },
    "wl-paste --no-newline --type text/uri-list": { stdout: `file://${encodeURI(big)}` },
  });
  const r = readClipboard(run, LINUX);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.unreadable, ["huge.log"]);
  assert.match(r.errors[0]!, /huge\.log is 6 MB \(limit 5 MB\)/);
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

test("a file that did not attach gets a chip that says so, and no attachment", () => {
  const drop = applyDrop("look at", 7, [], [], ["shot.png"]);
  assert.equal(drop.value, "look at [shot.png — unreadable] ");
  assert.deepEqual(drop.attachments, [], "a chip in an error state stands for no file");
  assert.doesNotMatch(drop.value, /\//, "the point of the chip is that no path reaches the screen (#85)");
});

test("a failed chip cannot take the tag a real file needs", () => {
  const drop = applyDrop("", 0, [att("shot.png")], [], ["shot.png"]);
  assert.equal(drop.value, "[shot.png] [shot.png — unreadable] ");
  assert.deepEqual(drop.attachments.map((a) => a.tag), ["[shot.png]"]);
});

test("a drop forgets the file whose tag the user already deleted", () => {
  const first = applyDrop("", 0, [att("shot.png")], []);
  // The user selects the tag and deletes it, then drops the same file again.
  const second = applyDrop("", 0, [att("shot.png")], first.attachments);
  assert.deepEqual(second.attachments.map((a) => a.tag), ["[shot.png]"], "the freed name is free to use again");
});
