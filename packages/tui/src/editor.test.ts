import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapEditorLines, caretToVisual, visualToCaret, moveVisualRow,
  lineStart, lineEnd, wordStart, wordEnd,
  deleteBack, deleteForward, deleteToLineStart, deleteToLineEnd,
  deleteWordBack, deleteWordForward, insert,
} from "./editor.js";

const texts = (v: string, w: number) => wrapEditorLines(v, w).map((l) => l.text);

test("wraps at word boundaries instead of splitting mid-word", () => {
  assert.deepEqual(texts("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
});

test("hard-breaks a single token longer than the line", () => {
  assert.deepEqual(texts("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
});

test("keeps explicit newlines as row breaks, including empty lines", () => {
  assert.deepEqual(texts("a\n\nb", 10), ["a", "", "b"]);
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
