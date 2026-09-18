/**
 * Palette discipline: near-black greys, three text tiers, one accent. Terminals vary, so we use truecolor hexes where Ink supports
 * them and fall back gracefully.
 */
export const T = {
  text: "#f5f5f5",
  muted: "#a3a3a3",
  subtle: "#737373",
  faint: "#4a4a4a",
  accent: "#7c87ff",
  accentDim: "#2a3f95",
  border: "#333333",
  surface: "#1b1b1b",
  surfaceAlt: "#242424",
  /**
   * The cursor row in a list: the sidebar, an overlay, the composer menu, the
   * options of a question. A tint is enough there, because the row is also
   * marked by a `❯` and by its text turning bold.
   *
   * This is not the text selection. A drag has no other mark, so it needs a
   * boundary the eye finds on its own — see `selectionBg`.
   */
  selection: "#2a2f45",
  /**
   * The background of selected text.
   *
   * Light on purpose. covey paints its own near-black surfaces, and the
   * lightest of them — the diff panel's added-line green — has a relative
   * luminance of 0.025. To clear 3:1 over that, a background needs a luminance
   * of at least 0.175, which is already a mid grey; a mid grey then leaves
   * `T.faint` at about 1.7:1 and unreadable. So the selection inverts the tier
   * instead of tinting it, which is what a terminal does for its own selection
   * and what the reader already expects.
   */
  selectionBg: "#aab4dc",
  /**
   * The one foreground every selected span takes.
   *
   * The selection replaces the colour rather than painting behind it: the
   * palette runs from `#f5f5f5` to `#4a4a4a`, and no single background keeps
   * both ends readable.
   */
  selectionText: "#12121a",
  success: "#10b981",
  info: "#3b82f6",
  warning: "#f59e0b",
  danger: "#ef4444",
  claude: "#d97757",
  working: "#7dd3fc",
  awaiting: "#818cf8",
  code: "#e5c07b",
  userBg: "#202020",
  diffAdd: "#b5e8b0",
  diffAddBg: "#173124",
  diffDel: "#f2b8b5",
  diffDelBg: "#3a1f1f",
} as const;

/**
 * Every background a text selection can be painted over.
 *
 * `#000000` stands for the terminal's own paint: a span that sets no
 * background falls through to it, and a covey user runs a dark terminal
 * because the text tiers assume one.
 */
export const SELECTION_SURFACES = [T.surface, T.surfaceAlt, T.userBg, T.diffAddBg, T.diffDelBg, "#000000"] as const;

/** The sRGB relative luminance of a `#rrggbb` colour, per WCAG 2. */
export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/**
 * The WCAG 2 contrast ratio between two colours, from 1 (identical) to 21
 * (black on white). Under about 3:1 is not a boundary a person can see.
 */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function statusColor(status: string, pulse: boolean): string {
  switch (status) {
    case "running": case "starting": return pulse ? T.info : T.working;
    case "waiting": return pulse ? T.warning : T.awaiting;
    case "error": return T.danger;
    case "interrupted": return T.subtle;
    default: return T.faint;
  }
}
