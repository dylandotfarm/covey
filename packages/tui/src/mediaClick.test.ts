/**
 * What a click on a shown file does, driven through the real component (#163).
 *
 * `media.test.ts` states what the escapes are and `mediaPaint.test.ts` states
 * that ink paints them. This states the part only App can answer: that a plain
 * click on a row `covey show` drew opens the preview instead of teaching the
 * browser gesture, and that a preview which cannot load says which of the four
 * things went wrong rather than sitting on an empty rectangle.
 *
 * Nothing here reaches a daemon. The view's machine is a port with nothing on
 * it, so the fetch is refused at once and the overlay lands in its error state
 * — which is the state worth testing, because it is the one a reader on a
 * machine that has gone away will see.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-media-"));
// The runner's terminal is not one that paints, so say that this one does.
// `App` asks `graphicsEnabled()` at the click rather than at its import, which
// is what lets a plain assignment here work at all: node evaluates every static
// import below before the first statement of this file.
process.env.COVEY_GRAPHICS = "1";
delete process.env.COVEY_NO_GRAPHICS;
delete process.env.TMUX;

import React from "react";
import { render } from "ink";
import type { TimelineItem } from "@covey/protocol";
import { App } from "./components/App.js";
import { Store } from "./store.js";
import { layoutTranscript } from "./components/Transcript.js";
import type { ThreadView } from "./store.js";

const ESC = "\u001b";
/** Nothing listens here, so `loadPreview` fails at the connection. */
const MACHINE = "ws://127.0.0.1:1";
const FILES = 200;

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await tick(20);
}

/**
 * One note with a file per row and no prose, so every row of the pane is a file
 * row and a press anywhere in it lands on one. Scrolled five lines up, which
 * puts the note's own trailing blank off the bottom.
 */
function noteItem(): TimelineItem {
  return {
    id: "n", threadId: "t", turnId: null, seq: 1, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", kind: "note", text: "", tone: "info",
    files: Array.from({ length: FILES }, (_, i) => ({ name: `shot-${i}.png`, path: `/w/.covey/threads/t/files/shot-${i}.png` })),
  } as unknown as TimelineItem;
}

function viewOf(): ThreadView {
  return {
    machine: MACHINE, threadId: "t", thread: null, items: new Map([["n", noteItem()]]),
    loading: false, error: null, hasMore: false, loadingOlder: false, seq: 1,
  } as unknown as ThreadView;
}

function fakeStdin() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.setRawMode = () => s;
  s.ref = () => s;
  s.unref = () => s;
  return s as NodeJS.ReadStream & { write(chunk: string): boolean };
}

/**
 * Mount App and wait until it has painted a file row.
 *
 * Waited for by the paint, never by a spell. A click that lands before the
 * first frame finds no layout to hit, and the case then fails on a timeout a
 * long way from what it covers — which is what a fixed 120ms did to
 * `mediaPaint.test.ts` on a loaded CI runner.
 */
async function mount() {
  const store = new Store([]);
  store.state = { ...store.state, focus: "composer", scrollFromBottom: 5, view: viewOf() } as Store["state"];
  const stdin = fakeStdin();
  const painted: string[] = [];
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 30;
  const write = stdout.write.bind(stdout);
  stdout.write = (c: unknown, ...rest: unknown[]) => { painted.push(String(c)); return write(c, ...rest); };
  stdout.resume();
  const app = render(React.createElement(App, { store }), {
    stdin, stdout: stdout as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  // `⎘` is the mark on a shown file, so a frame carrying one is a frame with
  // the rows this file clicks on.
  await until(() => painted.some((w) => w.includes("⎘")));
  return { store, stdin, unmount: () => app.unmount() };
}

const press = (col: number, row: number, mods = 0) => `${ESC}[<${mods};${col};${row}M`;
const click = (col: number, row: number, mods = 0) => press(col, row, mods) + `${ESC}[<${mods};${col};${row}m`;

// The sidebar is 34 columns and the transcript starts at screen row 3, so this
// is inside a `    ⎘ shot-N.png` row, on the name.
const ON_NAME = 45;
const ROW_Y = 8;

// ---------------------------------------------------------------------------
// The layout knows which rows are files
// ---------------------------------------------------------------------------

test("layoutTranscript maps every shown file row to its file and its thread", () => {
  const layout = layoutTranscript(viewOf(), 100, new Set(), { cursor: 0, answered: [] }, "full", { localFiles: false });
  assert.equal(layout.media.size, FILES, "one entry per file, and none for the blank");
  const first = layout.media.get([...layout.media.keys()].sort((a, b) => a - b)[0]!)!;
  // The thread comes off the item, because `/file` serves one thread's own
  // store and a preview filed under another thread would be refused.
  assert.equal(first.threadId, "t");
  assert.match(first.name, /^shot-\d+\.png$/);
  assert.match(first.path, /\/\.covey\/threads\/t\/files\/shot-\d+\.png$/);
});

test("a row that is not a file is not in the map", () => {
  const item = {
    id: "a", threadId: "t", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "assistant", text: "just prose, and a path /w/a.ts in it", streaming: false, model: null,
  } as unknown as TimelineItem;
  const view = { ...viewOf(), items: new Map([["a", item]]) } as ThreadView;
  assert.equal(layoutTranscript(view, 100, new Set(), { cursor: 0, answered: [] }, "full", { localFiles: true }).media.size, 0);
});

// ---------------------------------------------------------------------------
// The click
// ---------------------------------------------------------------------------

test("a plain click on a shown file opens the preview", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(ON_NAME, ROW_Y));
    await until(() => store.getState().overlay?.kind === "media");
    const ov = store.getState().overlay;
    assert.equal(ov?.kind, "media");
    assert.match(ov!.kind === "media" ? ov.name : "", /^shot-\d+\.png$/);
    // The URL is the daemon's own `/file` route, carrying the thread — not a
    // `file://` path, which would name a file on the wrong machine.
    assert.match(ov!.kind === "media" ? ov.uri ?? "" : "", /^http:\/\/127\.0\.0\.1:1\/file\?thread=t&path=/);
  } finally { unmount(); }
});

test("a click on a shown file does not teach the browser gesture", async () => {
  // The row carries the `/file` link as well, and a plain click elsewhere names
  // the gesture for it. Here the click already did something, so naming a
  // second route would be noise.
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(ON_NAME, ROW_Y));
    await until(() => store.getState().overlay?.kind === "media");
    assert.doesNotMatch(store.getState().notice?.text ?? "", /open this link/);
  } finally { unmount(); }
});

test("a preview covey cannot fetch says so, and says what went wrong", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(ON_NAME, ROW_Y));
    await until(() => {
      const ov = store.getState().overlay;
      return ov?.kind === "media" && ov.view.kind === "error";
    });
    const ov = store.getState().overlay;
    assert.equal(ov?.kind === "media" && ov.view.kind, "error");
    const message = ov?.kind === "media" && ov.view.kind === "error" ? ov.view.message : "";
    assert.match(message, /could not reach the machine/, `said: ${message}`);
  } finally { unmount(); }
});

test("esc closes the preview", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(ON_NAME, ROW_Y));
    await until(() => store.getState().overlay?.kind === "media");
    // Stated, not assumed: without this the case passes on a preview that never
    // opened, which is exactly how it read before `graphicsEnabled` was asked
    // at the click instead of at the import.
    assert.equal(store.getState().overlay?.kind, "media");
    stdin.write(ESC);
    await until(() => store.getState().overlay == null);
    assert.equal(store.getState().overlay, null);
  } finally { unmount(); }
});

test("a click closes the preview, the same gesture that opened it", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(ON_NAME, ROW_Y));
    await until(() => store.getState().overlay?.kind === "media");
    assert.equal(store.getState().overlay?.kind, "media");
    stdin.write(press(60, 10));
    await until(() => store.getState().overlay == null);
    assert.equal(store.getState().overlay, null);
  } finally { unmount(); }
});
