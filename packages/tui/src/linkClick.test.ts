/**
 * What a click on a link does, driven through the real component.
 *
 * `links.test.ts` states which text is a link and what opens it. This states
 * the one thing only the component can answer: covey never sees a cmd+click,
 * so a plain click on a link has to teach the gesture instead of opening
 * anything, and a modified click that lands on nothing has to say so.
 *
 * Nothing here spawns a browser. A click with alt held is tested only where
 * there is no link under it, because the branch that opens one runs `open` or
 * `xdg-open` on the machine the test runs on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-link-"));

import React from "react";
import { render } from "ink";
import type { TimelineItem } from "@covey/protocol";
import { App } from "./components/App.js";
import { Store } from "./store.js";
import { openGesture } from "./links.js";

const ESC = "\u001b";
const URL = "https://github.com/o/r/pull/9";
/** Every row is this, so a press anywhere in the pane lands on the URL. */
const ROW = `see ${URL} here`;
/** The words covey must use on the machine this test runs on. */
const GESTURE = openGesture(process.platform);

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function fakeStdin() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.setRawMode = () => s;
  s.ref = () => s;
  s.unref = () => s;
  return s as NodeJS.ReadStream & { write(chunk: string): boolean };
}

async function mount() {
  const item = {
    id: "a", threadId: "t", turnId: null, seq: 1, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", kind: "assistant",
    text: Array.from({ length: 200 }, () => ROW).join("\n"), streaming: false, model: null,
  } as unknown as TimelineItem;

  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "composer",
    scrollFromBottom: 5,
    view: {
      machine: "m", threadId: "t", thread: null, items: new Map([["a", item]]),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 1,
    },
  } as Store["state"];

  const stdin = fakeStdin();
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.resume();
  const app = render(React.createElement(App, { store }), {
    stdin, stdout: stdout as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  await tick(150);
  return { store, stdin, unmount: () => app.unmount() };
}

/** One press and release at one cell, with the modifier bits of `mods`. */
const click = (col: number, row: number, mods = 0) =>
  press(col, row, mods) + `${ESC}[<${mods};${col};${row}m`;

/** The press on its own, for a claim about the selection it opens. A release
 *  over the same cell selects nothing and so clears it again. */
const press = (col: number, row: number, mods = 0) => `${ESC}[<${mods};${col};${row}M`;

// The sidebar is 34 columns and the transcript starts at screen row 3, so
// screen column 45 is character 10 of the row — inside the URL, which starts
// at character 6. Column 38 is character 3, the space before it.
const ON_LINK = 45;
const OFF_LINK = 38;
const ROW_Y = 8;
const ALT = 8;

test(`a plain click on a link says "${GESTURE} to open this link", and opens nothing`, async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(press(ON_LINK, ROW_Y));
    await tick(150);
    assert.equal(store.getState().notice?.text, `${GESTURE} to open this link`);
    // The click still does its own job: it opens a selection to drag, it does
    // not swallow the press to show the hint.
    assert.ok(store.getState().selection, "the press still begins a selection");
  } finally { unmount(); }
});

test("a plain click away from a link says nothing", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(OFF_LINK, ROW_Y));
    await tick(150);
    assert.equal(store.getState().notice, null, "a hint on every click in the pane is noise");
  } finally { unmount(); }
});

test("alt+click away from a link names the gesture too", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    stdin.write(click(OFF_LINK, ROW_Y, ALT));
    await tick(150);
    assert.equal(store.getState().notice?.text, `no link here — ${GESTURE} a path or a URL`);
    assert.equal(store.getState().selection, null, "a click that asked to open starts no selection");
  } finally { unmount(); }
});
