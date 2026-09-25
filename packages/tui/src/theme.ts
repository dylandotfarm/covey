/**
 * The palette, and the themes that can fill it.
 *
 * Palette discipline: three text tiers over a near-black ground, one accent,
 * and one colour for each state a row can be in. Every pane reads `T`, which
 * is one object the whole program shares — `setTheme` writes the chosen
 * palette into it in place, so a component that already read `T` keeps
 * reading the right colours.
 *
 * A theme is the *device's* preference, like the level of detail: it travels
 * in no command, it reaches no daemon, and two clients on one thread may paint
 * it differently. `TuiConfig.prefs.theme` holds it.
 *
 * The TUI lets the terminal paint the ground, so a theme also names the
 * background it was measured against (`background`). Set the terminal to that
 * colour and the two agree; leave it and the text tiers still clear the
 * contrast bar, because `theme.test.ts` measures every theme against its own
 * background rather than against black.
 */

/** Every colour a pane may ask for. One theme fills all of them. */
export interface Palette {
  /** The ground the theme was measured against: what the terminal paints. */
  background: string;
  text: string;
  muted: string;
  subtle: string;
  faint: string;
  accent: string;
  accentDim: string;
  border: string;
  surface: string;
  surfaceAlt: string;
  /**
   * The cursor row in a list: the sidebar, an overlay, the composer menu, the
   * options of a question. A tint is enough there, because the row is also
   * marked by a `❯` and by its text turning bold.
   *
   * This is not the text selection. A drag has no other mark, so it needs a
   * boundary the eye finds on its own — see `selectionBg`.
   */
  selection: string;
  /**
   * The background of selected text.
   *
   * Light on purpose. covey paints its own near-black surfaces, and to clear
   * 3:1 over the lightest of them a background has to be a mid tone at least.
   * A mid grey then leaves `faint` unreadable, so the selection inverts the
   * tier instead of tinting it — which is what a terminal does for its own
   * selection and what the reader already expects.
   */
  selectionBg: string;
  /**
   * The one foreground every selected span takes.
   *
   * The selection replaces the colour rather than painting behind it: the
   * palette runs from `text` to `faint`, and no single background keeps both
   * ends readable.
   */
  selectionText: string;
  success: string;
  info: string;
  warning: string;
  danger: string;
  claude: string;
  working: string;
  awaiting: string;
  code: string;
  /** The block behind a message the reader wrote. */
  userBg: string;
  /**
   * A message covey wrote itself — the news from a watched pull request, the
   * line that restarts a turn after an authentication failure.
   *
   * It is a message, so it takes a block like the reader's; it is not the
   * reader's, so it takes its own colour and stays on the left. See
   * `isSystemMessage` in `lines.ts`.
   */
  system: string;
  systemBg: string;
  diffAdd: string;
  diffAddBg: string;
  diffDel: string;
  diffDelBg: string;
}

/** A theme the reader can pick, by the name they know it by. */
export interface Theme {
  id: string;
  label: string;
  /** One line under the name: where the colours come from. */
  hint: string;
  palette: Palette;
}

/**
 * covey's own. Near-black greys, three text tiers, one indigo accent.
 *
 * `background` is `#000000` because this palette assumes the terminal's own
 * dark paint and names nothing over it.
 */
const COVEY: Palette = {
  background: "#000000",
  text: "#f5f5f5",
  muted: "#a3a3a3",
  subtle: "#737373",
  faint: "#4a4a4a",
  accent: "#7c87ff",
  accentDim: "#2a3f95",
  border: "#333333",
  surface: "#1b1b1b",
  surfaceAlt: "#242424",
  selection: "#2a2f45",
  selectionBg: "#aab4dc",
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
  system: "#5eead4",
  systemBg: "#132523",
  diffAdd: "#b5e8b0",
  diffAddBg: "#173124",
  diffDel: "#f2b8b5",
  diffDelBg: "#3a1f1f",
};

const GRUVBOX: Palette = {
  background: "#282828",
  text: "#ebdbb2",
  muted: "#d5c4a1",
  subtle: "#a89984",
  faint: "#7c6f64",
  accent: "#fe8019",
  accentDim: "#6b3a12",
  border: "#504945",
  surface: "#32302f",
  surfaceAlt: "#3c3836",
  selection: "#3c3836",
  selectionBg: "#d5c4a1",
  selectionText: "#1d2021",
  success: "#b8bb26",
  info: "#83a598",
  warning: "#fabd2f",
  danger: "#fb4934",
  claude: "#fe8019",
  working: "#8ec07c",
  awaiting: "#d3869b",
  code: "#d3869b",
  userBg: "#32302f",
  system: "#8ec07c",
  systemBg: "#2c3430",
  diffAdd: "#b8bb26",
  diffAddBg: "#27331f",
  diffDel: "#fb4934",
  diffDelBg: "#3a2523",
};

const CATPPUCCIN: Palette = {
  background: "#1e1e2e",
  text: "#cdd6f4",
  muted: "#bac2de",
  subtle: "#9399b2",
  faint: "#585b70",
  accent: "#cba6f7",
  accentDim: "#4b3a63",
  border: "#313244",
  surface: "#232336",
  surfaceAlt: "#2a2a3e",
  selection: "#313244",
  selectionBg: "#b4befe",
  selectionText: "#11111b",
  success: "#a6e3a1",
  info: "#89b4fa",
  warning: "#f9e2af",
  danger: "#f38ba8",
  claude: "#fab387",
  working: "#89dceb",
  awaiting: "#b4befe",
  code: "#f5c2e7",
  userBg: "#262637",
  system: "#94e2d5",
  systemBg: "#1e2c30",
  diffAdd: "#a6e3a1",
  diffAddBg: "#1e2e26",
  diffDel: "#f38ba8",
  diffDelBg: "#33212b",
};

const NORD: Palette = {
  background: "#2e3440",
  text: "#eceff4",
  muted: "#d8dee9",
  subtle: "#a3adc0",
  faint: "#4c566a",
  accent: "#88c0d0",
  accentDim: "#3b5068",
  border: "#3b4252",
  surface: "#333b4a",
  surfaceAlt: "#3b4252",
  selection: "#3b4252",
  selectionBg: "#d8dee9",
  selectionText: "#2e3440",
  success: "#a3be8c",
  info: "#81a1c1",
  warning: "#ebcb8b",
  danger: "#d47b84",
  claude: "#d08770",
  working: "#8fbcbb",
  awaiting: "#b48ead",
  code: "#ebcb8b",
  userBg: "#353d4c",
  system: "#8fbcbb",
  systemBg: "#2f3a41",
  diffAdd: "#a3be8c",
  diffAddBg: "#2f3d34",
  diffDel: "#d47b84",
  diffDelBg: "#3e3038",
};

const DRACULA: Palette = {
  background: "#282a36",
  text: "#f8f8f2",
  muted: "#c8c8c2",
  subtle: "#9a9ab0",
  faint: "#6272a4",
  accent: "#bd93f9",
  accentDim: "#443266",
  border: "#44475a",
  surface: "#2f313f",
  surfaceAlt: "#383a4a",
  // Dracula's own current-line is `#44475a`, on which its red measures 2.91:1
  // — under the bar an offline machine's mark has to clear. The cursor row
  // takes a darker shade of it so the mark stays findable.
  selection: "#3b3e4e",
  selectionBg: "#bd93f9",
  selectionText: "#21222c",
  success: "#50fa7b",
  info: "#8be9fd",
  warning: "#f1fa8c",
  danger: "#ff5555",
  claude: "#ffb86c",
  working: "#8be9fd",
  awaiting: "#bd93f9",
  code: "#f1fa8c",
  userBg: "#2f313f",
  system: "#8be9fd",
  systemBg: "#26333c",
  diffAdd: "#50fa7b",
  diffAddBg: "#23362b",
  diffDel: "#ff5555",
  diffDelBg: "#3c262e",
};

const TOKYO_NIGHT: Palette = {
  background: "#1a1b26",
  text: "#c0caf5",
  muted: "#a9b1d6",
  subtle: "#8b94c4",
  faint: "#565f89",
  accent: "#7aa2f7",
  accentDim: "#2a3a66",
  border: "#292e42",
  surface: "#1f2030",
  surfaceAlt: "#292e42",
  selection: "#2f3450",
  selectionBg: "#a9b1d6",
  selectionText: "#16161e",
  success: "#9ece6a",
  info: "#7aa2f7",
  warning: "#e0af68",
  danger: "#f7768e",
  claude: "#ff9e64",
  working: "#7dcfff",
  awaiting: "#bb9af7",
  code: "#e0af68",
  userBg: "#222434",
  system: "#7dcfff",
  systemBg: "#1b2833",
  diffAdd: "#9ece6a",
  diffAddBg: "#1e2d22",
  diffDel: "#f7768e",
  diffDelBg: "#30212a",
};

const EVERFOREST: Palette = {
  background: "#2d353b",
  text: "#d3c6aa",
  muted: "#9da9a0",
  subtle: "#859289",
  faint: "#66756e",
  accent: "#a7c080",
  accentDim: "#41533b",
  border: "#3d484d",
  surface: "#343f44",
  surfaceAlt: "#3d484d",
  selection: "#3d484d",
  selectionBg: "#d3c6aa",
  selectionText: "#2d353b",
  success: "#a7c080",
  info: "#7fbbb3",
  warning: "#dbbc7f",
  danger: "#e67e80",
  claude: "#e69875",
  working: "#83c092",
  awaiting: "#d699b6",
  code: "#dbbc7f",
  userBg: "#333d42",
  system: "#83c092",
  systemBg: "#2f3c3b",
  diffAdd: "#a7c080",
  diffAddBg: "#2f3d33",
  diffDel: "#e67e80",
  diffDelBg: "#3e3335",
};

const SOLARIZED: Palette = {
  background: "#002b36",
  text: "#93a1a1",
  muted: "#839496",
  subtle: "#6d8388",
  faint: "#586e75",
  accent: "#268bd2",
  accentDim: "#164a6f",
  border: "#073642",
  surface: "#052f3b",
  surfaceAlt: "#073642",
  // Solarized is a low-contrast palette by design, and its own base02 as a
  // cursor row leaves the marks at about 3:1 with nothing to spare. This is
  // one step darker, so every mark clears the bar on the row as well as on
  // base03.
  selection: "#093946",
  selectionBg: "#93a1a1",
  selectionText: "#002b36",
  success: "#859900",
  info: "#41a5e8",
  warning: "#b58900",
  danger: "#e8524f",
  claude: "#cb4b16",
  working: "#2aa198",
  awaiting: "#8c90d8",
  code: "#b58900",
  userBg: "#063641",
  system: "#2aa198",
  systemBg: "#053a3c",
  diffAdd: "#859900",
  diffAddBg: "#0b3a28",
  diffDel: "#e8524f",
  diffDelBg: "#3a2124",
};

/**
 * Every theme, in the order the picker paints them. covey's own is first
 * because it is the default, and the rest are alphabetical.
 *
 * The hint names the terminal background the theme was drawn for. covey does
 * not paint the ground — the terminal does — so a reader who sets both gets
 * the theme whole, and a reader who sets neither still gets readable text.
 */
export const THEMES: Theme[] = [
  { id: "covey", label: "covey", hint: "the default — near-black greys, one indigo accent", palette: COVEY },
  { id: "catppuccin", label: "Catppuccin Mocha", hint: "terminal background #1e1e2e", palette: CATPPUCCIN },
  { id: "dracula", label: "Dracula", hint: "terminal background #282a36", palette: DRACULA },
  { id: "everforest", label: "Everforest Dark", hint: "terminal background #2d353b", palette: EVERFOREST },
  { id: "gruvbox", label: "Gruvbox Dark", hint: "terminal background #282828", palette: GRUVBOX },
  { id: "nord", label: "Nord", hint: "terminal background #2e3440", palette: NORD },
  { id: "solarized", label: "Solarized Dark", hint: "terminal background #002b36", palette: SOLARIZED },
  { id: "tokyonight", label: "Tokyo Night", hint: "terminal background #1a1b26", palette: TOKYO_NIGHT },
];

export const DEFAULT_THEME = "covey";

/** `raw` when it names a theme, else null. For a value stored by another covey. */
export function asThemeId(raw: unknown): string | null {
  return typeof raw === "string" && THEMES.some((t) => t.id === raw) ? raw : null;
}

/** The theme with this id, else the default. */
export function themeFor(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/**
 * The colours every pane reads.
 *
 * One object for the life of the program, rewritten in place by `setTheme`.
 * A module that holds `T` — which is all of them — therefore never holds a
 * stale palette, and nothing has to be re-imported or re-constructed when the
 * reader picks another theme.
 */
export const T: Palette = { ...COVEY };

let current = DEFAULT_THEME;
let generation = 0;

/** Which theme `T` currently holds. */
export function themeId(): string { return current; }

/**
 * How many times the palette has been rewritten.
 *
 * `ItemLines` caches painted lines against the item they came from, and an
 * item does not change when the theme does. This is the number it watches, so
 * a theme change empties that cache instead of leaving the old colours on the
 * screen until the next reply.
 */
export function themeGeneration(): number { return generation; }

/** Paint in `id` from now on. False when nothing knows that name. */
export function setTheme(id: string | null | undefined): boolean {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) return false;
  if (theme.id === current) return true;
  Object.assign(T, theme.palette);
  current = theme.id;
  generation++;
  return true;
}

/**
 * Every background a text selection can be painted over, in the theme `T`
 * holds now.
 *
 * `background` is the terminal's own paint: a span that sets no background
 * falls through to it.
 */
export function selectionSurfaces(p: Palette = T): string[] {
  return [p.surface, p.surfaceAlt, p.userBg, p.systemBg, p.diffAddBg, p.diffDelBg, p.background];
}

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

/**
 * Every background a sidebar row is painted on: the terminal's own paint, and
 * the tint under the cursor. A row's marks have to be legible on both, and the
 * cursor row is the harder of the two — `selection` lifts the floor without
 * lifting the dim tiers with it.
 */
export function sidebarRowSurfaces(p: Palette = T): string[] {
  return [p.background, p.selection];
}

/** The mark for a connection state, beside `connColor`: one glyph for every
 *  pane that paints a machine, so a connecting machine reads the same in the
 *  sidebar and in a summary. */
export function connDot(conn: string): string {
  switch (conn) {
    case "connected": return "●";
    case "connecting": return "◌";
    case "offline": return "✗";
    default: return "○";
  }
}

/**
 * The colour of a machine's mark in the sidebar, by connection state.
 *
 * `offline` is deliberately not dim. The first version of it used `faint`,
 * which `theme.test.ts` measures at 1.49:1 on the cursor row — the same
 * unreadable number the selection defect was reported for (#70). A machine the
 * client has given up on is the one a reader most needs to find, so it takes a
 * neutral grey that clears the bar on both surfaces: grey because giving up is
 * not an error, legible because it is the state that asks for an answer.
 *
 * Takes a `string` rather than `ConnState` for the same reason `statusColor`
 * does: the palette stays free of the rest of the program.
 */
export function connColor(conn: string, p: Palette = T): string {
  switch (conn) {
    case "connected": return p.success;
    case "connecting": return p.warning;
    case "offline": return p.muted;
    default: return p.danger;
  }
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
