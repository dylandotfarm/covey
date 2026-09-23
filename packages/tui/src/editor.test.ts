import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapEditorLines, caretToVisual, visualToCaret, moveVisualRow,
  lineStart, lineEnd, wordStart, wordEnd,
  deleteBack, deleteForward, deleteToLineStart, deleteToLineEnd,
  deleteWordBack, deleteWordForward, insert, normalisePaste,
} from "./editor.js";
import { width } from "./lines.js";

const texts = (v: string, w: number) => wrapEditorLines(v, w).map((l) => l.text);

/** Columns a terminal really paints for `s`, with tab stops every 8. This is
 *  what `width()` cannot do, because it gets no starting column. */
const painted = (s: string) => {
  let col = 0;
  for (const ch of s) col = ch === "\t" ? col + (8 - (col % 8)) : col + width(ch);
  return col;
};

test("wraps at word boundaries instead of splitting mid-word", () => {
  assert.deepEqual(texts("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
});

test("hard-breaks a single token longer than the line", () => {
  assert.deepEqual(texts("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
});

test("keeps explicit newlines as row breaks, including empty lines", () => {
  assert.deepEqual(texts("a\n\nb", 10), ["a", "", "b"]);
});

test("a pasted tab never makes a row wider than the budget", () => {
  const w = 60;
  const pasted = "\t\t\t\tconst result = compute(alpha, beta, gamma, delta);";
  // Guard, not the assertion under test: if the sample stopped overflowing the
  // case below would pass against any implementation and protect nothing.
  assert.ok(painted(pasted) > w, `the sample paste must overflow ${w} columns, or this case tests nothing`);
  // The defect is the painted width of a row, so assert exactly that. Checking
  // that no tab survived would pass for any expansion that drops tabs without
  // making one character one column, and would hide the overflow behind it.
  for (const row of wrapEditorLines(normalisePaste(pasted), w)) {
    const paints = painted(row.text);
    assert.ok(
      paints <= w,
      `row paints ${paints} columns into a ${w} column budget, so ${paints - w} columns land on the sidebar: ${JSON.stringify(row.text)}`,
    );
  }
});

// Not a regression case: the CRLF rule moved here from `App.tsx` unchanged.
// This pins the moved behaviour, and the indent depth the tab rule produces.
test("normalisePaste keeps indent depth and still folds CRLF", () => {
  assert.equal(normalisePaste("\ta\r\n\t\tb\rc"), "  a\n    b\nc");
});

test("every caret offset maps to exactly one row", () => {
  const value = "the quick brown fox\njumps over";
  const lines = wrapEditorLines(value, 10);
  for (let caret = 0; caret <= value.length; caret++) {
    const { row, col } = caretToVisual(lines, caret);
    assert.ok(row >= 0 && row < lines.length, `caret ${caret} fell outside the rows`);
    assert.ok(col <= lines[row]!.text.length, `caret ${caret} column past end of row`);
  }
});

test("caret round-trips through row/column for wrapped text", () => {
  const value = "the quick brown fox jumps";
  const lines = wrapEditorLines(value, 10);
  // offsets that sit on a swallowed space collapse to the end of their row,
  // so round-trip the positions that are actually addressable
  for (const caret of [0, 3, 4, 9, 10, 15, 20, value.length]) {
    const { row, col } = caretToVisual(lines, caret);
    const back = visualToCaret(lines, row, col);
    assert.equal(caretToVisual(lines, back).row, row);
  }
});

test("caret at the very end lands on the last row", () => {
  const value = "hello world";
  const lines = wrapEditorLines(value, 5);
  const { row } = caretToVisual(lines, value.length);
  assert.equal(row, lines.length - 1);
});

test("moveVisualRow walks wrapped rows, not just logical lines", () => {
  const value = "the quick brown fox jumps";
  const lines = wrapEditorLines(value, 10);
  const down = moveVisualRow({ value, caret: 1 }, lines, 1);
  assert.equal(caretToVisual(lines, down).row, 1);
  const up = moveVisualRow({ value, caret: down }, lines, -1);
  assert.equal(caretToVisual(lines, up).row, 0);
});

test("line boundaries are scoped to the current line", () => {
  const v = "first\nsecond\nthird";
  assert.equal(lineStart(v, 8), 6);
  assert.equal(lineEnd(v, 8), 12);
  assert.equal(lineStart(v, 0), 0);
  assert.equal(lineEnd(v, v.length), v.length);
});

test("word boundaries skip whitespace then the word", () => {
  const v = "alpha beta  gamma";
  assert.equal(wordStart(v, 10), 6);
  assert.equal(wordStart(v, 12), 6);
  assert.equal(wordEnd(v, 5), 10);
});

test("cmd+backspace deletes only the current line's text", () => {
  const r = deleteToLineStart({ value: "first\nsecond", caret: 12 });
  assert.deepEqual(r, { value: "first\n", caret: 6 });
});

test("cmd+delete deletes to end of the current line only", () => {
  const r = deleteToLineEnd({ value: "first\nsecond", caret: 6 });
  assert.deepEqual(r, { value: "first\n", caret: 6 });
});

test("cmd+backspace at the start of a line joins it to the line above (#47)", () => {
  assert.deepEqual(deleteToLineStart({ value: "one\ntwo", caret: 4 }), { value: "onetwo", caret: 3 });
  // Clear the line, then press again: the empty line joins, and the caret is at the end of "one".
  const cleared = deleteToLineStart({ value: "one\ntwo", caret: 7 });
  assert.deepEqual(cleared, { value: "one\n", caret: 4 });
  assert.deepEqual(deleteToLineStart(cleared), { value: "one", caret: 3 });
  // At the start of the draft there is no line above.
  assert.deepEqual(deleteToLineStart({ value: "one", caret: 0 }), { value: "one", caret: 0 });
});

test("cmd+delete at the end of a line pulls the next line up (#47)", () => {
  assert.deepEqual(deleteToLineEnd({ value: "one\ntwo", caret: 3 }), { value: "onetwo", caret: 3 });
  assert.deepEqual(deleteToLineEnd({ value: "one", caret: 3 }), { value: "one", caret: 3 });
});

test("alt+backspace deletes a word, alt+delete deletes the next word", () => {
  assert.deepEqual(deleteWordBack({ value: "alpha beta", caret: 10 }), { value: "alpha ", caret: 6 });
  assert.deepEqual(deleteWordForward({ value: "alpha beta", caret: 5 }), { value: "alpha", caret: 5 });
});

test("single-character deletes and insert", () => {
  assert.deepEqual(deleteBack({ value: "ab", caret: 2 }), { value: "a", caret: 1 });
  assert.deepEqual(deleteBack({ value: "ab", caret: 0 }), { value: "ab", caret: 0 });
  assert.deepEqual(deleteForward({ value: "ab", caret: 0 }), { value: "b", caret: 0 });
  assert.deepEqual(deleteForward({ value: "ab", caret: 2 }), { value: "ab", caret: 2 });
  assert.deepEqual(insert({ value: "ac", caret: 1 }, "b"), { value: "abc", caret: 2 });
});

test("deletes at the start of a line join to the previous line", () => {
  assert.deepEqual(deleteBack({ value: "a\nb", caret: 2 }), { value: "ab", caret: 1 });
  assert.deepEqual(deleteWordBack({ value: "alpha\nbeta", caret: 6 }), { value: "beta", caret: 0 });
});
