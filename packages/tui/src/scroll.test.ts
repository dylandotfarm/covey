import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorAt, resolveScroll, type ScrollLayout } from "./scroll.js";

/** A layout of items with the given line counts, in order. */
function layout(...sizes: number[]): ScrollLayout {
  const itemStarts: ScrollLayout["itemStarts"] = [];
  let at = 0;
  sizes.forEach((n, i) => { itemStarts.push({ id: `i${i}`, start: at, end: at + n }); at += n; });
  return { lines: { length: at }, itemStarts };
}

const H = 10;

test("at the bottom there is no anchor, and the count stands", () => {
  const l = layout(20, 20);
  assert.equal(anchorAt(l, 0, H), null);
  assert.equal(resolveScroll(l, 0, null, H), 0);
});

test("a scroll anchors on the item under the top row", () => {
  const l = layout(20, 20);
  // 40 lines, 5 below: the window is lines 25..34, and line 25 is 5 into i1.
  assert.deepEqual(anchorAt(l, 5, H), { id: "i1", offset: 5 });
  // 40 lines, 25 below: the window is lines 5..14, and line 5 is 5 into i0.
  assert.deepEqual(anchorAt(l, 25, H), { id: "i0", offset: 5 });
});

test("the anchor resolves to the count it was taken from when nothing changed", () => {
  const l = layout(20, 20, 3);
  for (const n of [1, 5, 17, 33]) assert.equal(resolveScroll(l, n, anchorAt(l, n, H), H), n);
});

test("a reply that grows at the bottom leaves the top row where it was", () => {
  const before = layout(20, 20, 4);
  const anchor = anchorAt(before, 6, H);
  // The last item streamed twelve more lines.
  const after = layout(20, 20, 16);
  assert.equal(resolveScroll(after, 6, anchor, H), 18, "the badge counts up by the growth");
  const top = (n: number, l: ScrollLayout) => Math.max(0, Math.max(0, l.lines.length - n) - H);
  assert.equal(top(18, after), top(6, before), "and the same line is under the top row");
});

test("a reader inside the streaming item stays on the line they read", () => {
  const before = layout(5, 20);
  // 25 lines, 3 below: the top row is line 12, seven lines into i1.
  const anchor = anchorAt(before, 3, H);
  assert.deepEqual(anchor, { id: "i1", offset: 7 });
  const after = layout(5, 40);
  assert.equal(resolveScroll(after, 3, anchor, H), 23);
});

test("a page of scrollback above the window changes nothing", () => {
  const before = layout(20, 20);
  const anchor = anchorAt(before, 7, H);
  // loadOlder put two items in front. Their ids come first; the old ones keep theirs.
  const after: ScrollLayout = {
    lines: { length: 40 + 50 },
    itemStarts: [{ id: "old0", start: 0, end: 30 }, { id: "old1", start: 30, end: 50 }, { id: "i0", start: 50, end: 70 }, { id: "i1", start: 70, end: 90 }],
  };
  assert.equal(resolveScroll(after, 7, anchor, H), 7);
});

test("an item that shrank keeps the reader inside it, and the count never passes the top", () => {
  const before = layout(30, 30);
  const anchor = anchorAt(before, 20, H); // top row is line 30, the first line of i1
  assert.deepEqual(anchor, { id: "i1", offset: 0 });
  // i1 folded to two lines. Its first line would sit under the top row with
  // eight empty rows below it, so the window pulls back to the bottom, and
  // i1 is still on screen.
  const folded = layout(30, 2);
  assert.equal(resolveScroll(folded, 20, anchor, H), 0);
  // A layout shorter than the window has nowhere to scroll.
  assert.equal(resolveScroll(layout(3, 2), 20, anchor, H), 0);
});

test("an anchor whose item left the layout falls back to the count", () => {
  const l = layout(20, 20);
  assert.equal(resolveScroll(l, 9, { id: "gone", offset: 3 }, H), 9);
  assert.equal(resolveScroll(l, 9, null, H), 9);
});
