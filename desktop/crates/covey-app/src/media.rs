//! Where a picture comes from, and how it becomes a texture.
//!
//! An attachment on a timeline item carries a `path` on the *daemon's* machine
//! and no bytes: the daemon strips them before it stores the item, because a
//! snapshot is re-sent on every reconnect and must not replay megabytes of
//! base64. So a client that wants to show the picture has to ask for it, and
//! the daemon already has the route — `GET /file?thread=…&path=…`, gated by the
//! same token as the socket and deliberately not gated on the web client, so
//! the daemon that holds the bytes need not be the one serving a page
//! (`packages/daemon/src/threadFiles.ts`, #135).
//!
//! Video follows covey's own rule for media tools rather than linking a
//! decoder. `shrinkImage` in the TUI shells out to `sips`, `magick`, `convert`
//! or `ffmpeg` — whichever the machine has. This does the same: `ffmpeg` is
//! asked for raw frames on a pipe, and a machine without it gets a caption
//! saying so. No native dependency, nothing to build, and a covey that still
//! installs with `pnpm run setup` and nothing else.

use std::collections::HashMap;
use std::io::Read;
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};

use covey_grid::MediaKind;

use crate::http;
use crate::transcript::MediaSizes;

/// How wide a decoded video frame is, in pixels.
///
/// A transcript shows a video at a few hundred pixels across, so decoding at
/// the source resolution would be work nobody sees. `ffmpeg` scales on its
/// side, which costs one pass it is already making.
const VIDEO_WIDTH: u32 = 480;

/// Frames a second. Enough to read a screen recording, few enough that the
/// pipe and the texture uploads stay cheap.
const VIDEO_FPS: u32 = 12;

/// How many frames wait between the decoder and the screen.
///
/// Small on purpose: this is the whole backpressure design. `ffmpeg` writes
/// into a pipe, this thread reads a frame at a time, and a full channel stops
/// the decoder rather than filling memory with a video nobody is watching.
const VIDEO_QUEUE: usize = 4;

/// What the cache knows about one file.
enum Entry {
    /// Asked for, not yet answered.
    Pending,
    Image(Picture),
    Video(Video),
    /// Named so the chip can say which of the things went wrong. One word for
    /// four problems is what made a screenshot read as "unreadable" for weeks
    /// (#132), and a picture has the same four: not there, not allowed, too
    /// big, or nothing on this machine could read it.
    Failed(String),
}

pub struct Picture {
    pub size: [usize; 2],
    pub texture: egui::TextureHandle,
}

pub struct Video {
    pub size: [usize; 2],
    pub texture: egui::TextureHandle,
    /// Frames from `ffmpeg`, or none once it has finished or was never started.
    frames: Option<Receiver<egui::ColorImage>>,
    pub playing: bool,
    next_frame_at: f64,
    pub ended: bool,
}

/// One frame, on its way from a decoder thread to the screen.
enum Loaded {
    Image(egui::ColorImage),
    Video {
        first: egui::ColorImage,
        frames: Receiver<egui::ColorImage>,
    },
    Failed(String),
}

/// Answers on their way back from the loader threads.
type Inbox = (
    std::sync::mpsc::Sender<(String, Loaded)>,
    std::sync::mpsc::Receiver<(String, Loaded)>,
);

pub struct MediaCache {
    entries: HashMap<String, Entry>,
    /// Answers from the loader threads. Read once per frame, so a decode lands
    /// on a frame boundary like everything else that did not come from the
    /// reader's hands.
    inbox: Inbox,
    /// How to turn a key into a URL. Set per thread, because the route names
    /// the thread that owns the file.
    pub source: Arc<Mutex<Option<Source>>>,
}

/// Where this client fetches a thread's files from.
#[derive(Clone)]
pub struct Source {
    pub http_base: String,
    pub thread_id: String,
    pub token: Option<String>,
}

impl Source {
    pub fn url(&self, path: &str) -> String {
        let mut url = format!(
            "{}/file?thread={}&path={}",
            self.http_base,
            http::encode(&self.thread_id),
            http::encode(path)
        );
        if let Some(t) = self.token.as_deref().filter(|t| !t.is_empty()) {
            url.push_str(&format!("&token={}", http::encode(t)));
        }
        url
    }
}

impl Default for MediaCache {
    fn default() -> Self {
        MediaCache {
            entries: HashMap::new(),
            inbox: std::sync::mpsc::channel(),
            source: Arc::new(Mutex::new(None)),
        }
    }
}

impl MediaCache {
    /// Forget everything. Called when the thread on screen changes: a `path` is
    /// only unique inside one thread's file store.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn set_source(&mut self, source: Option<Source>) {
        *self.source.lock().unwrap() = source;
    }

    /// Fold in whatever the loader threads finished. Once per frame.
    pub fn drain(&mut self, ctx: &egui::Context) -> bool {
        let mut changed = false;
        while let Ok((key, loaded)) = self.inbox.1.try_recv() {
            changed = true;
            let entry = match loaded {
                Loaded::Failed(why) => Entry::Failed(why),
                Loaded::Image(img) => {
                    let size = img.size;
                    let texture = ctx.load_texture(&key, img, texture_options());
                    Entry::Image(Picture { size, texture })
                }
                Loaded::Video { first, frames } => {
                    let size = first.size;
                    let texture = ctx.load_texture(&key, first, texture_options());
                    Entry::Video(Video {
                        size,
                        texture,
                        frames: Some(frames),
                        playing: false,
                        next_frame_at: 0.0,
                        ended: false,
                    })
                }
            };
            self.entries.insert(key, entry);
        }
        changed
    }

    /// Advance whatever is playing. Answers true when a texture changed, so the
    /// caller knows to ask for another frame.
    pub fn tick(&mut self, now: f64) -> bool {
        let mut painted = false;
        for entry in self.entries.values_mut() {
            let Entry::Video(v) = entry else { continue };
            if !v.playing || v.ended {
                continue;
            }
            if now < v.next_frame_at {
                continue;
            }
            let Some(rx) = v.frames.as_ref() else {
                v.ended = true;
                continue;
            };
            match rx.try_recv() {
                Ok(frame) => {
                    v.texture.set(frame, texture_options());
                    v.next_frame_at = now + 1.0 / VIDEO_FPS as f64;
                    painted = true;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    v.frames = None;
                    v.ended = true;
                    v.playing = false;
                    painted = true;
                }
            }
        }
        painted
    }

    /// True when something is playing, so the window has to keep painting.
    pub fn playing(&self) -> bool {
        self.entries
            .values()
            .any(|e| matches!(e, Entry::Video(v) if v.playing && !v.ended))
    }

    pub fn toggle_play(&mut self, key: &str) {
        if let Some(Entry::Video(v)) = self.entries.get_mut(key) {
            if v.ended {
                return;
            }
            v.playing = !v.playing;
            v.next_frame_at = 0.0;
        }
    }

    pub fn texture(&self, key: &str) -> Option<&egui::TextureHandle> {
        match self.entries.get(key) {
            Some(Entry::Image(p)) => Some(&p.texture),
            Some(Entry::Video(v)) => Some(&v.texture),
            _ => None,
        }
    }

    pub fn is_playing(&self, key: &str) -> bool {
        matches!(self.entries.get(key), Some(Entry::Video(v)) if v.playing && !v.ended)
    }

    /// Ask for a file, unless it has already been asked for.
    ///
    /// Called from the layout, which runs every frame — so "already asked for"
    /// has to be the first thing it answers, or one picture would start a
    /// thousand downloads a second.
    pub fn want(&mut self, key: &str, kind: MediaKind) {
        if self.entries.contains_key(key) {
            return;
        }
        let Some(source) = self.source.lock().unwrap().clone() else {
            return;
        };
        self.entries.insert(key.to_string(), Entry::Pending);
        let url = source.url(key);
        let tx = self.inbox.0.clone();
        let key = key.to_string();
        std::thread::spawn(move || {
            let loaded = match kind {
                MediaKind::Image => load_image(&url),
                MediaKind::Video => load_video(&url, &key),
            };
            let _ = tx.send((
                key,
                loaded.unwrap_or_else(|e| Loaded::Failed(e.to_string())),
            ));
        });
    }
}

fn texture_options() -> egui::TextureOptions {
    // Linear, because a screenshot in a transcript is nearly always scaled
    // down: nearest-neighbour on a 2576 px screenshot shown 400 px wide throws
    // away every second row of text and makes it unreadable.
    egui::TextureOptions::LINEAR
}

impl MediaSizes for MediaCache {
    fn aspect(&self, key: &str) -> Option<f32> {
        let [w, h] = match self.entries.get(key)? {
            Entry::Image(p) => p.size,
            Entry::Video(v) => v.size,
            _ => return None,
        };
        (h > 0).then(|| w as f32 / h as f32)
    }

    fn failed(&self, key: &str) -> Option<String> {
        match self.entries.get(key) {
            Some(Entry::Failed(why)) => Some(why.clone()),
            _ => None,
        }
    }
}

fn load_image(url: &str) -> anyhow::Result<Loaded> {
    let res = http::get(url)?;
    if res.status != 200 {
        return Ok(Loaded::Failed(status_words(res.status, &res.body)));
    }
    let img = image::load_from_memory(&res.body)
        .map_err(|e| anyhow::anyhow!("nothing here could read it: {e}"))?;
    Ok(Loaded::Image(to_color_image(
        img.width(),
        img.height(),
        img.to_rgba8().into_raw(),
    )))
}

/// The words for what the daemon said no with.
///
/// The route answers in plain text and says which of the four things happened,
/// so the body is better than anything this side could invent. It is trimmed to
/// one line because a chip is one line.
fn status_words(status: u16, body: &[u8]) -> String {
    let said = String::from_utf8_lossy(body);
    let line = said.lines().next().unwrap_or("").trim();
    let line = line.strip_prefix("file: ").unwrap_or(line);
    match (status, line.is_empty()) {
        (401, true) => "the daemon would not let this client read it".into(),
        (_, true) => format!("the daemon answered {status}"),
        _ => line.to_string(),
    }
}

/// Decode a video with whatever `ffmpeg` the machine has.
///
/// The file is fetched whole first rather than piped from the socket: `ffmpeg`
/// needs to seek an mp4's index, and covey caps one attachment at 32 MB anyway.
fn load_video(url: &str, key: &str) -> anyhow::Result<Loaded> {
    let res = http::get(url)?;
    if res.status != 200 {
        return Ok(Loaded::Failed(status_words(res.status, &res.body)));
    }
    let suffix = std::path::Path::new(key)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let temp = std::env::temp_dir().join(format!(
        "covey-desktop-{:x}.{suffix}",
        u64::from(std::process::id()) ^ hash(key)
    ));
    std::fs::write(&temp, &res.body)?;
    // The copy goes when the decoder is done with it, however that happens.
    decode_video(&temp, true)
}

/// Decode a video file into frames, with whatever `ffmpeg` the machine has.
///
/// `owned` says whether the file is this client's to delete when the decoder
/// finishes — true for the copy fetched from a daemon, false for a file a test
/// made.
fn decode_video(path: &std::path::Path, owned: bool) -> anyhow::Result<Loaded> {
    // `scale=W:-2` keeps the aspect and rounds the height to an even number,
    // which the pixel format needs. So the height has to be known before the
    // first frame can be cut out of the stream.
    let Some(height) = probe_height(path) else {
        cleanup(path, owned);
        return Ok(Loaded::Failed(
            "ffmpeg could not say how big the video is".into(),
        ));
    };

    let mut child = match std::process::Command::new("ffmpeg")
        .args([
            "-loglevel",
            "error",
            "-i",
            &path.to_string_lossy(),
            "-vf",
            &format!("fps={VIDEO_FPS},scale={VIDEO_WIDTH}:-2"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            cleanup(path, owned);
            return Ok(Loaded::Failed(
                "no ffmpeg on this machine, so covey cannot show the frames".into(),
            ));
        }
    };

    let mut stdout = child.stdout.take().expect("piped");
    let frame_bytes = (VIDEO_WIDTH as usize) * (height as usize) * 4;
    let mut buf = vec![0u8; frame_bytes];
    if stdout.read_exact(&mut buf).is_err() {
        let _ = child.kill();
        cleanup(path, owned);
        return Ok(Loaded::Failed("ffmpeg decoded no frames".into()));
    }
    let first = to_color_image(VIDEO_WIDTH, height, buf.clone());

    let (tx, rx): (SyncSender<egui::ColorImage>, Receiver<egui::ColorImage>) =
        std::sync::mpsc::sync_channel(VIDEO_QUEUE);
    let owned_path = path.to_path_buf();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; frame_bytes];
        // A full channel blocks here, which stops `ffmpeg` at the pipe. That is
        // the whole memory bound: four frames, never a decoded film.
        while stdout.read_exact(&mut buf).is_ok() {
            if tx
                .send(to_color_image(VIDEO_WIDTH, height, buf.clone()))
                .is_err()
            {
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        cleanup(&owned_path, owned);
    });

    Ok(Loaded::Video { first, frames: rx })
}

fn cleanup(path: &std::path::Path, owned: bool) {
    if owned {
        let _ = std::fs::remove_file(path);
    }
}

/// The height `ffmpeg` will write, asked of `ffprobe` and worked out the same
/// way `scale=W:-2` does when `ffprobe` is not there.
fn probe_height(path: &std::path::Path) -> Option<u32> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
            &path.to_string_lossy(),
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (w, h) = text.trim().split_once(',')?;
    let w: f64 = w.trim().parse().ok()?;
    let h: f64 = h.trim().parse().ok()?;
    if w <= 0.0 {
        return None;
    }
    Some(scaled_height(w, h))
}

/// What `scale=VIDEO_WIDTH:-2` gives: the aspect kept, rounded to an even
/// number of rows.
fn scaled_height(w: f64, h: f64) -> u32 {
    let exact = VIDEO_WIDTH as f64 * h / w;
    let even = (exact / 2.0).round() * 2.0;
    even.max(2.0) as u32
}

fn to_color_image(w: u32, h: u32, rgba: Vec<u8>) -> egui::ColorImage {
    egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba)
}

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_url_names_the_thread_that_owns_the_path() {
        let s = Source {
            http_base: "http://127.0.0.1:3790".into(),
            thread_id: "t-1".into(),
            token: Some("secret".into()),
        };
        let url = s.url("/w/.covey/threads/t-1/files/shot.png");
        assert!(url.starts_with("http://127.0.0.1:3790/file?thread=t-1&path="));
        // The path is encoded, or the first `/` would end the value.
        assert!(url.contains("%2Fshot.png"));
        assert!(url.contains("&token=secret"));
    }

    #[test]
    fn a_source_with_no_token_sends_none() {
        let s = Source {
            http_base: "http://h:1".into(),
            thread_id: "t".into(),
            token: None,
        };
        assert!(!s.url("/a.png").contains("token"));
    }

    #[test]
    fn a_refusal_keeps_the_daemons_own_words() {
        // The route says which of the four things went wrong, in plain text.
        // Nothing this side could invent says more.
        assert_eq!(
            status_words(404, b"file: the thread no longer holds that file\n"),
            "the thread no longer holds that file"
        );
        assert_eq!(
            status_words(401, b""),
            "the daemon would not let this client read it"
        );
        assert_eq!(status_words(500, b""), "the daemon answered 500");
    }

    /// Make a short clip with `ffmpeg`'s own test pattern. Returns none when
    /// this machine has no `ffmpeg`, which is a thing to skip over and not a
    /// thing to fail on — the client already says so to the reader.
    fn test_clip() -> Option<std::path::PathBuf> {
        let path = std::env::temp_dir().join("covey-desktop-test-clip.mp4");
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=12:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                &path.to_string_lossy(),
            ])
            .status()
            .ok()?;
        ok.success().then_some(path)
    }

    #[test]
    fn ffmpeg_hands_back_frames_of_the_shape_the_layout_was_promised() {
        // The one test here that runs a real decoder. It is what says the
        // constants above and `ffmpeg`'s own `scale=W:-2` agree: get that wrong
        // and every frame is read at the wrong offset, which looks like static.
        let Some(clip) = test_clip() else {
            eprintln!("no ffmpeg here; the client says so to the reader too");
            return;
        };
        let loaded = decode_video(&clip, false).unwrap();
        let Loaded::Video { first, frames } = loaded else {
            panic!("decode did not answer with frames");
        };
        assert_eq!(first.size, [VIDEO_WIDTH as usize, 270]);
        // 12 fps for a second, one of which was taken as the poster.
        let rest = frames.into_iter().count();
        assert!(rest >= 8, "only {rest} frames after the first");
        let _ = std::fs::remove_file(&clip);
    }

    #[test]
    fn a_video_this_machine_cannot_read_says_so_rather_than_showing_nothing() {
        let path = std::env::temp_dir().join("covey-desktop-not-a-video.mp4");
        std::fs::write(&path, b"this is not a video").unwrap();
        let loaded = decode_video(&path, true).unwrap();
        match loaded {
            Loaded::Failed(why) => assert!(!why.is_empty(), "the chip needs words"),
            _ => panic!("a text file decoded as a video"),
        }
    }

    #[test]
    fn a_scaled_frame_keeps_its_shape_and_an_even_number_of_rows() {
        // The pixel format needs an even height, which is what `-2` means.
        assert_eq!(scaled_height(1920.0, 1080.0), 270);
        assert_eq!(scaled_height(1000.0, 1001.0), 480);
        assert_eq!(scaled_height(VIDEO_WIDTH as f64, 101.0), 102);
        assert!(scaled_height(4000.0, 1.0) >= 2);
    }
}
