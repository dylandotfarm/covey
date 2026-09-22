/**
 * Where the reader is in the transcript.
 *
 * The store keeps the scroll as a count of lines from the bottom, because
 * that is the number the screen shows (`↓ N lines below`) and the number
 * every scroll key adds to. But the transcript grows at the bottom while a
 * reply streams, and a count from the bottom names a window that moves
 * with it: the lines a reader scrolled up to read slide up and out of view,
 * once per event. So a scroll also records an anchor — the item under the
 * top row of the screen and the offset into it — and each paint resolves
 * the anchor against the layout it is about to draw. A reply that grows
 * below the anchor leaves the screen where it was and counts the badge up.
 * A page of scrollback that arrives above it shifts the item's start by the
 * same number of lines, so the resolved count is unchanged, which is what
 * the count from the bottom gave before.
 *
 * A count of 0 means "follow": the reader is at the bottom, and every new
 * line scrolls in. That case has no anchor.
 */

export interface ScrollAnchor {
  /** The id of the item (or of a fold group) under the top row of the screen. */
  id: string;
  /** Lines from the item's first line to the top row. */
  offset: number;
}

/** The part of a transcript layout the scroll is measured against. */
export interface ScrollLayout {
  lines: { length: number };
  itemStarts: { id: string; start: number; end: number }[];
}

/** The number of lines above the window when `fromBottom` lines are below it. */
function topOf(layout: ScrollLayout, fromBottom: number, height: number): number {
  const end = Math.max(0, layout.lines.length - fromBottom);
  return Math.max(0, end - height);
}

/**
 * The anchor for a scroll of `fromBottom` lines against this layout, or null
 * when the reader follows the bottom or no item covers the top row.
 */
export function anchorAt(layout: ScrollLayout, fromBottom: number, height: number): ScrollAnchor | null {
  if (fromBottom <= 0) return null;
  const top = topOf(layout, fromBottom, height);
  const item = layout.itemStarts.find((i) => i.start <= top && top < i.end);
  return item ? { id: item.id, offset: top - item.start } : null;
}

/**
 * The count of lines below the window that keeps the anchored line under the
 * top row of this layout. Without an anchor, or when the anchored item has
 * left the layout, the stored count stands.
 */
export function resolveScroll(layout: ScrollLayout, fromBottom: number, anchor: ScrollAnchor | null, height: number): number {
  if (fromBottom <= 0 || !anchor) return Math.max(0, fromBottom);
  const item = layout.itemStarts.find((i) => i.id === anchor.id);
  if (!item || item.end <= item.start) return fromBottom;
  // An item that shrank (a fold, a re-wrap) keeps the reader inside it.
  const top = item.start + Math.min(anchor.offset, item.end - item.start - 1);
  const max = Math.max(0, layout.lines.length - height);
  return Math.min(max, Math.max(0, layout.lines.length - top - height));
}
