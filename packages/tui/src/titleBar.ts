/**
 * What the title bar shows when it cannot show everything (#87).
 *
 * The bar is one row, and three things want it: the name of the pane in front
 * of the reader, a notice, and a keybinding hint. At 80 columns their natural
 * widths add up to more than there is, and the first version let flex settle
 * it — two children that both wanted more than the row had, shrinking into
 * each other. The reader got `al…  …  esc interr…rl+k commands`: a title cut
 * to nothing and a hint cut from the middle, which is the one place a hint
 * cannot be cut. Worse, the outcome depended on the width the client *mounted*
 * at, because a cached text measurement was being reused for a constraint it
 * was not taken under, and only a row whose children fight for room can
 * disagree about it.
 *
 * So the widths are arithmetic here, and the two sides are ranked rather than
 * negotiated:
 *
 * - A **notice** takes its room first and the title gives way (#176). It is
 *   the only channel a failure has, and the row the title names is on the
 *   screen in front of the reader anyway.
 * - A **hint** takes only what the title leaves. It is the cheapest thing on
 *   the row — a reader needs it once — so it is shown in the longest of its
 *   forms that fits whole, and below that it is not shown at all.
 *
 * A hint is therefore never cut, and the title is never cut to make room for
 * one. The parts of the title give way from the right: the pane's own name is
 * truncated, and anything beside it is dropped rather than shortened to an
 * ellipsis nobody can read.
 */
import { elide, truncate, width } from "./lines.js";

/** The columns between two parts of the left-hand side. */
export const PART_GAP = 2;
/** The columns between the left-hand side and the notice or the hint. */
export const RIGHT_GAP = 2;

/** One thing the left-hand side of the bar names, in the order it is painted. */
export type BarPart = {
  text: string;
  /**
   * The pane's own name: the one part that is truncated rather than dropped.
   * Every other part is shown whole or not at all, because `1 project · 1 m…`
   * costs a reader more room than it gives them back.
   */
  keep?: boolean;
};

/** What stands on the right of the bar, and which rule it is laid out by. */
export type BarRight =
  | { kind: "notice"; text: string }
  | { kind: "hint"; forms: string[] };

/** A part that got room: what to paint, and whether two columns come first. */
export type BarPainted = { text: string; gap: boolean };

export type BarLayout = {
  /** One entry per part, in screen order. `null` is a part that got no room. */
  parts: (BarPainted | null)[];
  /** The notice, or the hint form that fits. `""` paints nothing. */
  right: string;
};

/** The columns `parts` wants, with the gap between each. */
function partsWidth(parts: BarPart[]): number {
  let w = 0;
  for (const p of parts) {
    if (!p.text) continue;
    w += (w ? PART_GAP : 0) + width(p.text);
  }
  return w;
}

/**
 * Fill `room` with `parts` from the left. A `keep` part takes what is left and
 * is truncated to it; any other part is taken only if it fits whole.
 */
function fitParts(parts: BarPart[], room: number): (BarPainted | null)[] {
  const out: (BarPainted | null)[] = [];
  let used = 0;
  for (const p of parts) {
    if (!p.text) { out.push(null); continue; }
    const gap = used > 0;
    const avail = Math.max(0, room - used - (gap ? PART_GAP : 0));
    if (width(p.text) <= avail) {
      out.push({ text: p.text, gap });
      used += (gap ? PART_GAP : 0) + width(p.text);
    } else if (p.keep && avail > 0) {
      const cut = truncate(p.text, avail);
      out.push({ text: cut, gap });
      used += (gap ? PART_GAP : 0) + width(cut);
    } else {
      out.push(null);
    }
  }
  return out;
}

/**
 * Lay the bar out in `room` columns.
 *
 * What comes back fits: the widths of the parts, their gaps, `RIGHT_GAP` and
 * the right-hand side add up to `room` or less, measured with covey's own
 * `width`. Ink measures with `string-width`, which reads a handful of
 * characters differently, so the boxes keep their own shrink as a net — but
 * nothing is laid out *expecting* one of them to give way.
 */
export function layoutTitleBar(parts: BarPart[], right: BarRight, room: number): BarLayout {
  if (right.kind === "notice") {
    // Cut here as well as at the caller. The caller decides how much of the
    // row a notice may claim, which depends on its tone and is none of this
    // module's business; what the row *has* is, and a notice wider than the
    // room is the overflow this function exists to rule out. `elide`, so a
    // bound that does bite keeps both ends of "what failed: why" (#176).
    const text = elide(right.text, Math.max(0, room - RIGHT_GAP));
    return { parts: fitParts(parts, text ? room - RIGHT_GAP - width(text) : room), right: text };
  }
  const want = partsWidth(parts);
  for (const form of right.forms) {
    if (want + RIGHT_GAP + width(form) <= room) return { parts: fitParts(parts, room), right: form };
  }
  return { parts: fitParts(parts, room), right: "" };
}
