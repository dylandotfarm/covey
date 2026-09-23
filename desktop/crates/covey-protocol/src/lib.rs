//! The covey wire protocol, as the Rust desktop client reads it.
//!
//! This mirrors `packages/protocol/src/index.ts`, which stays the one place
//! the protocol is defined. Two rules keep the mirror from cracking:
//!
//! 1. **Read loosely, write exactly.** Every record the daemon sends carries
//!    fields this client does not know, and it gains more with every release.
//!    So no struct refuses an unknown field, every field a daemon may omit is
//!    `#[serde(default)]`, and every tagged union has a fallback variant. A
//!    daemon newer than this client paints; it does not fail.
//! 2. **Keep the names.** The wire is camelCase and the field names are the
//!    TypeScript ones. Rename at the serde layer, never in the struct, so a
//!    reader can put the two files side by side.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The version the daemon checks at `hello`. Bump it with the TypeScript one.
pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 3790;

/// The `client` name this app gives at `hello`.
///
/// Not `covey-tui` and not `covey-web`. `isUserClient` in the TypeScript owns
/// the list of clients a person types into, and a name it does not know reads
/// as a program — so a thread this app creates would be filed as an agent's
/// until that function learns this name too.
pub const DESKTOP_CLIENT: &str = "covey-desktop";

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub machine_id: String,
    pub name: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub daemon_version: String,
    #[serde(default)]
    pub protocol_version: u32,
    #[serde(default)]
    pub claude_code_version: Option<String>,
    #[serde(default)]
    pub tailnet_name: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelChoice>,
    #[serde(default)]
    pub settings: MachineSettings,
    #[serde(default)]
    pub projects_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub resolved: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSettings {
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_permission_mode: Option<String>,
    #[serde(default)]
    pub default_streaming: Option<bool>,
    #[serde(default)]
    pub web_enabled: Option<bool>,
}

// ---------------------------------------------------------------------------
// Project and thread
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub workspace_root: String,
    #[serde(default)]
    pub repository_identity: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub secret_keys: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// What makes two projects one row in the sidebar: the repository *and* the
/// branch their threads start from.
///
/// The port of `projectPool` in `@covey/client`, and it has to stay a port.
/// Key this on the repository alone and a thread starts from the wrong commit
/// and opens its pull request against the wrong base.
pub fn project_pool(p: &Project) -> Option<String> {
    let repo = p.repository_identity.as_ref()?;
    if repo.is_empty() {
        return None;
    }
    // The daemon lowercases the identity; an older row may not. The branch
    // keeps its case, because git tells `feat/A` from `feat/a`.
    let repo = repo.to_lowercase();
    Some(match p.base_branch.as_deref() {
        Some(b) if !b.is_empty() => format!("{repo}#{b}"),
        _ => repo,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub title_auto: bool,
    #[serde(default)]
    pub origin: Option<ThreadOrigin>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default)]
    pub streaming: bool,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub status: SessionStatus,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub pending_approvals: u32,
    #[serde(default)]
    pub queued_turns: u32,
    #[serde(default)]
    pub latest_turn: Option<LatestTurn>,
    #[serde(default)]
    pub last_message_at: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub pinned_at: Option<String>,
    #[serde(default)]
    pub moved_to: Option<Value>,
    #[serde(default)]
    pub issue: Option<ThreadIssue>,
    #[serde(default)]
    pub pull_request: Option<ThreadPullRequest>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOrigin {
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
}

impl ThreadOrigin {
    pub fn is_agent(&self) -> bool {
        self.by == "agent"
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    #[default]
    Idle,
    Starting,
    Running,
    /// Blocked on an approval or a question.
    Waiting,
    Interrupted,
    Error,
    /// A state a newer daemon knows and this client does not.
    #[serde(other)]
    Unknown,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Starting => "starting",
            SessionStatus::Running => "running",
            SessionStatus::Waiting => "waiting",
            SessionStatus::Interrupted => "interrupted",
            SessionStatus::Error => "error",
            SessionStatus::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestTurn {
    pub turn_id: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIssue {
    pub number: i64,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPullRequest {
    pub number: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

/// True while the thread owes the reader something or is at work.
///
/// The port of `threadIsBusy`. The sidebar dot, the spinner and this client's
/// transcript all read this one function, so no two of them can disagree —
/// a thread the state calls still and the paint draws moving is a spinner
/// that never advances.
pub fn thread_is_busy(t: &Thread) -> bool {
    if t.pending_approvals > 0 {
        return true;
    }
    if t.latest_turn.as_ref().is_some_and(|x| x.state == "running") {
        return true;
    }
    matches!(
        t.status,
        SessionStatus::Running | SessionStatus::Starting | SessionStatus::Waiting
    )
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/// One row of a transcript.
///
/// The fields every kind shares sit on the struct, and the rest in `body`, so
/// an item of a kind this client has never heard of still has an id, a seq and
/// a place in the order. That is what `ItemBody::Unknown` is for: a newer
/// daemon's new kind paints as a stub in the right place, rather than taking
/// the whole snapshot down with it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub body: ItemBody,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemBody {
    User {
        #[serde(default)]
        text: String,
        #[serde(default)]
        attachments: Vec<Attachment>,
        #[serde(default)]
        queued: bool,
        #[serde(default)]
        folded: bool,
    },
    Assistant {
        #[serde(default)]
        text: String,
        #[serde(default)]
        streaming: bool,
        #[serde(default)]
        model: Option<String>,
    },
    Thinking {
        #[serde(default)]
        text: String,
        #[serde(default)]
        streaming: bool,
    },
    Tool {
        #[serde(default)]
        tool_name: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        output: Option<String>,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        duration_ms: Option<i64>,
    },
    Approval {
        #[serde(default)]
        request_id: String,
        #[serde(default)]
        tool_name: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        status: String,
    },
    Question {
        #[serde(default)]
        request_id: String,
        #[serde(default)]
        questions: Vec<QuestionAsk>,
        #[serde(default)]
        answers: Vec<String>,
        #[serde(default)]
        status: String,
    },
    Note {
        #[serde(default)]
        tone: String,
        #[serde(default)]
        text: String,
    },
    Error {
        #[serde(default)]
        text: String,
    },
    /// A kind this client does not know. It keeps its place in the order.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAsk {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<QuestionOption>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// A file on a message.
///
/// `data` is transport only, and it goes one way. The daemon writes the bytes
/// to disk and strips the field before it stores the item, so an attachment
/// that arrives in a snapshot has a `path` on the daemon's machine and no
/// bytes. That is why the desktop client cannot simply decode `data` to paint
/// a picture — see `media` in the app crate for where the bytes come from.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

/// Image media types the model accepts, and the ones this client paints inline.
pub const IMAGE_MIME_TYPES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

pub fn is_image_mime(m: &str) -> bool {
    IMAGE_MIME_TYPES.contains(&m)
}

/// Video media types this client paints inline, by decoding with `ffmpeg`.
pub const VIDEO_MIME_TYPES: &[&str] = &["video/mp4", "video/quicktime", "video/webm"];

pub fn is_video_mime(m: &str) -> bool {
    VIDEO_MIME_TYPES.contains(&m)
}

/// What one drop may weigh, unpacked, across every file in it. Bounds the
/// socket frame with it — keep the two numbers the same as the TypeScript's.
pub const MAX_ATTACHMENT_BYTES: u64 = 32 * 1024 * 1024;
/// What one image may weigh and still be shown to the model.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// The long edge covey shrinks an oversized image to. The API's own number, so
/// scaling to it costs nothing the model would have read.
pub const SHRINK_LONG_EDGE: u32 = 2576;

// ---------------------------------------------------------------------------
// Snapshots and events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    pub seq: i64,
    pub machine: MachineInfo,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub seq: i64,
    pub thread: Thread,
    #[serde(default)]
    pub items: Vec<TimelineItem>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub commands: Option<Vec<SlashCommandInfo>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub argument_hint: Option<String>,
}

// The variants differ a lot in size, and that is right: a `MachineInfo` is
// large and every other variant is an id. Boxing one would put an allocation on
// the path of every event a daemon sends to make the enum smaller than the
// snapshot it arrives beside.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum ShellEventBody {
    #[serde(rename = "machine.updated")]
    MachineUpdated { machine: MachineInfo },
    #[serde(rename = "project.upserted")]
    ProjectUpserted { project: Project },
    #[serde(rename = "project.removed")]
    ProjectRemoved {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    #[serde(rename = "thread.upserted")]
    ThreadUpserted { thread: Thread },
    #[serde(rename = "thread.removed")]
    ThreadRemoved {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    /// `run.upserted`, `run.removed`, and whatever a newer daemon adds. Runs
    /// are not in this client yet (issue #142 keeps them out of the first cut).
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ShellEvent {
    pub seq: i64,
    #[serde(flatten)]
    pub body: ShellEventBody,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum ThreadEventBody {
    #[serde(rename = "item.upserted")]
    ItemUpserted { item: TimelineItem },
    #[serde(rename = "item.removed")]
    ItemRemoved {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    #[serde(rename = "thread.updated")]
    ThreadUpdated { thread: Thread },
    #[serde(rename = "commands.updated")]
    CommandsUpdated { commands: Vec<SlashCommandInfo> },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThreadEvent {
    pub seq: i64,
    #[serde(flatten)]
    pub body: ThreadEventBody,
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

// Same judgement as `PushMessage` above: one variant is a whole event and the
// other is a small answer. The enum lives for one frame on the reading task's
// stack and is matched at once, so its size costs nothing an allocation would
// not cost more.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum WireFromDaemon {
    /// A push carries `push` and no `id`; a response carries `id` and `ok`.
    /// `push` is tried first because an untagged enum takes the first variant
    /// that fits, and a response never has a `push` field.
    Push(PushMessage),
    Response(RpcResponse),
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Deserialize)]
#[serde(tag = "push")]
pub enum PushMessage {
    #[serde(rename = "shell")]
    Shell {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        event: ShellEvent,
    },
    #[serde(rename = "shell.synchronized")]
    ShellSynchronized {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
    },
    #[serde(rename = "thread")]
    Thread {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        event: ThreadEvent,
    },
    #[serde(rename = "thread.synchronized")]
    ThreadSynchronized {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct RpcResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RpcError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

// ---------------------------------------------------------------------------
// Saved machines (the client's own config)
// ---------------------------------------------------------------------------

/// One machine in `config.json`.
///
/// The same file the TUI reads and writes. This client only reads it, so a
/// person who already runs the TUI dials their whole fleet with no setup — and
/// so a bug here can never cost them the list.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMachine {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub machine_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_item_kind_it_has_never_heard_of() {
        // The whole point of `ItemBody::Unknown`: a daemon ahead of this client
        // must paint, not fail. The shared fields still arrive, so the stub
        // keeps its place in the transcript's order.
        let raw = r#"{"id":"x","threadId":"t","turnId":null,"seq":9,
            "createdAt":"a","updatedAt":"b","kind":"hologram","wobble":3}"#;
        let item: TimelineItem = serde_json::from_str(raw).unwrap();
        assert_eq!(item.seq, 9);
        assert!(matches!(item.body, ItemBody::Unknown));
    }

    #[test]
    fn reads_an_assistant_item_with_fields_it_does_not_know() {
        let raw = r#"{"id":"x","threadId":"t","seq":1,"kind":"assistant",
            "text":"hi","streaming":true,"model":"sonnet","futureField":[1,2]}"#;
        let item: TimelineItem = serde_json::from_str(raw).unwrap();
        match item.body {
            ItemBody::Assistant {
                text, streaming, ..
            } => {
                assert_eq!(text, "hi");
                assert!(streaming);
            }
            other => panic!("wrong body: {other:?}"),
        }
    }

    #[test]
    fn tells_a_push_from_a_response() {
        let push = r#"{"push":"thread.synchronized","threadId":"t"}"#;
        assert!(matches!(
            serde_json::from_str::<WireFromDaemon>(push).unwrap(),
            WireFromDaemon::Push(PushMessage::ThreadSynchronized { .. })
        ));
        let res = r#"{"id":4,"ok":true,"result":{"subscriptionId":"s"}}"#;
        assert!(matches!(
            serde_json::from_str::<WireFromDaemon>(res).unwrap(),
            WireFromDaemon::Response(_)
        ));
    }

    #[test]
    fn a_push_kind_it_does_not_know_is_not_an_error() {
        let raw = r#"{"push":"machine.update","update":{"phase":"pull"}}"#;
        assert!(matches!(
            serde_json::from_str::<WireFromDaemon>(raw).unwrap(),
            WireFromDaemon::Push(PushMessage::Other)
        ));
    }

    #[test]
    fn a_shell_event_keeps_its_seq_through_an_unknown_kind() {
        let raw = r#"{"seq":77,"kind":"run.upserted","run":{"id":"r"}}"#;
        let ev: ShellEvent = serde_json::from_str(raw).unwrap();
        // The seq is what the replay cursor is made of. An event this client
        // skips must still move the cursor, or every reconnect replays it.
        assert_eq!(ev.seq, 77);
        assert!(matches!(ev.body, ShellEventBody::Other));
    }

    #[test]
    fn two_bases_of_one_repository_are_two_pools() {
        let mut p = Project {
            id: "1".into(),
            title: "covey".into(),
            workspace_root: String::new(),
            repository_identity: Some("GitHub.com/dylandotfarm/covey".into()),
            base_branch: None,
            default_model: None,
            secret_keys: vec![],
            updated_at: String::new(),
        };
        assert_eq!(
            project_pool(&p).as_deref(),
            Some("github.com/dylandotfarm/covey")
        );
        p.base_branch = Some("feat/A".into());
        // The branch keeps its case: git tells `feat/A` from `feat/a`.
        assert_eq!(
            project_pool(&p).as_deref(),
            Some("github.com/dylandotfarm/covey#feat/A")
        );
        p.repository_identity = None;
        assert_eq!(project_pool(&p), None);
    }

    #[test]
    fn a_thread_waiting_on_a_person_is_busy() {
        let raw = r#"{"id":"t","projectId":"p","title":"x","status":"waiting",
            "permissionMode":"default","pendingApprovals":0,"queuedTurns":0}"#;
        let t: Thread = serde_json::from_str(raw).unwrap();
        assert!(thread_is_busy(&t));
    }

    #[test]
    fn a_status_from_a_newer_daemon_reads_as_unknown_and_is_not_busy() {
        let raw = r#"{"id":"t","projectId":"p","title":"x","status":"hibernating",
            "permissionMode":"default","pendingApprovals":0,"queuedTurns":0}"#;
        let t: Thread = serde_json::from_str(raw).unwrap();
        assert_eq!(t.status, SessionStatus::Unknown);
        assert!(!thread_is_busy(&t));
    }
}
