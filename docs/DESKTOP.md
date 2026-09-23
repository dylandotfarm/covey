# covey-desktop — a second client, in a window

*Issue #142. This is a spike, not a replacement. The TUI keeps working, keeps
getting fixes, and is still the client covey ships. This one runs beside it
while we find out whether it is the better seat.*

## Why there is a second client

covey has outgrown what a terminal can paint.

- **A transcript carries pictures, and the TUI can only name them.** A dropped
  screenshot is a chip. A recording is a word. The agent sees the image; the
  person who dropped it does not.
- **A terminal reports very little about the mouse.** No pixel scroll, no
  hover, no right button. `cmd+click` is not even a thing covey can see — a
  mouse report has a bit for alt and one for ctrl and none for cmd, which is
  why the TUI has to ask the terminal to open a link for it (`links.ts`).
- **The one client that does paint media is a phone.** The web client shows an
  image inline, but it is one thread at a time on a small screen. It is not a
  desk.

A terminal is also the thing covey has least control over. Every glyph problem
in the tracker — the width of a combining mark, a colour a terminal will not
show, a paste split across two reads — is a problem about the terminal and not
about covey.

## The idea: a cell grid where a cell can be a picture

covey reads the way it does **because** it is a character grid. Every layout is
rows and columns: the sidebar's indents, the transcript's wrapping, the scroll
that counts lines from the bottom. Give that up and covey stops looking like
covey, and every cheap thing about its layout becomes expensive.

So: keep the grid, and stop asking a terminal to paint it.

A `Grid` (`desktop/crates/covey-grid`) is rows by columns of styled cells,
exactly like a terminal's screen buffer. It **also** carries a list of *media
placements*: a rectangle of cells that a picture is painted over instead of
glyphs.

```
┌──────────────────────────────────────┐
│ ❯ The recording of the fix.          │   ← cells, glyphs
│                                      │
│   ████████████████████████           │   ← cells, a picture
│   ████████████████████████           │
│   ████████████████████████           │
│                                      │
│ That is the hint holding its width.  │   ← cells, glyphs
└──────────────────────────────────────┘
```

One rule keeps that honest: **a placement owns its cells.** `place_media`
blanks the rectangle, and the renderer paints the picture over it without
looking at what was underneath. So layout never has to blank a region by hand,
and a picture can never half-cover a word.

What this buys, and why it is the whole design:

- **The layout code does not change shape.** It still writes text at a row and
  a column. A picture is `n` lines reserved, the same way a paragraph is.
- **Scroll is still a count of lines.** A picture is a run of `Line::MediaRow`
  entries, so it scrolls with everything else — and a picture at the edge of
  the pane is *half a picture*, which slides rather than jumps
  (`Media::skip_rows`).
- **The hit test is still a division.** A pointer position over `cell_w` and
  `cell_h` gives a row and a column, and one lookup says whether a placement
  owns it. That is how a click on a video is a click on *that* video.
- **The renderer is replaceable.** egui paints a `Grid` into a window;
  `render.rs` paints the very same `Grid` into a PNG with a font rasteriser and
  no display at all. The second one exists because a build server and an agent
  working on this code have no screen — and the fact that it works is the proof
  that the separation is real.

## The crates

| Crate | What it is |
| --- | --- |
| `covey-protocol` | The wire types in serde. Mirrors `packages/protocol`. |
| `covey-client` | The port of `MachineClient`: rpc, subscriptions, reconnect. |
| `covey-grid` | The styled cell buffer, the media placements, the palette. |
| `covey-app` | The window: state, layout, media, paint, input. |

A cargo workspace of its own under `desktop/`, beside the pnpm workspace and
not inside it. `tsc -b` must never see these files and `cargo` must never need
node. `pnpm run build` and `pnpm test` do not touch it; CI runs a second job.

### Reading the protocol

`covey-protocol` mirrors `packages/protocol/src/index.ts`, which stays the one
place the protocol is defined. Two rules keep the mirror from cracking.

**Read loosely, write exactly.** No struct refuses an unknown field, every
field a daemon may omit is `#[serde(default)]`, and every tagged union has a
fallback variant — `ItemBody::Unknown`, `SessionStatus::Unknown`,
`ShellEventBody::Other`. A daemon newer than this client *paints*; it does not
fail. An item of a kind this client has never heard of keeps its id, its seq
and its place in the transcript, and says in one line that it is too new to
show. A transcript with a hole in it is worse than one with a stub.

**Keep the names.** The wire is camelCase and the fields are the TypeScript
ones, renamed at the serde layer and never in the struct, so a reader can put
the two files side by side.

### Where the paint budget went

The TUI's hardest constraint is that a paint is the client's dearest act, and
that the keyboard waits behind it. Its answer is two ways to change state:
`set` paints at once and is for what the reader did; `setFromMachine` paints on
a frame boundary and is for everything a daemon said.

Here that rule is the architecture rather than a rule somebody has to remember.
Every connection is a task on a tokio runtime and speaks to the UI through a
queue; the UI drains the queue once per frame, at the top of `update`. The
reader's keystroke is a function call on the UI thread. **No callback can break
the rule by accident, because there are no callbacks.**

Two more things hold the budget up:

- Runs of cells that share a style are drawn as one string, not one per cell.
  Four thousand galleys a frame is four thousand galleys a frame.
- The window is asked to repaint only when something changed: a daemon said
  something, the reader pressed a key, a video is playing. Nothing paints on a
  timer. An idle covey client must cost nothing, which is the point of a client
  you leave open.

### Where a picture comes from

An attachment on a timeline item carries a `path` on the *daemon's* machine and
no bytes: the daemon strips them before it stores the item, because a snapshot
is re-sent on every reconnect and must not replay megabytes of base64.

The daemon already has the route the client needs — `GET
/file?thread=…&path=…` (`packages/daemon/src/threadFiles.ts`, #135). It is
gated by the same token as the socket, it refuses a path outside that thread's
own file store, and it is deliberately *not* gated on the web client, because
the daemon that holds the bytes is very often not the one serving a page. So
inline media works against a daemon anywhere on the tailnet, not only against
localhost, and **no protocol change was needed**.

`http.rs` speaks that route by hand: a socket, a request line and a length. A
covey address is `ws://host:port` and never TLS, so a TLS stack and its
transitive tree stay out of the client for a route that would not use one. It
reads a chunked body as well as one with a length — not out of politeness, but
because the route answers a *file* with a length and a *refusal* with
`res.end("file: …")`, which node sends chunked. The refusal is the message
worth reading carefully: it says which of the four things went wrong, and one
word for four problems is what made a screenshot read as "unreadable" for weeks
(#132).

### Video

covey already shells out to whatever the machine has — `sips`, `magick`,
`convert`, `ffmpeg` — to shrink an image. Video follows that rule rather than
linking a decoder: `ffmpeg` is asked for raw RGBA frames on a pipe, scaled to
480 px at 12 fps, and each frame becomes a texture.

- No native dependency and nothing to build. covey still installs with
  `pnpm run setup` and nothing else.
- The frame channel holds four frames. A full channel blocks the reader, which
  stops `ffmpeg` at the pipe. That is the whole memory bound: four frames, never
  a decoded film.
- A machine without `ffmpeg` gets a caption that says so, which is still more
  than the TUI shows.
- **No audio.** A transcript is a place to recognise a recording, not to watch
  one. Audio would want a mixer, a clock and a volume control, and none of those
  are a grid.

### Fonts

The sidebar paints `▾ ▸ ● ○ ◌ ✗ ◇ ❯ │ ─ ▌ ▣`. A font without those draws a box,
and a box says "something is wrong with covey" when what it means is "this
machine is offline". So the client looks through a short list of the usual
monospace families, **checks that the one it found can draw every mark**, and
skips one that cannot. `paint.rs` holds both the list and the marks, and a test
asserts the font this machine offers has them all.

## What the first cut does, and does not

**Does.** Reads the same `config.json` the TUI does, so an existing covey user
dials their whole fleet with no setup. Sidebar of machines → projects → threads,
folded across machines by `project_pool` and nested by `parent_thread_id`. Open
a thread, stream its transcript live, send a message. Inline images. Inline
video with a play control. Pixel scroll, click to open, click to fold.

**Does not, yet.** Runs. The diff panel. The overlays and the command palette.
The pull request and issue screens. Approvals and questions are shown but not
answered. Attaching a file. Creating a project or a thread. Moving a thread
between machines. Text selection and copy. Every one of those is a known gap,
not a discovery.

## Trying it

```bash
cd desktop
cargo run --bin covey-desktop            # dials the fleet in config.json
cargo test                               # no display needed
```

Two modes exist for a machine with no screen:

```bash
cargo run --bin covey-desktop -- --render frame.png   # one frame, to a file
cargo run --bin covey-desktop -- --probe ws://127.0.0.1:3790
```

`--probe` dials a daemon with the real client, waits for the shell snapshot,
opens the newest thread and prints what a paint would have had. If the wire
types are wrong it says so in a sentence instead of in a blank window. Point it
at a throwaway daemon, never at 3790:

```bash
COVEY_HOME=/tmp/h node packages/daemon/dist/main.js --bind loopback --port 3801
cargo run --bin covey-desktop -- --probe ws://127.0.0.1:3801
```

## How we will know whether this was worth it

Run both clients against the same daemon for a week and answer three questions.

1. Does a picture in the transcript change how the work reads, or is naming the
   file enough after all?
2. Is the mouse worth a second client, or is the keyboard the whole interface?
3. Does the grid still feel like covey when a window paints it?

If the answer is no, this is four crates to delete and the TUI has lost
nothing. If it is yes, the port order is the "does not, yet" list above.

## Dependencies

The crates follow covey's 7-day rule, the same one pnpm enforces for npm. Cargo
has its own setting for it — `registry.global-min-publish-age` and
`resolver.incompatible-publish-age`, both in `desktop/.cargo/config.toml` — but
it became stable only in **Rust 1.100**, and an older cargo warns that it is
ignoring both keys and resolves whatever it likes.

So until the toolchain moves, `scripts/crate-age.mjs` is the only thing holding
the rule. It reads `desktop/Cargo.lock` and fails on any version younger than a
week — or on any it could not date, because a crate nothing checked is exactly
what the rule exists to stop.

Publish dates are cached in `desktop/crate-publish-times.json`. A version's
publish date never changes, so the cache cannot go stale, and the check normally
makes no network requests at all: 436 crates in about 30 ms. That is not only
speed. Asking crates.io for four hundred versions on every push met its rate
limit, and a rate limit read as a failure is a red build with nothing wrong
behind it. The committed file also puts each new crate and its publish date in
the diff, next to the lockfile change that brought it in, where a reviewer can
see it.

After `cargo add`: `node scripts/crate-age.mjs refresh` to cache the new dates,
and `… pin` for the `cargo update --precise` lines if anything is too young.

Adding this check to the first lockfile caught six transitive crates published
five and six days earlier, which is the whole argument for having it.

## Rules for changing this code

- **The palette is a copy.** `covey-grid/src/theme.rs` is carried over from
  `packages/tui/src/theme.ts`. A colour that changes there changes here, in the
  same pull request. A person will run the two side by side.
- **The painted line list and the hit test read one array.** `Screen::cells` is
  that array. Keep two copies of it and a click lands on the row above the one
  under the pointer — the same rule `App.tsx` follows for the sidebar.
- **A placement owns its cells.** Do not write over a media rectangle and do not
  expect the renderer to blend with what is under it.
- **Everything a daemon says goes through the queue.** If you find yourself
  wanting to mutate the store from a tokio task, you want a `ClientEvent`.
- **The scroll is a count of lines from the bottom.** `0` means follow the
  bottom. A streaming item is re-sent whole and longer, so anything else drags
  the screen away from the reader mid-reply (#114).
