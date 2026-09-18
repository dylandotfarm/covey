/**
 * Double and triple click, driven through the real component.
 *
 * `selection.test.ts` states what a word and a run are. This states that a
 * second press within the window and within the slop reaches them at all:
 * the count lives in a ref inside a React closure, and the columns come from
 * the pane geometry, so neither can be checked anywhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-click-"));

import React from "react";
import { render } from "ink";
import type { TimelineItem } from "@covey/protocol";
import { App } from "./components/App.js";
import { Store, selectionBounds } from "./store.js";

const ESC = "\u001b";
const PATH = "packages/tui/src/lines.ts:439";
/** Every row is this, so a press anywhere in the pane lands on the path. */
const ROW = `see ${PATH} here`;
const SENTENCE = "The wrapper knows which breaks it inserted, so a copy puts the paragraph back together instead of carrying the pane width to the clipboard.";

function fakeStdin() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.setRawMode = () => s;
  s.ref = () => s;
  s.unref = () => s;
  return s as NodeJS.ReadStream & { write(chunk: string): boolean };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Mount over one assistant message of `count` identical lines. */
async function mount(line: string, count: number) {
  const item = {
    id: "a", threadId: "t", turnId: null, seq: 1, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", kind: "assistant",
    text: Array.from({ length: count }, () => line).join("\n"), streaming: false, model: null,
  } as unknown as TimelineItem;

  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "composer",
    // Scrolled a little off the bottom, so the blank row `renderItem` puts
    // after the message is below the pane and every visible row is text.
    scrollFromBottom: 5,
    view: {
      machine: "m", threadId: "t", thread: null, items: new Map([["a", item]]),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 1,
    },
  } as Store["state"];

  const stdin = fakeStdin();
  const written: string[] = [];
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.resume();
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk: any, ...rest: any[]) => { written.push(String(chunk)); return write(chunk, ...rest); };

  const app = render(React.createElement(App, { store }), {
    stdin, stdout: stdout as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false,
    // Ink writes only the final frame when it decides it is not interactive,
    // which is what it decides on a CI runner.
    interactive: true,
  });
  await tick(150);
  return { store, stdin, written, unmount: () => app.unmount() };
}

/** What the last OSC 52 put on the clipboard. */
function clipboard(written: string[]): string | null {
  const re = new RegExp(ESC + "\\]52;c;([A-Za-z0-9+/=]*)\\u0007");
  for (const chunk of written.slice().reverse()) {
    const m = re.exec(chunk);
    if (m) return Buffer.from(m[1]!, "base64").toString("utf8");
  }
  return null;
}

/**
 * `n` presses and releases at one cell, all inside one write.
 *
 * One chunk, so the whole run is handled in a single synchronous `useInput`
 * call. The gap between the presses is microseconds of arithmetic, not
 * something the machine's speed can stretch past the 400 ms window.
 */
const clicks = (n: number, col: number, row: number) =>
  `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`.repeat(n);

// The sidebar is 34 columns, and the transcript starts at screen row 3.
// Column 45 is character 10 of the row, which is inside the path; row 8 is
// five rows into the pane.
const COL = 45;
const ROW_Y = 8;

test("a double click on a path selects the whole path, including the :439", async () => {
  const { store, stdin, written, unmount } = await mount(ROW, 200);
  try {
    stdin.write(clicks(2, COL, ROW_Y));
    await tick(150);
    const sel = store.getState().selection;
    assert.ok(sel, "a double click leaves a selection behind");
    const { from, to } = selectionBounds(sel!);
    assert.equal(from.line, to.line, "a word is on one line");
    // "  see " is six columns, and the path is twenty-nine.
    assert.equal(from.col, 6);
    assert.equal(to.col, 6 + PATH.length);
    assert.equal(clipboard(written), PATH, "and it goes straight to the clipboard");
  } finally { unmount(); }
});

test("a single click selects nothing and copies nothing", async () => {
  // The other half of the claim: the second press is what makes the word, not
  // the first. Without it a click is still only a caret.
  const { store, stdin, written, unmount } = await mount(ROW, 200);
  try {
    stdin.write(clicks(1, COL, ROW_Y));
    await tick(150);
    assert.equal(store.getState().selection, null);
    assert.equal(clipboard(written), null);
  } finally { unmount(); }
});

test("a triple click takes the whole wrapped run, not the row under the pointer", async () => {
  // Each sentence is wider than the pane, so every logical line is two rows.
  const { store, stdin, written, unmount } = await mount(SENTENCE, 120);
  try {
    stdin.write(clicks(3, COL, ROW_Y));
    await tick(150);
    const sel = store.getState().selection;
    assert.ok(sel);
    const { from, to } = selectionBounds(sel!);
    assert.equal(to.line - from.line, 1, "the run really is two painted rows");
    assert.equal(clipboard(written), "  " + SENTENCE, "and it copies as one line");
  } finally { unmount(); }
});

test("a press outside the window starts a new run rather than counting on", async () => {
  const { store, stdin, written, unmount } = await mount(ROW, 200);
  try {
    stdin.write(clicks(1, COL, ROW_Y));
    await tick(450); // past MULTI_CLICK_MS
    stdin.write(clicks(1, COL, ROW_Y));
    await tick(150);
    assert.equal(store.getState().selection, null, "two slow clicks are two clicks");
    assert.equal(clipboard(written), null);
  } finally { unmount(); }
});
