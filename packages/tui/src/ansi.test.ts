import test from "node:test";
import assert from "node:assert/strict";
import { AnsiLog, applySgr, readEscape, xterm256 } from "./ansi.js";
import { lineText, lineWidth } from "./lines.js";
import { echoLine, exitLabel, shellPrompt } from "./shell.js";

/**
 * What a shell wrote, as rows the transcript's own renderer can paint (#10).
 *
 * The measurements are the point of this file. An escape sequence left in the
 * text would be counted as printable columns by `width()` and the frame would
 * be laid out too wide — the same trap `media.ts` and `Span.link` exist to
 * avoid — so every case here checks the *width* as well as the text.
 */

function log(...chunks: string[]) {
  const l = new AnsiLog(100);
  for (const c of chunks) l.write(c);
  return l;
}

const texts = (l: AnsiLog) => l.rows().map(lineText);

test("plain text becomes one row per newline", () => {
  const l = log("one\ntwo\n");
  assert.deepEqual(texts(l), ["one", "two"]);
});

test("a row without its newline is still shown", () => {
  // A prompt, a progress line, or the last chunk of a command that has not
  // finished. A log that only showed finished rows would show nothing at all
  // while a build was writing its first line.
  assert.deepEqual(texts(log("working")), ["working"]);
});

test("colour becomes a span and costs no columns", () => {
  const l = log("\x1b[31mred\x1b[39m plain\n");
  const row = l.rows()[0]!;
  assert.equal(lineText(row), "red plain");
  // Nine columns, not the twenty the escapes would have added.
  assert.equal(lineWidth(row), 9);
  assert.equal(row[0]!.color, "red");
  assert.equal(row[1]!.color, undefined);
});

test("bold, dim, italic and inverse come through", () => {
  const row = log("\x1b[1mb\x1b[22m\x1b[2md\x1b[22m\x1b[3mi\x1b[23m\x1b[7mv\x1b[27m\n").rows()[0]!;
  assert.equal(lineText(row), "bdiv");
  assert.equal(row[0]!.bold, true);
  assert.equal(row[1]!.dim, true);
  assert.equal(row[2]!.italic, true);
  assert.equal(row[3]!.inverse, true);
});

test("a reset clears every field", () => {
  const row = log("\x1b[1;31;44mon\x1b[0moff\n").rows()[0]!;
  assert.deepEqual({ ...row[1] }, { text: "off" });
});

test("256 colour and truecolour become hex, the first sixteen stay named", () => {
  // The first sixteen are the reader's own terminal colours, so they keep the
  // names and their emulator decides what they look like.
  assert.equal(xterm256(1), "red");
  assert.equal(xterm256(9), "redBright");
  assert.equal(xterm256(196), "#ff0000");
  assert.equal(xterm256(232), "#080808");
  const row = log("\x1b[38;5;196ma\x1b[38;2;17;34;51mb\n").rows()[0]!;
  assert.equal(row[0]!.color, "#ff0000");
  assert.equal(row[1]!.color, "#112233");
});

test("the sub-parameter form of a colour reads the same", () => {
  // `38:2:…` is the newer separator, and a tool may write either.
  assert.equal(log("\x1b[38:2:17:34:51mx\n").rows()[0]![0]!.color, "#112233");
});

test("a colour's own parameters are not read as the next attribute", () => {
  // `38;5;1` is colour 1, and the `1` must not also turn bold on.
  const row = log("\x1b[38;5;1mx\n").rows()[0]!;
  assert.equal(row[0]!.color, "red");
  assert.equal(row[0]!.bold, undefined);
});

test("a carriage return rewrites the line, which is how every progress bar works", () => {
  // Without this, `pnpm install` is two hundred rows of the same line.
  assert.deepEqual(texts(log("10%\r100%\n")), ["100%"]);
  // A shorter line over a longer one leaves the tail behind, exactly as a
  // terminal does — which is why the tools that do it send an erase as well.
  assert.deepEqual(texts(log("100%\r5%\n")), ["5%0%"]);
  assert.deepEqual(texts(log("100%\r5%\x1b[K\n")), ["5%"]);
});

test("a backspace and a tab move the column", () => {
  assert.deepEqual(texts(log("abc\b\bX\n")), ["aXc"]);
  assert.deepEqual(texts(log("a\tb\n")), ["a       b"]);
});

test("a cursor move is dropped rather than honoured", () => {
  // This is a scrolling log, not an emulator: nothing addresses a row that has
  // already gone out. A reader who runs `top` gets a mess, and `terminal.ts`
  // says why that is the deal.
  assert.deepEqual(texts(log("a\x1b[2Ab\x1b[Hc\n")), ["abc"]);
});

test("an OSC sequence is skipped whole", () => {
  // A title change, or somebody else's OSC 8 link. Covey's own links come from
  // `Span.link`, so there is nothing to read out of one here.
  assert.deepEqual(texts(log("\x1b]0;a title\x07text\n")), ["text"]);
  assert.deepEqual(texts(log("\x1b]8;;http://x\x1b\\label\x1b]8;;\x1b\\\n")), ["label"]);
});

test("a chunk cut inside an escape is finished by the next one", () => {
  // The daemon reads a pipe, not sequences, so a colour may arrive in two
  // pieces. Read as text instead, the row would show `[32m` and no colour —
  // the same seam `readSplitDrop` handles for a path cut in two (#130).
  const l = log("\x1b[3", "2mgreen\n");
  assert.deepEqual(texts(l), ["green"]);
  assert.equal(l.rows()[0]![0]!.color, "green");
});

test("an escape that is never finished does not swallow the stream", () => {
  // `ESC ]` with no BEL and no ST is what a `cat` of a binary file writes. Held
  // for ever, every byte after it buffers and the panel reads as frozen while
  // the command is still running — which a reader cannot tell from a hung
  // command. Past the cap the escape is given up on and the rest is text.
  const l = new AnsiLog(100);
  l.write("\x1b]0;" + "x".repeat(5000) + "\nafter\n");
  const text = texts(l).join("\n");
  assert.match(text, /after/, "the stream carries on");
  assert.match(text, /xxxx/, "and what was held is painted rather than lost");
});

test("a short unfinished escape is still held for the next chunk", () => {
  // The cap must not break the ordinary seam: a colour really does arrive in
  // two pieces, and giving up on those would paint `[32m` into the output.
  const l = new AnsiLog(100);
  l.write("\x1b]0;a title");
  assert.deepEqual(texts(l), []);
  l.write("\x07text\n");
  assert.deepEqual(texts(l), ["text"]);
});

test("a control character costs no column", () => {
  const row = log("a\x00b\x07c\n").rows()[0]!;
  assert.equal(lineText(row), "abc");
  assert.equal(lineWidth(row), 3);
});

test("the row count is bounded and the oldest rows go", () => {
  const l = new AnsiLog(3);
  for (let i = 0; i < 10; i++) l.write(`row ${i}\n`);
  assert.deepEqual(l.rows().map(lineText), ["row 7", "row 8", "row 9"]);
});

test("the generation moves only on a write, and rows keep their identity", () => {
  // The panel watches the generation because the log is mutated in place: a
  // build writes hundreds of chunks and a copy per chunk is a copy too many.
  const l = log("a\n");
  const first = l.rows();
  assert.equal(l.rows(), first, "the same array until something is written");
  const gen = l.generation;
  l.write("b\n");
  assert.ok(l.generation > gen);
  assert.notEqual(l.rows(), first);
});

test("a run of cells in one style is one span", () => {
  // A span per character is a `<Text>` per character, and the transcript's own
  // renderer already costs the frame more than covey would like.
  assert.equal(log("\x1b[31mhello\x1b[39m\n").rows()[0]!.length, 1);
});

test("readEscape answers null for a sequence that is not finished", () => {
  assert.equal(readEscape("\x1b[3", 0), null);
  assert.equal(readEscape("\x1b]0;half", 0), null);
  assert.deepEqual(readEscape("\x1b[31m", 0), { seq: "\x1b[31m", end: 5 });
  // `ESC (B` is three characters, so a two-character read would leave the `B`
  // behind as text.
  assert.deepEqual(readEscape("\x1b(B", 0), { seq: "\x1b(B", end: 3 });
});

test("applySgr leaves an attribute it cannot paint alone", () => {
  // Blink and strike-through have no `Span` field, so they are dropped rather
  // than approximated with one that does.
  assert.deepEqual(applySgr({ bold: true }, [5, 9]), { bold: true });
});

test("covey draws the prompt, because a shell on a pipe prints none", () => {
  assert.equal(shellPrompt("/home/me/code", "/home/me"), "~/code");
  assert.equal(shellPrompt("/home/me", "/home/me"), "~");
  assert.equal(shellPrompt("/srv/work", "/home/me"), "/srv/work");
  // The echo goes through the same parser the output does, so there is one
  // place a colour can be wrong rather than two.
  const row = log(echoLine("/home/me", "git status", "/home/me")).rows()[0]!;
  assert.equal(lineText(row), "~ $ git status");
});

test("only a failure is named in the header", () => {
  assert.equal(exitLabel(null), null);
  // Telling the reader about every command that worked is a row that stops
  // being read.
  assert.equal(exitLabel(0), null);
  assert.deepEqual(exitLabel(1), { text: "exit 1", bad: true });
  // The ctrl+c they just pressed is their own decision, not a fault, so it is
  // named without the colour that says something went wrong.
  assert.deepEqual(exitLabel(130), { text: "interrupted", bad: false });
  assert.deepEqual(exitLabel(137), { text: "killed by signal 9", bad: true });
});
