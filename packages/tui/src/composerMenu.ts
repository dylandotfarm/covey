/**
 * The list the composer paints above the draft, for every prefix that has one.
 *
 * Above, because Ink cannot draw under `position="absolute"`: a list that
 * overlaps the transcript is not available to us, so the composer grows upward
 * and the transcript gives up the rows. The full-view picker (`openPick`) is
 * the wrong shape for a list that re-filters on every keystroke.
 *
 * What fills the rows — the `/` commands, the `@` paths — lives beside this
 * module. This one owns only the shape: how tall the list is, and which part
 * of it is on screen.
 */

/** One row: what it inserts, what it reads as, and what it says about itself. */
export interface MenuRow {
  key: string;
  label: string;
  hint: string;
}

export interface MenuView {
  rows: MenuRow[];
  /** Row the reader is on. In range whenever `rows` is not empty. */
  index: number;
  /** One line to show in place of an empty list, saying why it is empty. */
  empty: string;
}

/** How many rows paint at once. */
export const MENU_ROWS = 8;

/**
 * Rows the menu takes on screen. `App` sizes the transcript from this and
 * `Composer` paints from it, so the two can never disagree.
 */
export function menuHeight(m: MenuView): number {
  // An empty menu is the one line that says why, and no hint to give.
  if (m.rows.length === 0) return 1;
  return Math.min(MENU_ROWS, m.rows.length) + 1;
}

/**
 * First row of the window onto the list, so the row under the cursor is always
 * painted. The window moves as little as it can: the list scrolls only once
 * the cursor reaches an edge.
 */
export function menuWindowStart(count: number, index: number): number {
  if (count <= MENU_ROWS) return 0;
  return Math.max(0, Math.min(index - MENU_ROWS + 1, count - MENU_ROWS));
}
