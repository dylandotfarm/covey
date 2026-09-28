/**
 * The fetch and the conversion, on real bytes (#163).
 *
 * `media.test.ts` and `mediaPaint.test.ts` work on strings and rectangles. This
 * one makes a real picture, serves it over a real HTTP route shaped like the
 * daemon's `/file`, and puts it through `loadPreview` — because the part that
 * can only be got wrong for real is the part where another program writes the
 * PNG: the flags, the order they come in, and whether the shape survives.
 *
 * `ffmpeg` builds the fixtures and is the only tool that can take a frame out
 * of a video, so the whole file waits on it. A machine without it skips these
 * and keeps the rest; that is the same machine on which covey answers a click
 * with "this machine has no tool to make a picture of it", which is the
 * behaviour, not a gap in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPreviewCache, loadPreview, PreviewCache, PREVIEW_LONG_EDGE, type Preview } from "./mediaView.js";
import { ASSUMED_CELL, kittyTransmit, mediaBox, pngSize } from "./media.js";

const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const skip = HAVE_FFMPEG ? false : "this machine has no ffmpeg";
const dir = mkdtempSync(join(tmpdir(), "covey-media-load-"));

/** A test pattern of the given size, in the given container. */
function fixture(name: string, args: string[]): Buffer {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args, path]);
  return readFileSync(path);
}

/** Serve one body on every request, the way `/file` serves one file. */
async function serving(body: Buffer | string, status = 200): Promise<{ url: (name: string) => string; close: () => void; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.writeHead(status, { "content-type": "application/octet-stream" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (name) => `http://127.0.0.1:${port}/file?thread=t&path=${encodeURIComponent("/w/" + name)}`,
    close: () => server.close(),
    hits: () => hits,
  };
}

test("a JPEG comes back a PNG, with its shape", { skip }, async () => {
  // Two to one, so a conversion that squared it would be caught.
  const jpg = fixture("shot.jpg", ["-f", "lavfi", "-i", "testsrc=size=1200x600:duration=1:rate=1", "-frames:v", "1"]);
  const s = await serving(jpg);
  try {
    const got = await loadPreview(s.url("shot.jpg"), "shot.jpg");
    assert.ok(!("error" in got), `loadPreview said: ${"error" in got ? got.error : ""}`);
    if ("error" in got) return;
    // A PNG, and one `pngSize` agrees about — the transmit escape says `f=100`,
    // so anything else is a picture the terminal refuses without saying so.
    assert.deepEqual(pngSize(got.png), { width: got.width, height: got.height });
    assert.equal(got.width / got.height, 2, "the shape survived the conversion");
    assert.ok(got.width <= PREVIEW_LONG_EDGE && got.height <= PREVIEW_LONG_EDGE);
    assert.equal(got.poster, false);
  } finally { s.close(); }
});

test("a picture over the long edge is scaled down before it travels", { skip }, async () => {
  const big = fixture("big.png", ["-f", "lavfi", "-i", `testsrc=size=${PREVIEW_LONG_EDGE * 2}x${PREVIEW_LONG_EDGE}:duration=1:rate=1`, "-frames:v", "1"]);
  const s = await serving(big);
  try {
    const got = await loadPreview(s.url("big.png"), "big.png");
    assert.ok(!("error" in got), `loadPreview said: ${"error" in got ? got.error : ""}`);
    if ("error" in got) return;
    assert.equal(got.width, PREVIEW_LONG_EDGE, "the long edge came down to the cap");
    assert.equal(got.height, PREVIEW_LONG_EDGE / 2, "and the shape held");
  } finally { s.close(); }
});

test("an mp4 comes back as one frame", { skip }, async () => {
  const mp4 = fixture("clip.mp4", ["-f", "lavfi", "-i", "testsrc=size=640x480:duration=3:rate=10", "-pix_fmt", "yuv420p"]);
  const s = await serving(mp4);
  try {
    const got = await loadPreview(s.url("clip.mp4"), "clip.mp4");
    assert.ok(!("error" in got), `loadPreview said: ${"error" in got ? got.error : ""}`);
    if ("error" in got) return;
    assert.equal(got.poster, true, "the reader has to be told it is one frame");
    assert.deepEqual(pngSize(got.png), { width: 640, height: 480 });
  } finally { s.close(); }
});

test("a clip shorter than the seek still gives a frame", { skip }, async () => {
  // `-ss 1` skips the blank first frame of a screen recording, and a clip that
  // ends before then has to fall back to the start rather than come back empty.
  const mp4 = fixture("short.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:duration=0.2:rate=10", "-pix_fmt", "yuv420p"]);
  const s = await serving(mp4);
  try {
    const got = await loadPreview(s.url("short.mp4"), "short.mp4");
    assert.ok(!("error" in got), `loadPreview said: ${"error" in got ? got.error : ""}`);
    if ("error" in got) return;
    assert.deepEqual(pngSize(got.png), { width: 320, height: 240 });
  } finally { s.close(); }
});

test("the whole escape is well formed, and chunked", { skip }, async () => {
  const jpg = fixture("wide.jpg", ["-f", "lavfi", "-i", "testsrc=size=1200x600:duration=1:rate=1", "-frames:v", "1"]);
  const s = await serving(jpg);
  try {
    const got = await loadPreview(s.url("wide.jpg"), "wide.jpg");
    if ("error" in got) return assert.fail(got.error);
    const box = mediaBox(got, ASSUMED_CELL, { cols: 90, rows: 24 });
    // 90 columns of an 8px cell is 720px, and 2:1 wants 360px of 16px rows.
    assert.deepEqual(box, { cols: 90, rows: 23 });
    const esc = kittyTransmit(1, got.png, box.cols, box.rows);
    assert.ok(esc.startsWith("\u001b_Ga=T,U=1,i=1,f=100,t=d,c=90,r=23,q=2,m=1;"));
    assert.ok(esc.endsWith("\u001b\\"));
    // A real screenshot is many chunks, which is the case the loop exists for.
    assert.ok(esc.split("\u001b_G").length - 1 > 1, "a real picture takes more than one chunk");
    assert.ok(!/m=1;[^;]*$/.test(esc), "the last chunk says m=0");
  } finally { s.close(); }
});

test("the daemon's own refusal is the sentence the reader gets", async () => {
  // Not skipped: no tool is needed to fail. The route says which of the four
  // things went wrong (#132), and covey must pass that on rather than write
  // something vaguer from the status code.
  const s = await serving("file: not found in this thread's files", 404);
  try {
    const got = await loadPreview(s.url("gone.png"), "gone.png");
    assert.ok("error" in got);
    assert.match("error" in got ? got.error : "", /not found in this thread/);
  } finally { s.close(); }
});

test("a name covey cannot paint is refused before anything is fetched", async () => {
  // No server at all: if this reached the network the test would hang.
  const got = await loadPreview("http://127.0.0.1:1/file?thread=t&path=x", "notes.txt");
  assert.ok("error" in got);
  assert.match("error" in got ? got.error : "", /cannot paint \.txt/);
});

// ---------------------------------------------------------------------------
// The cache, which is what makes an arrow key instant (#165)
// ---------------------------------------------------------------------------

test("a picture covey already holds is not fetched again", { skip }, async () => {
  // A reader walks a conversation's pictures back and forth. Without this,
  // every step pays the network and another run of a conversion tool for bytes
  // covey already had.
  clearPreviewCache();
  const jpg = fixture("again.jpg", ["-f", "lavfi", "-i", "testsrc=size=320x240:duration=1:rate=1", "-frames:v", "1"]);
  const s = await serving(jpg);
  try {
    const first = await loadPreview(s.url("again.jpg"), "again.jpg");
    assert.ok(!("error" in first));
    assert.equal(s.hits(), 1);
    const second = await loadPreview(s.url("again.jpg"), "again.jpg");
    assert.ok(!("error" in second));
    assert.equal(s.hits(), 1, "the second look went nowhere near the network");
    // The same bytes, so the same escape and the same picture.
    if ("error" in first || "error" in second) return;
    assert.deepEqual([second.width, second.height], [first.width, first.height]);
    assert.ok(second.png.equals(first.png));
  } finally { s.close(); }
});

test("a failure is never cached", { skip: false }, async () => {
  // A machine that was away for a moment must not be away for the session.
  clearPreviewCache();
  const s = await serving("file: not there", 404);
  try {
    assert.ok("error" in await loadPreview(s.url("gone.png"), "gone.png"));
    assert.equal(s.hits(), 1);
    assert.ok("error" in await loadPreview(s.url("gone.png"), "gone.png"));
    assert.equal(s.hits(), 2, "covey asked again");
  } finally { s.close(); }
});

// The eviction rules, on a budget small enough to reach. The cache above is
// 48 MB, so nothing a test could reasonably make would ever fill it.
const fake = (bytes: number): Preview => ({ png: Buffer.alloc(bytes), width: 1, height: 1, poster: false });

test("the cache drops the oldest picture to make room", () => {
  const cache = new PreviewCache(300);
  cache.put("a", fake(100));
  cache.put("b", fake(100));
  cache.put("c", fake(100));
  assert.equal(cache.size, 300);
  cache.put("d", fake(100));
  assert.equal(cache.get("a"), undefined, "the oldest went");
  assert.ok(cache.get("b") && cache.get("c") && cache.get("d"));
  assert.equal(cache.size, 300);
});

test("the picture just asked for is never the one evicted", () => {
  // It is the one on the screen. Dropping it would refetch it on the next step
  // back, which is the whole thing this cache exists to stop.
  const cache = new PreviewCache(100);
  cache.put("a", fake(60));
  cache.put("b", fake(90));
  assert.ok(cache.get("b"), "the newest stayed");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 90);
});

test("a picture larger than the whole budget is not kept, and costs nothing", () => {
  // It would empty the cache to make room and then still not fit.
  const cache = new PreviewCache(100);
  cache.put("a", fake(50));
  cache.put("huge", fake(500));
  assert.equal(cache.get("huge"), undefined);
  assert.ok(cache.get("a"), "the picture already held was not thrown away for it");
  assert.equal(cache.size, 50);
});

test("putting the same picture twice counts it once", () => {
  const cache = new PreviewCache(100);
  cache.put("a", fake(40));
  cache.put("a", fake(40));
  assert.equal(cache.size, 40);
});
