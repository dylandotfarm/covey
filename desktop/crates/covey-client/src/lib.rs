//! One connection to one covey daemon.
//!
//! The port of `packages/client/src/client.ts`. It owns the same three things:
//! reconnect (one retry owner), the shell subscription with seq-based replay,
//! and at most one thread subscription — the thread on screen.
//!
//! What is new here is the shape, not the rules. The TypeScript client calls
//! the store back; this one is a task on a tokio runtime and speaks to the UI
//! through a queue. That difference is worth having on purpose. covey's paint
//! budget has one rule above the rest: what the reader did paints at once, and
//! what a daemon said paints on a frame boundary (`CLAUDE.md`, and `set` against
//! `setFromMachine` in the TUI's store). Here the reader's keystroke is a
//! function call on the UI thread, and everything a daemon says is a message in
//! a queue the UI drains once per frame. The rule is the architecture, so no
//! callback can break it by accident.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use covey_protocol as proto;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// What the socket is doing, as the sidebar reads it.
///
/// `Offline` is the one that is not about the socket: it means the client has
/// stopped dialling. The other four all say "a connection is on its way, or was
/// a moment ago", which is why a machine that had been off since breakfast used
/// to read the same as one about to answer (issue #68).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Connecting,
    Connected,
    Disconnected,
    Error,
    Offline,
}

impl ConnState {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnState::Connecting => "connecting",
            ConnState::Connected => "connected",
            ConnState::Disconnected => "disconnected",
            ConnState::Error => "error",
            ConnState::Offline => "offline",
        }
    }
}

/// How many dials a machine gets before the client calls it offline and stops.
///
/// Three numbers because the three cases are not the same problem:
///
/// - `first` — the machine has never answered. The likely cause is a typo in
///   the URL or a port nothing listens on, and the reader wants to hear that
///   now, not in an hour.
/// - `again` — it answered before, so the address is right and something else
///   went away: a laptop lid, a tailnet hiccup, a daemon that crashed. That
///   earns more patience.
/// - `restarting` — we asked the daemon to restart, so the drop is the request
///   working. Forty dials at the 8 s ceiling is about five minutes, which
///   covers a pull, a rebuild and a restart on the slowest machine in a fleet,
///   and still ends.
pub const TRIES_FIRST: u32 = 3;
pub const TRIES_AGAIN: u32 = 6;
pub const TRIES_RESTARTING: u32 = 40;

const BACKOFF_MS: &[u64] = &[500, 1000, 2000, 4000, 8000];

/// How long to wait for the handshake. A host that drops packets rather than
/// refusing them would otherwise hold a dial open for the operating system's
/// own timeout, which is minutes.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The deadline for one call. A caller that knows the daemon gives itself
/// longer — a clone gets ten minutes — says so with `rpc_timeout`.
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

/// What the daemon gives itself for a command that clones a repository.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

/// The daemon's socket accepts 64 MB, because one drop may carry 32 MB of
/// bytes and base64 is a third larger again. Read the same size, or a drop
/// echoed back in a snapshot tears the connection down.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// How many timeline items a first paint asks for.
const SNAPSHOT_LIMIT: u32 = 300;

/// Everything a daemon says, in the order it said it.
///
/// The UI drains this once per frame. Nothing here paints on its own.
#[derive(Debug)]
pub enum ClientEvent {
    State {
        machine: String,
        state: ConnState,
        error: Option<String>,
    },
    ShellSnapshot {
        machine: String,
        snapshot: Box<proto::ShellSnapshot>,
    },
    ShellEvent {
        machine: String,
        event: Box<proto::ShellEvent>,
    },
    ThreadSnapshot {
        machine: String,
        thread_id: String,
        snapshot: Box<proto::ThreadSnapshot>,
    },
    ThreadEvent {
        machine: String,
        thread_id: String,
        event: Box<proto::ThreadEvent>,
    },
    /// A call the UI asked for came back. `tag` is what the UI called it.
    CallDone {
        machine: String,
        tag: String,
        result: Result<Value, String>,
    },
}

/// What the UI asks of one machine.
#[derive(Debug)]
enum Request {
    /// Watch a thread from a fresh snapshot.
    Watch {
        thread_id: String,
    },
    Unwatch,
    /// One command, already carrying its `commandId`.
    Command {
        tag: String,
        command: Value,
    },
    /// Dial again now, with a fresh budget. This is what the reader presses on
    /// an offline row.
    Retry,
    /// The daemon is about to go away because we asked it to.
    ExpectRestart,
    Stop,
}

/// The seq cursors, shared between the supervisor and the tasks it spawns.
///
/// Small on purpose. Everything else the connection knows lives in the
/// supervisor's own stack frame, where nothing can race it.
struct Cursors {
    /// -1 until the first shell snapshot. A reconnect resubscribes from here
    /// rather than asking for the snapshot again, so a drop costs one round
    /// trip and no rebuild of the sidebar.
    shell_seq: i64,
    thread: Option<ThreadSub>,
}

#[derive(Clone)]
struct ThreadSub {
    thread_id: String,
    sub_id: Option<String>,
    seq: i64,
}

impl Cursors {
    fn new() -> Self {
        Cursors {
            shell_seq: -1,
            thread: None,
        }
    }
}

/// The way anything on the runtime hands an event to the UI.
///
/// It carries the machine's name so no caller has to remember to fill it in,
/// and it calls `repaint` after every event — which is the only thing that
/// wakes a window that is otherwise asleep. An idle covey client must cost
/// nothing, so nothing here paints on a timer.
#[derive(Clone)]
struct Emitter {
    machine: String,
    events: mpsc::UnboundedSender<ClientEvent>,
    repaint: Arc<dyn Fn() + Send + Sync>,
}

impl Emitter {
    fn send(&self, ev: ClientEvent) {
        let _ = self.events.send(ev);
        (self.repaint)();
    }

    fn state(&self, state: ConnState, error: Option<String>) {
        self.send(ClientEvent::State {
            machine: self.machine.clone(),
            state,
            error,
        });
    }

    fn name(&self) -> String {
        self.machine.clone()
    }
}

/// The handle the UI holds. Cloneable, and every method returns at once.
#[derive(Clone)]
pub struct MachineHandle {
    pub name: String,
    tx: mpsc::UnboundedSender<Request>,
}

impl MachineHandle {
    /// A handle with nothing on the other end.
    ///
    /// For a test that builds a screen without a daemon: every request it sends
    /// is dropped, which is exactly what a paint wants and what a test of a
    /// paint should not have to mock.
    pub fn detached(name: &str) -> MachineHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        MachineHandle {
            name: name.to_string(),
            tx,
        }
    }

    pub fn watch_thread(&self, thread_id: &str) {
        let _ = self.tx.send(Request::Watch {
            thread_id: thread_id.to_string(),
        });
    }

    pub fn unwatch_thread(&self) {
        let _ = self.tx.send(Request::Unwatch);
    }

    /// Send one command. `tag` comes back on the `CallDone` event, so the UI
    /// can tell which of several commands answered.
    ///
    /// The `commandId` is minted here, which is what makes a retry idempotent:
    /// the daemon has seen the id before and does the work once.
    pub fn command(&self, tag: &str, mut command: Value) {
        if let Some(obj) = command.as_object_mut() {
            obj.insert(
                "commandId".into(),
                Value::String(uuid::Uuid::new_v4().to_string()),
            );
        }
        let _ = self.tx.send(Request::Command {
            tag: tag.to_string(),
            command,
        });
    }

    pub fn retry(&self) {
        let _ = self.tx.send(Request::Retry);
    }

    pub fn expect_restart(&self) {
        let _ = self.tx.send(Request::ExpectRestart);
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Request::Stop);
    }
}

/// The calls waiting for an answer, by the id they were sent under.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A connection that is open: the way to make a call on it.
#[derive(Clone)]
struct Conn {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
}

impl Conn {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        self.rpc_timeout(method, params, RPC_TIMEOUT).await
    }

    async fn rpc_timeout(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = json!({ "id": id, "method": method, "params": params });
        if self.out.send(frame.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("not connected".into());
        }
        match tokio::time::timeout(deadline, rx).await {
            Ok(Ok(res)) => res,
            // The socket went and drained the map. `attempt_connection` has
            // already answered every waiter, so this is the answer arriving.
            Ok(Err(_)) => Err("disconnected".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method} timed out"))
            }
        }
    }
}

/// Start one machine's connection on the runtime, and hand back its handle.
///
/// `repaint` is what wakes the window. In the app it is
/// `egui::Context::request_repaint`.
pub fn spawn(
    rt: &tokio::runtime::Handle,
    saved: proto::SavedMachine,
    events: mpsc::UnboundedSender<ClientEvent>,
    repaint: Arc<dyn Fn() + Send + Sync>,
) -> MachineHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = MachineHandle {
        name: saved.name.clone(),
        tx,
    };
    let emit = Emitter {
        machine: saved.name.clone(),
        events,
        repaint,
    };
    rt.spawn(supervise(saved, rx, emit));
    handle
}

/// The retry owner. One of these per machine, and never two: a second dial
/// would orphan the first, whose own close would then schedule a third.
async fn supervise(
    saved: proto::SavedMachine,
    mut requests: mpsc::UnboundedReceiver<Request>,
    emit: Emitter,
) {
    let cursors = Arc::new(Mutex::new(Cursors::new()));
    let mut attempt: u32 = 0;
    // The machine has answered at least once, so its address is not the problem.
    let mut ever_connected = false;
    // We asked the daemon to restart, so the drop that follows is expected.
    let mut expecting_restart = false;
    // Why the last dial failed, kept so the offline row can say more than
    // "offline".
    let mut last_error: Option<String> = None;

    loop {
        // Counted here rather than where the retry is scheduled, so the number
        // is "dials made" and the cap reads as the number of dials it is.
        attempt += 1;
        emit.state(ConnState::Connecting, None);

        match attempt_connection(&saved, &cursors, &emit, &mut requests).await {
            Outcome::Stopped => return,
            Outcome::Ended(why) => {
                // The budget resets when the machine answered `hello`, not when
                // the socket opened: a socket that opens is not a machine that
                // answered. A daemon a protocol version behind opens every
                // socket and refuses every hello, and a budget that reset on
                // open would never run out on it.
                attempt = 0;
                ever_connected = true;
                expecting_restart = false;
                last_error = why;
            }
            Outcome::Failed(why) => last_error = Some(why),
            Outcome::Restarting => {
                expecting_restart = true;
                attempt = 0;
            }
        }

        // Every call in flight died with the socket, and so did the thread
        // subscription's id. The seq it had reached does not die, because that
        // is what the replay asks from.
        if let Some(sub) = cursors.lock().unwrap().thread.as_mut() {
            sub.sub_id = None;
        }

        let budget = if expecting_restart {
            TRIES_RESTARTING
        } else if ever_connected {
            TRIES_AGAIN
        } else {
            TRIES_FIRST
        };

        if attempt >= budget {
            emit.state(ConnState::Offline, Some(give_up(&last_error, budget)));
            // Nothing restarts this but `retry` or `expect_restart`. There is
            // no heartbeat, and issue #68 is why.
            match wait_for_wake(&mut requests).await {
                Wake::Stop => return,
                Wake::Retry => {
                    attempt = 0;
                    last_error = None;
                }
                Wake::Restart => {
                    expecting_restart = true;
                    attempt = 0;
                }
            }
            continue;
        }

        // "offline" replaces "disconnected" rather than following it: one drop
        // is one thing to say, and saying both would paint the row twice.
        emit.state(
            if last_error.is_some() {
                ConnState::Error
            } else {
                ConnState::Disconnected
            },
            last_error.clone(),
        );

        let delay = backoff_for(attempt);
        // A retry pressed during the wait skips the rest of it. The reader
        // asked for a dial now, and a row that sits still for eight seconds
        // after they pressed reads as a client that did not hear them.
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            req = requests.recv() => match req {
                None | Some(Request::Stop) => return,
                Some(Request::Retry) => { attempt = 0; last_error = None; }
                Some(Request::ExpectRestart) => { expecting_restart = true; attempt = 0; }
                Some(_) => {} // a command with no socket to carry it
            }
        }
    }
}

/// Stop dialling and say why.
///
/// The reason carries the last error rather than flattening it: a host that is
/// off and a token the daemon refuses both end here, and they are not the same
/// problem. Silence says nothing the count does not already say better.
fn give_up(last_error: &Option<String>, budget: u32) -> String {
    match last_error {
        Some(e) if !is_silence(e) => e.clone(),
        _ => format!("no answer after {budget} tries"),
    }
}

/// `attempt - 1` because the dial has already been counted. It is 0 only just
/// after a connection that worked, and there the wait is the first delay rather
/// than none.
fn backoff_for(attempt: u32) -> Duration {
    let idx = (attempt.saturating_sub(1) as usize).min(BACKOFF_MS.len() - 1);
    Duration::from_millis(BACKOFF_MS[idx])
}

enum Outcome {
    /// The socket opened, `hello` was answered, and the connection has now
    /// ended. The string is why, when the far end said.
    Ended(Option<String>),
    Failed(String),
    Restarting,
    Stopped,
}

enum Wake {
    Retry,
    Restart,
    Stop,
}

async fn wait_for_wake(requests: &mut mpsc::UnboundedReceiver<Request>) -> Wake {
    loop {
        match requests.recv().await {
            None | Some(Request::Stop) => return Wake::Stop,
            Some(Request::Retry) => return Wake::Retry,
            // A restart asked for after the client already gave up has to start
            // dialling again; nothing else will.
            Some(Request::ExpectRestart) => return Wake::Restart,
            Some(_) => {}
        }
    }
}

async fn attempt_connection(
    saved: &proto::SavedMachine,
    cursors: &Arc<Mutex<Cursors>>,
    emit: &Emitter,
    requests: &mut mpsc::UnboundedReceiver<Request>,
) -> Outcome {
    let url = match dial_url(saved) {
        Ok(u) => u,
        Err(e) => return Outcome::Failed(e.to_string()),
    };

    let config = WebSocketConfig {
        max_message_size: Some(MAX_FRAME_BYTES),
        max_frame_size: Some(MAX_FRAME_BYTES),
        ..WebSocketConfig::default()
    };
    let connect = tokio_tungstenite::connect_async_with_config(url, Some(config), false);
    let socket = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connect).await {
        Err(_) => return Outcome::Failed("handshake has timed out".into()),
        Ok(Err(e)) => return Outcome::Failed(refusal(&e.to_string())),
        Ok(Ok((s, _))) => s,
    };

    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let conn = Conn {
        out: out_tx,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
    };

    // `hello` is answered before the loop that routes every other answer
    // exists, so it is read here by hand.
    if let Err(e) = say_hello(&conn, &mut stream).await {
        writer.abort();
        return Outcome::Failed(e);
    }
    emit.state(ConnState::Connected, None);

    // Resubscribe runs behind the first paint rather than in front of it: the
    // daemon replays from the seq we give, so nothing that happens while a
    // subscription is opening is lost.
    tokio::spawn(resubscribe(conn.clone(), cursors.clone(), emit.clone()));

    let mut restarting = false;
    let ended = loop {
        tokio::select! {
            msg = stream.next() => match msg {
                None => break None,
                Some(Err(e)) => break Some(e.to_string()),
                Some(Ok(Message::Close(_))) => break None,
                Some(Ok(Message::Text(text))) => on_message(&text, &conn, cursors, emit),
                Some(Ok(_)) => {}
            },
            req = requests.recv() => match req {
                None | Some(Request::Stop) => {
                    writer.abort();
                    return Outcome::Stopped;
                }
                Some(Request::Retry) => {} // already connected
                Some(Request::ExpectRestart) => restarting = true,
                Some(Request::Watch { thread_id }) => {
                    tokio::spawn(watch_thread(conn.clone(), cursors.clone(), thread_id, emit.clone()));
                }
                Some(Request::Unwatch) => {
                    let sub = cursors.lock().unwrap().thread.take();
                    if let Some(ThreadSub { sub_id: Some(id), .. }) = sub {
                        drop_subscription(&conn, id);
                    }
                }
                Some(Request::Command { tag, command }) => {
                    let conn = conn.clone();
                    let emit = emit.clone();
                    tokio::spawn(async move {
                        let result = conn.rpc_timeout("command", command, COMMAND_TIMEOUT).await;
                        emit.send(ClientEvent::CallDone { machine: emit.name(), tag, result });
                    });
                }
            },
        }
    };

    // The socket went. Every call still waiting has to be told, or its caller
    // waits out a minute of timeout for an answer that will never come.
    let waits: Vec<_> = conn
        .pending
        .lock()
        .unwrap()
        .drain()
        .map(|(_, tx)| tx)
        .collect();
    for w in waits {
        let _ = w.send(Err("disconnected".into()));
    }
    writer.abort();

    if restarting {
        Outcome::Restarting
    } else {
        Outcome::Ended(ended)
    }
}

/// Say `hello` and read its answer off the stream directly.
///
/// The machine's own record comes back here, but the shell snapshot carries it
/// too and that is where the UI reads it, so this only has to succeed.
async fn say_hello<S>(conn: &Conn, stream: &mut S) -> Result<(), String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let id = conn.next_id.fetch_add(1, Ordering::Relaxed);
    let frame = json!({
        "id": id,
        "method": "hello",
        "params": {
            "protocolVersion": proto::PROTOCOL_VERSION,
            "client": proto::DESKTOP_CLIENT,
        },
    });
    conn.out
        .send(frame.to_string())
        .map_err(|_| "disconnected".to_string())?;

    let deadline = tokio::time::Instant::now() + RPC_TIMEOUT;
    loop {
        let text = match tokio::time::timeout_at(deadline, stream.next()).await {
            Err(_) => return Err("hello timed out".into()),
            // The socket went first. "disconnected" is silence with extra
            // steps, and the attempt count says it better.
            Ok(None) | Ok(Some(Ok(Message::Close(_)))) => return Err("disconnected".into()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(Message::Text(t)))) => t,
            Ok(Some(Ok(_))) => continue,
        };
        let Ok(proto::WireFromDaemon::Response(r)) = serde_json::from_str(&text) else {
            continue;
        };
        if r.id != id {
            continue;
        }
        return if r.ok {
            Ok(())
        } else {
            Err(r
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "hello refused".into()))
        };
    }
}

fn drop_subscription(conn: &Conn, id: String) {
    let conn = conn.clone();
    tokio::spawn(async move {
        let _ = conn
            .rpc("unsubscribe", json!({ "subscriptionId": id }))
            .await;
    });
}

fn dial_url(saved: &proto::SavedMachine) -> Result<String> {
    let mut url = url::Url::parse(&saved.url).map_err(|e| anyhow!("bad url: {e}"))?;
    if let Some(token) = saved.token.as_deref().filter(|t| !t.is_empty()) {
        url.query_pairs_mut().append_pair("token", token);
    }
    Ok(url.to_string())
}

async fn resubscribe(conn: Conn, cursors: Arc<Mutex<Cursors>>, emit: Emitter) {
    let have_shell = cursors.lock().unwrap().shell_seq >= 0;
    if !have_shell {
        let Ok(raw) = conn.rpc("shell.snapshot", json!({})).await else {
            return;
        };
        let Ok(snap) = serde_json::from_value::<proto::ShellSnapshot>(raw) else {
            return;
        };
        cursors.lock().unwrap().shell_seq = snap.seq;
        emit.send(ClientEvent::ShellSnapshot {
            machine: emit.name(),
            snapshot: Box::new(snap),
        });
    }
    let after = cursors.lock().unwrap().shell_seq;
    let _ = conn
        .rpc("shell.subscribe", json!({ "afterSeq": after }))
        .await;

    // A thread was on screen when the socket went. Open its subscription again
    // from the seq it had reached, so the transcript fills the gap in rather
    // than being rebuilt.
    let sub = cursors.lock().unwrap().thread.clone();
    if let Some(sub) = sub {
        open_thread_sub(&conn, &cursors, &sub.thread_id, sub.seq).await;
    }
}

async fn open_thread_sub(conn: &Conn, cursors: &Arc<Mutex<Cursors>>, thread_id: &str, after: i64) {
    let Ok(res) = conn
        .rpc(
            "thread.subscribe",
            json!({ "threadId": thread_id, "afterSeq": after }),
        )
        .await
    else {
        return;
    };
    let id = res
        .get("subscriptionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let mine = {
        let mut c = cursors.lock().unwrap();
        match c.thread.as_mut() {
            Some(sub) if sub.thread_id == thread_id => {
                sub.sub_id = Some(id.clone());
                true
            }
            _ => false,
        }
    };
    // A later watch already owns the stream. Do not take it back; drop the
    // subscription we just opened instead.
    if !mine {
        drop_subscription(conn, id);
    }
}

/// Watch a thread: the snapshot, then the stream.
///
/// Only the snapshot is on the critical path. Dropping the previous
/// subscription and opening the new one are the daemon's business, so they run
/// behind the first paint rather than costing two more round trips before it —
/// which is what browsing the sidebar over a tailnet was paying per row. The
/// new subscription carries `afterSeq = snap.seq`, so nothing that happens
/// while it opens is lost; it is replayed.
async fn watch_thread(conn: Conn, cursors: Arc<Mutex<Cursors>>, thread_id: String, emit: Emitter) {
    let previous = cursors.lock().unwrap().thread.take();
    if let Some(ThreadSub {
        sub_id: Some(id), ..
    }) = previous
    {
        drop_subscription(&conn, id);
    }

    let Ok(raw) = conn
        .rpc(
            "thread.snapshot",
            json!({ "threadId": &thread_id, "limit": SNAPSHOT_LIMIT }),
        )
        .await
    else {
        return;
    };
    let Ok(snap) = serde_json::from_value::<proto::ThreadSnapshot>(raw) else {
        return;
    };

    // Another watch started while the snapshot was in flight. Hand the snapshot
    // up anyway — the UI decides whether it is still wanted — but do not take
    // the stream from under it.
    let stale = {
        let mut c = cursors.lock().unwrap();
        match c.thread.as_ref() {
            Some(sub) if sub.thread_id != thread_id => true,
            _ => {
                c.thread = Some(ThreadSub {
                    thread_id: thread_id.clone(),
                    sub_id: None,
                    seq: snap.seq,
                });
                false
            }
        }
    };
    let seq = snap.seq;
    emit.send(ClientEvent::ThreadSnapshot {
        machine: emit.name(),
        thread_id: thread_id.clone(),
        snapshot: Box::new(snap),
    });
    if !stale {
        open_thread_sub(&conn, &cursors, &thread_id, seq).await;
    }
}

fn on_message(text: &str, conn: &Conn, cursors: &Arc<Mutex<Cursors>>, emit: &Emitter) {
    let Ok(wire) = serde_json::from_str::<proto::WireFromDaemon>(text) else {
        return;
    };
    match wire {
        proto::WireFromDaemon::Response(r) => {
            let Some(tx) = conn.pending.lock().unwrap().remove(&r.id) else {
                return;
            };
            let _ = tx.send(if r.ok {
                Ok(r.result.unwrap_or(Value::Null))
            } else {
                Err(r
                    .error
                    .map(|e| e.message)
                    .unwrap_or_else(|| "refused".into()))
            });
        }
        proto::WireFromDaemon::Push(proto::PushMessage::Shell { event, .. }) => {
            // Replay overlap. A reconnect asks from the seq we hold, and the
            // daemon is allowed to send one we already had.
            {
                let mut c = cursors.lock().unwrap();
                if event.seq <= c.shell_seq {
                    return;
                }
                c.shell_seq = event.seq;
            }
            emit.send(ClientEvent::ShellEvent {
                machine: emit.name(),
                event: Box::new(event),
            });
        }
        proto::WireFromDaemon::Push(proto::PushMessage::Thread {
            thread_id, event, ..
        }) => {
            {
                let mut c = cursors.lock().unwrap();
                let Some(sub) = c.thread.as_mut() else { return };
                if sub.thread_id != thread_id {
                    return;
                }
                // An `item.upserted` is let through even at a seq already seen.
                // Timeline streaming re-sends the whole item under the same id
                // as it grows, and there is no delta channel — so the seq of a
                // growing item does not move, and a check that dropped it would
                // freeze every reply at its first token.
                let upsert = matches!(event.body, proto::ThreadEventBody::ItemUpserted { .. });
                if event.seq <= sub.seq && !upsert {
                    return;
                }
                sub.seq = sub.seq.max(event.seq);
            }
            emit.send(ClientEvent::ThreadEvent {
                machine: emit.name(),
                thread_id,
                event: Box::new(event),
            });
        }
        proto::WireFromDaemon::Push(_) => {}
    }
}

/// The words for a handshake the daemon refused, where the socket says the
/// status. 401 is the one a reader can act on.
fn refusal(message: &str) -> String {
    if message.contains("401") {
        return "unauthorized (not a tailnet peer of the owner, or bad token)".into();
    }
    message.to_string()
}

/// True when the error only means "nobody answered" — which the attempt count
/// already says, and better. Anything else is a machine that is there and said
/// no, and the reader needs the words.
fn is_silence(message: &str) -> bool {
    if message == "disconnected" {
        return true;
    }
    const QUIET: &[&str] = &[
        "Connection refused",
        "No route to host",
        "Network is unreachable",
        "timed out",
        "failed to lookup address",
        "os error 111",
        "os error 113",
    ];
    QUIET.iter().any(|q| message.contains(q))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(token: Option<&str>) -> proto::SavedMachine {
        proto::SavedMachine {
            name: "local".into(),
            url: "ws://127.0.0.1:3790".into(),
            token: token.map(str::to_string),
            machine_id: None,
        }
    }

    #[test]
    fn a_token_rides_on_the_query_string() {
        assert_eq!(
            dial_url(&saved(Some("abc"))).unwrap(),
            "ws://127.0.0.1:3790/?token=abc"
        );
    }

    #[test]
    fn an_empty_token_is_no_token() {
        assert!(!dial_url(&saved(Some(""))).unwrap().contains("token"));
        assert!(!dial_url(&saved(None)).unwrap().contains("token"));
    }

    #[test]
    fn a_refused_handshake_says_what_the_reader_can_act_on() {
        assert_eq!(
            refusal("HTTP error: 401 Unauthorized"),
            "unauthorized (not a tailnet peer of the owner, or bad token)"
        );
        assert_eq!(refusal("Connection reset"), "Connection reset");
    }

    #[test]
    fn silence_is_told_from_a_refusal() {
        // Silence says nothing the attempt count does not already say better,
        // so the offline row keeps the count. A refusal is a machine that is
        // there and said no, and those words are the whole answer.
        assert!(is_silence("Connection refused (os error 111)"));
        assert!(is_silence("disconnected"));
        assert!(!is_silence(
            "unauthorized (not a tailnet peer of the owner, or bad token)"
        ));
        assert!(!is_silence("protocol version 2 is not supported"));
    }

    #[test]
    fn giving_up_keeps_the_words_of_a_refusal_and_drops_silence() {
        assert_eq!(
            give_up(&Some("unauthorized (bad token)".into()), 6),
            "unauthorized (bad token)"
        );
        assert_eq!(
            give_up(&Some("Connection refused (os error 111)".into()), 3),
            "no answer after 3 tries"
        );
        assert_eq!(give_up(&None, 40), "no answer after 40 tries");
    }

    #[test]
    fn the_backoff_walks_and_then_holds() {
        // Attempt 0 happens only just after a connection that worked; there the
        // wait is the first delay rather than none.
        assert_eq!(backoff_for(0), Duration::from_millis(500));
        assert_eq!(backoff_for(1), Duration::from_millis(500));
        assert_eq!(backoff_for(5), Duration::from_millis(8000));
        // Every dial past the walk waits at the ceiling, so `TRIES_RESTARTING`
        // is about five minutes — a pull, a rebuild and a restart.
        assert_eq!(backoff_for(TRIES_RESTARTING), Duration::from_millis(8000));
        assert_eq!(BACKOFF_MS.iter().sum::<u64>(), 15_500);
    }

    #[test]
    fn a_command_carries_an_id_the_daemon_can_deduplicate() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = MachineHandle {
            name: "local".into(),
            tx,
        };
        h.command("send", json!({ "type": "turn.interrupt", "threadId": "t" }));
        let Some(Request::Command { command, tag }) = rx.try_recv().ok() else {
            panic!("no command");
        };
        assert_eq!(tag, "send");
        assert!(command["commandId"].as_str().is_some_and(|s| s.len() == 36));
    }
}
