/**
 * What ink actually paints for a picture (#163).
 *
 * `media.test.ts` states what the rows are. This states that they survive ink:
 * the whole route rests on a claim only a render can settle — that a row of
 * placeholder cells reaches the terminal *byte for byte*, and costs exactly the
 * columns it covers on the way.
 *
 * It matters more here than it did for OSC 8, because a placeholder row is not
 * an escape ink can ignore. It is printable text made of a private-use
 * character and combining marks, and every stage ink puts a line through —
 * `wrap-ansi`, `slice-ansi`, the style it inherits from its parent — is a stage
 * that could reorder a mark or cut a cell in half. A terminal handed half a cell
 * paints the wrong part of the picture, or nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import stringWidth from "string-width";
import { OverlayView } from "./components/Overlay.js";
import { PLACEHOLDER, placeholderRows } from "./media.js";
import type { Overlay } from "./store.js";

/** The footer of every media overlay, in all three of its states. */
const FOOTER = "esc or click close";

/**
 * Render one overlay and give back the last frame ink painted.
 *
 * The last one *before* the unmount: ink clears the screen and paints again on
 * the way out, so a test that read every write would count each row twice and a
 * crop would look like a spill.
 *
 * `interactive` is spelled out, and must stay that way. ink resolves it as
 * `interactive ?? (!isInCi && stdout.isTTY)`, so on a CI runner it goes
 * non-interactive and writes nothing at all until the unmount — which is a
 * different renderer from the one a reader has, and not the one this file is
 * about. Left to itself every case here passed on a desk and timed out on CI.
 * `CI=true pnpm test` reproduces that in one command.
 *
 * Waited for by the frame, never by a spell, for the same reason: a fixed wait
 * measures the runner and not covey. The footer is the condition because it is
 * on the screen in all three states, so a frame that carries it is a frame that
 * has been laid out.
 */
async function paint(overlay: Overlay, width = 80, height = 24): Promise<string> {
  const writes: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { writes.push(String(c)); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = width;
  stdout.rows = height;
  (stdout as { isTTY?: boolean }).isTTY = true;
  const app = render(
    React.createElement(OverlayView, { overlay, cursor: 0, filter: "", checked: false, width, height }),
    { stdout, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  // A frame is a write that carries rows; the rest are the cursor and the
  // synchronised-update brackets around it.
  const frames = () => writes.filter((w) => w.includes("\n") && w.includes(FOOTER));
  const deadline = Date.now() + 10_000;
  while (frames().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const frame = frames().at(-1) ?? "";
  app.unmount();
  assert.ok(frame, "ink painted no frame at all");
  return frame;
}

/** A media overlay in whatever state a case is about. */
function media(view: (Overlay & { kind: "media" })["view"]): Overlay {
  return {
    kind: "media", threadId: "t-1", path: "/w/.covey/threads/t-1/files/shot.png", name: "shot.png",
    uri: "http://box:3790/file?thread=t-1&path=%2Fw%2Fshot.png", view,
  };
}

const ready = (id: number, cols: number, rows: number, poster = false): Overlay =>
  media({ kind: "ready", id, cols, rows, poster });

/** The frame's lines, as the terminal would take them. */
const framed = (frame: string) => frame.split("\n");

test("every painted row reaches the terminal byte for byte", async () => {
  const frame = await paint(ready(0x4242, 30, 6));
  for (const row of placeholderRows(0x4242, 30, 6)) {
    assert.ok(frame.includes(row), "ink changed a placeholder row on the way out");
  }
});

test("a painted row costs the columns it covers, and no more", async () => {
  // If ink counted the marks or the colour, the picture would be pushed off the
  // right edge and the rows under it would wrap.
  const width = 80;
  const frame = await paint(ready(7, 40, 4), width);
  const picture = framed(frame).filter((l) => l.includes(PLACEHOLDER));
  assert.equal(picture.length, 4);
  for (const l of picture) {
    // The row itself is 40 columns; the rest of the line is the blank the
    // centring put in front of it.
    assert.ok(stringWidth(l) <= width, `a picture row measured ${stringWidth(l)} of ${width}`);
    assert.ok(stringWidth(l) >= 40, `a picture row measured only ${stringWidth(l)}`);
  }
});

test("the rows are not wrapped, whatever the pane does", async () => {
  // A row as wide as the pane is the case that would wrap, and a wrapped row
  // paints the bottom of the picture beside the top of it.
  const frame = await paint(ready(9, 76, 3), 80);
  assert.equal(framed(frame).filter((l) => l.includes(PLACEHOLDER)).length, 3);
});

test("a rectangle taller than the pane is cropped, not spilled", async () => {
  // The picture was sized against the pane the reader clicked in. After a
  // resize the layout must stay sane, and a cropped picture is what does that.
  const frame = await paint(ready(11, 20, 40), 80, 12);
  const painted = framed(frame).filter((l) => l.includes(PLACEHOLDER)).length;
  assert.ok(painted > 0 && painted <= 12, `painted ${painted} rows into 12`);
});

test("the name and the way out are always on the screen", async () => {
  const frame = await paint(ready(1, 20, 3));
  assert.match(frame, /shot\.png/);
  assert.match(frame, new RegExp(FOOTER));
});

test("a video says it is one frame, and an image does not", async () => {
  assert.match(await paint(ready(1, 20, 3, true)), /the first frame/);
  assert.doesNotMatch(await paint(ready(1, 20, 3, false)), /the first frame/);
});

test("while covey fetches, the overlay says so and paints no cells", async () => {
  const frame = await paint(media({ kind: "loading" }));
  assert.match(frame, /fetching/);
  assert.ok(!frame.includes(PLACEHOLDER));
});

test("a failure is the sentence, not a blank rectangle", async () => {
  // Four things can go wrong and the reader has to be told which (#132).
  const message = "this machine has no tool to make a picture of it (covey looks for sips, magick, convert or ffmpeg)";
  const frame = await paint(media({ kind: "error", message }));
  assert.match(frame, /no tool to make a picture/);
  assert.ok(!frame.includes(PLACEHOLDER));
});
