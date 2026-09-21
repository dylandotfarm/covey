import type { SidebarRow } from "./store.js";

/**
 * The sidebar list, line by line.
 *
 * Rows and screen lines are not the same thing: a blank line sits above every
 * project after the first and above the machines section, and a long tree is
 * a window over the rows rather than all of them. Both facts have to be known in exactly one place, because
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
    // A blank line above every project but the first, and above the machines
    // section: the projects stand apart from each other, and the fleet from
    // the last project. A run that no project can claim sits above the
    // projects without one, as it did when it sat under the machine.
    const k = rows[i]!.kind;
    if (i > 0 && (k === "project" || k === "machines")) all.push({ kind: "blank" });
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

/**
 * Where the cursor sits now. The cursor is held as a row key, not as an index,
 * because the tree re-sorts under it: `byRecency` moves a thread to the top of
 * its project on every turn that starts and every turn that finishes, on any
 * machine. An index would slide onto whichever thread spoke last.
 *
 * `last` is the index the cursor was on before. A key cannot say where its row
 * used to be, so when the row goes — archived, deleted, moved, or folded away
 * with its project — this is what puts the cursor next to where it was instead
 * of at the top of the tree.
 */
export function cursorIndex(rows: SidebarRow[], key: string, last: number): number {
  const at = rows.findIndex((r) => r.key === key);
  return at >= 0 ? at : Math.max(0, Math.min(rows.length - 1, last));
}
