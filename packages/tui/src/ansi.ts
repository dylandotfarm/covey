import { type Line, type Span } from "./lines.js";

/**
 * What a shell wrote, as painted rows (#10).
 *
 * The panel cannot hand the bytes to Ink as they came. Ink measures the string
 * it is given to lay the frame out, and an escape sequence inside it counts as
 * printable columns — the same reason `Span.link` holds a URI instead of an
 * OSC 8 escape, and the reason `media.ts` writes its graphics escapes out of
 * band. So the escapes are read here and become `Span` fields, which the
 * transcript's own renderer already knows how to paint and `selectedText`
 * already knows how to copy.
 *
 * This is not a terminal emulator, and must not grow into one. It is a
 * *scrolling log*: rows are appended and never addressed, so everything that
 * moves the cursor up or clears the screen is dropped rather than honoured.
 * What it does honour is the handful of sequences a build writes on its way
 * past:
 *
 * - **SGR** (`CSI … m`), because `git status` without colour is most of why a
 *   reader opened the panel.
 * - **`\r`**, because that is how every progress bar in existence rewrites its
 *   own line. Without it `pnpm install` is two hundred rows of the same line.
 * - **erase in line** (`CSI K`), which the same progress bars use to rub out
 *   the tail of the line they just shortened.
 * - **`\b`** and **`\t`**, which are column moves a log really does contain.
 *
 * Everything else — cursor moves, screen clears, alternate screen, the mode
 * sets a full-screen program writes — is skipped. A reader who runs `vim` here
 * gets a mess, and `terminal.ts` says why that is the deal.
 */

/** One cell of the row being built: the character and the style it is in. */
interface Cell { ch: string; style: Style }

/** The SGR state. The same fields `Span` carries, so a run becomes a span. */
interface Style {
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
}

const BLANK: Style = {};

/** A tab stop every eight columns, which is every terminal's default. */
const TAB = 8;

/**
 * How much of a half-read escape sequence is still worth waiting for.
 *
 * A chunk may end inside a sequence, and the remainder is held until the next
 * one finishes it. Something has to bound that wait, because a sequence may
 * never be finished: `ESC ]` with no BEL and no ST is what a `cat` of a binary
 * file writes, and with no bound every byte after it buffers for ever — the
 * panel reads as frozen while the command is still running, which is the one
 * failure a reader cannot tell from a hung command.
 *
 * Past this the escape is given up on and what follows is painted as text. A
 * mess on one row is a far better answer than a dead pane, and the longest
 * sequence anything here really writes — an OSC 8 with a URL in it — is a
 * small fraction of this.
 */
const MAX_PENDING_ESCAPE = 4096;

/**
 * The eight ANSI colours and their bright forms, by Ink's own names.
 *
 * Names rather than hex on purpose: these are the reader's *terminal* colours,
 * the ones their own shell paints in, and a hex value would override the theme
 * they chose in their emulator. Covey's palette (`theme.ts`) is for what covey
 * draws; this is for what somebody else's program drew.
 */
const BASE = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const BRIGHT = ["blackBright", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"] as const;

/**
 * One of the 256 colours of the xterm cube, as hex.
 *
 * The first sixteen are the terminal's own, so they keep their names and the
 * reader's emulator decides what they look like. 16–231 are the 6×6×6 cube and
 * 232–255 the grey ramp, both of which have exact values nobody themes.
 */
export function xterm256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return hex(steps[Math.floor(i / 36)]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!);
  }
  const v = 8 + (n - 232) * 10;
  return hex(v, v, v);
}

function hex(r: number, g: number, b: number): string {
  const p = (x: number) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

/**
 * Apply one SGR sequence's parameters to a style, and answer the new one.
 *
 * Exported for its test. The parameters are read left to right, because that
 * is what they mean: `0;31;1` is reset, then red, then bold.
 */
export function applySgr(style: Style, params: number[]): Style {
  let s: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) { s = {}; continue; }
    if (p === 1) { s.bold = true; continue; }
    if (p === 2) { s.dim = true; continue; }
    if (p === 3) { s.italic = true; continue; }
    if (p === 7) { s.inverse = true; continue; }
    if (p === 22) { delete s.bold; delete s.dim; continue; }
    if (p === 23) { delete s.italic; continue; }
    if (p === 27) { delete s.inverse; continue; }
    if (p >= 30 && p <= 37) { s.color = BASE[p - 30]; continue; }
    if (p >= 90 && p <= 97) { s.color = BRIGHT[p - 90]; continue; }
    if (p === 39) { delete s.color; continue; }
    if (p >= 40 && p <= 47) { s.bg = BASE[p - 40]; continue; }
    if (p >= 100 && p <= 107) { s.bg = BRIGHT[p - 100]; continue; }
    if (p === 49) { delete s.bg; continue; }
    if (p === 38 || p === 48) {
      // `38;5;n` is one of the 256, `38;2;r;g;b` is truecolour. The parameters
      // that follow belong to this one, so the loop steps over them; a short
      // sequence is dropped rather than read into the next colour.
      const kind = params[i + 1];
      if (kind === 5) {
        const c = xterm256(params[i + 2] ?? -1);
        if (c) { if (p === 38) s.color = c; else s.bg = c; }
        i += 2;
      } else if (kind === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if (r !== undefined && g !== undefined && b !== undefined) {
          const c = hex(r, g, b);
          if (p === 38) s.color = c; else s.bg = c;
        }
        i += 4;
      }
      continue;
    }
    // Anything else — blink, strike-through, the fonts — has no `Span` field,
    // so it is dropped rather than approximated with one that does.
  }
  return s;
}

/**
 * A shell's output, kept as rows and fed in chunks.
 *
 * Mutable and kept out of React state, because a build writes hundreds of
 * chunks and a new array per chunk is a copy per chunk. `rows()` hands back the
 * one array it holds, by identity, and the panel reads a generation number to
 * know it moved — which is `ItemLines`' rule for the same reason.
 */
export class AnsiLog {
  /** Rows that are finished, oldest first. */
  private done: Line[] = [];
  /** The row being written, as cells, so a `\r` can overwrite what is there. */
  private cells: Cell[] = [];
  private col = 0;
  private style: Style = BLANK;
  /** Partial escape left by a chunk that was cut inside one. */
  private tail = "";
  private gen = 0;

  constructor(private readonly maxRows: number) {}

  /** Bumped by every `write` that changed anything. The panel repaints on it. */
  get generation() { return this.gen; }

  /**
   * Every row, the finished ones and the one in progress.
   *
   * One array, rebuilt only when the content moved, so a frame that paints the
   * same log twice lays out the same array twice.
   */
  rows(): Line[] {
    if (!this.cache || this.cacheGen !== this.gen) {
      this.cache = this.cells.length > 0 ? [...this.done, compress(this.cells)] : [...this.done];
      this.cacheGen = this.gen;
    }
    return this.cache;
  }
  private cache: Line[] | null = null;
  private cacheGen = -1;

  clear() {
    this.done = [];
    this.cells = [];
    this.col = 0;
    this.gen++;
  }

  write(data: string) {
    // A chunk may end inside an escape sequence: the daemon reads the pipe, not
    // the sequences in it. Joining the remainder onto the next chunk is the
    // same seam `readSplitDrop` handles for a path cut in two (#130).
    const s = this.tail + data;
    this.tail = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        const esc = readEscape(s, i);
        if (esc === null) {
          // Still plausibly a sequence cut in two: hold it for the next chunk.
          if (s.length - i <= MAX_PENDING_ESCAPE) { this.tail = s.slice(i); break; }
          // Too long to be one. Step over the escape itself and read the rest
          // as the text it evidently is — see `MAX_PENDING_ESCAPE`.
          i++;
          continue;
        }
        this.escape(esc.seq);
        i = esc.end;
        continue;
      }
      i++;
      if (ch === "\n") { this.endRow(); continue; }
      if (ch === "\r") { this.col = 0; continue; }
      if (ch === "\b") { this.col = Math.max(0, this.col - 1); continue; }
      if (ch === "\t") {
        const to = (Math.floor(this.col / TAB) + 1) * TAB;
        while (this.col < to) this.put(" ");
        continue;
      }
      // Every other C0 control, and the DEL at the top of the range, prints as
      // nothing on a terminal and must print as nothing here: a NUL painted as
      // a cell would make the row one column wider than the reader sees.
      if (ch < " " || ch === "\x7f") continue;
      this.put(ch);
    }
    this.gen++;
  }

  private escape(seq: string) {
    // `CSI … m` is the one we act on, and `CSI … K` the other. Everything else
    // moves a cursor this log has no notion of, so it is skipped — which is the
    // right answer, not a shortcut: see the note at the top of the file.
    const csi = /^\x1b\[([\d;:?]*)(.)$/.exec(seq);
    if (!csi) return;
    const [, raw, final] = csi;
    if (final === "m") {
      // `CSI m` with no parameter is `CSI 0 m`, a reset. A colon inside a
      // parameter is the newer sub-parameter form of `38:2:…`, which reads the
      // same once the separators are one kind.
      const params = (raw === "" ? "0" : raw!).replace(/:/g, ";").split(";").map((p) => (p === "" ? 0 : Number(p)));
      if (params.every((p) => Number.isFinite(p))) this.style = applySgr(this.style, params);
      return;
    }
    if (final === "K") {
      const mode = raw === "" ? 0 : Number(raw);
      if (mode === 0) this.cells.length = Math.min(this.cells.length, this.col);
      else if (mode === 1) for (let c = 0; c < this.col && c < this.cells.length; c++) this.cells[c] = { ch: " ", style: BLANK };
      else if (mode === 2) { this.cells.length = 0; this.col = 0; }
    }
  }

  private put(ch: string) {
    // Past the end of the row the gap is filled with blanks: a `CSI 20G` then a
    // character is a column move covey does not honour, but a `\r` then a short
    // line over a long one is, and the cells between have to exist.
    while (this.cells.length < this.col) this.cells.push({ ch: " ", style: BLANK });
    this.cells[this.col] = { ch, style: this.style };
    this.col++;
  }

  private endRow() {
    this.done.push(compress(this.cells));
    this.cells = [];
    this.col = 0;
    // Bounded by rows, because the panel scrolls by rows and a reader scrolling
    // back wants to know how far back they may go. The daemon bounds its own
    // copy by bytes, for a different reason — see `TERMINAL_SCROLLBACK_BYTES`.
    if (this.done.length > this.maxRows) this.done.splice(0, this.done.length - this.maxRows);
  }
}

/**
 * One row of cells as the fewest spans that paint it.
 *
 * A run of cells in one style is one span, because a span per character is a
 * `<Text>` per character and the transcript's own renderer already costs the
 * frame more than covey would like.
 */
function compress(cells: Cell[]): Line {
  const line: Line = [] as unknown as Line;
  let run = "";
  let style: Style = BLANK;
  for (const cell of cells) {
    if (run !== "" && !sameStyle(style, cell.style)) { line.push({ text: run, ...style }); run = ""; }
    style = cell.style;
    run += cell.ch;
  }
  if (run !== "") line.push({ text: run, ...style });
  return line;
}

function sameStyle(a: Style, b: Style): boolean {
  return a.color === b.color && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.inverse === b.inverse;
}

/**
 * The escape sequence starting at `i`, or `null` when the chunk ends inside it.
 *
 * `null` is not an error: the daemon hands over whatever the pipe gave it, and
 * a sequence cut in half is finished by the next chunk. Reading it as text
 * instead would paint `[32m` into the output and leave the colour off.
 */
export function readEscape(s: string, i: number): { seq: string; end: number } | null {
  const next = s[i + 1];
  if (next === undefined) return null;
  // OSC: `ESC ] … BEL` or `ESC ] … ESC \`. A title change, or an OSC 8 link
  // some tool wrote. Skipped whole; covey's own links come from `Span.link`.
  if (next === "]") {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return { seq: s.slice(i, j + 1), end: j + 1 };
      if (s[j] === "\x1b" && s[j + 1] === "\\") return { seq: s.slice(i, j + 2), end: j + 2 };
    }
    return null;
  }
  if (next === "[") {
    // CSI: parameters and intermediates, then one final byte in 0x40–0x7e.
    for (let j = i + 2; j < s.length; j++) {
      const c = s[j]!;
      if (c >= "\x40" && c <= "\x7e") return { seq: s.slice(i, j + 1), end: j + 1 };
    }
    return null;
  }
  // `ESC P` (DCS), `ESC X`, `ESC ^`, `ESC _` all run to a string terminator.
  if (next === "P" || next === "X" || next === "^" || next === "_") {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return { seq: s.slice(i, j + 1), end: j + 1 };
      if (s[j] === "\x1b" && s[j + 1] === "\\") return { seq: s.slice(i, j + 2), end: j + 2 };
    }
    return null;
  }
  // Everything else is a two-character escape: `ESC =`, `ESC (B`, and so on.
  // `ESC (` takes one more byte, so it is read as three.
  if (next === "(" || next === ")" || next === "*" || next === "+") {
    if (s[i + 2] === undefined) return null;
    return { seq: s.slice(i, i + 3), end: i + 3 };
  }
  return { seq: s.slice(i, i + 2), end: i + 2 };
}

/** The style fields of a span, for a caller that builds one by hand. */
export type AnsiStyle = Style;
export type { Span };
