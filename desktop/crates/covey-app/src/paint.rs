//! The grid, painted into a window.
//!
//! This is the only file in the client that knows egui exists. Everything above
//! it builds a [`Grid`]; this turns one into rectangles and glyphs, and turns a
//! pointer position back into a row and a column.
//!
//! A paint is the dearest act a covey client performs, so two things here are
//! deliberate. Runs of cells that share a style are drawn as one string rather
//! than one per cell, because four thousand galleys a frame is four thousand
//! galleys a frame. And the window is asked to repaint only when something
//! changed — a daemon said something, the reader pressed a key, a video is
//! playing — never on a timer. An idle covey client must cost nothing.

use covey_grid::{theme, CellText, Grid, MediaKind, Rgb, Style};

use crate::media::MediaCache;

/// The size the grid is drawn at, in points.
pub const FONT_POINTS: f32 = 14.0;

/// Monospace fonts to look for, in order, before falling back to the one egui
/// bundles.
///
/// A covey sidebar paints `▾ ▸ ● ○ ◌ ✗ ◇ ❯ │ ─ ▌ ▣`, and a font without those
/// draws a box instead of a mark. These are the families that carry them and
/// that a desk running covey is likely to have; `glyphs_present` is the test
/// that says whether the one we found does.
const FONT_CANDIDATES: &[&str] = &[
    // macOS
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    // Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
    // Windows
    "C:\\Windows\\Fonts\\consola.ttf",
    "C:\\Windows\\Fonts\\CascadiaMono.ttf",
];

/// Every glyph the client paints that is not plain text.
///
/// Named here so one test can ask whether the font in use has them all. A mark
/// that draws as a box is worse than no mark: it says "something is wrong with
/// covey" rather than "this machine is offline".
pub const MARKS: &[char] = &[
    '▾', '▸', '●', '○', '◌', '✗', '◇', '❯', '│', '─', '▌', '▣', '·', '…',
];

/// Load a monospace font from the machine, if one of the usual ones is there
/// *and* it can draw every mark the client paints.
///
/// A font that is missing one is skipped rather than used, because a box in the
/// sidebar says "something is wrong with covey" when what it means is "this
/// machine is offline". Falling through to egui's own font is the better of two
/// imperfect answers.
pub fn system_mono() -> Option<(String, Vec<u8>)> {
    let mut first_incomplete: Option<(String, Vec<u8>)> = None;
    for path in FONT_CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        match glyphs_present(&bytes, MARKS) {
            Ok(missing) if missing.is_empty() => return Some((path.to_string(), bytes)),
            Ok(_) if first_incomplete.is_none() => {
                first_incomplete = Some((path.to_string(), bytes))
            }
            _ => {}
        }
    }
    // Every font on this machine is missing something. The most complete answer
    // is still a monospace font, which is what the grid needs above all.
    first_incomplete
}

/// Put the monospace font in front of egui's own, for both families.
///
/// Both, because this client has no proportional text: every pane is the grid.
pub fn install_fonts(ctx: &egui::Context) {
    let Some((name, bytes)) = system_mono() else {
        return;
    };
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "covey-mono".into(),
        std::sync::Arc::new(egui::FontData::from_owned(bytes)),
    );
    for family in [egui::FontFamily::Monospace, egui::FontFamily::Proportional] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "covey-mono".into());
    }
    let _ = name;
    ctx.set_fonts(fonts);
}

/// How big one cell is, in points.
#[derive(Debug, Clone, Copy)]
pub struct Metrics {
    pub cell_w: f32,
    pub cell_h: f32,
}

impl Metrics {
    pub fn read(ctx: &egui::Context) -> Metrics {
        let font = egui::FontId::monospace(FONT_POINTS);
        let (w, h) = ctx.fonts(|f| (f.glyph_width(&font, 'M'), f.row_height(&font)));
        Metrics {
            // A zero would make the grid infinitely wide. It only happens
            // before the first frame has laid a glyph out.
            cell_w: if w > 0.1 { w } else { FONT_POINTS * 0.6 },
            cell_h: if h > 0.1 { h } else { FONT_POINTS * 1.3 },
        }
    }

    /// How many whole cells fit in a rectangle.
    pub fn cells_in(&self, size: egui::Vec2) -> (usize, usize) {
        (
            (size.x / self.cell_w).floor().max(1.0) as usize,
            (size.y / self.cell_h).floor().max(1.0) as usize,
        )
    }

    /// The cell under a point, or none when the point is outside the grid.
    pub fn cell_at(
        &self,
        origin: egui::Pos2,
        point: egui::Pos2,
        cols: usize,
        rows: usize,
    ) -> Option<(usize, usize)> {
        let x = point.x - origin.x;
        let y = point.y - origin.y;
        if x < 0.0 || y < 0.0 {
            return None;
        }
        let col = (x / self.cell_w) as usize;
        let row = (y / self.cell_h) as usize;
        (col < cols && row < rows).then_some((row, col))
    }
}

fn color(c: Rgb) -> egui::Color32 {
    egui::Color32::from_rgb(c.0, c.1, c.2)
}

/// Draw the whole grid at `origin`.
pub fn draw(painter: &egui::Painter, origin: egui::Pos2, g: &Grid, m: Metrics, media: &MediaCache) {
    let font = egui::FontId::monospace(FONT_POINTS);
    let bold = egui::FontId::monospace(FONT_POINTS);

    // Backgrounds first, as runs: a selected sidebar row is one rectangle and
    // not thirty-one.
    for row in 0..g.rows() {
        let mut run: Option<(usize, Rgb)> = None;
        for col in 0..=g.cols() {
            let here = (col < g.cols())
                .then(|| g.cell(row, col).and_then(|c| c.style.bg))
                .flatten();
            match (&run, here) {
                (Some((start, bg)), Some(h)) if *bg == h => {}
                (Some((start, bg)), _) => {
                    fill(painter, origin, m, row, *start, col - *start, *bg);
                    run = here.map(|h| (col, h));
                }
                (None, Some(h)) => run = Some((col, h)),
                (None, None) => {}
            }
        }
    }

    // Then the glyphs, batching a run of plain single-width cells that share a
    // style into one string.
    for row in 0..g.rows() {
        let mut buf = String::new();
        let mut run_start = 0usize;
        let mut run_style: Option<Style> = None;
        let flush =
            |painter: &egui::Painter, buf: &mut String, start: usize, style: Option<Style>| {
                if buf.is_empty() {
                    return;
                }
                if let Some(st) = style {
                    text(painter, origin, m, row, start, buf, st, &font, &bold);
                }
                buf.clear();
            };
        for col in 0..g.cols() {
            let Some(cell) = g.cell(row, col) else {
                continue;
            };
            match cell.text {
                CellText::Blank | CellText::Continuation => {
                    flush(painter, &mut buf, run_start, run_style);
                    run_style = None;
                }
                CellText::Ch(c) if c.is_ascii_graphic() => {
                    if run_style != Some(cell.style) {
                        flush(painter, &mut buf, run_start, run_style);
                        run_start = col;
                        run_style = Some(cell.style);
                    }
                    if buf.is_empty() {
                        run_start = col;
                    }
                    buf.push(c);
                }
                // A mark, a wide glyph or a cluster. Placed on its own cell, so
                // a font whose advance is not exactly one cell cannot push the
                // rest of the row sideways.
                other => {
                    flush(painter, &mut buf, run_start, run_style);
                    run_style = None;
                    let s = match other {
                        CellText::Ch(c) => c.to_string(),
                        CellText::Long(_) => g.long_at(row, col).unwrap_or_default().to_string(),
                        _ => String::new(),
                    };
                    if !s.is_empty() {
                        text(painter, origin, m, row, col, &s, cell.style, &font, &bold);
                    }
                }
            }
        }
        flush(painter, &mut buf, run_start, run_style);
    }

    for placement in g.media() {
        draw_media(painter, origin, m, placement, media);
    }
}

fn fill(
    painter: &egui::Painter,
    origin: egui::Pos2,
    m: Metrics,
    row: usize,
    col: usize,
    cols: usize,
    bg: Rgb,
) {
    let rect = egui::Rect::from_min_size(
        egui::pos2(
            origin.x + col as f32 * m.cell_w,
            origin.y + row as f32 * m.cell_h,
        ),
        egui::vec2(cols as f32 * m.cell_w, m.cell_h),
    );
    painter.rect_filled(rect, 0.0, color(bg));
}

#[allow(clippy::too_many_arguments)]
fn text(
    painter: &egui::Painter,
    origin: egui::Pos2,
    m: Metrics,
    row: usize,
    col: usize,
    s: &str,
    style: Style,
    font: &egui::FontId,
    bold: &egui::FontId,
) {
    let pos = egui::pos2(
        origin.x + col as f32 * m.cell_w,
        origin.y + row as f32 * m.cell_h,
    );
    let id = if style.bold {
        bold.clone()
    } else {
        font.clone()
    };
    painter.text(pos, egui::Align2::LEFT_TOP, s, id, color(style.fg));
}

fn draw_media(
    painter: &egui::Painter,
    origin: egui::Pos2,
    m: Metrics,
    p: &covey_grid::Media,
    media: &MediaCache,
) {
    // The visible cells, which is what the placement owns.
    let visible = egui::Rect::from_min_size(
        egui::pos2(
            origin.x + p.col as f32 * m.cell_w,
            origin.y + p.row as f32 * m.cell_h,
        ),
        egui::vec2(p.cols as f32 * m.cell_w, p.rows as f32 * m.cell_h),
    );
    // The whole picture, which may start above the pane. Clipping the one to
    // the other is what makes a picture slide into view a line at a time
    // instead of appearing whole.
    let whole = egui::Rect::from_min_size(
        egui::pos2(visible.min.x, visible.min.y - p.skip_rows as f32 * m.cell_h),
        egui::vec2(p.cols as f32 * m.cell_w, p.total_rows as f32 * m.cell_h),
    );
    let painter = painter.with_clip_rect(visible.intersect(painter.clip_rect()));

    match media.texture(&p.key) {
        Some(tex) => {
            painter.image(
                tex.id(),
                whole,
                egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                egui::Color32::WHITE,
            );
            if p.kind == MediaKind::Video {
                let playing = media.is_playing(&p.key);
                let badge = egui::Rect::from_min_size(
                    egui::pos2(whole.min.x + 4.0, whole.max.y - m.cell_h - 4.0),
                    egui::vec2(m.cell_w * 3.0, m.cell_h),
                );
                painter.rect_filled(badge, 2.0, egui::Color32::from_black_alpha(160));
                painter.text(
                    badge.left_top(),
                    egui::Align2::LEFT_TOP,
                    if playing { " ❙❙" } else { " ▶" },
                    egui::FontId::monospace(FONT_POINTS),
                    color(theme::TEXT),
                );
            }
        }
        None => {
            // Still coming. A rule and the file's name, so the space the
            // picture will take is already the right shape and the transcript
            // does not jump when it lands.
            painter.rect_stroke(
                whole,
                2.0,
                egui::Stroke::new(1.0_f32, color(theme::BORDER)),
                egui::StrokeKind::Inside,
            );
            painter.text(
                whole.min + egui::vec2(m.cell_w, m.cell_h * 0.5),
                egui::Align2::LEFT_TOP,
                &p.caption,
                egui::FontId::monospace(FONT_POINTS),
                color(theme::SUBTLE),
            );
        }
    }
}

/// The marks of `marks` that `font` has no shape for. Empty is the good answer.
pub fn glyphs_present(font_bytes: &[u8], marks: &[char]) -> Result<Vec<char>, String> {
    use ab_glyph::{Font, FontRef};
    let font = FontRef::try_from_slice(font_bytes).map_err(|e| e.to_string())?;
    Ok(marks
        .iter()
        .copied()
        .filter(|c| font.glyph_id(*c).0 == 0)
        .collect())
}

/// Which cell of `g` a point is over, and what is there.
pub fn cell_under(
    g: &Grid,
    m: Metrics,
    origin: egui::Pos2,
    at: egui::Pos2,
) -> Option<(usize, usize)> {
    m.cell_at(origin, at, g.cols(), g.rows())
}

/// The placement a point is over, if any. This is what makes a click on a video
/// a click on that video.
pub fn media_under(g: &Grid, row: usize, col: usize) -> Option<&covey_grid::Media> {
    g.media()
        .iter()
        .find(|p| row >= p.row && row < p.row + p.rows && col >= p.col && col < p.col + p.cols)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_maps_to_the_cell_under_it() {
        let m = Metrics {
            cell_w: 8.0,
            cell_h: 16.0,
        };
        let origin = egui::pos2(10.0, 20.0);
        assert_eq!(
            m.cell_at(origin, egui::pos2(10.0, 20.0), 10, 10),
            Some((0, 0))
        );
        assert_eq!(
            m.cell_at(origin, egui::pos2(27.0, 53.0), 10, 10),
            Some((2, 2))
        );
        // Outside the grid on either side is nothing, not the nearest cell: a
        // click above the first row must not select the first row.
        assert_eq!(m.cell_at(origin, egui::pos2(9.0, 20.0), 10, 10), None);
        assert_eq!(m.cell_at(origin, egui::pos2(10.0, 19.0), 10, 10), None);
        assert_eq!(m.cell_at(origin, egui::pos2(999.0, 20.0), 10, 10), None);
    }

    #[test]
    fn the_grid_is_as_many_whole_cells_as_fit() {
        let m = Metrics {
            cell_w: 8.0,
            cell_h: 16.0,
        };
        assert_eq!(m.cells_in(egui::vec2(83.0, 100.0)), (10, 6));
        // A window too small for one cell still has one, or the grid would
        // have no rows and every index would be out of range.
        assert_eq!(m.cells_in(egui::vec2(1.0, 1.0)), (1, 1));
    }

    #[test]
    fn a_click_finds_the_video_it_landed_on() {
        let mut g = Grid::new(40, 20);
        g.place_media(covey_grid::Media {
            row: 4,
            col: 2,
            rows: 6,
            cols: 20,
            skip_rows: 0,
            total_rows: 6,
            kind: MediaKind::Video,
            key: "/f/clip.mp4".into(),
            caption: "clip.mp4".into(),
        });
        assert_eq!(
            media_under(&g, 5, 3).map(|p| p.key.as_str()),
            Some("/f/clip.mp4")
        );
        assert!(media_under(&g, 3, 3).is_none());
        assert!(media_under(&g, 5, 30).is_none());
    }

    #[test]
    fn the_font_this_machine_offers_has_every_mark_the_client_paints() {
        // A mark that draws as a box says "something is wrong with covey"
        // rather than "this machine is offline". If this fails on a platform,
        // the answer is another candidate in `FONT_CANDIDATES` or a simpler
        // mark — not a box in the sidebar.
        let Some((path, bytes)) = system_mono() else {
            eprintln!("no system monospace font here; egui's own is in use");
            return;
        };
        let missing = glyphs_present(&bytes, MARKS).unwrap_or_default();
        assert!(missing.is_empty(), "{path} has no glyph for {missing:?}");
    }
}
