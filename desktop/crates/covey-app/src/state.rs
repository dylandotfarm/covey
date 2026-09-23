//! What the client knows, and the tree the sidebar paints from it.
//!
//! Everything a daemon says arrives here through [`Store::apply`], which the UI
//! calls once per frame while it drains the client's queue. Everything the
//! reader does calls a method directly. That is the same line the TUI's store
//! draws between `setFromMachine` and `set`, and it is drawn here by the shape
//! of the program rather than by a rule somebody has to remember.

use std::collections::HashMap;

use covey_client::{ClientEvent, ConnState, MachineHandle};
use covey_protocol as proto;

pub struct Machine {
    pub saved: proto::SavedMachine,
    pub handle: MachineHandle,
    pub conn: ConnState,
    pub error: Option<String>,
    pub info: Option<proto::MachineInfo>,
    pub projects: HashMap<String, proto::Project>,
    pub threads: HashMap<String, proto::Thread>,
}

impl Machine {
    pub fn display_name(&self) -> String {
        self.info
            .as_ref()
            .map(|i| i.name.clone())
            .unwrap_or_else(|| self.saved.name.clone())
    }
}

/// The thread on screen, and everything the transcript needs to paint it.
#[derive(Default)]
pub struct Open {
    pub machine: usize,
    pub thread_id: String,
    pub thread: Option<proto::Thread>,
    /// In seq order. The daemon re-sends a streaming item whole under the same
    /// id, so an upsert replaces in place and never appends a second copy.
    pub items: Vec<proto::TimelineItem>,
    /// Lines from the bottom. `0` is "follow the bottom", which is what a
    /// streaming reply needs: the item grows and the bottom moves under it.
    pub scroll_from_bottom: usize,
    pub draft: String,
}

impl Open {
    fn upsert(&mut self, item: proto::TimelineItem) {
        match self.items.iter_mut().find(|i| i.id == item.id) {
            Some(slot) => *slot = item,
            None => {
                // Almost always an append, because seq only grows. The search
                // is for the replay after a reconnect, which can arrive with a
                // gap already filled.
                let at = self
                    .items
                    .iter()
                    .position(|i| i.seq > item.seq)
                    .unwrap_or(self.items.len());
                self.items.insert(at, item);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    /// One repository at one base branch, folded across every machine that
    /// holds it.
    Project {
        key: String,
        title: String,
        threads: usize,
        busy: bool,
        waiting: bool,
    },
    Thread {
        machine: usize,
        thread_id: String,
        depth: usize,
    },
    /// The fleet, below the work. It furls.
    MachinesHeader,
    Machine {
        machine: usize,
    },
    Empty,
}

impl Row {
    /// The key the cursor is held by.
    ///
    /// The cursor cannot be an index, because the tree re-sorts under it: a
    /// thread moves to the top of its project on every turn that starts and
    /// every turn that ends, on any machine. An index would slide onto
    /// whichever thread spoke last.
    pub fn key(&self) -> String {
        match self {
            Row::Project { key, .. } => format!("p:{key}"),
            Row::Thread {
                machine, thread_id, ..
            } => format!("t:{machine}:{thread_id}"),
            Row::MachinesHeader => "machines".into(),
            Row::Machine { machine } => format!("m:{machine}"),
            Row::Empty => "empty".into(),
        }
    }
}

/// One painted line of the sidebar.
///
/// Rows and screen lines are not the same thing: a blank line sits above every
/// project after the first and above the fleet. Both facts have to be known in
/// exactly one place, because the paint and the hit test have to agree about
/// which row sits on which line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cell {
    Blank,
    Row(usize),
}

pub const MACHINES_KEY: &str = "machines";

pub struct Store {
    pub machines: Vec<Machine>,
    pub open: Option<Open>,
    /// Which project rows and which sections are unfurled. A project is open
    /// unless it says otherwise; the fleet is furled unless it says otherwise.
    pub expanded: HashMap<String, bool>,
    pub cursor_key: String,
    pub cursor_index: usize,
    pub notice: Option<String>,
}

impl Store {
    pub fn new(machines: Vec<Machine>) -> Store {
        Store {
            machines,
            open: None,
            expanded: HashMap::new(),
            cursor_key: String::new(),
            cursor_index: 0,
            notice: None,
        }
    }

    fn machine_at(&mut self, name: &str) -> Option<&mut Machine> {
        self.machines.iter_mut().find(|m| m.saved.name == name)
    }

    fn index_of(&self, name: &str) -> Option<usize> {
        self.machines.iter().position(|m| m.saved.name == name)
    }

    /// Fold in one thing a daemon said. Called while the UI drains the queue,
    /// so every change here lands on a frame boundary.
    pub fn apply(&mut self, ev: ClientEvent) {
        match ev {
            ClientEvent::State {
                machine,
                state,
                error,
            } => {
                if let Some(m) = self.machine_at(&machine) {
                    m.conn = state;
                    m.error = error;
                }
            }
            ClientEvent::ShellSnapshot { machine, snapshot } => {
                let snap = *snapshot;
                if let Some(m) = self.machine_at(&machine) {
                    m.info = Some(snap.machine);
                    m.projects = snap
                        .projects
                        .into_iter()
                        .map(|p| (p.id.clone(), p))
                        .collect();
                    m.threads = snap
                        .threads
                        .into_iter()
                        .map(|t| (t.id.clone(), t))
                        .collect();
                }
            }
            ClientEvent::ShellEvent { machine, event } => {
                let Some(mi) = self.index_of(&machine) else {
                    return;
                };
                match event.body {
                    proto::ShellEventBody::MachineUpdated { machine } => {
                        self.machines[mi].info = Some(machine)
                    }
                    proto::ShellEventBody::ProjectUpserted { project } => {
                        self.machines[mi]
                            .projects
                            .insert(project.id.clone(), project);
                    }
                    proto::ShellEventBody::ProjectRemoved { project_id } => {
                        self.machines[mi].projects.remove(&project_id);
                    }
                    proto::ShellEventBody::ThreadUpserted { thread } => {
                        // The thread on screen keeps its own copy up to date
                        // from here too, so the header and the sidebar can
                        // never disagree about whether it is busy.
                        if let Some(open) = self.open.as_mut() {
                            if open.machine == mi && open.thread_id == thread.id {
                                open.thread = Some(thread.clone());
                            }
                        }
                        self.machines[mi].threads.insert(thread.id.clone(), thread);
                    }
                    proto::ShellEventBody::ThreadRemoved { thread_id } => {
                        self.machines[mi].threads.remove(&thread_id);
                    }
                    proto::ShellEventBody::Other => {}
                }
            }
            ClientEvent::ThreadSnapshot {
                machine,
                thread_id,
                snapshot,
            } => {
                let Some(idx) = self.index_of(&machine) else {
                    return;
                };
                // A snapshot that lost the race to a later watch is not the
                // thread on screen. Drop it rather than paint the wrong one.
                let wanted = self
                    .open
                    .as_ref()
                    .is_some_and(|o| o.thread_id == thread_id && o.machine == idx);
                if !wanted {
                    return;
                }
                let snap = *snapshot;
                let open = self.open.as_mut().unwrap();
                open.thread = Some(snap.thread);
                open.items = snap.items;
                open.scroll_from_bottom = 0;
            }
            ClientEvent::ThreadEvent {
                machine,
                thread_id,
                event,
            } => {
                let Some(idx) = self.index_of(&machine) else {
                    return;
                };
                let Some(open) = self.open.as_mut() else {
                    return;
                };
                if open.thread_id != thread_id || open.machine != idx {
                    return;
                }
                match event.body {
                    proto::ThreadEventBody::ItemUpserted { item } => open.upsert(item),
                    proto::ThreadEventBody::ItemRemoved { item_id } => {
                        open.items.retain(|i| i.id != item_id)
                    }
                    proto::ThreadEventBody::ThreadUpdated { thread } => open.thread = Some(thread),
                    _ => {}
                }
            }
            ClientEvent::CallDone { result, tag, .. } => {
                // A command that failed is the one thing here the reader has to
                // be told about; one that worked shows up as the work itself.
                if let Err(e) = result {
                    self.notice = Some(format!("{tag}: {e}"));
                }
            }
        }
    }

    /// Open a thread: ask its machine to watch it, and clear what was there.
    pub fn open_thread(&mut self, machine: usize, thread_id: &str) {
        if let Some(open) = self.open.as_ref() {
            if open.machine != machine {
                if let Some(m) = self.machines.get(open.machine) {
                    m.handle.unwatch_thread();
                }
            }
        }
        self.open = Some(Open {
            machine,
            thread_id: thread_id.to_string(),
            thread: self.machines[machine].threads.get(thread_id).cloned(),
            items: Vec::new(),
            scroll_from_bottom: 0,
            draft: String::new(),
        });
        self.machines[machine].handle.watch_thread(thread_id);
    }

    pub fn is_expanded(&self, key: &str, default_open: bool) -> bool {
        *self.expanded.get(key).unwrap_or(&default_open)
    }

    /// The tree, top to bottom.
    ///
    /// A project row is one repository at one base branch, folded across every
    /// machine that holds it — `project_pool` decides, and it must stay the
    /// only thing that does. Key this on the repository alone and a new thread
    /// starts from the wrong commit.
    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        let mut pools: Vec<PoolBuild> = Vec::new();
        let mut by_key: HashMap<String, usize> = HashMap::new();

        for (mi, m) in self.machines.iter().enumerate() {
            for p in m.projects.values() {
                let key = proto::project_pool(p).unwrap_or_else(|| format!("{mi}:{}", p.id));
                let at = *by_key.entry(key.clone()).or_insert_with(|| {
                    pools.push(PoolBuild {
                        key: key.clone(),
                        title: p.title.clone(),
                        project_ids: Vec::new(),
                        recency: String::new(),
                    });
                    pools.len() - 1
                });
                pools[at].project_ids.push((mi, p.id.clone()));
                if p.updated_at > pools[at].recency {
                    pools[at].recency = p.updated_at.clone();
                }
            }
        }

        // Threads under each pool, newest first, with a thread a program
        // started nested under the thread that started it (#49).
        let mut threads_by_pool: HashMap<String, Vec<(usize, &proto::Thread)>> = HashMap::new();
        for pool in &pools {
            let mut ts: Vec<(usize, &proto::Thread)> = Vec::new();
            for (mi, pid) in &pool.project_ids {
                for t in self.machines[*mi].threads.values() {
                    if &t.project_id == pid && t.archived_at.is_none() && t.moved_to.is_none() {
                        ts.push((*mi, t));
                    }
                }
            }
            ts.sort_by(|a, b| recency(b.1).cmp(recency(a.1)));
            threads_by_pool.insert(pool.key.clone(), ts);
        }

        pools.sort_by(|a, b| {
            let ra = threads_by_pool[&a.key]
                .first()
                .map(|t| recency(t.1))
                .unwrap_or(&a.recency);
            let rb = threads_by_pool[&b.key]
                .first()
                .map(|t| recency(t.1))
                .unwrap_or(&b.recency);
            rb.cmp(ra).then(a.title.cmp(&b.title))
        });

        for pool in &pools {
            let ts = &threads_by_pool[&pool.key];
            let busy = ts.iter().any(|(_, t)| proto::thread_is_busy(t));
            let waiting = ts
                .iter()
                .any(|(_, t)| t.pending_approvals > 0 || t.status == proto::SessionStatus::Waiting);
            rows.push(Row::Project {
                key: pool.key.clone(),
                title: pool.title.clone(),
                threads: ts.len(),
                busy,
                waiting,
            });
            if !self.is_expanded(&pool.key, true) {
                continue;
            }
            // Top-level threads first, then whatever each one started.
            let ids: std::collections::HashSet<&str> =
                ts.iter().map(|(_, t)| t.id.as_str()).collect();
            for (mi, t) in ts {
                let parent = t
                    .origin
                    .as_ref()
                    .and_then(|o| o.parent_thread_id.as_deref());
                // A parent the sidebar cannot find is ignored, and the child
                // stays a top-level row: a thread is never hidden by a link
                // that leads nowhere.
                if parent.is_some_and(|p| ids.contains(p)) {
                    continue;
                }
                rows.push(Row::Thread {
                    machine: *mi,
                    thread_id: t.id.clone(),
                    depth: 1,
                });
                push_children(&mut rows, ts, &t.id, 2);
            }
        }

        if pools.is_empty() {
            rows.push(Row::Empty);
        }

        rows.push(Row::MachinesHeader);
        if self.is_expanded(MACHINES_KEY, false) {
            for i in 0..self.machines.len() {
                rows.push(Row::Machine { machine: i });
            }
        }
        rows
    }

    /// The lines to paint, scrolled so `cursor` is visible.
    ///
    /// Centring the cursor keeps this a pure function of the state we already
    /// have, with no scroll offset to remember or to get out of step.
    pub fn cells(rows: &[Row], cursor: usize, height: usize) -> Vec<Cell> {
        if height == 0 {
            return Vec::new();
        }
        let mut all = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            if i > 0 && matches!(r, Row::Project { .. } | Row::MachinesHeader) {
                all.push(Cell::Blank);
            }
            all.push(Cell::Row(i));
        }
        if all.len() <= height {
            return all;
        }
        let at = all
            .iter()
            .position(|c| *c == Cell::Row(cursor))
            .unwrap_or(0);
        let start = at
            .saturating_sub(height / 2)
            .min(all.len().saturating_sub(height));
        all[start..start + height].to_vec()
    }

    /// Where the cursor sits now.
    ///
    /// `last` is the index it was on before. A key cannot say where its row
    /// used to be, so when the row goes — archived, deleted, folded away with
    /// its project — this is what puts the cursor next to where it was instead
    /// of at the top of the tree.
    pub fn cursor_index_in(rows: &[Row], key: &str, last: usize) -> usize {
        match rows.iter().position(|r| r.key() == key) {
            Some(at) => at,
            None => last.min(rows.len().saturating_sub(1)),
        }
    }
}

struct PoolBuild {
    key: String,
    title: String,
    project_ids: Vec<(usize, String)>,
    recency: String,
}

fn push_children(rows: &mut Vec<Row>, ts: &[(usize, &proto::Thread)], parent: &str, depth: usize) {
    // A tree deep enough to run out of sidebar is a tree nobody meant to make.
    if depth > 6 {
        return;
    }
    for (mi, t) in ts {
        let is_child = t
            .origin
            .as_ref()
            .and_then(|o| o.parent_thread_id.as_deref())
            == Some(parent);
        if !is_child {
            continue;
        }
        rows.push(Row::Thread {
            machine: *mi,
            thread_id: t.id.clone(),
            depth,
        });
        push_children(rows, ts, &t.id, depth + 1);
    }
}

/// When a thread last did anything. `last_message_at` is what a reader means by
/// "recent"; `updated_at` catches a thread that has changed without speaking.
fn recency(t: &proto::Thread) -> &str {
    match t.last_message_at.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => &t.updated_at,
    }
}

/// How far from the left a row of each kind starts, in columns.
///
/// One number cannot serve every kind, because they spend different room before
/// the title: a thread row keeps a gutter for the caret or the `◇` and two more
/// for its status dot. These put a thread at the same column whatever started
/// it, which is what makes the indent read as "under" rather than as a second
/// kind of list.
pub fn thread_indent(depth: usize) -> usize {
    (1 + 2 * depth.saturating_sub(1)).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, project: &str, parent: Option<&str>, at: &str) -> proto::Thread {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "projectId": project,
            "title": id,
            "status": "idle",
            "permissionMode": "default",
            "pendingApprovals": 0,
            "queuedTurns": 0,
            "lastMessageAt": at,
            "updatedAt": at,
            "origin": parent.map(|p| serde_json::json!({ "by": "agent", "parentThreadId": p })),
        }))
        .unwrap()
    }

    fn item(id: &str, seq: i64, text: &str) -> proto::TimelineItem {
        serde_json::from_value(serde_json::json!({
            "id": id, "threadId": "t", "seq": seq,
            "kind": "assistant", "text": text, "streaming": false,
        }))
        .unwrap()
    }

    #[test]
    fn a_streaming_item_replaces_in_place_and_never_appends_a_second_copy() {
        // Timeline streaming re-sends the whole item under the same id as it
        // grows. An upsert that appended would paint the reply twice, once
        // short and once long.
        let mut open = Open::default();
        open.upsert(item("a", 1, "he"));
        open.upsert(item("b", 2, "tool"));
        open.upsert(item("a", 1, "hello"));
        assert_eq!(open.items.len(), 2);
        assert_eq!(open.items[0].id, "a");
        match &open.items[0].body {
            proto::ItemBody::Assistant { text, .. } => assert_eq!(text, "hello"),
            _ => panic!("wrong kind"),
        }
    }

    #[test]
    fn an_item_that_arrives_out_of_order_lands_at_its_seq() {
        // A reconnect replays, and a replay can fill a gap after the items
        // around it have already been painted.
        let mut open = Open::default();
        open.upsert(item("c", 3, "third"));
        open.upsert(item("a", 1, "first"));
        open.upsert(item("b", 2, "second"));
        let seqs: Vec<i64> = open.items.iter().map(|i| i.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn a_blank_line_sits_above_every_project_but_the_first_and_above_the_fleet() {
        let rows = vec![
            Row::Project {
                key: "a".into(),
                title: "a".into(),
                threads: 0,
                busy: false,
                waiting: false,
            },
            Row::Thread {
                machine: 0,
                thread_id: "t".into(),
                depth: 1,
            },
            Row::Project {
                key: "b".into(),
                title: "b".into(),
                threads: 0,
                busy: false,
                waiting: false,
            },
            Row::MachinesHeader,
        ];
        let cells = Store::cells(&rows, 0, 20);
        assert_eq!(
            cells,
            vec![
                Cell::Row(0),
                Cell::Row(1),
                Cell::Blank,
                Cell::Row(2),
                Cell::Blank,
                Cell::Row(3),
            ]
        );
    }

    #[test]
    fn the_window_centres_the_cursor_and_never_runs_off_the_end() {
        let rows: Vec<Row> = (0..20)
            .map(|i| Row::Thread {
                machine: 0,
                thread_id: format!("t{i}"),
                depth: 1,
            })
            .collect();
        let cells = Store::cells(&rows, 10, 5);
        assert_eq!(cells.len(), 5);
        assert!(cells.contains(&Cell::Row(10)));
        // At the end the window stops rather than scrolling past the last row.
        let cells = Store::cells(&rows, 19, 5);
        assert_eq!(cells.last(), Some(&Cell::Row(19)));
    }

    #[test]
    fn the_cursor_is_held_by_key_because_the_tree_re_sorts_under_it() {
        let rows = vec![
            Row::Thread {
                machine: 0,
                thread_id: "b".into(),
                depth: 1,
            },
            Row::Thread {
                machine: 0,
                thread_id: "a".into(),
                depth: 1,
            },
        ];
        // `a` was at index 0 and is now at index 1. Following the key keeps the
        // cursor on the thread the reader was looking at.
        assert_eq!(Store::cursor_index_in(&rows, "t:0:a", 0), 1);
        // A row that has gone leaves the cursor where it was, not at the top.
        assert_eq!(Store::cursor_index_in(&rows, "t:0:gone", 1), 1);
    }

    #[test]
    fn a_thread_a_program_started_sits_under_the_thread_that_started_it() {
        let parent = thread("parent", "p", None, "3");
        let child = thread("child", "p", Some("parent"), "2");
        let other = thread("other", "p", None, "1");
        let ts: Vec<(usize, &proto::Thread)> = vec![(0, &parent), (0, &child), (0, &other)];
        let mut rows = Vec::new();
        push_children(&mut rows, &ts, "parent", 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0],
            Row::Thread {
                machine: 0,
                thread_id: "child".into(),
                depth: 2
            }
        );
    }

    #[test]
    fn a_parent_the_sidebar_cannot_find_leaves_its_child_a_top_level_row() {
        // The parent is on another machine, or archived. The child must still
        // be reachable; a thread is never hidden by a link that leads nowhere.
        let child = thread("child", "p", Some("missing"), "1");
        let ts: Vec<(usize, &proto::Thread)> = vec![(0, &child)];
        let ids: std::collections::HashSet<&str> = ts.iter().map(|(_, t)| t.id.as_str()).collect();
        let parent = ts[0]
            .1
            .origin
            .as_ref()
            .and_then(|o| o.parent_thread_id.as_deref());
        assert!(!parent.is_some_and(|p| ids.contains(p)));
    }

    #[test]
    fn a_thread_indents_two_columns_per_level() {
        assert_eq!(thread_indent(1), 1);
        assert_eq!(thread_indent(2), 3);
        assert_eq!(thread_indent(3), 5);
    }
}
