//! The screen: one [`Grid`], built from the store, once per frame.
//!
//! Nothing here touches egui. The whole window is written as cells and media
//! placements, which is what lets the layout be tested without a display server
//! — `render.rs` turns the same grid into a picture, and `paint.rs` turns it
//! into a window.
//!
//! One rule carries over from the TUI unchanged: **the painted line list and
//! the hit test read the same array.** [`Screen::cells`] is that array. Change
//! how the sidebar is painted and the mouse follows for free; keep two copies
//! of it and a click lands on the row above the one under the pointer.

use covey_grid::{self as grid, theme, Grid, Style};
use covey_protocol as proto;

use crate::state::{Cell, Row, Store, MACHINES_KEY};
use crate::transcript::{self, CellAspect, Layout, MediaSizes};

/// How wide the sidebar rail is. A fixed rail, as in the TUI: the pane beside
/// it takes what is left.
pub const SIDEBAR_COLS: usize = 32;

/// The smallest window this layout has room for: a header, a rule, a line of
/// transcript, a rule and a composer, plus the rail and something beside it.
///
/// A window smaller than this is not laid out at all. That is not a refusal to
/// be small — it is that every pane below computes its size by subtraction, and
/// a subtraction that runs past zero is a panic rather than a narrow pane.
pub const MIN_COLS: usize = SIDEBAR_COLS + 8;
pub const MIN_ROWS: usize = 8;

/// Where the panes sit, and the arrays the mouse reads.
pub struct Screen {
    pub grid: Grid,
    /// The sidebar's painted lines, the same array the paint walked.
    pub cells: Vec<Cell>,
    pub rows: Vec<Row>,
    pub sidebar_top: usize,
    pub transcript_top: usize,
    pub transcript_rows: usize,
    pub transcript: Layout,
    pub cursor: usize,
}

impl Screen {
    /// The sidebar row under a grid row, or none for a blank line, the header,
    /// the footer, or a point in the pane beside the rail.
    pub fn row_at(&self, row: usize, col: usize) -> Option<usize> {
        if col >= SIDEBAR_COLS - 1 || row < self.sidebar_top {
            return None;
        }
        match self.cells.get(row - self.sidebar_top) {
            Some(Cell::Row(i)) => Some(*i),
            _ => None,
        }
    }

    /// True when a point is in the transcript pane, where the wheel scrolls.
    pub fn in_transcript(&self, row: usize, col: usize) -> bool {
        col >= SIDEBAR_COLS
            && row >= self.transcript_top
            && row < self.transcript_top + self.transcript_rows
    }
}

pub fn build(
    store: &Store,
    cols: usize,
    rows: usize,
    aspect: CellAspect,
    media: &dyn MediaSizes,
) -> Screen {
    if cols < MIN_COLS || rows < MIN_ROWS {
        return too_small(cols, rows);
    }
    let mut g = Grid::new(cols, rows);
    let sidebar_rows = store.rows();
    let cursor = Store::cursor_index_in(&sidebar_rows, &store.cursor_key, store.cursor_index);

    // The rail, and the rule that separates it from the pane.
    let sidebar_top = 1;
    let sidebar_height = rows.saturating_sub(sidebar_top + 1);
    let cells = Store::cells(&sidebar_rows, cursor, sidebar_height);
    for r in 0..rows {
        g.put(r, SIDEBAR_COLS - 1, "│", Style::fg(theme::BORDER));
    }

    header(&mut g, store, &sidebar_rows);
    for (i, cell) in cells.iter().enumerate() {
        let Cell::Row(at) = cell else { continue };
        paint_row(
            &mut g,
            store,
            &sidebar_rows[*at],
            sidebar_top + i,
            *at == cursor,
        );
    }
    footer(&mut g, rows);

    // The pane.
    let pane_left = SIDEBAR_COLS;
    let pane_cols = cols.saturating_sub(pane_left + 1);
    let transcript_top = 2;
    // Two rows of composer, a rule above it, and the footer line.
    let transcript_rows = rows.saturating_sub(transcript_top + 4);
    let mut layout = Layout::default();

    if let Some(open) = store.open.as_ref() {
        pane_header(&mut g, store, open, pane_left, pane_cols);
        layout = transcript::layout(&open.items, pane_cols, transcript_rows, aspect, media);
        transcript::paint(
            &mut g,
            &layout,
            transcript_top,
            pane_left + 1,
            pane_cols,
            transcript_rows,
            open.scroll_from_bottom,
        );
        composer(&mut g, open, pane_left, pane_cols, rows);
    } else {
        g.put(
            transcript_top + 1,
            pane_left + 2,
            "Pick a conversation on the left, or press n to start one.",
            Style::fg(theme::SUBTLE),
        );
    }

    if let Some(notice) = store.notice.as_deref() {
        g.put_clipped(
            rows - 1,
            pane_left + 1,
            notice,
            Style::fg(theme::WARNING),
            pane_cols,
        );
    }

    Screen {
        grid: g,
        cells,
        rows: sidebar_rows,
        sidebar_top,
        transcript_top,
        transcript_rows,
        transcript: layout,
        cursor,
    }
}

/// A window with no room for the layout. It still says what it is, which is
/// more than an empty rectangle does.
fn too_small(cols: usize, rows: usize) -> Screen {
    let mut g = Grid::new(cols, rows);
    g.put_clipped(
        rows / 2,
        0,
        "covey — the window is too small",
        Style::fg(theme::SUBTLE),
        cols,
    );
    Screen {
        grid: g,
        cells: Vec::new(),
        rows: Vec::new(),
        sidebar_top: 0,
        transcript_top: 0,
        transcript_rows: 0,
        transcript: Layout::default(),
        cursor: 0,
    }
}

fn header(g: &mut Grid, store: &Store, rows: &[Row]) {
    g.put(0, 1, "covey", Style::fg(theme::TEXT).bold());
    let projects = rows
        .iter()
        .filter(|r| matches!(r, Row::Project { .. }))
        .count();
    let machines = store.machines.len();
    let meta = format!(
        "{projects} project{} · {machines} machine{}",
        if projects == 1 { "" } else { "s" },
        if machines == 1 { "" } else { "s" }
    );
    g.put_clipped(
        0,
        8,
        &meta,
        Style::fg(theme::SUBTLE),
        SIDEBAR_COLS.saturating_sub(9),
    );
}

fn footer(g: &mut Grid, rows: usize) {
    g.put(rows - 1, 1, "↑↓ move  ⏎ open  ⌫ …", Style::fg(theme::FAINT));
}

fn paint_row(g: &mut Grid, store: &Store, row: &Row, at: usize, selected: bool) {
    let inner = SIDEBAR_COLS - 1;
    if selected {
        g.fill_bg(at, 0, inner, theme::SELECTION);
    }
    let bg = selected.then_some(theme::SELECTION);
    match row {
        Row::Project {
            title,
            threads,
            busy,
            waiting,
            key,
        } => {
            let open = store.is_expanded(key, true);
            // A fold may never hide that something inside it is working or that
            // something is waiting on a person.
            let (mark, mark_style) = if !open && (*waiting || *busy) {
                (
                    "●",
                    Style::fg(if *waiting {
                        theme::AWAITING
                    } else {
                        theme::WORKING
                    }),
                )
            } else {
                (if open { "▾" } else { "▸" }, Style::fg(theme::SUBTLE))
            };
            g.put(at, 1, mark, mark_style.maybe_on(bg));
            let count = threads.to_string();
            let room = inner.saturating_sub(5 + count.len());
            g.put_clipped(
                at,
                3,
                &grid::truncate(title, room),
                Style::fg(theme::TEXT).bold().maybe_on(bg),
                room,
            );
            g.put(
                at,
                inner - count.len() - 1,
                &count,
                Style::fg(theme::FAINT).maybe_on(bg),
            );
        }
        Row::Thread {
            machine,
            thread_id,
            depth,
        } => {
            let Some(t) = store.machines[*machine].threads.get(thread_id) else {
                return;
            };
            let indent = crate::state::thread_indent(*depth);
            let active = store
                .open
                .as_ref()
                .is_some_and(|o| o.machine == *machine && o.thread_id == *thread_id);
            // A thread a program started carries its own mark, so the reader
            // can tell their own work from an agent's at a glance (#49).
            let agent = t.origin.as_ref().is_some_and(|o| o.is_agent());
            if active {
                g.put(
                    at,
                    indent,
                    "❯",
                    Style::fg(theme::ACCENT).bold().maybe_on(bg),
                );
            } else if agent {
                g.put(
                    at,
                    indent,
                    theme::AGENT_MARK,
                    Style::fg(theme::FAINT).maybe_on(bg),
                );
            }
            let busy = proto::thread_is_busy(t);
            g.put(
                at,
                indent + 2,
                if busy { "●" } else { "·" },
                Style::fg(theme::status_color(t.status.as_str(), false)).maybe_on(bg),
            );
            let col = indent + 4;
            let room = inner.saturating_sub(col + 1);
            g.put_clipped(
                at,
                col,
                &grid::truncate(&t.title, room),
                Style::fg(if active { theme::TEXT } else { theme::MUTED }).maybe_on(bg),
                room,
            );
        }
        Row::MachinesHeader => {
            let open = store.is_expanded(MACHINES_KEY, false);
            let offline = store
                .machines
                .iter()
                .filter(|m| m.conn == covey_client::ConnState::Offline)
                .count();
            g.put(
                at,
                1,
                if open { "▾" } else { "▸" },
                Style::fg(theme::SUBTLE).maybe_on(bg),
            );
            g.put(
                at,
                3,
                "MACHINES",
                Style::fg(theme::TEXT).bold().maybe_on(bg),
            );
            // Furled, the section still says what needs a person.
            let meta = if offline > 0 {
                format!("{offline} offline")
            } else {
                store.machines.len().to_string()
            };
            g.put(
                at,
                inner - meta.len() - 1,
                &meta,
                Style::fg(if offline > 0 {
                    theme::conn_color("offline")
                } else {
                    theme::FAINT
                })
                .maybe_on(bg),
            );
        }
        Row::Machine { machine } => {
            let m = &store.machines[*machine];
            let conn = m.conn.as_str();
            g.put(
                at,
                3,
                theme::conn_dot(conn),
                Style::fg(theme::conn_color(conn)).maybe_on(bg),
            );
            // Room here is a dozen characters, so the reason lives elsewhere;
            // what the row owes the reader is that nothing more will happen
            // unless they ask, which is what "enter to retry" says.
            let meta = match conn {
                "offline" => "offline · ⏎".to_string(),
                "connected" => m.info.as_ref().map(|i| i.os.clone()).unwrap_or_default(),
                other => other.to_string(),
            };
            let room = inner.saturating_sub(6 + meta.len());
            g.put_clipped(
                at,
                5,
                &grid::truncate(&m.display_name().to_uppercase(), room),
                Style::fg(theme::TEXT).bold().maybe_on(bg),
                room,
            );
            g.put(
                at,
                inner - meta.len() - 1,
                &meta,
                Style::fg(if conn == "offline" {
                    theme::conn_color(conn)
                } else {
                    theme::SUBTLE
                })
                .maybe_on(bg),
            );
        }
        Row::Empty => {
            g.put(
                at,
                1,
                "no projects — press a",
                Style::fg(theme::SUBTLE).italic().maybe_on(bg),
            );
        }
    }
}

fn pane_header(g: &mut Grid, store: &Store, open: &crate::state::Open, left: usize, cols: usize) {
    let Some(t) = open.thread.as_ref() else {
        return;
    };
    let machine = store.machines[open.machine].display_name();
    let busy = proto::thread_is_busy(t);
    g.put(
        1,
        left + 1,
        if busy { "●" } else { "·" },
        Style::fg(theme::status_color(t.status.as_str(), false)),
    );
    let right = format!("{machine} · {}", t.status.as_str());
    let room = cols.saturating_sub(right.len() + 4);
    g.put_clipped(
        1,
        left + 3,
        &grid::truncate(&t.title, room),
        Style::fg(theme::TEXT).bold(),
        room,
    );
    g.put_clipped(
        1,
        left + cols - right.len(),
        &right,
        Style::fg(theme::SUBTLE),
        right.len(),
    );
}

fn composer(g: &mut Grid, open: &crate::state::Open, left: usize, cols: usize, rows: usize) {
    let rule = rows - 3;
    for c in left + 1..left + cols {
        g.put(rule, c, "─", Style::fg(theme::BORDER));
    }
    g.put(rule + 1, left + 1, "❯", Style::fg(theme::ACCENT).bold());
    let text = if open.draft.is_empty() {
        grid::truncate("Ask anything. ⏎ sends.", cols.saturating_sub(4))
    } else {
        // The tail, so a long line keeps its end — which is where the caret is.
        let w = cols.saturating_sub(5);
        let full = grid::text_width(&open.draft);
        if full <= w {
            open.draft.clone()
        } else {
            let mut keep = String::new();
            let mut used = 0;
            for gr in open.draft.chars().rev().collect::<String>().chars() {
                let gw = grid::text_width(&gr.to_string());
                if used + gw > w {
                    break;
                }
                keep.insert(0, gr);
                used += gw;
            }
            keep
        }
    };
    let style = if open.draft.is_empty() {
        Style::fg(theme::FAINT).italic()
    } else {
        Style::fg(theme::TEXT)
    };
    g.put_clipped(rule + 1, left + 3, &text, style, cols.saturating_sub(4));
    if !open.draft.is_empty() {
        let at = left + 3 + grid::text_width(&text);
        g.put(
            rule + 1,
            at.min(left + cols - 1),
            "▏",
            Style::fg(theme::ACCENT),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Machine;
    use covey_client::ConnState;

    fn store_with(threads: usize) -> Store {
        let handle = covey_client::MachineHandle::detached("local");
        let mut m = Machine {
            saved: proto::SavedMachine {
                name: "local".into(),
                url: "ws://127.0.0.1:3790".into(),
                token: None,
                machine_id: None,
            },
            handle,
            conn: ConnState::Connected,
            error: None,
            info: None,
            projects: Default::default(),
            threads: Default::default(),
        };
        let p: proto::Project = serde_json::from_value(serde_json::json!({
            "id": "p1", "title": "covey", "workspaceRoot": "/w",
            "repositoryIdentity": "github.com/dylandotfarm/covey", "updatedAt": "2026-01-01",
        }))
        .unwrap();
        m.projects.insert("p1".into(), p);
        for i in 0..threads {
            let t: proto::Thread = serde_json::from_value(serde_json::json!({
                "id": format!("t{i}"), "projectId": "p1", "title": format!("thread {i}"),
                "status": "idle", "permissionMode": "default",
                "pendingApprovals": 0, "queuedTurns": 0,
                "updatedAt": format!("2026-01-0{}", i + 1),
            }))
            .unwrap();
            m.threads.insert(t.id.clone(), t);
        }
        Store::new(vec![m])
    }

    #[test]
    fn the_sidebar_paints_the_project_and_its_threads() {
        let s = store_with(2);
        let screen = build(&s, 100, 24, CellAspect(2.0), &transcript::NoMedia);
        let text: Vec<String> = (0..24).map(|r| screen.grid.row_text(r)).collect();
        assert!(text[0].trim_start().starts_with("covey"), "{:?}", text[0]);
        assert!(
            text.iter().any(|l| l.contains("covey") && l.contains('2')),
            "no project row: {text:#?}"
        );
        assert!(text.iter().any(|l| l.contains("thread 1")));
        assert!(text.iter().any(|l| l.contains("MACHINES")));
    }

    #[test]
    fn the_hit_test_and_the_paint_read_one_array() {
        // The bug this pins: two copies of the line list, and a click lands on
        // the row above the one under the pointer.
        let s = store_with(3);
        let screen = build(&s, 100, 24, CellAspect(2.0), &transcript::NoMedia);
        for (i, cell) in screen.cells.iter().enumerate() {
            let row = screen.sidebar_top + i;
            match cell {
                Cell::Row(at) => assert_eq!(screen.row_at(row, 4), Some(*at)),
                Cell::Blank => assert_eq!(screen.row_at(row, 4), None),
            }
        }
        // A click in the pane beside the rail is never a sidebar row.
        assert_eq!(screen.row_at(screen.sidebar_top, SIDEBAR_COLS), None);
    }

    #[test]
    fn nothing_is_painted_outside_the_grid() {
        // A narrow window is the one that finds an arithmetic mistake. Every
        // call below would panic on an index if a width went negative — and
        // the sizes below `MIN_COLS` and `MIN_ROWS` are the ones that did.
        for cols in [1usize, 8, 33, 39, 40, 60, 100, 200] {
            for rows in [1usize, 2, 7, 8, 10, 24, 60] {
                let s = store_with(3);
                let screen = build(&s, cols, rows, CellAspect(2.0), &transcript::NoMedia);
                assert_eq!(screen.grid.cols(), cols);
                assert_eq!(screen.grid.rows(), rows);
            }
        }
    }

    #[test]
    fn the_rail_has_a_rule_down_its_right_edge() {
        let s = store_with(1);
        let screen = build(&s, 80, 20, CellAspect(2.0), &transcript::NoMedia);
        for r in 0..20 {
            let row = screen.grid.row_text(r);
            assert!(row.contains('│'), "row {r} has no rule: {row:?}");
        }
    }
}
