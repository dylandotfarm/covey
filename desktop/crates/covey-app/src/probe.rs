//! `covey-desktop --probe <ws url>` — connect, say what came back, and stop.
//!
//! The window cannot be opened on a build server or under an agent, but the
//! half of this client that matters most can still be exercised there: the
//! protocol. This dials a daemon with the real [`covey_client`], waits for the
//! shell snapshot, opens the newest thread, and prints what a paint would have
//! had. If the wire types are wrong, this says so in a sentence instead of in a
//! blank window.
//!
//! It also fetches one file over the daemon's `/file` route when the open
//! thread has an attachment, because that is the path an inline picture takes
//! and it is worth being able to check on its own.

use std::sync::Arc;
use std::time::{Duration, Instant};

use covey_client::{ClientEvent, ConnState};
use covey_protocol as proto;

pub fn run(url: &str, seconds: u64) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let saved = proto::SavedMachine {
        name: "probe".into(),
        url: url.to_string(),
        token: std::env::var("COVEY_TOKEN").ok().filter(|t| !t.is_empty()),
        machine_id: None,
    };
    let handle = covey_client::spawn(rt.handle(), saved.clone(), tx, Arc::new(|| {}));

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut watched: Option<String> = None;
    let mut items = 0usize;
    let mut attachments: Vec<proto::Attachment> = Vec::new();

    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        let Some(ev) =
            rt.block_on(async { tokio::time::timeout(left, rx.recv()).await.ok().flatten() })
        else {
            break;
        };
        match ev {
            ClientEvent::State { state, error, .. } => {
                println!("state: {}{}", state.as_str(), suffix(&error));
                if state == ConnState::Offline {
                    break;
                }
            }
            ClientEvent::ShellSnapshot { snapshot, .. } => {
                let s = *snapshot;
                println!(
                    "machine: {} ({} {}), daemon {}, protocol v{}",
                    s.machine.name,
                    s.machine.os,
                    s.machine.arch,
                    s.machine.daemon_version,
                    s.machine.protocol_version
                );
                println!("models: {}", s.machine.models.len());
                println!("projects: {}", s.projects.len());
                for p in &s.projects {
                    println!(
                        "  {} — pool {}",
                        p.title,
                        proto::project_pool(p).unwrap_or_else(|| "(no remote)".into())
                    );
                }
                println!("threads: {}", s.threads.len());
                let mut newest: Option<&proto::Thread> = None;
                for t in &s.threads {
                    println!(
                        "  {} [{}]{}",
                        t.title,
                        t.status.as_str(),
                        if proto::thread_is_busy(t) {
                            " busy"
                        } else {
                            ""
                        }
                    );
                    if newest.is_none_or(|n| t.updated_at > n.updated_at) {
                        newest = Some(t);
                    }
                }
                if let Some(t) = newest {
                    println!("watching: {}", t.title);
                    watched = Some(t.id.clone());
                    handle.watch_thread(&t.id);
                }
            }
            ClientEvent::ThreadSnapshot { snapshot, .. } => {
                let s = *snapshot;
                items = s.items.len();
                println!("timeline: {items} items, hasMore={}", s.has_more);
                for item in &s.items {
                    println!("  seq {} {}", item.seq, kind_of(&item.body));
                    if let proto::ItemBody::User { attachments: a, .. } = &item.body {
                        attachments.extend(a.iter().cloned());
                    }
                }
            }
            ClientEvent::ThreadEvent { event, .. } => {
                println!("thread event: seq {}", event.seq);
            }
            ClientEvent::ShellEvent { event, .. } => {
                println!("shell event: seq {}", event.seq);
            }
            ClientEvent::CallDone { tag, result, .. } => {
                println!("call {tag}: {result:?}");
            }
        }
        if watched.is_some() && items > 0 {
            break;
        }
    }

    if let (Some(thread_id), Some(base)) =
        (watched.as_deref(), crate::config::http_base(&saved.url))
    {
        for a in attachments.iter().take(3) {
            let source = crate::media::Source {
                http_base: base.clone(),
                thread_id: thread_id.to_string(),
                token: saved.token.clone(),
            };
            match crate::http::get(&source.url(&a.path)) {
                Ok(res) => println!(
                    "file {}: {} — {} bytes, {}",
                    a.name,
                    res.status,
                    res.body.len(),
                    describe(&res.body)
                ),
                Err(e) => println!("file {}: {e}", a.name),
            }
        }
    }

    handle.stop();
    println!("done");
    Ok(())
}

fn suffix(e: &Option<String>) -> String {
    e.as_ref().map(|e| format!(" — {e}")).unwrap_or_default()
}

fn kind_of(b: &proto::ItemBody) -> String {
    match b {
        proto::ItemBody::User {
            text, attachments, ..
        } => {
            format!("user ({} chars, {} files)", text.len(), attachments.len())
        }
        proto::ItemBody::Assistant {
            text, streaming, ..
        } => {
            format!(
                "assistant ({} chars{})",
                text.len(),
                if *streaming { ", streaming" } else { "" }
            )
        }
        proto::ItemBody::Thinking { text, .. } => format!("thinking ({} chars)", text.len()),
        proto::ItemBody::Tool {
            tool_name, status, ..
        } => format!("tool {tool_name} [{status}]"),
        proto::ItemBody::Approval {
            tool_name, status, ..
        } => format!("approval {tool_name} [{status}]"),
        proto::ItemBody::Question { questions, .. } => format!("question ({})", questions.len()),
        proto::ItemBody::Note { tone, .. } => format!("note [{tone}]"),
        proto::ItemBody::Error { .. } => "error".into(),
        proto::ItemBody::Unknown => "a kind this client does not know".into(),
    }
}

/// What the bytes are, read from the file's own head rather than from the name.
fn describe(bytes: &[u8]) -> String {
    match image::load_from_memory(bytes) {
        Ok(img) => format!("decoded {}×{}", img.width(), img.height()),
        Err(e) => format!("did not decode: {e}"),
    }
}
