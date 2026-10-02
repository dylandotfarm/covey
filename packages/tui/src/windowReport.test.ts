/**
 * What the terminal says about its own window must never land in the composer.
 *
 * Resize the window and two things come back up the stream: the answer to the
 * cell size question covey asks for a preview (#163), and, on some terminals,
 * a window size report nobody asked for. Ink hands an unrecognised CSI to
 * `useInput` as the reader's typing, so a reader who dragged the window by
 * its corner found `[6;34;16t` thirty-eight times over in the composer.
 *
 * The form matters, and it is the whole of why the first guard here failed.
 * Ink splits one stdin chunk into one event per escape sequence
 * (`input-parser.js`) and then drops the *leading* escape of each
 * (`use-input.js`), so the answer covey is handed is `[6;34;16t` — which is
 * not what an answer looks like anywhere else, and not what the guard matched.
 *
 * `media.test.ts` states which text is a report. This states the one thing
 * only the component can answer: that what ink really delivers, through the
 * real stdin, is read as the terminal's and not as a hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-window-"));

import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";
import { Store } from "./store.js";

const ESC = "\u001b";
/** The answer to `CELL_SIZE_QUERY`, as ink delivers it: the first escape of
 *  the chunk is gone, and every one after it is not. */
const REPLY = "[6;34;16t";
const MORE = ESC + "[6;34;16t";

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const store = new Store([]);
  store.state = { ...store.state, focus: "composer" } as Store["state"];

  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let painted = "";
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.on("data", (c: Buffer) => { painted += c.toString(); });
  const app = render(React.createElement(App, { store }), {
    stdin, stdout: stdout as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  await tick(150);
  return {
    stdin: stdin as { write(chunk: string): boolean },
    reset() { painted = ""; },
    get painted() { return painted; },
    unmount: () => app.unmount(),
  };
}

test("a drag's worth of cell size answers never reaches the composer", async () => {
  const ink = await mount();
  try {
    ink.reset();
    // One drag of the corner: covey asked again on every resize, and the
    // terminal answered every question.
    ink.stdin.write(REPLY + MORE.repeat(37));
    await tick();
    assert.equal(ink.painted.includes("6;34;16t"), false, "the answers are the terminal's, not the reader's");
  } finally { ink.unmount(); }
});

test("a key that arrives with a report is still the reader's", async () => {
  const ink = await mount();
  try {
    ink.reset();
    ink.stdin.write(REPLY + MORE + "q");
    await tick();
    assert.equal(ink.painted.includes("6;34;16t"), false);
    // The draft is the component's own state, so the screen is where it is
    // read: the composer paints its border, a space, and then the draft.
    assert.ok(ink.painted.includes("│ q "), "the key goes on, so a report never costs a keystroke");
  } finally { ink.unmount(); }
});

test("ordinary typing is untouched", async () => {
  const ink = await mount();
  try {
    ink.reset();
    for (const ch of "hello") ink.stdin.write(ch);
    await tick();
    assert.ok(ink.painted.includes("hello"), "a word the reader typed still lands");
  } finally { ink.unmount(); }
});
