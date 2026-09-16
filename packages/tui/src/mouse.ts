/**
 * Mouse reporting and clipboard, for pane-scoped selection.
 *
 * The terminal's own selection works on the rendered screen grid, so dragging
 * across the transcript also picks up the sidebar sitting beside it. To select
 * only within a pane we have to take over the mouse and track the drag
 * ourselves.
 *
 * The escape here is that essentially every terminal bypasses mouse reporting
 * while Shift is held, so shift+drag still gives the user native selection and
 * scrollback behaviour. That is documented in the help overlay. It also rules
 * shift out as *the* modifier for the wheel, because in most terminals the
 * report never arrives. `wheelDelta` below names alt, which no common terminal
 * claims, and takes shift only where a terminal does forward it.
 *
 * Ink has no mouse support, but it also does not mangle these sequences: an
 * unrecognised CSI arrives at `useInput` as the raw sequence with one leading
 * ESC stripped (verified against ink 7.1.1's parse-keypress). So the app layer
 * can pick them out of the input string rather than restructuring stdin.
 */

/** 1002 = report drag motion while a button is held; 1006 = SGR coordinates
 *  (required past column 223). */
const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1002l\x1b[?1006l";

export function enableMouse(out: NodeJS.WriteStream = process.stdout): void {
  out.write(ENABLE);
}

export function disableMouse(out: NodeJS.WriteStream = process.stdout): void {
  out.write(DISABLE);
}

/**
 * The SGR wheel codes are 64 up, 65 down, 66 left, 67 right, so the direction
 * is the low *two* bits. Testing only the low bit read a left notch as an up
 * and a right notch as a down. A trackpad mixes a small sideways component into
 * most of a slow vertical scroll, so that showed up as a flicker: scroll down,
 * and every stray 66 threw the view back up against the hand.
 */
const WHEEL = ["up", "down", "left", "right"] as const;
export type WheelDirection = (typeof WHEEL)[number];

export interface MouseEvent {
  kind: "press" | "drag" | "release" | "wheel";
  /** 0 = left, 1 = middle, 2 = right. Says nothing on a wheel event, where the
   *  same two bits carry the direction; read `wheel` there. */
  button: number;
  /** 1-based screen coordinates. */
  col: number;
  row: number;
  wheel?: WheelDirection;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const SGR = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse zero or more SGR mouse events out of an `useInput` chunk. A drag emits
 * many motion events, which the terminal often delivers batched into one chunk,
 * so this always returns an array.
 */
export function parseMouse(input: string): MouseEvent[] {
  if (!input.includes("[<")) return [];
  const out: MouseEvent[] = [];
  for (const part of input.split("\x1b")) {
    const m = SGR.exec(part);
    if (!m) continue;
    const code = Number(m[1]);
    const col = Number(m[2]);
    const row = Number(m[3]);
    const released = m[4] === "m";
    const motion = (code & 32) !== 0;
    const isWheel = (code & 64) !== 0;
    const mods = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
    if (isWheel) {
      out.push({ kind: "wheel", button: code & 3, col, row, wheel: WHEEL[code & 3]!, ...mods });
    } else if (released) {
      out.push({ kind: "release", button: code & 3, col, row, ...mods });
    } else {
      out.push({ kind: motion ? "drag" : "press", button: code & 3, col, row, ...mods });
    }
  }
  return out;
}

/**
 * Rows to move for one wheel notch: positive towards the older lines, negative
 * towards the newest. One row a notch, so the scroll follows the hand; a
 * modifier asks for `page` instead.
 *
 * A sideways notch gives 0, because no pane scrolls sideways. The caller must
 * treat 0 as "do nothing" rather than as a scroll of no distance, so that a
 * sideways notch cannot take the focus or start a page load either.
 *
 * alt is the modifier the help overlay names. shift and ctrl also count, because
 * they cost nothing and a terminal that does forward them then behaves the same.
 */
export function wheelDelta(ev: MouseEvent, page: number): number {
  if (ev.kind !== "wheel") return 0;
  const step = ev.alt || ev.ctrl || ev.shift ? Math.max(1, page) : 1;
  if (ev.wheel === "up") return step;
  if (ev.wheel === "down") return -step;
  return 0;
}

/** True when the chunk is nothing but mouse reports, so it must not be typed. */
export function isMouseInput(input: string): boolean {
  return /^(?:\x1b?\[<\d+;\d+;\d+[Mm])+$/.test(input);
}

/**
 * Copy via OSC 52, which works over SSH where there is no local clipboard
 * binary to shell out to.
 *
 * Deliberately *not* wrapped in tmux's passthrough sequence: tmux forwards a
 * bare OSC 52 to the outer terminal on its own (`set-clipboard`, which defaults
 * to `external`), whereas passthrough additionally requires `allow-passthrough`,
 * which has defaulted to off since tmux 3.3 — so wrapping it silently copies
 * nothing for most users inside tmux.
 */
export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): void {
  out.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}
