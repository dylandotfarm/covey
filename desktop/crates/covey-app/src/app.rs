//! The window: one frame of covey.
//!
//! The order in `update` is the whole design, so it is worth reading once.
//!
//! 1. Drain what the daemons said. Every one of those lands here, on a frame
//!    boundary, and never in the middle of a paint. That is the TUI's
//!    `setFromMachine`, made structural.
//! 2. Drain what the decoders finished, and advance whatever is playing.
//! 3. Handle the reader's input, against the screen they were looking at when
//!    they acted — the one built last frame. That is the only honest thing to
//!    hit-test against, and it is why [`App::screen`] is kept.
//! 4. Build this frame's grid, and draw it.
//!
//! The window is asked to paint again only when something is moving. An idle
//! covey client costs nothing, which is the point of a client you leave open.

use covey_client::{ClientEvent, ConnState};
use covey_grid::MediaKind;
use serde_json::json;
use tokio::sync::mpsc;

use crate::media::{MediaCache, Source};
use crate::paint::{self, Metrics};
use crate::state::{Row, Store, MACHINES_KEY};
use crate::transcript::CellAspect;
use crate::ui::{self, Screen};

/// How many lines one notch of the wheel moves. Three is what a terminal does
/// and what a hand expects.
const WHEEL_LINES: f32 = 3.0;

pub struct App {
    store: Store,
    events: mpsc::UnboundedReceiver<ClientEvent>,
    media: MediaCache,
    /// The screen the reader is looking at: built last frame, hit-tested this
    /// one.
    screen: Option<Screen>,
    fonts_installed: bool,
}

impl App {
    pub fn new(store: Store, events: mpsc::UnboundedReceiver<ClientEvent>) -> App {
        App {
            store,
            events,
            media: MediaCache::default(),
            screen: None,
            fonts_installed: false,
        }
    }

    fn drain_daemons(&mut self) {
        while let Ok(ev) = self.events.try_recv() {
            self.store.apply(ev);
        }
    }

    /// Point the media cache at the thread on screen.
    ///
    /// A `path` is only unique inside one thread's file store, so the cache is
    /// emptied when the thread changes. Keeping it would show the last
    /// thread's screenshot under this thread's file name.
    fn follow_open_thread(&mut self) {
        let want = self
            .store
            .open
            .as_ref()
            .map(|o| (o.machine, o.thread_id.clone()));
        let have = self
            .media
            .source
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.thread_id.clone());
        match want {
            Some((mi, id)) if have.as_deref() != Some(id.as_str()) => {
                self.media.clear();
                let m = &self.store.machines[mi];
                let source = crate::config::http_base(&m.saved.url).map(|http_base| Source {
                    http_base,
                    thread_id: id,
                    token: m.saved.token.clone(),
                });
                self.media.set_source(source);
            }
            None if have.is_some() => {
                self.media.clear();
                self.media.set_source(None);
            }
            _ => {}
        }
    }

    /// What pressing enter, or clicking, on a row does.
    fn activate(&mut self, index: usize) {
        let Some(screen) = self.screen.as_ref() else {
            return;
        };
        let Some(row) = screen.rows.get(index).cloned() else {
            return;
        };
        self.store.cursor_key = row.key();
        self.store.cursor_index = index;
        match row {
            Row::Project { key, .. } => {
                let open = self.store.is_expanded(&key, true);
                self.store.expanded.insert(key, !open);
            }
            Row::MachinesHeader => {
                let open = self.store.is_expanded(MACHINES_KEY, false);
                self.store.expanded.insert(MACHINES_KEY.into(), !open);
            }
            Row::Thread {
                machine, thread_id, ..
            } => self.store.open_thread(machine, &thread_id),
            Row::Machine { machine } => {
                // Nothing dials an offline machine but the reader, and this is
                // where they say so. There is no heartbeat, and #68 is why.
                if self.store.machines[machine].conn == ConnState::Offline {
                    self.store.machines[machine].handle.retry();
                }
            }
            Row::Empty => {}
        }
    }

    fn move_cursor(&mut self, by: isize) {
        let Some(screen) = self.screen.as_ref() else {
            return;
        };
        if screen.rows.is_empty() {
            return;
        }
        let at = screen.cursor as isize + by;
        let at = at.clamp(0, screen.rows.len() as isize - 1) as usize;
        self.store.cursor_index = at;
        self.store.cursor_key = screen.rows[at].key();
    }

    fn scroll(&mut self, lines: isize) {
        let Some(screen) = self.screen.as_ref() else {
            return;
        };
        let total = screen.transcript.lines.len();
        let height = screen.transcript_rows;
        let Some(open) = self.store.open.as_mut() else {
            return;
        };
        let max = crate::transcript::max_scroll(total, height) as isize;
        let at = open.scroll_from_bottom as isize + lines;
        open.scroll_from_bottom = at.clamp(0, max) as usize;
    }

    fn send(&mut self) {
        let Some(open) = self.store.open.as_mut() else {
            return;
        };
        let text = std::mem::take(&mut open.draft);
        if text.trim().is_empty() {
            return;
        }
        // A new message means the reader wants the end of the conversation.
        open.scroll_from_bottom = 0;
        let thread_id = open.thread_id.clone();
        let machine = open.machine;
        // The turn id is minted client side, as the TUI does, so the daemon can
        // tell one send from a retry of the same send.
        let turn_id = uuid::Uuid::new_v4().to_string();
        self.store.machines[machine].handle.command(
            "send",
            json!({
                "type": "turn.send",
                "threadId": thread_id,
                "turnId": turn_id,
                "text": text,
            }),
        );
    }

    fn handle_input(&mut self, ctx: &egui::Context, origin: egui::Pos2, m: Metrics) {
        let mut typed = String::new();
        let mut actions: Vec<Action> = Vec::new();

        ctx.input(|i| {
            for ev in &i.events {
                match ev {
                    egui::Event::Text(t) => typed.push_str(t),
                    egui::Event::Key {
                        key,
                        pressed: true,
                        modifiers,
                        ..
                    } => match key {
                        egui::Key::ArrowUp => actions.push(Action::Cursor(-1)),
                        egui::Key::ArrowDown => actions.push(Action::Cursor(1)),
                        egui::Key::PageUp => actions.push(Action::Scroll(10)),
                        egui::Key::PageDown => actions.push(Action::Scroll(-10)),
                        egui::Key::Enter => actions.push(Action::Enter),
                        egui::Key::Backspace => actions.push(Action::Backspace(modifiers.command)),
                        egui::Key::Escape => actions.push(Action::Escape),
                        _ => {}
                    },
                    _ => {}
                }
            }

            // The wheel scrolls the transcript when the pointer is over it, and
            // nothing otherwise. A real wheel event carries pixels, so a
            // trackpad glides instead of stepping — which is the whole reason
            // to leave the terminal.
            let scroll = i.raw_scroll_delta.y;
            if scroll != 0.0 {
                if let Some(pos) = i.pointer.latest_pos() {
                    actions.push(Action::WheelAt(pos, scroll));
                }
            }
            if i.pointer.primary_clicked() {
                if let Some(pos) = i.pointer.interact_pos() {
                    actions.push(Action::ClickAt(pos));
                }
            }
        });

        for action in actions {
            match action {
                Action::Cursor(by) => self.move_cursor(by),
                Action::Scroll(by) => self.scroll(by),
                Action::Enter => {
                    let has_draft = self
                        .store
                        .open
                        .as_ref()
                        .is_some_and(|o| !o.draft.trim().is_empty());
                    if has_draft {
                        self.send();
                    } else if let Some(screen) = self.screen.as_ref() {
                        self.activate(screen.cursor);
                    }
                }
                Action::Backspace(whole_word) => {
                    if let Some(open) = self.store.open.as_mut() {
                        if whole_word {
                            open.draft.clear();
                        } else {
                            open.draft.pop();
                        }
                    }
                }
                Action::Escape => {
                    self.store.notice = None;
                    if let Some(open) = self.store.open.as_mut() {
                        open.draft.clear();
                    }
                }
                Action::WheelAt(pos, delta) => {
                    let hit = self.hit(origin, m, pos);
                    if let Some((row, col)) = hit {
                        if self
                            .screen
                            .as_ref()
                            .is_some_and(|s| s.in_transcript(row, col))
                        {
                            let lines = (delta / m.cell_h * WHEEL_LINES).round() as isize;
                            self.scroll(lines);
                        }
                    }
                }
                Action::ClickAt(pos) => {
                    let Some((row, col)) = self.hit(origin, m, pos) else {
                        continue;
                    };
                    // A click on a video is a click on that video, wherever it
                    // is: the placement knows the cells it owns.
                    let on_media = self
                        .screen
                        .as_ref()
                        .and_then(|s| paint::media_under(&s.grid, row, col))
                        .map(|p| (p.kind, p.key.clone()));
                    if let Some((MediaKind::Video, key)) = on_media {
                        self.media.toggle_play(&key);
                        continue;
                    }
                    if let Some(index) = self.screen.as_ref().and_then(|s| s.row_at(row, col)) {
                        self.activate(index);
                    }
                }
            }
        }

        if !typed.is_empty() {
            if let Some(open) = self.store.open.as_mut() {
                open.draft.push_str(&typed);
            }
        }
    }

    fn hit(&self, origin: egui::Pos2, m: Metrics, at: egui::Pos2) -> Option<(usize, usize)> {
        let screen = self.screen.as_ref()?;
        paint::cell_under(&screen.grid, m, origin, at)
    }
}

enum Action {
    Cursor(isize),
    Scroll(isize),
    Enter,
    Backspace(bool),
    Escape,
    WheelAt(egui::Pos2, f32),
    ClickAt(egui::Pos2),
}

impl eframe::App for App {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        let c = covey_grid::theme::BACKGROUND;
        [
            c.0 as f32 / 255.0,
            c.1 as f32 / 255.0,
            c.2 as f32 / 255.0,
            1.0,
        ]
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if !self.fonts_installed {
            paint::install_fonts(ctx);
            self.fonts_installed = true;
        }
        self.drain_daemons();
        self.follow_open_thread();
        let decoded = self.media.drain(ctx);
        let advanced = self.media.tick(ctx.input(|i| i.time));

        let metrics = Metrics::read(ctx);
        let aspect = CellAspect(metrics.cell_h / metrics.cell_w);

        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(egui::Color32::from_rgb(
                covey_grid::theme::BACKGROUND.0,
                covey_grid::theme::BACKGROUND.1,
                covey_grid::theme::BACKGROUND.2,
            )))
            .show(ctx, |egui_ui| {
                let rect = egui_ui.max_rect();
                let (cols, rows) = metrics.cells_in(rect.size());
                self.handle_input(ctx, rect.min, metrics);

                let screen = ui::build(&self.store, cols, rows, aspect, &self.media);
                // Asking is idempotent and cheap: the cache answers "already"
                // for everything it holds, which is what makes it safe to ask
                // from a function that runs sixty times a second.
                for block in &screen.transcript.blocks {
                    self.media.want(&block.key, block.kind);
                }
                paint::draw(
                    egui_ui.painter(),
                    rect.min,
                    &screen.grid,
                    metrics,
                    &self.media,
                );
                self.screen = Some(screen);
            });

        // Nothing paints on a timer. A video that is playing is the one thing
        // that moves on its own, and it asks for the next frame itself.
        if self.media.playing() || decoded || advanced {
            ctx.request_repaint();
        }
    }
}
