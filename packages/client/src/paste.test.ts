/**
 * The text rules for a pasted block held as a chip.
 *
 * The wiring — which key does this, and where the text is held — is each
 * client's own (the TUI's is `pasteChip.test.ts`). These are the decisions
 * underneath it: when a paste becomes a chip, what the chip says, and that the
 * turn carries the lines back exactly as they came.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPaste, chipsPaste, expandPastes, pasteLabel, pasteLines, pastedAlready, revealPaste, type PastedText } from "./paste.js";
import { cutTag, tagSpanAt } from "./attach.js";

const THREE = "one\ntwo\nthree";

test("one line and two lines stay in the sentence; three go aside", () => {
  assert.equal(chipsPaste("a path/to/file.ts"), false);
  assert.equal(chipsPaste("first\nsecond"), false);
  assert.equal(chipsPaste(THREE), true);
});

test("a trailing newline is not a fourth line", () => {
  assert.equal(pasteLines("one\ntwo\nthree\n"), 3);
  assert.equal(pasteLines("one\ntwo\n"), 2, "two lines copied out of an editor are two lines");
  assert.equal(chipsPaste("one\ntwo\n"), false);
});

test("the chip says how many lines it holds", () => {
  assert.equal(pasteLabel(THREE), "pasted 3 lines");
  assert.equal(pasteLabel("x\n".repeat(120)), "pasted 120 lines");
});

test("a paste reads as a word in the sentence, and the text is held", () => {
  const put = applyPaste("look at", 7, THREE, []);
  assert.equal(put.value, "look at [pasted 3 lines] ");
  assert.equal(put.caret, put.value.length);
  assert.deepEqual(put.pastes, [{ tag: "[pasted 3 lines]", text: THREE }]);
});

test("two pastes of the same size get two chips, told apart", () => {
  const one = applyPaste("", 0, THREE, []);
  const two = applyPaste(one.value, one.caret, "4\n5\n6", one.pastes);
  assert.equal(two.value, "[pasted 3 lines] [pasted 3 lines 2] ");
  assert.deepEqual(two.pastes.map((p) => p.tag), ["[pasted 3 lines]", "[pasted 3 lines 2]"]);
});

test("a paste forgets the text whose chip the reader deleted", () => {
  const one = applyPaste("", 0, THREE, []);
  // The reader took the chip out again; the draft is the only record of it.
  const two = applyPaste("", 0, "4\n5\n6", one.pastes);
  assert.deepEqual(two.pastes.map((p) => p.text), ["4\n5\n6"], "the deleted one is gone");
  assert.equal(two.value, "[pasted 3 lines] ", "and its label is free again");
});

test("the turn carries the lines, in the place the chip stood", () => {
  const put = applyPaste("explain", 7, THREE, []);
  assert.equal(expandPastes(put.value.trim(), put.pastes), `explain ${THREE}`);
});

test("expanding is one pass, so pasted text that names a chip is left alone", () => {
  const held: PastedText[] = [{ tag: "[pasted 3 lines]", text: "see [pasted 3 lines] there\nb\nc" }];
  assert.equal(expandPastes("[pasted 3 lines]", held), "see [pasted 3 lines] there\nb\nc");
});

test("a chip whose text is not held expands to nothing but itself", () => {
  assert.equal(expandPastes("[pasted 3 lines]", []), "[pasted 3 lines]");
});

test("the same block pasted twice shows the text, where the chip stood", () => {
  const put = applyPaste("look at", 7, THREE, []);
  const again = pastedAlready(put.value, THREE, put.pastes);
  assert.ok(again, "the second paste found the first");
  const shown = revealPaste(put.value, again)!;
  assert.equal(shown.value, `look at ${THREE} `);
  assert.equal(shown.caret, `look at ${THREE}`.length, "the caret ends where the text ends");
});

test("a block pasted again after its chip went is a new paste", () => {
  const put = applyPaste("", 0, THREE, []);
  assert.equal(pastedAlready("nothing here", THREE, put.pastes), null);
});

test("a chip is one key to delete and one step to walk over", () => {
  const put = applyPaste("look at", 7, THREE, []);
  const tags = put.pastes.map((p) => p.tag);
  const v = put.value;
  // backspace at the end of the chip, delete at its start, both the whole chip.
  const back = tagSpanAt(v, 24, tags, true);
  assert.deepEqual(back, { start: 8, end: 24 });
  assert.deepEqual(cutTag(v, back!), { value: "look at ", caret: 8 });
  assert.deepEqual(tagSpanAt(v, 8, tags, false), { start: 8, end: 24 });
  // And the caret inside it: one step out either way, never sixteen.
  assert.equal(tagSpanAt(v, 14, tags, true)!.start, 8);
  assert.equal(tagSpanAt(v, 14, tags, false)!.end, 24);
});
