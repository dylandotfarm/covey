//! A styled character grid where a rectangle of cells can hold a picture.
//!
//! This is the whole idea of the desktop client (issue #142), and it is worth
//! stating plainly.
//!
//! covey reads the way it does because it is a character grid. Everything is
//! laid out in rows and columns: the sidebar's indents, the transcript's
//! wrapping, the scroll that counts lines from the bottom. Give that up and
//! covey stops looking like covey. But a terminal can only put a glyph in a
//! cell, so a screenshot in a transcript is a file name and nothing more.
//!
//! So keep the grid and stop asking a terminal to paint it. A [`Grid`] is rows
//! by columns of styled cells, exactly like a terminal's screen buffer — and it
//! *also* carries a list of [`Media`] placements, each one a rectangle of cells
//! that a picture is painted over instead of glyphs. The layout code above it
//! does not change shape: it still writes text at a row and a column, and it
//! reserves whole rows for a picture the same way it reserves them for a
//! paragraph. Scroll is still a count of lines. A hit test is still a division.
//!
//! One rule keeps that honest: **a placement owns its cells.** The renderer
//! paints the picture over them and skips whatever glyphs are there, so layout
//! never has to blank a region by hand, and a picture can never half-cover a
//! word.

pub mod theme;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub use theme::Rgb;

/// How a cell is painted.
///
/// `bg: None` means the window's own background shows through, which is what
/// most of the screen is. The TUI says the same thing by setting no background
/// and letting the terminal's paint through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Style {
    pub fg: Rgb,
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub italic: bool,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            fg: theme::TEXT,
            bg: None,
            bold: false,
            italic: false,
        }
    }
}

impl Style {
    pub fn fg(fg: Rgb) -> Style {
        Style {
            fg,
            ..Style::default()
        }
    }
    pub fn bold(mut self) -> Style {
        self.bold = true;
        self
    }
    pub fn italic(mut self) -> Style {
        self.italic = true;
        self
    }
    pub fn on(mut self, bg: Rgb) -> Style {
        self.bg = Some(bg);
        self
    }
    pub fn maybe_on(mut self, bg: Option<Rgb>) -> Style {
        self.bg = bg;
        self
    }
}

/// What a cell holds.
///
/// `Ch` covers all but a handful of cells, so the common case costs no
/// allocation. `Long` is a grapheme cluster that is more than one `char` — a
/// family emoji, a letter with two combining marks — and indexes the grid's
/// side table. `Continuation` is the second cell of a wide grapheme: it paints
/// nothing, and it exists so a column count is always a column count.
///
/// That last variant is the fix for the class of bug issue #24 reports against
/// the TUI. There, width is counted in `char`s, so a combining mark or a ZWJ
/// emoji makes a wrapped row overflow its pane. Here a grapheme is placed once
/// and its width is taken from the Unicode tables, so the count cannot drift
/// from what is painted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellText {
    Blank,
    Ch(char),
    Long(u32),
    Continuation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub text: CellText,
    pub style: Style,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            text: CellText::Blank,
            style: Style::default(),
        }
    }
}

/// What kind of thing a placement paints, so the renderer knows what to ask the
/// media cache for and what controls to draw over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    /// A video. The renderer paints the frame the decoder has reached and puts
    /// a play control in the bottom left of the rectangle.
    Video,
}

/// A rectangle of cells that a picture is painted over.
///
/// `key` is opaque to the grid. The app's media cache keys on it — in practice
/// the attachment's path on the daemon's machine, which is stable and unique.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Media {
    /// The first row of the grid this placement owns.
    pub row: usize,
    pub col: usize,
    /// How many rows it owns *here*, which is not always how tall the picture
    /// is: a picture scrolled half off the top owns only the rows still in the
    /// pane.
    pub rows: usize,
    pub cols: usize,
    /// How many rows of the picture are above `row`, out of the pane.
    ///
    /// Scroll is a count of lines and a picture is a run of lines, so a picture
    /// at the edge of the pane is part of a picture. The renderer draws the
    /// whole thing — `total_rows` tall, starting `skip_rows` above `row` — and
    /// clips to the pane. Without this a picture would jump into place whole
    /// instead of sliding in, which is not how a line scrolls.
    pub skip_rows: usize,
    /// How tall the picture is in rows, out of the pane and in.
    pub total_rows: usize,
    pub kind: MediaKind,
    pub key: String,
    /// What to paint while the bytes are still coming, and what to say when
    /// they never do.
    pub caption: String,
}

/// The screen, as this client builds it every frame.
pub struct Grid {
    cols: usize,
    rows: usize,
    cells: Vec<Cell>,
    longs: Vec<String>,
    media: Vec<Media>,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Grid {
        Grid {
            cols,
            rows,
            cells: vec![Cell::default(); cols * rows],
            longs: Vec::new(),
            media: Vec::new(),
        }
    }

    pub fn cols(&self) -> usize {
        self.cols
    }
    pub fn rows(&self) -> usize {
        self.rows
    }
    pub fn media(&self) -> &[Media] {
        &self.media
    }

    pub fn cell(&self, row: usize, col: usize) -> Option<&Cell> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        self.cells.get(row * self.cols + col)
    }

    /// The grapheme cluster in a cell, when it is more than one `char`.
    ///
    /// The renderer places one of these on its own cell rather than in a run,
    /// because a font whose advance for it is not exactly one cell would push
    /// the rest of the row sideways.
    pub fn long_at(&self, row: usize, col: usize) -> Option<&str> {
        match self.cell(row, col)?.text {
            CellText::Long(i) => self.longs.get(i as usize).map(String::as_str),
            _ => None,
        }
    }

    /// One row as a string, trailing blanks trimmed. Tests read this; the
    /// renderer walks the cells instead, because it needs the styles.
    pub fn row_text(&self, row: usize) -> String {
        let mut s = String::new();
        for col in 0..self.cols {
            match self.cells[row * self.cols + col].text {
                CellText::Blank => s.push(' '),
                CellText::Ch(c) => s.push(c),
                CellText::Long(i) => s.push_str(&self.longs[i as usize]),
                CellText::Continuation => {}
            }
        }
        s.trim_end().to_string()
    }

    /// Paint `text` starting at (`row`, `col`), and answer how many columns it
    /// took. Clipped at the right edge, and at `max_cols` when one is given.
    ///
    /// Clipping is by grapheme, never by `char`: half of a wide glyph is not a
    /// glyph, so a grapheme that will not fit is not placed at all.
    pub fn put(&mut self, row: usize, col: usize, text: &str, style: Style) -> usize {
        self.put_clipped(row, col, text, style, usize::MAX)
    }

    pub fn put_clipped(
        &mut self,
        row: usize,
        col: usize,
        text: &str,
        style: Style,
        max_cols: usize,
    ) -> usize {
        if row >= self.rows || col >= self.cols {
            return 0;
        }
        let limit = self.cols.min(col.saturating_add(max_cols));
        let mut at = col;
        for g in text.graphemes(true) {
            if g == "\n" {
                break;
            }
            let w = grapheme_width(g);
            if w == 0 {
                // A lone combining mark with nothing to combine with. Dropping
                // it is right: it has no cell of its own, and carrying it would
                // make the column count disagree with the paint.
                continue;
            }
            if at + w > limit {
                break;
            }
            let text = if g.chars().count() == 1 {
                CellText::Ch(g.chars().next().unwrap())
            } else {
                self.longs.push(g.to_string());
                CellText::Long((self.longs.len() - 1) as u32)
            };
            self.cells[row * self.cols + at] = Cell { text, style };
            for k in 1..w {
                self.cells[row * self.cols + at + k] = Cell {
                    text: CellText::Continuation,
                    style,
                };
            }
            at += w;
        }
        at - col
    }

    /// Paint a background across a run of cells without changing their text.
    /// This is what a selected sidebar row and a user message's block are.
    pub fn fill_bg(&mut self, row: usize, col: usize, cols: usize, bg: Rgb) {
        if row >= self.rows {
            return;
        }
        let end = self.cols.min(col + cols);
        for c in col..end {
            self.cells[row * self.cols + c].style.bg = Some(bg);
        }
    }

    /// Reserve a rectangle of cells for a picture.
    ///
    /// The cells are blanked, because the placement owns them from here: the
    /// renderer paints the picture over the rectangle and never looks at what
    /// was underneath. Layout therefore cannot leave half a word showing
    /// through a screenshot.
    pub fn place_media(&mut self, media: Media) {
        let row_end = self.rows.min(media.row + media.rows);
        let col_end = self.cols.min(media.col + media.cols);
        for r in media.row..row_end {
            for c in media.col..col_end {
                self.cells[r * self.cols + c] = Cell::default();
            }
        }
        self.media.push(media);
    }
}

/// The columns one grapheme cluster takes.
///
/// `unicode-width` answers for the string, which is the right question: a base
/// letter plus two combining marks is one column, and a ZWJ sequence is two.
/// Anything the tables call zero-width but that stands alone still gets a cell,
/// because a cell that paints nothing and takes no room cannot be clicked.
pub fn grapheme_width(g: &str) -> usize {
    UnicodeWidthStr::width(g)
}

/// The columns a whole string takes, counted the way `put` places it.
pub fn text_width(s: &str) -> usize {
    s.graphemes(true).map(grapheme_width).sum()
}

/// Cut `s` to `cols` columns, with `…` when anything was cut.
///
/// The ellipsis costs a column, so a cut string is `cols` wide and not one
/// more. A `cols` of 0 or 1 gives back nothing, because an ellipsis alone says
/// less than blank does.
pub fn truncate(s: &str, cols: usize) -> String {
    if text_width(s) <= cols {
        return s.to_string();
    }
    if cols <= 1 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for g in s.graphemes(true) {
        let gw = grapheme_width(g);
        if w + gw > cols - 1 {
            break;
        }
        out.push_str(g);
        w += gw;
    }
    out.push('…');
    out
}

/// Wrap `text` to `cols` columns, breaking at spaces where it can.
///
/// A word longer than the line — a path, a hash, a URL — is cut rather than
/// pushed past the edge, because a transcript that overflows its pane is the
/// one thing a grid must never do.
pub fn wrap(text: &str, cols: usize) -> Vec<String> {
    if cols == 0 {
        return vec![];
    }
    let mut out = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut cur = String::new();
        let mut cur_w = 0usize;
        for word in line.split_inclusive(' ') {
            let ww = text_width(word);
            if cur_w + ww > cols && cur_w > 0 {
                out.push(cur.trim_end().to_string());
                cur = String::new();
                cur_w = 0;
            }
            if ww > cols {
                // Longer than a whole line. Fill what is left of this one and
                // keep cutting, so nothing is lost and nothing overflows.
                for g in word.graphemes(true) {
                    let gw = grapheme_width(g);
                    if cur_w + gw > cols {
                        out.push(cur.trim_end().to_string());
                        cur = String::new();
                        cur_w = 0;
                    }
                    cur.push_str(g);
                    cur_w += gw;
                }
                continue;
            }
            cur.push_str(word);
            cur_w += ww;
        }
        out.push(cur.trim_end().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wide_grapheme_takes_two_cells_and_the_second_paints_nothing() {
        let mut g = Grid::new(10, 1);
        let used = g.put(0, 0, "日本", Style::default());
        assert_eq!(used, 4);
        assert_eq!(g.cell(0, 1).unwrap().text, CellText::Continuation);
        assert_eq!(g.cell(0, 3).unwrap().text, CellText::Continuation);
        assert_eq!(g.row_text(0), "日本");
    }

    #[test]
    fn a_grapheme_that_does_not_fit_is_not_half_painted() {
        // Half of a wide glyph is not a glyph, so the last column is left
        // blank rather than filled with the left half of 日.
        let mut g = Grid::new(2, 1);
        assert_eq!(g.put(0, 0, "a日", Style::default()), 1);
        assert_eq!(g.row_text(0), "a");
        // One column wider and the same glyph fits whole.
        let mut g = Grid::new(3, 1);
        assert_eq!(g.put(0, 0, "a日", Style::default()), 3);
        assert_eq!(g.row_text(0), "a日");
    }

    #[test]
    fn a_zwj_emoji_is_one_grapheme_and_two_columns() {
        // This is the count issue #24 reports the TUI getting wrong: a family
        // emoji is seven `char`s, and counting `char`s overflows the row.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert!(family.chars().count() > 2);
        assert_eq!(text_width(family), 2);
        let mut g = Grid::new(4, 1);
        assert_eq!(g.put(0, 0, family, Style::default()), 2);
        assert_eq!(g.row_text(0), family);
    }

    #[test]
    fn a_combining_mark_rides_on_its_base_and_costs_no_column() {
        // The cluster stays decomposed — the grid never normalises what it was
        // given — but it takes one column, so the `x` lands in column 1.
        let e = "e\u{0301}"; // e + combining acute
        assert_eq!(text_width(e), 1);
        let mut g = Grid::new(3, 1);
        g.put(0, 0, e, Style::default());
        g.put(0, 1, "x", Style::default());
        assert_eq!(g.row_text(0), "e\u{0301}x");
    }

    #[test]
    fn put_clips_at_the_right_edge_and_at_the_limit_it_was_given() {
        let mut g = Grid::new(20, 1);
        assert_eq!(g.put_clipped(0, 0, "abcdefgh", Style::default(), 4), 4);
        assert_eq!(g.row_text(0), "abcd");
        let mut g = Grid::new(3, 1);
        assert_eq!(g.put(0, 0, "abcdefgh", Style::default()), 3);
        assert_eq!(g.row_text(0), "abc");
    }

    #[test]
    fn truncate_keeps_the_width_it_was_asked_for() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 8), "hello w…");
        assert_eq!(text_width(&truncate("hello world", 8)), 8);
        // A wide glyph that would straddle the ellipsis is dropped whole.
        assert_eq!(text_width(&truncate("日本語です", 5)), 5);
        assert_eq!(truncate("hello", 1), "");
    }

    #[test]
    fn wrap_breaks_at_spaces_and_cuts_a_word_too_long_for_a_line() {
        assert_eq!(
            wrap("the parser rejects the token", 12),
            vec!["the parser", "rejects the", "token"]
        );
        let long = wrap("/a/very/long/path/that/never/breaks", 10);
        assert!(long.iter().all(|l| text_width(l) <= 10));
        assert_eq!(long.concat(), "/a/very/long/path/that/never/breaks");
    }

    #[test]
    fn wrap_keeps_an_empty_line() {
        assert_eq!(wrap("a\n\nb", 10), vec!["a", "", "b"]);
    }

    #[test]
    fn a_placement_owns_its_cells() {
        // The renderer paints the picture over the rectangle without looking at
        // what was underneath, so layout must never be able to leave half a
        // word showing through a screenshot.
        let mut g = Grid::new(20, 5);
        g.put(1, 0, "this text is under the picture", Style::default());
        g.place_media(Media {
            row: 1,
            col: 2,
            rows: 3,
            cols: 18,
            skip_rows: 0,
            total_rows: 3,
            kind: MediaKind::Image,
            key: "/tmp/a.png".into(),
            caption: "a.png".into(),
        });
        assert_eq!(g.row_text(1), "th");
        assert_eq!(g.media().len(), 1);
    }

    #[test]
    fn a_placement_at_the_edge_does_not_write_outside_the_grid() {
        let mut g = Grid::new(10, 4);
        g.place_media(Media {
            row: 3,
            col: 8,
            rows: 40,
            cols: 40,
            skip_rows: 0,
            total_rows: 40,
            kind: MediaKind::Video,
            key: "/tmp/v.mp4".into(),
            caption: "v.mp4".into(),
        });
        assert_eq!(g.media().len(), 1);
    }

    #[test]
    fn fill_bg_tints_a_row_without_touching_its_text() {
        let mut g = Grid::new(10, 1);
        g.put(0, 0, "row", Style::fg(theme::TEXT));
        g.fill_bg(0, 0, 10, theme::SELECTION);
        assert_eq!(g.row_text(0), "row");
        assert_eq!(g.cell(0, 0).unwrap().style.bg, Some(theme::SELECTION));
        assert_eq!(g.cell(0, 9).unwrap().style.bg, Some(theme::SELECTION));
    }
}
