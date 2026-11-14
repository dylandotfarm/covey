import type { SidebarRow } from "./store.js";

/**
 * The sidebar list, line by line.
 *
 * Rows and screen lines are not the same thing: a blank line sits above every
 * project after the first, above the machines section and above every fleet,
 * and a long tree is a window over the rows rather than all of them. Both
 * facts have to be known in exactly one place, because rendering and clicking
 * have to agree on which row sits on which line — the same reason the
 * transcript's lines are built in App and handed to both the painter and the
 * hit test.
 */
export type SidebarCell = { kind: "blank" } | { kind: "row"; index: number };

/**
 * Every line the sidebar would paint, unscrolled.
 *
 * This used to window the list on the cursor and centre it, which made the
 * cursor the only viewport there was. Two defects came out of that and both
 * are a reader's. The sidebar could not be scrolled at all: a notch over it
 * went to the conversation, because moving the cursor opens the thread it
 * lands on and a scroll must never do that. And clicking a row re-centred the
 * list under the hand that clicked it, so the tree jumped on every click.
 *
 * So the window is the reader's now (`sidebarTop`) and this is pure again.
 */
export function sidebarCells(rows: SidebarRow[]): SidebarCell[] {
  const all: SidebarCell[] = [];
  for (let i = 0; i < rows.length; i++) {
    // A blank line above every project but the first, above the machines
    // section, above the archived projects, and above every fleet: the
    // projects stand apart from each other, the machines from the last
    // project, and a fleet from the fleet before it. A run that no project
    // can claim sits above the projects without one, as it did when it sat
    // under the machine.
    //
    // A project that leads a fleet takes no line of its own: the fleet row
    // above it already carries one, and two blanks read as a gap rather than
    // as a heading.
    const k = rows[i]!.kind;
    const after = rows[i - 1]?.kind;
    if (i > 0 && (k === "project" || k === "machines" || k === "fleet" || k === "archivedProjects") && after !== "fleet") all.push({ kind: "blank" });
    all.push({ kind: "row", index: i });
  }
  return all;
}

/**
 * The first line to paint.
 *
 * `top` is where the reader left the window — the wheel writes it, and nothing
 * else does. The cursor pulls the window only as far as it must to be seen,
 * and the caller asks for that pull only when the cursor *moves*: a window the
 * reader scrolled away from must stay where they put it while the tree re-sorts
 * under it, and a click that lands on a row already on screen must move
 * nothing at all.
 *
 * `follow` false is the other half, and it is what a wheel notch passes: clamp
 * the window to the list and leave the cursor wherever it is, off screen
 * included.
 */
export function sidebarTop(cells: SidebarCell[], cursor: number, height: number, top: number, follow: boolean): number {
  if (height <= 0) return 0;
  const max = Math.max(0, cells.length - height);
  const start = Math.max(0, Math.min(max, Math.floor(top)));
  if (!follow) return start;
  const at = cells.findIndex((c) => c.kind === "row" && c.index === cursor);
  if (at < 0) return start;
  // A project row is painted under a blank line, and the blank is what says it
  // is a heading. Pulling the window to the row alone would cut that line off,
  // so the top of the window takes the blank with it.
  const want = at > 0 && cells[at - 1]!.kind === "blank" ? at - 1 : at;
  if (want < start) return want;
  if (at >= start + height) return Math.min(max, at - height + 1);
  return start;
}

/** The lines on screen, from `top`. */
export function sidebarWindow(cells: SidebarCell[], top: number, height: number): SidebarCell[] {
  if (height <= 0) return [];
  return cells.slice(top, top + height);
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
