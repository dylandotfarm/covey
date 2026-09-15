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
  selection: "#2a2f45",
  success: "#10b981",
  info: "#3b82f6",
  warning: "#f59e0b",
  danger: "#ef4444",
  claude: "#d97757",
  working: "#7dd3fc",
  awaiting: "#818cf8",
  code: "#e5c07b",
  userBg: "#202020",
} as const;

export function statusColor(status: string, pulse: boolean): string {
  switch (status) {
    case "running": case "starting": return pulse ? T.info : T.working;
    case "waiting": return pulse ? T.warning : T.awaiting;
    case "error": return T.danger;
    case "interrupted": return T.subtle;
    default: return T.faint;
  }
}
