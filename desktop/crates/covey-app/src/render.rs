//! The same grid, rasterised to a picture, with no window.
//!
//! The app paints a [`Grid`] with egui. This paints the very same grid with a
//! font rasteriser and writes a PNG. That is only possible because the grid is
//! the thing the layout produces, and egui is only ever a way of showing one —
//! the separation the whole client is built on, checked by using it.
//!
//! It earns its place twice. A build server and an agent working on this code
//! have no display, so `covey-desktop --render frame.png` is how a change to
//! the layout is seen at all. And a test can assert on the pixels of a picture
//! rather than only on the cells behind it.
//!
//! It is not a screenshot of the app. The glyphs come from the same font and
//! the colours from the same palette, but egui does the subpixel placement its
//! own way. Do not use this to judge a kerning question; use it to judge a
//! layout.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use covey_grid::{theme, CellText, Grid, MediaKind, Rgb};
use image::{Rgba, RgbaImage};
use std::collections::HashMap;

use crate::transcript::{CellAspect, MediaSizes};

/// The size the headless render draws at, in pixels. Bigger than the window's
/// points, so a picture of a frame is legible when it is scaled down in a pull
/// request.
const PX: f32 = 18.0;

pub struct Raster {
    font: FontRef<'static>,
    pub cell_w: f32,
    pub cell_h: f32,
    ascent: f32,
}

impl Raster {
    pub fn new(font_bytes: &'static [u8]) -> anyhow::Result<Raster> {
        let font = FontRef::try_from_slice(font_bytes)
            .map_err(|e| anyhow::anyhow!("that font did not parse: {e}"))?;
        let scaled = font.as_scaled(PxScale::from(PX));
        let cell_w = scaled.h_advance(font.glyph_id('M'));
        let cell_h = (scaled.ascent() - scaled.descent() + scaled.line_gap()).ceil();
        let ascent = scaled.ascent();
        Ok(Raster {
            font,
            cell_w,
            cell_h,
            ascent,
        })
    }

    pub fn aspect(&self) -> CellAspect {
        CellAspect(self.cell_h / self.cell_w)
    }

    /// Draw a grid. `pictures` supplies the bytes for a media placement; a key
    /// it does not answer is drawn as the outline the app draws while the file
    /// is still coming.
    pub fn draw(&self, g: &Grid, pictures: &HashMap<String, RgbaImage>) -> RgbaImage {
        let w = (g.cols() as f32 * self.cell_w).ceil() as u32;
        let h = (g.rows() as f32 * self.cell_h).ceil() as u32;
        let mut img = RgbaImage::from_pixel(w.max(1), h.max(1), rgba(theme::BACKGROUND));

        for row in 0..g.rows() {
            for col in 0..g.cols() {
                let Some(cell) = g.cell(row, col) else {
                    continue;
                };
                if let Some(bg) = cell.style.bg {
                    self.fill_cell(&mut img, row, col, bg);
                }
            }
        }
        for row in 0..g.rows() {
            for col in 0..g.cols() {
                let Some(cell) = g.cell(row, col) else {
                    continue;
                };
                let s = match cell.text {
                    CellText::Ch(c) => c.to_string(),
                    CellText::Long(_) => g.long_at(row, col).unwrap_or("").to_string(),
                    _ => continue,
                };
                for ch in s.chars() {
                    self.glyph(&mut img, row, col, ch, cell.style.fg);
                }
            }
        }
        for p in g.media() {
            self.media(&mut img, p, pictures);
        }
        img
    }

    fn fill_cell(&self, img: &mut RgbaImage, row: usize, col: usize, bg: Rgb) {
        let x0 = (col as f32 * self.cell_w) as u32;
        let y0 = (row as f32 * self.cell_h) as u32;
        let x1 = (((col + 1) as f32 * self.cell_w) as u32).min(img.width());
        let y1 = (((row + 1) as f32 * self.cell_h) as u32).min(img.height());
        for y in y0..y1 {
            for x in x0..x1 {
                img.put_pixel(x, y, rgba(bg));
            }
        }
    }

    fn glyph(&self, img: &mut RgbaImage, row: usize, col: usize, ch: char, fg: Rgb) {
        let scaled = self.font.as_scaled(PxScale::from(PX));
        let glyph = self.font.glyph_id(ch).with_scale_and_position(
            PxScale::from(PX),
            ab_glyph::point(
                col as f32 * self.cell_w,
                row as f32 * self.cell_h + self.ascent,
            ),
        );
        let _ = scaled;
        let Some(outlined) = self.font.outline_glyph(glyph) else {
            return;
        };
        let bounds = outlined.px_bounds();
        outlined.draw(|gx, gy, coverage| {
            let x = bounds.min.x as i32 + gx as i32;
            let y = bounds.min.y as i32 + gy as i32;
            if x < 0 || y < 0 || x >= img.width() as i32 || y >= img.height() as i32 {
                return;
            }
            let dst = img.get_pixel(x as u32, y as u32).0;
            let a = coverage.clamp(0.0, 1.0);
            let blend = |s: u8, d: u8| (s as f32 * a + d as f32 * (1.0 - a)).round() as u8;
            img.put_pixel(
                x as u32,
                y as u32,
                Rgba([
                    blend(fg.0, dst[0]),
                    blend(fg.1, dst[1]),
                    blend(fg.2, dst[2]),
                    255,
                ]),
            );
        });
    }

    fn media(
        &self,
        img: &mut RgbaImage,
        p: &covey_grid::Media,
        pictures: &HashMap<String, RgbaImage>,
    ) {
        let x0 = (p.col as f32 * self.cell_w) as i64;
        let y0 = ((p.row as f32 - p.skip_rows as f32) * self.cell_h) as i64;
        let w = (p.cols as f32 * self.cell_w) as i64;
        let h = (p.total_rows as f32 * self.cell_h) as i64;
        // The cells the placement owns, which is where anything may be drawn.
        let clip_y0 = (p.row as f32 * self.cell_h) as i64;
        let clip_y1 = ((p.row + p.rows) as f32 * self.cell_h) as i64;

        match pictures.get(&p.key) {
            Some(src) if w > 0 && h > 0 => {
                for y in clip_y0.max(0)..clip_y1.min(img.height() as i64) {
                    for x in x0.max(0)..(x0 + w).min(img.width() as i64) {
                        // Nearest neighbour is enough here: this is a picture of
                        // a layout, not the layout's own paint.
                        let u = ((x - x0) as f32 / w as f32 * src.width() as f32) as u32;
                        let v = ((y - y0) as f32 / h as f32 * src.height() as f32) as u32;
                        let px = src.get_pixel(u.min(src.width() - 1), v.min(src.height() - 1));
                        img.put_pixel(x as u32, y as u32, *px);
                    }
                }
                if p.kind == MediaKind::Video {
                    self.glyph(
                        img,
                        p.row + p.rows.saturating_sub(1),
                        p.col + 1,
                        '▶',
                        theme::TEXT,
                    );
                }
            }
            _ => {
                let colour = rgba(theme::BORDER);
                for x in x0.max(0)..(x0 + w).min(img.width() as i64) {
                    for y in [clip_y0.max(0), (clip_y1 - 1).min(img.height() as i64 - 1)] {
                        if y >= 0 {
                            img.put_pixel(x as u32, y as u32, colour);
                        }
                    }
                }
                for (i, ch) in p.caption.chars().take(p.cols.saturating_sub(2)).enumerate() {
                    self.glyph(img, p.row + p.rows / 2, p.col + 1 + i, ch, theme::SUBTLE);
                }
            }
        }
    }
}

fn rgba(c: Rgb) -> Rgba<u8> {
    Rgba([c.0, c.1, c.2, 255])
}

/// The sizes a demo render knows, from the pictures it was handed.
#[derive(Default)]
struct Known {
    sizes: HashMap<String, (usize, usize)>,
    failed: HashMap<String, String>,
}

impl MediaSizes for Known {
    fn aspect(&self, key: &str) -> Option<f32> {
        let (w, h) = self.sizes.get(key)?;
        (*h > 0).then(|| *w as f32 / *h as f32)
    }
    fn failed(&self, key: &str) -> Option<String> {
        self.failed.get(key).cloned()
    }
}

/// Write one frame of a made-up fleet to a file.
///
/// Made up on purpose: it runs with no daemon, no network and no display, so a
/// build server can check that the layout still produces a picture, and a
/// person can look at one.
pub fn demo_to_file(path: &std::path::Path) -> anyhow::Result<()> {
    let (_, bytes) = crate::paint::system_mono()
        .ok_or_else(|| anyhow::anyhow!("no monospace font on this machine to draw with"))?;
    // `FontRef` borrows for `'static`, and the bytes live as long as the
    // process does.
    let bytes: &'static [u8] = Box::leak(bytes.into_boxed_slice());
    let raster = Raster::new(bytes)?;

    let store = demo_store();
    let shot = demo_picture(960, 540);
    let clip = demo_frame(640, 360);
    let mut known = Known::default();
    let mut pictures = HashMap::new();
    for (key, picture) in [(SHOT, shot), (CLIP, clip)] {
        known.sizes.insert(
            key.to_string(),
            (picture.width() as usize, picture.height() as usize),
        );
        pictures.insert(key.to_string(), picture);
    }
    known.failed.insert(
        GONE.to_string(),
        "the thread no longer holds that file".into(),
    );

    let screen = crate::ui::build(&store, 120, 40, raster.aspect(), &known);
    let img = raster.draw(&screen.grid, &pictures);
    img.save(path)?;
    println!(
        "wrote {} ({}×{})",
        path.display(),
        img.width(),
        img.height()
    );
    Ok(())
}

/// The three files the demo frame shows: one that arrived, one that plays, and
/// one that did not come.
const SHOT: &str = "/w/.covey/threads/t1/files/before.png";
const CLIP: &str = "/w/.covey/threads/t1/files/scroll.mp4";
const GONE: &str = "/w/.covey/threads/t1/files/gone.png";

/// A fleet that is not there, so the layout can be seen without one.
fn demo_store() -> crate::state::Store {
    use crate::state::{Machine, Open};
    use covey_client::ConnState;
    use covey_protocol as proto;

    let mut m = Machine {
        saved: proto::SavedMachine {
            name: "local".into(),
            url: "ws://127.0.0.1:3790".into(),
            token: None,
            machine_id: None,
        },
        handle: covey_client::MachineHandle::detached("local"),
        conn: ConnState::Connected,
        error: None,
        info: serde_json::from_value(serde_json::json!({
            "machineId": "m1", "name": "workshop", "os": "linux",
            "protocolVersion": 1, "settings": {}
        }))
        .ok(),
        projects: Default::default(),
        threads: Default::default(),
    };
    let p: proto::Project = serde_json::from_value(serde_json::json!({
        "id": "p1", "title": "covey", "workspaceRoot": "/w",
        "repositoryIdentity": "github.com/dylandotfarm/covey", "updatedAt": "2026-09-23T10:00:00Z",
    }))
    .unwrap();
    m.projects.insert("p1".into(), p);
    for (id, title, status, at) in [
        (
            "t1",
            "A second client, in a window",
            "running",
            "2026-09-23T12:00:00Z",
        ),
        (
            "t2",
            "Lay a markdown table out as a table",
            "idle",
            "2026-09-23T11:00:00Z",
        ),
        (
            "t3",
            "Name cmd+click as the gesture",
            "waiting",
            "2026-09-23T10:30:00Z",
        ),
    ] {
        let t: proto::Thread = serde_json::from_value(serde_json::json!({
            "id": id, "projectId": "p1", "title": title, "status": status,
            "permissionMode": "default", "pendingApprovals": 0, "queuedTurns": 0,
            "lastMessageAt": at, "updatedAt": at,
        }))
        .unwrap();
        m.threads.insert(id.into(), t);
    }
    let mut store = crate::state::Store::new(vec![m]);
    store.cursor_key = "t:0:t1".into();

    let items: Vec<proto::TimelineItem> = vec![
        serde_json::from_value(serde_json::json!({
            "id": "i1", "threadId": "t1", "seq": 1, "kind": "user",
            "text": "The sidebar collides with its own hint under 94 columns. Here is what it looks like now.",
            "attachments": [{ "name": "before.png", "path": SHOT, "mimeType": "image/png" }],
        }))
        .unwrap(),
        serde_json::from_value(serde_json::json!({
            "id": "i2", "threadId": "t1", "seq": 2, "kind": "assistant",
            "text": "I see it: the hint and the count are both laid out from the right edge, so they overlap once the rail is narrow enough.",
            "streaming": false,
        }))
        .unwrap(),
        serde_json::from_value(serde_json::json!({
            "id": "i3", "threadId": "t1", "seq": 3, "kind": "tool",
            "toolName": "Read", "summary": "Read packages/tui/src/components/Sidebar.tsx",
            "status": "completed", "isError": false,
        }))
        .unwrap(),
        serde_json::from_value(serde_json::json!({
            "id": "i4", "threadId": "t1", "seq": 4, "kind": "assistant",
            "text": "Neither reserves room for the other. I gave the hint the width that is left after the count. Here it is at 80 columns:",
            "streaming": false,
        }))
        .unwrap(),
        serde_json::from_value(serde_json::json!({
            "id": "i5", "threadId": "t1", "seq": 5, "kind": "user",
            "text": "The recording of the fix, and the screenshot I meant to keep.",
            "attachments": [
                { "name": "scroll.mp4", "path": CLIP, "mimeType": "video/mp4" },
                { "name": "gone.png", "path": GONE, "mimeType": "image/png" },
            ],
        }))
        .unwrap(),
        serde_json::from_value(serde_json::json!({
            "id": "i6", "threadId": "t1", "seq": 6, "kind": "assistant",
            "text": "That is the hint holding its width.",
            "streaming": true,
        }))
        .unwrap(),
    ];
    store.open = Some(Open {
        machine: 0,
        thread_id: "t1".into(),
        thread: store.machines[0].threads.get("t1").cloned(),
        items,
        scroll_from_bottom: 0,
        draft: "and add a test at 80 columns".into(),
    });
    store
}

/// One frame of a screen recording, as a still. Stands in for the poster frame
/// `ffmpeg` hands back before anybody presses play.
fn demo_frame(w: u32, h: u32) -> RgbaImage {
    let mut img = RgbaImage::from_pixel(w, h, Rgba([16, 16, 16, 255]));
    for y in 0..h {
        for x in 0..w {
            let bar = (y as i32 - (h as i32 / 2)).abs() < 3;
            let px = if bar {
                Rgba([124, 135, 255, 255])
            } else if (x / 40 + y / 40) % 2 == 0 {
                Rgba([30, 30, 30, 255])
            } else {
                Rgba([22, 22, 22, 255])
            };
            img.put_pixel(x, y, px);
        }
    }
    img
}

/// A picture that stands in for a screenshot: the kind of thing a person drops
/// into a thread, in the colours covey paints.
fn demo_picture(w: u32, h: u32) -> RgbaImage {
    let mut img = RgbaImage::from_pixel(w, h, Rgba([27, 27, 27, 255]));
    for y in 0..h {
        for x in 0..w {
            let on_rule = x == w / 4;
            let band = (y / 28) % 2 == 0;
            let px = if on_rule {
                Rgba([124, 135, 255, 255])
            } else if x < w / 4 {
                if band {
                    Rgba([36, 36, 36, 255])
                } else {
                    Rgba([27, 27, 27, 255])
                }
            } else if (x + y) % 140 < 90 && y % 28 < 12 {
                Rgba([163, 163, 163, 255])
            } else {
                Rgba([16, 16, 16, 255])
            };
            img.put_pixel(x, y, px);
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;
    use covey_grid::Style;

    fn raster() -> Option<Raster> {
        let (_, bytes) = crate::paint::system_mono()?;
        let bytes: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        Raster::new(bytes).ok()
    }

    #[test]
    fn a_grid_rasterises_to_a_picture_of_the_size_its_cells_ask_for() {
        let Some(r) = raster() else { return };
        let mut g = Grid::new(20, 4);
        g.put(0, 0, "hello", Style::fg(theme::TEXT));
        let img = r.draw(&g, &HashMap::new());
        assert_eq!(img.width(), (20.0 * r.cell_w).ceil() as u32);
        assert_eq!(img.height(), (4.0 * r.cell_h).ceil() as u32);
    }

    #[test]
    fn a_picture_is_drawn_over_the_cells_its_placement_owns() {
        // The claim under test is the one the client rests on: the rectangle a
        // placement names really does become picture, and the cells under it
        // really are not painted.
        let Some(r) = raster() else { return };
        let mut g = Grid::new(20, 8);
        g.put(4, 2, "XXXXXXXX", Style::fg(theme::TEXT));
        g.place_media(covey_grid::Media {
            row: 4,
            col: 2,
            rows: 3,
            cols: 8,
            skip_rows: 0,
            total_rows: 3,
            kind: MediaKind::Image,
            key: "k".into(),
            caption: "k".into(),
        });
        let mut pictures = HashMap::new();
        pictures.insert(
            "k".to_string(),
            RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255])),
        );
        let img = r.draw(&g, &pictures);
        let x = (2.5 * r.cell_w) as u32;
        let y = (4.5 * r.cell_h) as u32;
        assert_eq!(img.get_pixel(x, y), &Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn the_demo_frame_draws_without_a_display_or_a_daemon() {
        let Some(r) = raster() else { return };
        let store = demo_store();
        let screen = crate::ui::build(&store, 120, 34, r.aspect(), &Known::default());
        let img = r.draw(&screen.grid, &HashMap::new());
        assert!(img.width() > 100 && img.height() > 100);
    }
}
