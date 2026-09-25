//! The transcript, laid out into lines.
//!
//! One function turns a thread's timeline into a list of lines, and a line is
//! either text or one row of a picture. Everything downstream — the scroll, the
//! window, the hit test — then works on lines and does not care which kind it
//! has. That is what lets a screenshot sit in a conversation without anything
//! else in the client learning what a screenshot is.
//!
//! Two rules come out of the TUI and hold here.
//!
//! - **The scroll is a count of lines from the bottom.** `0` means "follow the
//!   bottom". A streaming item is re-sent whole and longer, so the bottom moves
//!   under the reader; anything but a count from the bottom drags the screen
//!   away from them mid-reply (#114).
//! - **A picture is a run of lines, not a thing beside them.** So a picture at
//!   the edge of the pane is half a picture, and it slides rather than jumps.
//!   [`Placed::skip_rows`] is how.

use covey_grid::{self as grid, theme, MediaKind, Rgb, Style};
use covey_protocol as proto;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: Style,
}

impl Span {
    pub fn new(text: impl Into<String>, style: Style) -> Span {
        Span {
            text: text.into(),
            style,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Text {
        indent: usize,
        spans: Vec<Span>,
        /// A background across the whole width, which is how a user's own
        /// message is marked off from the agent's.
        bg: Option<Rgb>,
    },
    /// One row of the picture that block `block` holds.
    MediaRow { block: usize, row: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub key: String,
    pub kind: MediaKind,
    pub caption: String,
    pub col: usize,
    pub cols: usize,
    pub rows: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Layout {
    pub lines: Vec<Line>,
    pub blocks: Vec<Block>,
}

/// How tall a picture may be, as a share of the pane.
///
/// The same 40% the web client's style sheet caps an inline image at (#110). A
/// picture is there to be recognised, not to take the conversation's place, and
/// a tap opens it full size.
const MEDIA_MAX_PANE_SHARE: f32 = 0.4;

/// The narrowest picture worth drawing. Below this there is nothing to see and
/// the caption says more.
const MEDIA_MIN_COLS: usize = 8;

/// How many rows a picture takes before its real shape is known.
///
/// The grid is rebuilt every frame, so the moment the decoder answers, the
/// layout takes the true shape. This is only what the reader sees for the frame
/// or two in between.
const MEDIA_PENDING_ROWS: usize = 6;

/// What a cell's height is worth in units of its width.
///
/// A picture's shape is in pixels and a block's shape is in cells, so one of
/// the two has to know the other's aspect. The renderer owns the real number
/// (it knows the font), and hands it in.
#[derive(Debug, Clone, Copy)]
pub struct CellAspect(pub f32);

impl Default for CellAspect {
    fn default() -> Self {
        // A monospace cell is about twice as tall as it is wide.
        CellAspect(2.0)
    }
}

/// What the layout needs to know about a file it has not got.
pub trait MediaSizes {
    /// Width over height, once the picture has been decoded.
    fn aspect(&self, key: &str) -> Option<f32>;
    /// True once the client knows the file is not coming — no such file, no
    /// permission, or a decoder that refused it. The caption then says so.
    fn failed(&self, key: &str) -> Option<String>;
}

/// No media cache: every picture is still on its way. Layout tests use it, and
/// so does anything that wants a layout without fetching a byte.
#[allow(dead_code)]
pub struct NoMedia;

impl MediaSizes for NoMedia {
    fn aspect(&self, _key: &str) -> Option<f32> {
        None
    }
    fn failed(&self, _key: &str) -> Option<String> {
        None
    }
}

/// Lay a thread's timeline out at `cols` wide.
pub fn layout(
    items: &[proto::TimelineItem],
    cols: usize,
    pane_rows: usize,
    aspect: CellAspect,
    media: &dyn MediaSizes,
) -> Layout {
    let mut out = Layout::default();
    if cols == 0 {
        return out;
    }
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.lines.push(blank());
        }
        lay_item(&mut out, item, cols, pane_rows, aspect, media);
    }
    out
}

fn blank() -> Line {
    Line::Text {
        indent: 0,
        spans: Vec::new(),
        bg: None,
    }
}

fn text_lines(
    out: &mut Layout,
    text: &str,
    indent: usize,
    cols: usize,
    style: Style,
    bg: Option<Rgb>,
) {
    let width = cols.saturating_sub(indent).max(1);
    for l in grid::wrap(text, width) {
        out.lines.push(Line::Text {
            indent,
            spans: vec![Span::new(l, style)],
            bg,
        });
    }
}

fn lay_item(
    out: &mut Layout,
    item: &proto::TimelineItem,
    cols: usize,
    pane_rows: usize,
    aspect: CellAspect,
    media: &dyn MediaSizes,
) {
    match &item.body {
        proto::ItemBody::User {
            text,
            attachments,
            queued,
            folded,
            ..
        } => {
            let mut head = vec![Span::new("❯ ", Style::fg(theme::ACCENT).bold())];
            if *queued {
                head.push(Span::new("queued  ", Style::fg(theme::SUBTLE)));
            } else if *folded {
                head.push(Span::new("folded in  ", Style::fg(theme::SUBTLE)));
            }
            let first = grid::wrap(text, cols.saturating_sub(2).max(1));
            let mut rest = first.iter();
            if let Some(l) = rest.next() {
                head.push(Span::new(l.clone(), Style::fg(theme::TEXT)));
            }
            out.lines.push(Line::Text {
                indent: 0,
                spans: head,
                bg: Some(theme::USER_BG),
            });
            for l in rest {
                out.lines.push(Line::Text {
                    indent: 2,
                    spans: vec![Span::new(l.clone(), Style::fg(theme::TEXT))],
                    bg: Some(theme::USER_BG),
                });
            }
            for a in attachments {
                lay_attachment(out, a, cols, pane_rows, aspect, media);
            }
        }
        proto::ItemBody::Assistant {
            text, streaming, ..
        } => {
            text_lines(out, text, 0, cols, Style::fg(theme::TEXT), None);
            if *streaming {
                out.lines.push(Line::Text {
                    indent: 0,
                    spans: vec![Span::new("▌", Style::fg(theme::CLAUDE))],
                    bg: None,
                });
            }
        }
        proto::ItemBody::Thinking { text, .. } => {
            text_lines(out, text, 2, cols, Style::fg(theme::SUBTLE).italic(), None);
        }
        proto::ItemBody::Tool {
            summary,
            status,
            is_error,
            ..
        } => {
            let colour = if *is_error || status == "error" {
                theme::DANGER
            } else if status == "running" {
                theme::WORKING
            } else if status == "denied" {
                theme::WARNING
            } else {
                theme::SUBTLE
            };
            out.lines.push(Line::Text {
                indent: 0,
                spans: vec![
                    Span::new(">_ ", Style::fg(theme::FAINT)),
                    Span::new(
                        grid::truncate(summary, cols.saturating_sub(3)),
                        Style::fg(colour),
                    ),
                ],
                bg: None,
            });
        }
        proto::ItemBody::Approval {
            tool_name,
            summary,
            status,
            ..
        } => {
            let colour = match status.as_str() {
                "pending" => theme::AWAITING,
                "allowed" => theme::SUCCESS,
                "denied" => theme::DANGER,
                _ => theme::SUBTLE,
            };
            out.lines.push(Line::Text {
                indent: 0,
                spans: vec![
                    Span::new("? ", Style::fg(colour).bold()),
                    Span::new(
                        grid::truncate(&format!("{tool_name} — {summary}"), cols.saturating_sub(2)),
                        Style::fg(theme::TEXT),
                    ),
                ],
                bg: None,
            });
            if status == "pending" {
                out.lines.push(Line::Text {
                    indent: 2,
                    spans: vec![Span::new("waiting for a person", Style::fg(theme::SUBTLE))],
                    bg: None,
                });
            }
        }
        proto::ItemBody::Question {
            questions, answers, ..
        } => {
            for (i, q) in questions.iter().enumerate() {
                out.lines.push(Line::Text {
                    indent: 0,
                    spans: vec![
                        Span::new("? ", Style::fg(theme::AWAITING).bold()),
                        Span::new(
                            grid::truncate(&q.question, cols.saturating_sub(2)),
                            Style::fg(theme::TEXT),
                        ),
                    ],
                    bg: None,
                });
                match answers.get(i) {
                    Some(a) if !a.is_empty() => {
                        text_lines(out, a, 2, cols, Style::fg(theme::SUCCESS), None)
                    }
                    _ => {
                        for o in q.options.iter().flatten() {
                            out.lines.push(Line::Text {
                                indent: 2,
                                spans: vec![Span::new(
                                    grid::truncate(&o.label, cols.saturating_sub(2)),
                                    Style::fg(theme::MUTED),
                                )],
                                bg: None,
                            });
                        }
                    }
                }
            }
        }
        proto::ItemBody::Note { tone, text } => {
            let colour = if tone == "warning" {
                theme::WARNING
            } else {
                theme::SUBTLE
            };
            text_lines(out, text, 0, cols, Style::fg(colour).italic(), None);
        }
        proto::ItemBody::Error { text } => {
            text_lines(out, text, 0, cols, Style::fg(theme::DANGER), None);
        }
        proto::ItemBody::Unknown => {
            // A kind from a daemon newer than this client. Say so plainly and
            // keep its place; a transcript with a hole in it is worse.
            out.lines.push(Line::Text {
                indent: 0,
                spans: vec![Span::new(
                    "· an item this client is too old to show",
                    Style::fg(theme::FAINT).italic(),
                )],
                bg: None,
            });
        }
    }
}

fn lay_attachment(
    out: &mut Layout,
    a: &proto::Attachment,
    cols: usize,
    pane_rows: usize,
    aspect: CellAspect,
    media: &dyn MediaSizes,
) {
    let kind = if proto::is_image_mime(&a.mime_type) {
        MediaKind::Image
    } else if proto::is_video_mime(&a.mime_type) {
        MediaKind::Video
    } else {
        // Not something this client can show. The chip is the whole answer, and
        // it names the file so the reader can open it themselves.
        out.lines.push(Line::Text {
            indent: 2,
            spans: vec![
                Span::new("▣ ", Style::fg(theme::FAINT)),
                Span::new(
                    grid::truncate(&a.name, cols.saturating_sub(4)),
                    Style::fg(theme::MUTED),
                ),
            ],
            bg: None,
        });
        return;
    };

    // A file this client already tried and could not read. Say which of the
    // things went wrong, in the chip: one word for four problems is what made a
    // screenshot read as "unreadable" for weeks (#132).
    if let Some(why) = media.failed(&a.path) {
        out.lines.push(Line::Text {
            indent: 2,
            spans: vec![
                Span::new("▣ ", Style::fg(theme::DANGER)),
                Span::new(
                    grid::truncate(&format!("{} — {why}", a.name), cols.saturating_sub(4)),
                    Style::fg(theme::DANGER),
                ),
            ],
            bg: None,
        });
        return;
    }

    let col = 2usize;
    let avail_cols = cols.saturating_sub(col);
    if avail_cols < MEDIA_MIN_COLS {
        return;
    }
    let max_rows = ((pane_rows as f32 * MEDIA_MAX_PANE_SHARE) as usize).max(3);
    let (block_cols, block_rows) = match media.aspect(&a.path) {
        None => (avail_cols.min(40), MEDIA_PENDING_ROWS.min(max_rows)),
        Some(ar) => fit(ar, avail_cols, max_rows, aspect),
    };

    out.blocks.push(Block {
        key: a.path.clone(),
        kind,
        caption: a.name.clone(),
        col,
        cols: block_cols,
        rows: block_rows,
    });
    let block = out.blocks.len() - 1;
    for row in 0..block_rows {
        out.lines.push(Line::MediaRow { block, row });
    }
}

/// The largest block of cells with the picture's shape that fits the pane.
///
/// A cell is taller than it is wide, so a square picture is fewer rows than it
/// is columns. Getting that backwards is what makes a screenshot in a terminal
/// look stretched.
fn fit(picture_aspect: f32, max_cols: usize, max_rows: usize, cell: CellAspect) -> (usize, usize) {
    let ar = if picture_aspect.is_finite() && picture_aspect > 0.0 {
        picture_aspect
    } else {
        1.0
    };
    // rows = cols / (picture aspect) / (cell aspect)
    let by_width = (max_cols as f32 / ar / cell.0).round().max(1.0) as usize;
    if by_width <= max_rows {
        return (max_cols, by_width);
    }
    let cols = (max_rows as f32 * ar * cell.0).round().max(1.0) as usize;
    (cols.min(max_cols).max(1), max_rows)
}

/// Which lines the pane shows, given the scroll.
///
/// `from_bottom` counts lines up from the last one. The answer is the first
/// line index; a caller that asked to scroll past the top gets the top.
pub fn window_start(total: usize, height: usize, from_bottom: usize) -> usize {
    let max_start = total.saturating_sub(height);
    max_start.saturating_sub(from_bottom)
}

/// How far up the reader may scroll before there is nothing above.
pub fn max_scroll(total: usize, height: usize) -> usize {
    total.saturating_sub(height)
}

/// Write the visible lines of a layout into `g`, at `top`, `height` rows tall.
///
/// A picture whose first rows are above the pane is placed with `skip_rows`
/// set, so it slides rather than jumps.
pub fn paint(
    g: &mut grid::Grid,
    layout: &Layout,
    top: usize,
    left: usize,
    cols: usize,
    height: usize,
    from_bottom: usize,
) {
    let start = window_start(layout.lines.len(), height, from_bottom);
    // What of each block is on screen: the grid row its first visible row
    // lands on, how many of its rows are above the pane, and how many show.
    let mut seen: Vec<Option<(usize, usize, usize)>> = vec![None; layout.blocks.len()];

    for (i, line) in layout.lines.iter().enumerate().skip(start).take(height) {
        let row = top + (i - start);
        match line {
            Line::Text { indent, spans, bg } => {
                if let Some(bg) = bg {
                    g.fill_bg(row, left, cols, *bg);
                }
                let mut at = left + indent;
                for s in spans {
                    let style = match bg {
                        Some(b) => s.style.on(*b),
                        None => s.style,
                    };
                    at += g.put_clipped(row, at, &s.text, style, (left + cols).saturating_sub(at));
                }
            }
            Line::MediaRow { block, row: r } => match seen[*block].as_mut() {
                // The first visible row of a block opens it and remembers how
                // much of the picture is above the pane.
                None => seen[*block] = Some((row, *r, 1)),
                Some((_, _, rows)) => *rows += 1,
            },
        }
    }

    // The placements go on last, because a placement owns its cells: it blanks
    // whatever is under it, and nothing may be written there afterwards.
    for (b, hit) in layout.blocks.iter().zip(seen) {
        let Some((row, skip, rows)) = hit else {
            continue;
        };
        g.place_media(grid::Media {
            row,
            col: left + b.col,
            rows,
            cols: b.cols,
            skip_rows: skip,
            total_rows: b.rows,
            kind: b.kind,
            key: b.key.clone(),
            caption: b.caption.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str, atts: serde_json::Value) -> proto::TimelineItem {
        serde_json::from_value(serde_json::json!({
            "id": "u", "threadId": "t", "seq": 1,
            "kind": "user", "text": text, "attachments": atts,
        }))
        .unwrap()
    }

    fn assistant(text: &str) -> proto::TimelineItem {
        serde_json::from_value(serde_json::json!({
            "id": "a", "threadId": "t", "seq": 2,
            "kind": "assistant", "text": text, "streaming": false,
        }))
        .unwrap()
    }

    struct Known(f32);
    impl MediaSizes for Known {
        fn aspect(&self, _k: &str) -> Option<f32> {
            Some(self.0)
        }
        fn failed(&self, _k: &str) -> Option<String> {
            None
        }
    }

    struct Broken(&'static str);
    impl MediaSizes for Broken {
        fn aspect(&self, _k: &str) -> Option<f32> {
            None
        }
        fn failed(&self, _k: &str) -> Option<String> {
            Some(self.0.to_string())
        }
    }

    #[test]
    fn an_image_becomes_a_run_of_lines() {
        // This is the claim the whole client rests on: a picture is lines, so
        // the scroll, the window and the hit test need learn nothing about it.
        let item = user(
            "look",
            serde_json::json!([{ "name": "shot.png", "path": "/f/shot.png", "mimeType": "image/png" }]),
        );
        let l = layout(&[item], 60, 40, CellAspect(2.0), &Known(16.0 / 9.0));
        assert_eq!(l.blocks.len(), 1);
        let media_lines = l
            .lines
            .iter()
            .filter(|x| matches!(x, Line::MediaRow { .. }))
            .count();
        assert_eq!(media_lines, l.blocks[0].rows);
        assert!(media_lines > 1);
    }

    #[test]
    fn a_picture_never_takes_more_than_its_share_of_the_pane() {
        // 40%, the same cap the web client's style sheet applies (#110). A
        // very tall picture is what tests it.
        let item = user(
            "tall",
            serde_json::json!([{ "name": "t.png", "path": "/f/t.png", "mimeType": "image/png" }]),
        );
        let l = layout(&[item], 60, 40, CellAspect(2.0), &Known(0.2));
        assert!(l.blocks[0].rows <= 16, "rows: {}", l.blocks[0].rows);
    }

    #[test]
    fn a_cell_is_taller_than_it_is_wide_so_a_square_picture_is_not_square_in_cells() {
        // Getting this backwards is what makes a screenshot look stretched.
        let (cols, rows) = fit(1.0, 40, 100, CellAspect(2.0));
        assert_eq!(cols, 40);
        assert_eq!(rows, 20);
    }

    #[test]
    fn a_wide_picture_fills_the_width_and_a_tall_one_fills_the_height() {
        let (cols, rows) = fit(4.0, 40, 100, CellAspect(2.0));
        assert_eq!((cols, rows), (40, 5));
        let (cols, rows) = fit(0.25, 40, 10, CellAspect(2.0));
        assert_eq!(rows, 10);
        assert!((1..=40).contains(&cols));
    }

    #[test]
    fn a_file_that_could_not_be_read_says_which_thing_went_wrong() {
        // One word for four problems is what made a screenshot read as
        // "unreadable" for weeks (#132).
        let item = user(
            "look",
            serde_json::json!([{ "name": "shot.png", "path": "/f/shot.png", "mimeType": "image/png" }]),
        );
        let l = layout(
            &[item],
            60,
            40,
            CellAspect(2.0),
            &Broken("the thread no longer holds that file"),
        );
        assert!(l.blocks.is_empty());
        let text: String = l
            .lines
            .iter()
            .map(|x| match x {
                Line::Text { spans, .. } => spans.iter().map(|s| s.text.clone()).collect(),
                _ => String::new(),
            })
            .collect::<Vec<String>>()
            .join("\n");
        assert!(text.contains("no longer holds"), "{text}");
    }

    #[test]
    fn a_file_this_client_cannot_show_is_a_chip_and_not_a_hole() {
        let item = user(
            "log",
            serde_json::json!([{ "name": "run.log", "path": "/f/run.log", "mimeType": "text/plain" }]),
        );
        let l = layout(&[item], 60, 40, CellAspect(2.0), &NoMedia);
        assert!(l.blocks.is_empty());
        assert!(l.lines.iter().any(|x| matches!(x, Line::Text { spans, .. }
            if spans.iter().any(|s| s.text.contains("run.log")))));
    }

    #[test]
    fn the_window_follows_the_bottom_at_a_scroll_of_zero() {
        // A streaming item is re-sent whole and longer, so the bottom moves
        // under the reader. A count from the bottom is what keeps the last line
        // last (#114).
        assert_eq!(window_start(100, 10, 0), 90);
        assert_eq!(window_start(101, 10, 0), 91);
        assert_eq!(window_start(100, 10, 5), 85);
        // Scrolled past the top, the window stops at the top.
        assert_eq!(window_start(100, 10, 999), 0);
        // Fewer lines than the pane: there is nothing to scroll.
        assert_eq!(window_start(3, 10, 0), 0);
        assert_eq!(max_scroll(3, 10), 0);
    }

    #[test]
    fn an_item_kind_this_client_does_not_know_keeps_its_place() {
        let raw: proto::TimelineItem = serde_json::from_value(serde_json::json!({
            "id": "x", "threadId": "t", "seq": 3, "kind": "hologram",
        }))
        .unwrap();
        let l = layout(
            &[assistant("before"), raw],
            40,
            20,
            CellAspect(2.0),
            &NoMedia,
        );
        let text: Vec<String> = l
            .lines
            .iter()
            .map(|x| match x {
                Line::Text { spans, .. } => spans.iter().map(|s| s.text.clone()).collect(),
                _ => String::new(),
            })
            .collect();
        assert!(text.iter().any(|t| t.contains("too old to show")));
        assert!(text.iter().any(|t| t.contains("before")));
    }
}
