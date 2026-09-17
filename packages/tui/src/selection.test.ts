/**
 * What a selection puts on the clipboard, and what a double or triple click
 * takes.
 *
 * These work on the `Line` arrays that the renderer produces, so they can
 * state the defect directly: the same selection at two pane widths has to give
 * the same text. Anything that still records the wrap as content fails that
 * one, whatever else it gets right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem } from "@covey/protocol";
import { renderItem, selectedText, wordRangeAt, wrappedRun, lineWidth, lineText, highlightLine, type Line } from "./lines.js";
import { applySelection } from "./components/Transcript.js";
import type { Selection } from "./store.js";
import { T, contrastRatio } from "./theme.js";

const OPTS = { expanded: new Set<string>(), question: { cursor: 0, answered: [] } };

/** Render one message the way the transcript does, at a given pane width. */
function paint(kind: "assistant" | "user", text: string, width: number): Line[] {
  const item = {
    id: "a", threadId: "t", turnId: "T1", seq: 1, createdAt: "", updatedAt: "",
    kind, text, streaming: false, attachments: [], folded: false, queued: false,
  } as unknown as TimelineItem;
  return renderItem(item, { ...OPTS, width });
}

/** Everything a selection over the whole item would copy. `renderItem` ends
 *  each item with a blank row, which is spacing rather than content. */
function copyAll(lines: Line[]): string {
  let last = lines.length - 1;
  while (last > 0 && lines[last]!.length === 0) last--;
  return selectedText(lines, { line: 0, col: 0 }, { line: last, col: lineWidth(lines[last]!) });
}

/** The text of one run, the way a triple click would take it. */
function copyRun(lines: Line[], at: number): string {
  const run = wrappedRun(lines, at);
  return selectedText(lines, { line: run.from, col: 0 }, { line: run.to, col: lineWidth(lines[run.to]!) });
}

/** Every item row carries a two-space indent; it is content, not a wrap. */
const IND = "  ";

const PARAGRAPH = "The wrapper is the one that inserted the break, so it is the one that knows which breaks are its own and which were in the message.";

// ---------------------------------------------------------------------------
// The assertion that pins the defect
// ---------------------------------------------------------------------------

test("the same selection at two pane widths gives the same clipboard text", () => {
  const narrow = copyAll(paint("assistant", PARAGRAPH, 40));
  const wide = copyAll(paint("assistant", PARAGRAPH, 100));
  assert.equal(narrow, wide, "the pane width must not reach the clipboard");
  assert.equal(narrow, IND + PARAGRAPH, "one paragraph is one line");
});

test("a user message copies the same at two pane widths, padding and all", () => {
  // The user block rebuilds every row to draw its background, so it is the
  // item type where a carried wrap marker is easiest to lose.
  const narrow = copyAll(paint("user", PARAGRAPH, 44));
  const wide = copyAll(paint("user", PARAGRAPH, 120));
  assert.equal(narrow, wide);
  assert.equal(narrow, IND + PARAGRAPH);
});

test("a wrapped paragraph copies as its own words, not as rows", () => {
  const got = copyAll(paint("assistant", PARAGRAPH, 40));
  assert.equal(got, IND + PARAGRAPH);
});

// ---------------------------------------------------------------------------
// The breaks that are real
// ---------------------------------------------------------------------------

test("a code block keeps one line per line", () => {
  const src = ["```ts", "const a = 1;", "const b = 2;", "const c = 3;", "```"].join("\n");
  const got = copyAll(paint("assistant", src, 60));
  assert.match(got, / {2}const a = 1;\n {2}const b = 2;\n {2}const c = 3;/);
});

test("a code line too long for the pane still copies as one line", () => {
  // The break inside it is the wrapper's, so joining it is what restores the
  // code. Guessing from indentation would get this one wrong.
  const line = "const value = compute(alpha, beta, gamma, delta, epsilon);";
  const got = copyAll(paint("assistant", ["```ts", line, "```"].join("\n"), 34));
  assert.match(got, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(got.split("\n").filter((l) => l.includes("const value")).length, 1);
});

test("list items keep a line each", () => {
  const src = ["- first item", "- second item", "- third item"].join("\n");
  const got = copyAll(paint("assistant", src, 60));
  assert.equal(got.split("\n").filter((l) => l.trim()).length, 3);
});

test("a blank line between paragraphs survives", () => {
  const got = copyAll(paint("assistant", "one\n\ntwo", 60));
  assert.match(got, / {2}one\n\n {2}two/);
});

test("a token broken mid-word rejoins with nothing, not with a space", () => {
  const long = "supercalifragilisticexpialidocious";
  const got = copyAll(paint("assistant", long, 20));
  assert.match(got, new RegExp(long));
});

test("padding spans never become spaces in a joined line", () => {
  const got = copyAll(paint("user", PARAGRAPH, 44)).slice(IND.length);
  assert.equal(/ {2,}/.test(got), false, "no run of spaces from the block padding");
});

// ---------------------------------------------------------------------------
// Double click
// ---------------------------------------------------------------------------

/** The text a double click at `col` would take from one row. */
function wordAtCol(line: Line, col: number): string {
  const { from, to } = wordRangeAt(line, col);
  return selectedText([line], { line: 0, col: from }, { line: 0, col: to });
}

test("double click on a path takes the whole path, including the :line", () => {
  const line: Line = [{ text: "see packages/tui/src/lines.ts:439 for the join" }];
  assert.equal(wordAtCol(line, 10), "packages/tui/src/lines.ts:439");
  // And from the number, which is where a reader chasing a line points.
  assert.equal(wordAtCol(line, 31), "packages/tui/src/lines.ts:439");
});

test("double click on a plain word takes the word", () => {
  const line: Line = [{ text: "the quick brown fox" }];
  assert.equal(wordAtCol(line, 4), "quick");
  assert.equal(wordAtCol(line, 0), "the");
});

test("double click on a URL takes the URL, not a piece of it", () => {
  const line: Line = [{ text: "open https://github.com/dylandotfarm/covey/issues/70 now" }];
  assert.equal(wordAtCol(line, 20), "https://github.com/dylandotfarm/covey/issues/70");
});

test("double click leaves the sentence's punctuation behind", () => {
  const line: Line = [{ text: "it lives in lines.ts, near the wrap." }];
  assert.equal(wordAtCol(line, 13), "lines.ts");
  assert.equal(wordAtCol(line, 31), "wrap");
});

test("double click works across the span boundaries the wrap leaves", () => {
  // A path that carried a link arrives as several spans; the word boundary
  // reads the row's text, so it does not stop at one.
  const line: Line = [{ text: "edit " }, { text: "src/lines", link: "file:///x" }, { text: ".ts" }];
  assert.equal(wordAtCol(line, 8), "src/lines.ts");
});

// ---------------------------------------------------------------------------
// Triple click
// ---------------------------------------------------------------------------

test("triple click takes the whole wrapped run, not the row under the pointer", () => {
  const lines = paint("assistant", PARAGRAPH, 40);
  assert.ok(lines.length > 3, "the paragraph really is wrapped over several rows");
  const run = wrappedRun(lines, 1);
  assert.equal(run.from, 0, "a click on the second row reaches back to the first");
  assert.ok(run.to >= 2, "and forward past the row that was clicked");
  assert.equal(copyRun(lines, 1), IND + PARAGRAPH);
});

test("triple click on a code line stops at that line", () => {
  const lines = paint("assistant", ["```ts", "const a = 1;", "const b = 2;", "```"].join("\n"), 60);
  const at = lines.findIndex((l) => lineText(l).includes("const b"));
  assert.ok(at > 0);
  assert.deepEqual(wrappedRun(lines, at), { from: at, to: at });
});

test("the run of a paragraph at two widths is the same text", () => {
  for (const w of [30, 55, 90]) {
    assert.equal(copyRun(paint("assistant", PARAGRAPH, w), 0), IND + PARAGRAPH, `at width ${w}`);
  }
});

// ---------------------------------------------------------------------------
// The paint
// ---------------------------------------------------------------------------

test("the selection repaints the colour it covers, so no tier stays dim", () => {
  const line: Line = [{ text: "faint", color: T.faint }, { text: "code", color: T.code, dim: true }];
  const out = highlightLine(line, 0, 9, T.selectionBg, T.selectionText);
  for (const sp of out) {
    assert.equal(sp.bg, T.selectionBg);
    assert.equal(sp.dim, false, "a dim span would wash the foreground back out");
    assert.ok(contrastRatio(sp.color!, sp.bg!) >= 4.5, `${sp.text} is unreadable on the selection`);
  }
});

test("the transcript paints the selection with both the background and a foreground", () => {
  // The wiring, not the helper. `applySelection` used to pass a background
  // only, so every span kept its own colour inside the highlight and the
  // dimmest of them stayed dim.
  const sel: Selection = { pane: "transcript", anchor: { line: 0, col: 0 }, head: { line: 0, col: 10 }, dragging: false };
  const [painted] = applySelection([[{ text: "faint text", color: T.faint }]], 0, sel, "transcript");
  const covered = painted!.filter((sp) => sp.bg === T.selectionBg);
  assert.ok(covered.length > 0, "the selection background reaches the paint");
  for (const sp of covered) {
    assert.ok(contrastRatio(sp.color!, T.selectionBg) >= 4.5, `${sp.color} is unreadable on the selection`);
  }
});
