//! The palette, carried over whole from `packages/tui/src/theme.ts`.
//!
//! Same discipline: near-black greys, three text tiers, one accent. The two
//! clients must not drift, because a person will run them side by side. When a
//! colour changes there, change it here in the same pull request.

/// A colour, as the palette writes them. Kept as three bytes rather than a
/// float triple so a hex from the TypeScript can be pasted in unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub const fn hex(v: u32) -> Rgb {
        Rgb(
            ((v >> 16) & 0xff) as u8,
            ((v >> 8) & 0xff) as u8,
            (v & 0xff) as u8,
        )
    }

    /// The sRGB relative luminance, per WCAG 2.
    pub fn luminance(self) -> f32 {
        let channel = |v: u8| {
            let c = v as f32 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(self.0) + 0.7152 * channel(self.1) + 0.0722 * channel(self.2)
    }
}

/// The WCAG 2 contrast ratio between two colours, from 1 (identical) to 21
/// (black on white). Under about 3:1 is not a boundary a person can see.
pub fn contrast_ratio(a: Rgb, b: Rgb) -> f32 {
    let (x, y) = (a.luminance(), b.luminance());
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

pub const TEXT: Rgb = Rgb::hex(0xf5f5f5);
pub const MUTED: Rgb = Rgb::hex(0xa3a3a3);
pub const SUBTLE: Rgb = Rgb::hex(0x737373);
pub const FAINT: Rgb = Rgb::hex(0x4a4a4a);
pub const ACCENT: Rgb = Rgb::hex(0x7c87ff);
pub const ACCENT_DIM: Rgb = Rgb::hex(0x2a3f95);
pub const BORDER: Rgb = Rgb::hex(0x333333);
pub const SURFACE: Rgb = Rgb::hex(0x1b1b1b);
pub const SURFACE_ALT: Rgb = Rgb::hex(0x242424);
/// The cursor row in a list. A tint is enough, because the row is also marked
/// by a `❯` and by its text turning bold.
pub const SELECTION: Rgb = Rgb::hex(0x2a2f45);
/// The background of selected *text*. Light on purpose: a drag has no other
/// mark, so it needs a boundary the eye finds on its own.
pub const SELECTION_BG: Rgb = Rgb::hex(0xaab4dc);
/// The one foreground every selected span takes. The selection replaces the
/// colour rather than painting behind it, because the palette runs from
/// `#f5f5f5` to `#4a4a4a` and no single background keeps both ends readable.
pub const SELECTION_TEXT: Rgb = Rgb::hex(0x12121a);
pub const SUCCESS: Rgb = Rgb::hex(0x10b981);
pub const INFO: Rgb = Rgb::hex(0x3b82f6);
pub const WARNING: Rgb = Rgb::hex(0xf59e0b);
pub const DANGER: Rgb = Rgb::hex(0xef4444);
pub const CLAUDE: Rgb = Rgb::hex(0xd97757);
pub const WORKING: Rgb = Rgb::hex(0x7dd3fc);
pub const AWAITING: Rgb = Rgb::hex(0x818cf8);
pub const CODE: Rgb = Rgb::hex(0xe5c07b);
pub const USER_BG: Rgb = Rgb::hex(0x202020);
pub const DIFF_ADD: Rgb = Rgb::hex(0xb5e8b0);
pub const DIFF_ADD_BG: Rgb = Rgb::hex(0x173124);
pub const DIFF_DEL: Rgb = Rgb::hex(0xf2b8b5);
pub const DIFF_DEL_BG: Rgb = Rgb::hex(0x3a1f1f);

/// What the window paints behind everything.
///
/// The TUI lets the terminal's own paint show through, and a covey user runs a
/// dark terminal because the text tiers assume one. This app has no terminal to
/// fall through to, so it names the colour the tiers were chosen against.
pub const BACKGROUND: Rgb = Rgb::hex(0x000000);

/// Every background a sidebar row is painted on. A row's marks have to be
/// legible on both, and the cursor row is the harder of the two.
pub const SIDEBAR_ROW_SURFACES: &[Rgb] = &[BACKGROUND, SELECTION];

/// The mark for a connection state: one glyph for every pane that paints a
/// machine, so a connecting machine reads the same everywhere.
pub fn conn_dot(conn: &str) -> &'static str {
    match conn {
        "connected" => "●",
        "connecting" => "◌",
        "offline" => "✗",
        _ => "○",
    }
}

/// The colour of a machine's mark, by connection state.
///
/// `offline` is deliberately not dim. A machine the client has given up on is
/// the one a reader most needs to find, so it takes a neutral grey that clears
/// the contrast bar on both surfaces: grey because giving up is not an error,
/// legible because it is the state that asks for an answer (issue #70).
pub fn conn_color(conn: &str) -> Rgb {
    match conn {
        "connected" => SUCCESS,
        "connecting" => WARNING,
        "offline" => MUTED,
        _ => DANGER,
    }
}

pub fn status_color(status: &str, pulse: bool) -> Rgb {
    match status {
        "running" | "starting" => {
            if pulse {
                INFO
            } else {
                WORKING
            }
        }
        "waiting" => {
            if pulse {
                WARNING
            } else {
                AWAITING
            }
        }
        "error" => DANGER,
        "interrupted" => SUBTLE,
        _ => FAINT,
    }
}

/// The mark on a thread a program started (#49). Geometric Shapes, the same
/// block the rest of the sidebar's marks come from.
pub const AGENT_MARK: &str = "◇";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luminance_matches_the_typescript() {
        // The three numbers `theme.test.ts` pins. Black is 0, white is 1, and
        // the diff panel's added-line green is the lightest surface covey
        // paints — 0.025, which is what sets the floor for the selection.
        assert!((Rgb::hex(0x000000).luminance() - 0.0).abs() < 1e-6);
        assert!((Rgb::hex(0xffffff).luminance() - 1.0).abs() < 1e-6);
        assert!((DIFF_ADD_BG.luminance() - 0.025).abs() < 0.005);
    }

    #[test]
    fn every_mark_a_sidebar_row_paints_is_legible_on_both_surfaces() {
        // The bug this pins is issue #70: `offline` was `FAINT`, which measures
        // 1.49:1 on the cursor row and cannot be read. A mark that asks for an
        // answer has to clear 3:1 on the terminal's paint *and* on the tint.
        for conn in ["connected", "connecting", "offline", "disconnected"] {
            for &bg in SIDEBAR_ROW_SURFACES {
                let c = contrast_ratio(conn_color(conn), bg);
                assert!(c >= 3.0, "{conn} on {bg:?} is {c:.2}:1");
            }
        }
    }

    #[test]
    fn selected_text_clears_the_bar_against_its_own_background() {
        assert!(contrast_ratio(SELECTION_TEXT, SELECTION_BG) >= 4.5);
    }

    #[test]
    fn the_text_tiers_are_readable_on_the_window_background() {
        // The window paints its own black, so there is no terminal to fall
        // through to and no terminal to blame. The two tiers that carry words
        // clear the 4.5:1 that body text asks for; `SUBTLE` carries meta — a
        // count, a relative time — and clears the 3:1 bar a mark needs.
        for tier in [TEXT, MUTED] {
            assert!(contrast_ratio(tier, BACKGROUND) >= 4.5, "{tier:?}");
        }
        assert!(contrast_ratio(SUBTLE, BACKGROUND) >= 3.0);
        // `FAINT` is under 3:1 and is not a tier for words. It marks a rule and
        // a hint the reader is not meant to read first, exactly as in the TUI.
        assert!(contrast_ratio(FAINT, BACKGROUND) < 3.0);
    }
}
