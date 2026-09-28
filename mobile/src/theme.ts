/**
 * The palette, copied from the web client's own (`packages/web/static/app.css`).
 *
 * This is the same relationship `desktop/crates/covey-grid/src/theme.rs` has
 * with `packages/tui/src/theme.ts`: a copy, not an import, because a style
 * sheet is not a module and React Native has no custom properties. Move a
 * colour in one and move it in the other, or the phone's two clients stop
 * looking like the same program.
 *
 * One theme, as the web client has one. The TUI's eight are a picker this
 * client does not have yet.
 */
export const T = {
  bg: "#121212",
  surface: "#1b1b1b",
  surfaceAlt: "#242424",
  border: "#333333",
  text: "#f5f5f5",
  muted: "#a3a3a3",
  subtle: "#737373",
  faint: "#4a4a4a",
  accent: "#7c87ff",
  accentDim: "#2a3f95",
  success: "#10b981",
  info: "#3b82f6",
  warning: "#f59e0b",
  danger: "#ef4444",
  working: "#7dd3fc",
  awaiting: "#818cf8",
  code: "#e5c07b",
  userBg: "#202020",
} as const;

/** The colour a thread's state is painted in. `state.ts` decides the state. */
export const TONE: Record<"busy" | "waiting" | "error" | "done" | "idle", string> = {
  busy: T.working,
  waiting: T.awaiting,
  error: T.danger,
  done: T.success,
  idle: T.subtle,
};

/** The one monospace family that exists on Android, for code and for diffs. */
export const MONO = "monospace";

export const SIZE = { small: 12, body: 15, title: 16, heading: 19 } as const;
