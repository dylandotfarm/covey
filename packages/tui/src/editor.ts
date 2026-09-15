import { width } from "./lines.js";

/**
 * Pure text-editing model for the composer.
 *
 * Kept out of React (and out of `App.tsx`) so the cursor arithmetic is unit
 * testable. Two concerns live here:
 *
 *  - **visual wrapping**: the composer word-wraps like the transcript does, so
 *    a long word moves to the next row instead of being chopped mid-token. The
 *    wrap has to report source offsets, because the caret is stored as an index
 *    into the raw value and has to be painted at the right row/column.
 *  - **edit operations**: line- and word-scoped deletes, matching the readline
 *    and macOS conventions (cmd = line, alt = word).
 */

export interface EditState {
  value: string;
  caret: number;
}

/** One rendered row. `text` is what is painted; `[start,end)` are offsets into
 *  the raw value that this row owns, including any trailing run of spaces that
 *  was swallowed by the wrap (so the caret always belongs to exactly one row). */
export interface VisualLine {
  text: string;
  start: number;
  end: number;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t";

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** Word-wrap `value` to `w` columns, preserving source offsets. */
export function wrapEditorLines(value: string, w: number): VisualLine[] {
  const cols = Math.max(1, Math.floor(w));
  const out: VisualLine[] = [];
  let base = 0;
  for (const logical of value.split("\n")) {
    wrapOne(logical, base, cols, out);
    base += logical.length + 1; // + the newline itself
  }
  return out;
}

function wrapOne(text: string, base: number, w: number, out: VisualLine[]): void {
  if (text.length === 0) {
    out.push({ text: "", start: base, end: base });
    return;
  }
  let start = 0;
  while (start < text.length) {
    // Longest prefix of text[start..] that fits in w columns.
    let end = start;
    let acc = 0;
    while (end < text.length) {
      const cw = width(text[end]!);
      if (acc + cw > w) break;
      acc += cw;
      end++;
    }
    if (end >= text.length) {
      out.push({ text: text.slice(start), start: base + start, end: base + text.length });
      return;
    }
    // Prefer breaking at the last space inside the window; otherwise this is a
    // single token longer than the line, so hard-break it.
    let brk = -1;
    for (let i = end; i > start; i--) {
      if (isSpace(text[i])) { brk = i; break; }
    }
    let next: number;
    let shown: number;
    if (brk > start) {
      let ws = brk;
      while (ws < text.length && isSpace(text[ws])) ws++;
      next = ws;
      shown = brk; // trailing spaces are owned by the row but not painted
    } else {
      next = end;
      shown = end;
    }
    if (next <= start) next = start + 1; // never stall
    out.push({ text: text.slice(start, shown), start: base + start, end: base + next });
    start = next;
  }
}

/** Row/column of the caret within `lines`. */
export function caretToVisual(lines: VisualLine[], caret: number): { row: number; col: number } {
  if (lines.length === 0) return { row: 0, col: 0 };
  let row = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.start <= caret) row = i;
    else break;
  }
  const line = lines[row]!;
  return { row, col: Math.max(0, Math.min(caret - line.start, line.text.length)) };
}

/** Inverse of `caretToVisual`, clamped into range. */
export function visualToCaret(lines: VisualLine[], row: number, col: number): number {
  if (lines.length === 0) return 0;
  const line = lines[Math.max(0, Math.min(row, lines.length - 1))]!;
  return line.start + Math.max(0, Math.min(col, line.text.length));
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

/** Start of the logical (newline-delimited) line containing `caret`. */
export function lineStart(v: string, caret: number): number {
  if (caret <= 0) return 0;
  return v.lastIndexOf("\n", caret - 1) + 1;
}

/** End of the logical line containing `caret`, excluding the newline. */
export function lineEnd(v: string, caret: number): number {
  const i = v.indexOf("\n", caret);
  return i < 0 ? v.length : i;
}

/** Start of the word before `caret`, skipping any whitespace first. */
export function wordStart(v: string, caret: number): number {
  let i = Math.max(0, Math.min(caret, v.length));
  while (i > 0 && /\s/.test(v[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
  return i;
}

/** End of the word after `caret`, skipping any whitespace first. */
export function wordEnd(v: string, caret: number): number {
  let i = Math.max(0, Math.min(caret, v.length));
  while (i < v.length && /\s/.test(v[i]!)) i++;
  while (i < v.length && !/\s/.test(v[i]!)) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

const cut = (v: string, from: number, to: number): EditState => ({
  value: v.slice(0, from) + v.slice(to),
  caret: from,
});

export function insert(s: EditState, text: string): EditState {
  return { value: s.value.slice(0, s.caret) + text + s.value.slice(s.caret), caret: s.caret + text.length };
}

export function deleteBack(s: EditState): EditState {
  return s.caret === 0 ? s : cut(s.value, s.caret - 1, s.caret);
}

export function deleteForward(s: EditState): EditState {
  return s.caret >= s.value.length ? s : cut(s.value, s.caret, s.caret + 1);
}

/** cmd+backspace — delete to the start of the current line only. */
export function deleteToLineStart(s: EditState): EditState {
  return cut(s.value, lineStart(s.value, s.caret), s.caret);
}

/** cmd+delete — delete to the end of the current line only. */
export function deleteToLineEnd(s: EditState): EditState {
  return cut(s.value, s.caret, lineEnd(s.value, s.caret));
}

/** alt+backspace — delete the word before the caret. */
export function deleteWordBack(s: EditState): EditState {
  return cut(s.value, wordStart(s.value, s.caret), s.caret);
}

/** alt+delete — delete the word after the caret. */
export function deleteWordForward(s: EditState): EditState {
  return cut(s.value, s.caret, wordEnd(s.value, s.caret));
}

/** Move the caret one visual row up/down, keeping the column where possible. */
export function moveVisualRow(s: EditState, lines: VisualLine[], delta: -1 | 1): number {
  const { row, col } = caretToVisual(lines, s.caret);
  const next = row + delta;
  if (next < 0) return 0;
  if (next >= lines.length) return s.value.length;
  return visualToCaret(lines, next, col);
}
