/**
 * The pieces of markdown both clients must read the same way.
 *
 * The TUI paints a table in aligned columns (`lines.ts`) and the page writes a
 * `<table>` (`web/src/markdown.ts`). They lay one out differently, on purpose,
 * because a terminal pane and a phone are not the same thing. What they must
 * never differ on is what counts as a table and where its cells are: a reply
 * read as a table on one client and as prose on the other is a bug the reader
 * cannot explain. So the parser lives here and the layout stays with the
 * client that does it.
 *
 * Nothing here touches the DOM or node.
 */

export type Align = "left" | "right" | "center";

/** A pipe table, parsed: the header row, the body rows, and how each column aligns. */
export interface Table {
  header: string[];
  rows: string[][];
  align: Align[];
  /** The index of the first source line after the table. */
  end: number;
}

/** A row that starts with `|`, or that holds one `|` not at either end. */
const tableRow = (line: string) => /^\s*\|/.test(line) || /\S\s*\|\s*\S/.test(line);
/** The row under the header: `---`, `:--`, `--:` or `:-:` in each cell. */
const tableRule = (line: string) => line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

/**
 * Split a pipe row into its cells. One `|` at each end is a border and not a
 * cell, and `\|` is a pipe that stays in the cell.
 */
export function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/**
 * The table that starts at `src[i]`, or null. A table is a header row, a rule
 * row with as many cells as the header, and then every row up to the first
 * line without a pipe, as GitHub reads one.
 */
export function tableAt(src: string[], i: number): Table | null {
  const head = src[i]!; const rule = src[i + 1];
  if (rule === undefined || !tableRow(head) || !tableRule(rule)) return null;
  const header = tableCells(head);
  const marks = tableCells(rule);
  if (marks.length !== header.length) return null;
  const align = marks.map<Align>((m) => (m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : "left"));
  const rows: string[][] = [];
  let end = i + 2;
  for (; end < src.length && src[end]!.trim() !== "" && tableRow(src[end]!); end++) {
    // A short row is padded and a long one is cut, so every row has the
    // header's columns.
    const cells = tableCells(src[end]!).slice(0, header.length);
    while (cells.length < header.length) cells.push("");
    rows.push(cells);
  }
  return { header, rows, align, end };
}
