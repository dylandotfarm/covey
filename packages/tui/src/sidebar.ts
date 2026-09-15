import type { SidebarRow } from "./store.js";

/**
 * The sidebar list, line by line.
 *
 * Rows and screen lines are not the same thing: every machine header is
 * preceded by a blank line, and a long tree is a window over the rows rather
 * than all of them. Both facts have to be known in exactly one place, because
 * rendering and clicking have to agree on which row sits on which line —
 * the same reason the transcript's lines are built in App and handed to both
 * the painter and the hit test.
 */
export type SidebarCell = { kind: "blank" } | { kind: "row"; index: number };

/**
 * The lines to paint, scrolled so `cursor` is visible. Centring the cursor
 * (the idiom the pick overlay already uses) keeps this a pure function of the
 * state we have, with no scroll offset to remember or get out of step.
 */
export function sidebarCells(rows: SidebarRow[], cursor: number, height: number): SidebarCell[] {
  if (height <= 0) return [];
  const all: SidebarCell[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === "machine") all.push({ kind: "blank" });
    all.push({ kind: "row", index: i });
  }
  if (all.length <= height) return all;
  const at = all.findIndex((c) => c.kind === "row" && c.index === cursor);
  const start = Math.max(0, Math.min((at < 0 ? 0 : at) - Math.floor(height / 2), all.length - height));
  return all.slice(start, start + height);
}

/**
 * Row index under a 1-based terminal row, or null for a blank line or a click
 * below the list. `top` is the screen row the first cell is painted on.
 */
export function rowAtScreenRow(cells: SidebarCell[], screenRow: number, top: number): number | null {
  const c = cells[screenRow - top];
  return c && c.kind === "row" ? c.index : null;
}
