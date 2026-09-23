//! One HTTP GET, by hand.
//!
//! The daemon serves its socket and its files from one port and speaks plain
//! HTTP/1.1 — a covey address is `ws://host:port`, on a tailnet or a LAN, and
//! never TLS. So this is a socket, a request line and a `content-length`, and
//! it keeps a TLS stack and its transitive tree out of the client for a route
//! that would not use it.
//!
//! It refuses anything it does not understand rather than guessing: no
//! redirects, no keep-alive, no compression it did not ask for.
//!
//! It does read a chunked body, and that is not politeness. The file route
//! answers a *file* with a `content-length`, but it answers a *refusal* with
//! `res.end("file: …")` and no length, which node then sends chunked. The
//! refusal is the one thing here worth reading carefully — it says which of the
//! four things went wrong, and one word for four problems is what made a
//! screenshot read as "unreadable" for weeks (#132). A client that could not
//! read a chunked body would throw the daemon's answer away and invent a worse
//! one.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// What one GET may bring back.
///
/// The same cap the wire carries on one drop, so a file this client refuses is
/// a file covey would have refused to carry in the first place.
pub const MAX_BODY_BYTES: u64 = covey_protocol::MAX_ATTACHMENT_BYTES;

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// `scheme://host:port/path?query`, split the way a request line needs it.
struct Target {
    host: String,
    port: u16,
    path_and_query: String,
}

fn parse(url: &str) -> Result<Target> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("only http:// is supported here, not {url}"))?;
    let (authority, rest) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // `[::1]:3790` as well as `host:3790`.
    let (host, port) = if let Some(end) = authority.strip_prefix('[').and_then(|a| a.find(']')) {
        // `end` counts from after the `[`, so in `authority` the `]` is at
        // `end + 1`, the `:` at `end + 2` and the port at `end + 3`.
        let host = &authority[1..=end];
        let port = authority
            .get(end + 3..)
            .and_then(|p| p.parse().ok())
            .unwrap_or(80);
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(80)),
            None => (authority.to_string(), 80),
        }
    };
    Ok(Target {
        host,
        port,
        path_and_query: if rest.is_empty() {
            "/".into()
        } else {
            rest.to_string()
        },
    })
}

pub fn get(url: &str) -> Result<Response> {
    let t = parse(url)?;
    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&(t.host.as_str(), t.port))?.collect();
    let addr = addrs
        .first()
        .ok_or_else(|| anyhow!("{} does not resolve", t.host))?;
    let stream = TcpStream::connect_timeout(addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(READ_TIMEOUT))?;
    let mut stream = stream;
    write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nUser-Agent: covey-desktop\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        t.path_and_query, t.host, t.port
    )?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("no status in {line:?}"))?;

    let mut content_length: Option<u64> = None;
    let mut content_type = String::new();
    let mut chunked = false;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().ok(),
            "content-type" => content_type = value.to_string(),
            "transfer-encoding" if value.eq_ignore_ascii_case("chunked") => chunked = true,
            _ => {}
        }
    }

    let body = if chunked {
        read_chunked(&mut reader)?
    } else {
        let len = content_length
            .ok_or_else(|| anyhow!("the daemon answered without a content-length"))?;
        if len > MAX_BODY_BYTES {
            bail!(
                "the file is {} MB, over the {} MB this client will carry",
                len / (1024 * 1024),
                MAX_BODY_BYTES / (1024 * 1024)
            );
        }
        let mut body = vec![0u8; len as usize];
        reader.read_exact(&mut body)?;
        body
    };
    Ok(Response {
        status,
        content_type,
        body,
    })
}

/// A body sent in chunks, each one a hexadecimal length and then that many
/// bytes. The cap is the same as for a body of known length, and it is checked
/// as the body grows rather than from a header a chunked answer does not have.
fn read_chunked(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            bail!("the answer ended in the middle of a chunked body");
        }
        // A chunk header may carry extensions after a `;`. Nothing covey sends
        // uses one, but the length is still only the part before it.
        let head = line.trim_end();
        let size_text = head.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_text, 16)
            .map_err(|_| anyhow!("{size_text:?} is not a chunk length"))?;
        if size == 0 {
            break;
        }
        if body.len() as u64 + size > MAX_BODY_BYTES {
            bail!(
                "the answer is over the {} MB this client will carry",
                MAX_BODY_BYTES / (1024 * 1024)
            );
        }
        let at = body.len();
        body.resize(at + size as usize, 0);
        reader.read_exact(&mut body[at..])?;
        // The CRLF that ends the chunk.
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf)?;
    }
    Ok(body)
}

/// Percent-encode one query value. The paths a daemon hands back hold `/` and
/// can hold a space, and a query value that is not encoded is a broken request.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_splits_into_a_host_a_port_and_a_request_line() {
        let t = parse("http://127.0.0.1:3790/file?thread=a&path=%2Fx").unwrap();
        assert_eq!(t.host, "127.0.0.1");
        assert_eq!(t.port, 3790);
        assert_eq!(t.path_and_query, "/file?thread=a&path=%2Fx");
    }

    #[test]
    fn a_host_with_no_port_and_no_path_still_makes_a_request() {
        let t = parse("http://pi.tail1234.ts.net").unwrap();
        assert_eq!(t.host, "pi.tail1234.ts.net");
        assert_eq!(t.port, 80);
        assert_eq!(t.path_and_query, "/");
    }

    #[test]
    fn a_bracketed_ipv6_host_keeps_its_port() {
        let t = parse("http://[::1]:3790/file").unwrap();
        assert_eq!(t.host, "::1");
        assert_eq!(t.port, 3790);
    }

    #[test]
    fn https_is_refused_rather_than_guessed_at() {
        assert!(parse("https://example/file").is_err());
    }

    #[test]
    fn a_chunked_body_is_read_because_a_refusal_arrives_that_way() {
        // The file route answers a file with a length and a refusal without
        // one, which node sends chunked. The refusal is the message that says
        // which of the four things went wrong, so it is the one that must
        // arrive whole.
        let one = "file: the path must be one of that ";
        let two = "thread's own files\n";
        let raw = format!(
            "{:x}\r\n{one}\r\n{:x}\r\n{two}\r\n0\r\n\r\n",
            one.len(),
            two.len()
        );
        let mut reader = std::io::BufReader::new(raw.as_bytes());
        let body = read_chunked(&mut reader).unwrap();
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "file: the path must be one of that thread's own files\n"
        );
    }

    #[test]
    fn a_chunk_length_that_is_not_a_length_is_an_error_and_not_a_guess() {
        let raw = b"nonsense\r\n";
        let mut reader = std::io::BufReader::new(&raw[..]);
        assert!(read_chunked(&mut reader).is_err());
    }

    #[test]
    fn a_path_is_encoded_so_a_separator_cannot_end_the_value() {
        assert_eq!(
            encode("/home/a b/.covey/threads/t/files/shot.png"),
            "%2Fhome%2Fa%20b%2F.covey%2Fthreads%2Ft%2Ffiles%2Fshot.png"
        );
        assert_eq!(encode("plain-name_1.png"), "plain-name_1.png");
    }
}
