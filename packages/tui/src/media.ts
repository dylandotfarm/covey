/**
 * Paint a picture in the terminal, over the kitty graphics protocol (#163).
 *
 * The TUI could only name a file `covey show` put in the conversation (#160).
 * Ghostty, kitty, WezTerm and Konsole all speak a protocol that paints one, so
 * a reader on one of those can look at a screenshot without leaving for a
 * browser.
 *
 * Everything here is pure: it builds strings and measures rectangles, and it
 * writes nothing. `mediaView.ts` fetches the bytes and `Overlay.tsx` paints
 * the rows.
 *
 * ## Why Unicode placeholders, and not a plain placement
 *
 * Ink repaints. `log-update.js` erases the rows it is about to rewrite, and the
 * client re-renders every `CLOCK_MS` because `relTime` dates the sidebar off
 * `Date.now()`. A picture placed at the cursor belongs to the *screen*, so the
 * next repaint erases it.
 *
 * A *virtual* placement belongs to cells instead. covey sends the bytes once
 * with `U=1` and no placement of its own, then paints a rectangle of
 * `U+10EEEE` cells whose foreground colour carries the image id. The terminal
 * composites the picture over those cells on every repaint, so a repaint costs
 * nothing and loses nothing.
 *
 * It also measures right, which is what makes it usable from Ink at all.
 * Against `string-width@8.2.2`, the version ink 7.1.1 lays out with:
 *
 * - the graphics escape itself measures 17 columns, so it can never sit inside
 *   a span — covey writes it out of band, to the stream ink owns;
 * - `U+10EEEE` measures 1, a combining diacritic 0, and a truecolour SGR 0, so
 *   a painted row measures exactly the cells it covers.
 *
 * ## The one rule about responses
 *
 * Every escape carries `q=2`, which tells the terminal to answer neither an OK
 * nor an error. covey has no route for an answer: the terminal would write it
 * to stdin, and `useInput` in `App.tsx` would read it as the reader's typing.
 */

/**
 * The cell a virtual placement is painted over. Private use, plane 16, so no
 * font draws it and no text can contain it by accident.
 */
export const PLACEHOLDER = "\u{10EEEE}";

/**
 * How many payload bytes one escape may carry. kitty's own limit; a larger
 * chunk is refused rather than split for us.
 */
export const CHUNK_BYTES = 4096;

/**
 * The row and the column of a placeholder cell, as combining marks.
 *
 * Copied from kitty's `rowcolumn-diacritics.txt`, which is derived from
 * Unicode 6.0.0: every combining mark of class 230 that has no decomposition
 * mapping, less the ones normalisation would fuse into the base character. The
 * order is the file's order and the index is the value, so this array may
 * never be sorted or added to in the middle.
 */
const DIACRITICS: readonly number[] = [
  0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A, 0x034B, 0x034C,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
  0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8,
  0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2, 0x06E4, 0x06E7, 0x06E8, 0x06EB,
  0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3,
  0x0816, 0x0817, 0x0818, 0x0819, 0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C, 0x082D, 0x0951, 0x0953, 0x0954,
  0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
  0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71,
  0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
  0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
  0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
  0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7,
  0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
  0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE,
  0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
  0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1,
  0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
  0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1,
  0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186,
  0x1D187, 0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
];

/** How many rows or columns a placeholder rectangle may be. */
export const MAX_CELLS = DIACRITICS.length;

const ESC = "\u001b";
const APC = ESC + "_G";
const ST = ESC + "\\";

/** One cell of a placeholder row: the mark for its row, then for its column. */
function cell(row: number, col: number): string {
  const r = DIACRITICS[row];
  const c = DIACRITICS[col];
  // Past the table there is no mark to write, so the cell inherits the one to
  // its left — which is the wrong column. Callers bound the rectangle with
  // `MAX_CELLS`; this is the floor under a caller that did not.
  if (r === undefined || c === undefined) return PLACEHOLDER;
  return PLACEHOLDER + String.fromCodePoint(r) + String.fromCodePoint(c);
}

/**
 * The rows that paint one image, as strings ink can put in a `<Text>`.
 *
 * Every cell carries both of its marks. kitty lets a cell inherit a missing
 * mark from the cell to its left, and a shorter row could be built that way,
 * but a row ink wrapped or a selection that highlighted part of one would then
 * paint the rest of the picture in the wrong place. Whole marks cost bytes and
 * no columns.
 *
 * The foreground colour is the image id, in 24 bits, so ids run to 0xffffff
 * without the third mark kitty keeps for a wider one.
 */
export function placeholderRows(id: number, cols: number, rows: number): string[] {
  const w = Math.max(0, Math.min(cols, MAX_CELLS));
  const h = Math.max(0, Math.min(rows, MAX_CELLS));
  const fg = `${ESC}[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`;
  const out: string[] = [];
  for (let r = 0; r < h; r++) {
    let line = fg;
    for (let c = 0; c < w; c++) line += cell(r, c);
    out.push(line + ESC + "[39m");
  }
  return out;
}

/**
 * Send one PNG and make a virtual placement of it, as one escape per chunk.
 *
 * `a=T` transmits and places in one go, `U=1` makes the placement a virtual
 * one, and `c` and `r` give it the size of the rectangle the rows below will
 * cover. The control keys ride on the first chunk only; every later chunk
 * carries nothing but `m`, which is 1 while more follows and 0 on the last.
 *
 * `f=100` is PNG. kitty reads PNG, 24-bit RGB and 32-bit RGBA and nothing
 * else, which is why `mediaView.ts` converts a JPEG and a video frame first.
 */
export function kittyTransmit(id: number, png: Uint8Array, cols: number, rows: number): string {
  const b64 = Buffer.from(png).toString("base64");
  const head = `a=T,U=1,i=${id},f=100,t=d,c=${cols},r=${rows},q=2`;
  let out = "";
  // A payload short enough for one escape still goes through the loop, and
  // comes out as a single chunk with `m=0`.
  for (let at = 0; at < b64.length || at === 0; at += CHUNK_BYTES) {
    const part = b64.slice(at, at + CHUNK_BYTES);
    const more = at + CHUNK_BYTES < b64.length ? 1 : 0;
    const keys = at === 0 ? `${head},m=${more}` : `m=${more}`;
    out += `${APC}${keys};${part}${ST}`;
  }
  return out;
}

/**
 * Forget one image and free its bytes.
 *
 * `d=I` rather than `d=i`: the lower case one drops the placements and keeps
 * the data, which would leave every picture a reader opened in the terminal's
 * memory for as long as the session lasts.
 */
export function kittyDelete(id: number): string {
  return `${APC}a=d,d=I,i=${id},q=2;${ST}`;
}

export interface CellSize {
  /** The width and the height of one cell, in pixels. */
  w: number;
  h: number;
}

/**
 * A cell where the terminal will not say (see `queryCellSize`).
 *
 * Two to one is the shape of nearly every monospace cell, so a picture sized
 * with this is close rather than right, and no picture is ever stretched by
 * more than the font is.
 */
export const ASSUMED_CELL: CellSize = { w: 8, h: 16 };

/** The escape that asks the terminal how big one cell is. */
export const CELL_SIZE_QUERY = `${ESC}[16t`;

/**
 * Read the answer to `CELL_SIZE_QUERY`, which is `CSI 6 ; height ; width t`.
 *
 * Answers undefined for anything else, including the `CSI 4 ; …` and
 * `CSI 8 ; …` reports a terminal may send unasked on a resize: the height and
 * the width of the *window* would size a picture to the whole screen.
 */
export function parseCellSize(reply: string): CellSize | undefined {
  const m = /\u001b\[6;(\d+);(\d+)t/.exec(reply);
  if (!m) return undefined;
  const h = Number(m[1]);
  const w = Number(m[2]);
  // A zero would divide the rectangle to nothing, and a cell of a thousand
  // pixels is a terminal answering a different question.
  if (!(h > 0 && h < 1000 && w > 0 && w < 1000)) return undefined;
  return { w, h };
}

export interface Box {
  cols: number;
  rows: number;
}

/**
 * The rectangle of cells one picture should cover: as large as it may be, and
 * the shape the picture already is.
 *
 * The terminal scales the picture to fill whatever rectangle it is given, so
 * this is the whole of what keeps a screenshot from being stretched. Both
 * sides matter: a wide picture is bounded by the pane and a tall one by the
 * rows, and the smaller of the two scales decides.
 */
export function mediaBox(img: { width: number; height: number }, cell: CellSize, max: Box): Box {
  const maxCols = Math.max(1, Math.min(max.cols, MAX_CELLS));
  const maxRows = Math.max(1, Math.min(max.rows, MAX_CELLS));
  if (!(img.width > 0 && img.height > 0)) return { cols: maxCols, rows: maxRows };
  // The picture's size in cells if it were painted at its own scale, which is
  // the ceiling on both sides: covey never blows a small picture up.
  const wantCols = img.width / cell.w;
  const wantRows = img.height / cell.h;
  const scale = Math.min(1, maxCols / wantCols, maxRows / wantRows);
  return {
    cols: Math.max(1, Math.min(maxCols, Math.round(wantCols * scale))),
    rows: Math.max(1, Math.min(maxRows, Math.round(wantRows * scale))),
  };
}

/**
 * The size of a PNG, read out of its `IHDR`.
 *
 * The chunk is first by the specification and its two lengths are at a fixed
 * offset, so this needs no decoder. Answers undefined when the bytes are not a
 * PNG, which is how the caller learns a conversion failed quietly.
 */
export function pngSize(buf: Uint8Array): { width: number; height: number } | undefined {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24) return undefined;
  for (let i = 0; i < SIG.length; i++) if (buf[i] !== SIG[i]) return undefined;
  const at = (o: number) => ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
  const width = at(16);
  const height = at(20);
  if (!(width > 0 && height > 0)) return undefined;
  return { width, height };
}

/**
 * Whether this terminal paints a picture at all.
 *
 * A query would be the honest way to ask, and covey cannot: the answer arrives
 * on stdin, where `useInput` would read it as typing. So covey reads the
 * terminal's name, as it does for the kitty keyboard protocol, and keeps an
 * escape hatch for a terminal this list has not met.
 *
 * `TERM_PROGRAM` names Ghostty and WezTerm; `TERM` names kitty, which sets
 * `xterm-kitty`. Konsole sets neither and is left out rather than guessed at.
 * iTerm2 and Terminal.app cannot: iTerm2 paints over `OSC 1337`, which places
 * a picture at the cursor, and a repaint would erase it.
 */
export function graphicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COVEY_NO_GRAPHICS) return false;
  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  // Inside tmux or screen the escape reaches the multiplexer and not the
  // terminal, and a placement it does pass through lands in the wrong cell. A
  // reader there gets the link, as before. This comes before `COVEY_GRAPHICS`,
  // because the hatch is for a terminal the list has not met and not for a
  // multiplexer the protocol cannot cross.
  if (env.TMUX || term.startsWith("screen")) return false;
  if (env.COVEY_GRAPHICS) return true;
  return term.includes("kitty") || program === "ghostty" || program === "wezterm";
}
