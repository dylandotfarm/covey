//! The fleet, read from the file the TUI already keeps.
//!
//! This client reads `config.json` and never writes it. A person who runs the
//! TUI therefore dials their whole fleet here with no setup, and a bug in this
//! client can never cost them the list. The port of
//! `packages/tui/src/config.ts`, minus everything that saves.

use std::path::PathBuf;

use covey_protocol::{SavedMachine, DEFAULT_PORT};

/// Where `config.json` lives, by the rules the TUI and the daemon both follow.
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("COVEY_CONFIG") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = home_dir();
    if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("covey")
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"))
            .join("covey")
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".config"))
            .join("covey")
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// The local daemon. `COVEY_PORT` moves the whole local pair — daemon and
/// client — off the default, so a throwaway instance can run beside a real one.
pub fn local_machine() -> SavedMachine {
    let port = std::env::var("COVEY_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT);
    SavedMachine {
        name: "local".into(),
        url: format!("ws://127.0.0.1:{port}"),
        token: None,
        machine_id: None,
    }
}

/// The machines to dial: the local daemon first, then everything in the config
/// that is not the local daemon again.
///
/// The same list the CLI builds for the TUI, and in the same order, so the two
/// clients show the same fleet in the same order.
pub fn machines() -> Vec<SavedMachine> {
    let local = local_machine();
    let mut out = vec![local.clone()];
    for m in saved_machines() {
        if m.url != local.url {
            out.push(m);
        }
    }
    out
}

fn saved_machines() -> Vec<SavedMachine> {
    let file = config_dir().join("config.json");
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };
    // A config this client cannot read is not a reason to start with nothing:
    // the local daemon is still there, and the reader can see that it is.
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("machines")
        .and_then(|m| serde_json::from_value::<Vec<SavedMachine>>(m.clone()).ok())
        .unwrap_or_default()
}

/// The base of this daemon's HTTP routes, from the `ws://` the client dials.
///
/// The daemon serves its socket and its files from one port, so the file route
/// is the same host with the scheme changed. `wss` maps to `https` for
/// completeness, though covey's own addresses are plain.
pub fn http_base(ws_url: &str) -> Option<String> {
    let rest = ws_url
        .strip_prefix("ws://")
        .map(|r| ("http", r))
        .or_else(|| ws_url.strip_prefix("wss://").map(|r| ("https", r)))?;
    let (scheme, authority) = rest;
    let authority = authority.split(['/', '?']).next().unwrap_or(authority);
    Some(format!("{scheme}://{authority}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_daemon_leads_the_fleet_and_is_never_listed_twice() {
        let local = local_machine();
        let saved = vec![
            SavedMachine {
                name: "local-again".into(),
                url: local.url.clone(),
                token: None,
                machine_id: None,
            },
            SavedMachine {
                name: "pi".into(),
                url: "ws://pi:3790".into(),
                token: None,
                machine_id: None,
            },
        ];
        let mut out = vec![local.clone()];
        for m in saved {
            if m.url != local.url {
                out.push(m);
            }
        }
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "local");
        assert_eq!(out[1].name, "pi");
    }

    #[test]
    fn the_file_route_sits_on_the_same_host_as_the_socket() {
        assert_eq!(
            http_base("ws://127.0.0.1:3790").as_deref(),
            Some("http://127.0.0.1:3790")
        );
        assert_eq!(
            http_base("ws://pi.tail1234.ts.net:3790/").as_deref(),
            Some("http://pi.tail1234.ts.net:3790")
        );
        assert_eq!(
            http_base("wss://example:443").as_deref(),
            Some("https://example:443")
        );
        assert_eq!(http_base("http://nope"), None);
    }
}
