//! covey-desktop — a second covey client, in a window (issue #142).
//!
//! It dials the same fleet the TUI does, from the same `config.json`, and shows
//! the same tree. What it adds is what a terminal cannot give: a picture in a
//! transcript, a wheel that reports pixels, and one binary that runs on Linux,
//! macOS and Windows.
//!
//! Run `covey-desktop --render <file.png>` to write one frame to a file without
//! opening a window. That is how the layout is checked on a machine with no
//! display — a build server, or an agent working on this code.

mod app;
mod config;
mod http;
mod media;
mod paint;
mod probe;
mod render;
mod state;
mod transcript;
mod ui;

use std::sync::Arc;

use covey_client::ConnState;
use state::{Machine, Store};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(at) = args.iter().position(|a| a == "--render") {
        let out = args
            .get(at + 1)
            .ok_or("--render wants a path to write the picture to")?;
        return render::demo_to_file(std::path::Path::new(out)).map_err(Into::into);
    }
    if let Some(at) = args.iter().position(|a| a == "--probe") {
        let url = args
            .get(at + 1)
            .ok_or("--probe wants the ws:// address of a daemon")?;
        return probe::run(url, 20).map_err(Into::into);
    }
    if let Some(at) = args.iter().position(|a| a == "--fetch") {
        let url = args
            .get(at + 1)
            .ok_or("--fetch wants the http:// address of a file route")?;
        let res = http::get(url)?;
        println!(
            "{} — {} bytes, {}",
            res.status,
            res.body.len(),
            res.content_type
        );
        match image::load_from_memory(&res.body) {
            Ok(img) => println!("decoded {}×{}", img.width(), img.height()),
            Err(e) => println!("did not decode: {e}"),
        }
        return Ok(());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("covey-desktop              open the window");
        println!("covey-desktop --render F   write one frame to F, with no window");
        println!("covey-desktop --probe URL  dial a daemon and say what came back");
        println!("covey-desktop --fetch URL  read one file route and decode what came back");
        return Ok(());
    }

    // One runtime for every machine's connection. Two threads is plenty: the
    // work here is a socket and a JSON parse, and the paint is on another
    // thread entirely.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

    // The window has to exist before anything can ask it to repaint, and the
    // connections have to exist before the window has anything to show. The
    // cell holds the one for the other.
    let ctx: Arc<std::sync::OnceLock<egui::Context>> = Arc::new(std::sync::OnceLock::new());
    let repaint: Arc<dyn Fn() + Send + Sync> = {
        let ctx = ctx.clone();
        Arc::new(move || {
            if let Some(c) = ctx.get() {
                c.request_repaint();
            }
        })
    };

    let mut machines = Vec::new();
    for saved in config::machines() {
        let handle = covey_client::spawn(rt.handle(), saved.clone(), tx.clone(), repaint.clone());
        machines.push(Machine {
            saved,
            handle,
            conn: ConnState::Connecting,
            error: None,
            info: None,
            projects: Default::default(),
            threads: Default::default(),
        });
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("covey")
            .with_inner_size([1100.0, 720.0])
            .with_min_inner_size([640.0, 360.0]),
        ..Default::default()
    };

    eframe::run_native(
        "covey",
        options,
        Box::new(move |cc| {
            let _ = ctx.set(cc.egui_ctx.clone());
            Ok(Box::new(app::App::new(Store::new(machines), rx)))
        }),
    )?;
    Ok(())
}
