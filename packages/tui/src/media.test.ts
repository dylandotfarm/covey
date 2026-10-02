import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  ASSUMED_CELL, CELL_SIZE_QUERY, CHUNK_BYTES, MAX_CELLS, PLACEHOLDER,
  graphicsEnabled, kittyDelete, kittyTransmit, mediaBox, parseCellSize, placeholderRows, pngSize, takeWindowReports,
} from "./media.js";
import { width } from "./lines.js";

const ESC = "\u001b";

// ---------------------------------------------------------------------------
// The rows measure what they cover
// ---------------------------------------------------------------------------

test("a painted row measures exactly the cells it covers", () => {
  // The whole feature rests on this. ink lays a line out with `string-width`,
  // so a row that measured its escapes would push the pane's own content off
  // the screen.
  for (const cols of [1, 7, 40, 120]) {
    const rows = placeholderRows(0x42, cols, 3);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(stringWidth(r), cols, `${cols} columns`);
  }
});

test("every cell carries its own row and column mark", () => {
  const [first, second] = placeholderRows(1, 3, 2);
  // Three cells, each a placeholder and two combining marks, so nine code
  // points between the colour and the reset.
  const cells = (s: string) => [...s.replace(/\u001b\[[^m]*m/g, "")];
  assert.equal(cells(first!).length, 9);
  assert.equal(cells(second!).length, 9);
  // The rows differ, because the row mark differs; the columns inside one row
  // differ too. A row that repeated one cell would paint one pixel row of the
  // picture over the whole rectangle.
  assert.notEqual(first, second);
  assert.equal(new Set(cells(first!).join("").split(PLACEHOLDER).filter(Boolean)).size, 3);
});

test("the foreground colour is the image id in 24 bits", () => {
  assert.match(placeholderRows(0x010203, 1, 1)[0]!, new RegExp(`^\\${ESC}\\[38;2;1;2;3m`));
  assert.match(placeholderRows(0xffffff, 1, 1)[0]!, new RegExp(`^\\${ESC}\\[38;2;255;255;255m`));
  // And the colour is put back, or every row under the picture would inherit it.
  assert.ok(placeholderRows(1, 1, 1)[0]!.endsWith(ESC + "[39m"));
});

test("a rectangle past the diacritic table is clamped, never mismarked", () => {
  const rows = placeholderRows(1, MAX_CELLS + 50, MAX_CELLS + 50);
  assert.equal(rows.length, MAX_CELLS);
  assert.equal(stringWidth(rows[0]!), MAX_CELLS);
});

test("covey's own width() cannot measure a painted row yet (#24)", () => {
  // `width()` miscounts a combining mark (#24), which is why the overlay builds
  // its own rows and never calls `wrapSpans`. This test states the gap rather
  // than hiding it: when #24 lands, both numbers are 8 and inline media in the
  // transcript becomes possible.
  const row = placeholderRows(1, 8, 1)[0]!;
  assert.equal(stringWidth(row), 8);
  assert.ok(width(row) > 8, "width() counts the marks and the escape — see #24");
});

// ---------------------------------------------------------------------------
// The escapes
// ---------------------------------------------------------------------------

test("a small image goes as one chunk, with the control keys and m=0", () => {
  const esc = kittyTransmit(7, Buffer.from("hello"), 10, 4);
  assert.equal(esc.startsWith(ESC + "_G"), true);
  assert.equal(esc.endsWith(ESC + "\\"), true);
  assert.match(esc, /a=T,U=1,i=7,f=100,t=d,c=10,r=4,q=2,m=0;aGVsbG8=/);
  assert.equal(esc.split(ESC + "_G").length - 1, 1);
});

test("a large image is chunked, and only the first chunk carries the keys", () => {
  // Three chunks' worth of base64, so there is a middle one: the middle is the
  // chunk that must carry `m=1` and no keys.
  const png = Buffer.alloc(CHUNK_BYTES * 2);
  const esc = kittyTransmit(9, png, 20, 10);
  const parts = esc.split(ESC + "_G").slice(1);
  assert.equal(parts.length, 3);
  assert.match(parts[0]!, /^a=T,U=1,i=9,f=100,t=d,c=20,r=10,q=2,m=1;/);
  assert.match(parts[1]!, /^m=1;/);
  assert.match(parts[2]!, /^m=0;/);
  // Every chunk is within the limit, and the payload is the whole image.
  const payload = parts.map((p) => p.slice(p.indexOf(";") + 1).replace(ESC + "\\", "")).join("");
  for (const p of parts) assert.ok(p.slice(p.indexOf(";") + 1).replace(ESC + "\\", "").length <= CHUNK_BYTES);
  assert.equal(Buffer.from(payload, "base64").length, png.length);
});

test("every escape asks the terminal not to answer", () => {
  // An answer arrives on stdin, where `useInput` would read it as typing.
  for (const esc of [kittyTransmit(1, Buffer.from("x"), 1, 1), kittyDelete(1)]) assert.match(esc, /q=2/);
});

test("delete frees the bytes, not only the placement", () => {
  assert.equal(kittyDelete(12), ESC + "_Ga=d,d=I,i=12,q=2;" + ESC + "\\");
});

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

test("parseCellSize reads the answer to the query, and nothing else", () => {
  assert.equal(CELL_SIZE_QUERY, ESC + "[16t");
  assert.deepEqual(parseCellSize(ESC + "[6;18;9t"), { w: 9, h: 18 });
  // A window report, which a terminal sends unasked on a resize. Sizing a
  // picture off this would make it the size of the screen.
  assert.equal(parseCellSize(ESC + "[4;1080;1920t"), undefined);
  assert.equal(parseCellSize(ESC + "[8;45;120t"), undefined);
  assert.equal(parseCellSize(ESC + "[6;0;9t"), undefined);
  assert.equal(parseCellSize("hello"), undefined);
  // `useInput` takes the first escape of a chunk off before covey sees it.
  assert.deepEqual(parseCellSize("[6;18;9t"), { w: 9, h: 18 });
});

test("takeWindowReports takes every report out of a chunk, and nothing else", () => {
  // One answer, which is how ink delivers one: its leading escape is gone,
  // because ink cuts a read at every escape and drops the first of the event.
  assert.deepEqual(takeWindowReports("[6;34;16t"), { cell: { w: 16, h: 34 }, rest: "" });
  // A whole drag of a corner, were the answers ever to share one chunk.
  const many = "[6;34;16t" + (ESC + "[6;34;16t").repeat(37);
  assert.deepEqual(takeWindowReports(many), { cell: { w: 16, h: 34 }, rest: "" });
  // The window reports a terminal sends unasked go too, and size nothing.
  assert.deepEqual(takeWindowReports(ESC + "[4;1080;1920t" + ESC + "[8;45;120t"), { cell: undefined, rest: "" });
  // The last answer is the one that describes the window now.
  assert.deepEqual(takeWindowReports("[6;34;16t" + ESC + "[6;40;20t").cell, { w: 20, h: 40 });
  // Text around a report is the reader's: this is a bracketed paste, which ink
  // hands over whole, and the one chunk that really does carry both.
  assert.deepEqual(takeWindowReports("before " + ESC + "[6;34;16t after").rest, "before  after");
  // Everything else is the reader's, whole.
  assert.deepEqual(takeWindowReports("hello"), { cell: undefined, rest: "hello" });
  assert.deepEqual(takeWindowReports("the cost is 16t"), { cell: undefined, rest: "the cost is 16t" });
  // A mouse report and a kitty key report are not window reports.
  assert.deepEqual(takeWindowReports(ESC + "[<0;45;8M").rest, ESC + "[<0;45;8M");
  assert.deepEqual(takeWindowReports(ESC + "[116;1u").rest, ESC + "[116;1u");
});

test("mediaBox keeps the picture's shape", () => {
  // A 16:9 screenshot in a pane 100 columns by 20 rows. At an 8x16 cell the
  // picture wants 240 columns and 67.5 rows, so the rows bind: 20/67.5 of the
  // way down, and the columns follow to 240 * 0.296 = 71. Stretched to the
  // full 100 it would be a picture nobody could read a menu off.
  assert.deepEqual(mediaBox({ width: 1920, height: 1080 }, ASSUMED_CELL, { cols: 100, rows: 20 }), { cols: 71, rows: 20 });
  // The same picture in a pane with rows to spare: now the columns bind.
  assert.deepEqual(mediaBox({ width: 1920, height: 1080 }, ASSUMED_CELL, { cols: 100, rows: 60 }), { cols: 100, rows: 28 });
});

test("mediaBox never blows a small picture up", () => {
  // 80x32 pixels is 10 columns and 2 rows at this cell size, and stays there in
  // a pane with room for a hundred.
  assert.deepEqual(mediaBox({ width: 80, height: 32 }, ASSUMED_CELL, { cols: 100, rows: 40 }), { cols: 10, rows: 2 });
});

test("mediaBox always gives back at least one cell", () => {
  assert.deepEqual(mediaBox({ width: 1, height: 4000 }, ASSUMED_CELL, { cols: 80, rows: 20 }), { cols: 1, rows: 20 });
  assert.deepEqual(mediaBox({ width: 0, height: 0 }, ASSUMED_CELL, { cols: 80, rows: 20 }), { cols: 80, rows: 20 });
});

test("pngSize reads the IHDR, and refuses anything that is not a PNG", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
    Buffer.from([0, 0, 0x04, 0xd2, 0, 0, 0x02, 0x9a]),
  ]);
  assert.deepEqual(pngSize(png), { width: 1234, height: 666 });
  assert.equal(pngSize(Buffer.from("\xff\xd8\xffnot a png at all, but long enough")), undefined);
  assert.equal(pngSize(Buffer.alloc(4)), undefined);
});

// ---------------------------------------------------------------------------
// Which terminals
// ---------------------------------------------------------------------------

test("graphicsEnabled names the terminals that can paint", () => {
  assert.equal(graphicsEnabled({ TERM: "xterm-kitty" }), true);
  assert.equal(graphicsEnabled({ TERM_PROGRAM: "ghostty" }), true);
  assert.equal(graphicsEnabled({ TERM_PROGRAM: "WezTerm" }), true);
  // iTerm2 places at the cursor, so a repaint would erase the picture.
  assert.equal(graphicsEnabled({ TERM_PROGRAM: "iTerm.app" }), false);
  assert.equal(graphicsEnabled({ TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(graphicsEnabled({}), false);
});

test("a multiplexer turns it off, and the escape hatches win", () => {
  assert.equal(graphicsEnabled({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1/default,1,0" }), false);
  assert.equal(graphicsEnabled({ TERM: "screen.xterm-kitty" }), false);
  assert.equal(graphicsEnabled({ TERM: "xterm-kitty", COVEY_NO_GRAPHICS: "1" }), false);
  // `COVEY_GRAPHICS` is for a terminal this list has not met — but never inside
  // a multiplexer, which would paint in the wrong cell.
  assert.equal(graphicsEnabled({ TERM: "foot", COVEY_GRAPHICS: "1" }), true);
  assert.equal(graphicsEnabled({ TERM: "foot", COVEY_GRAPHICS: "1", TMUX: "x" }), false);
});
