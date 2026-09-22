import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// The store reads its preferences the moment it is built, so point the config
// at a throwaway directory before the module is ever imported.
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-stream-"));

import React from "react";
import { render } from "ink";
import type { TimelineItem } from "@covey/protocol";
import { App } from "./components/App.js";
import { Store } from "./store.js";

/**
 * #114: a reply that streams must not drag the screen under a reader who
 * scrolled up.
 *
 * The scroll is a count of lines from the bottom, and a streamed item is
 * re-sent whole with more text each time, so the bottom moves and the same
 * count named a window further down the transcript — once per event, which is
 * what threw the reader's place away. `scroll.ts` holds the arithmetic and
 * `scroll.test.ts` tests it; what only a mounted App can show is that the
 * store, the layout and the paint agree, so these cases read the frame.
 */

const item = (n: number): TimelineItem => ({
  id: `i${n}`, threadId: "t", turnId: null, seq: n, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "assistant", text: `line ${n}`, streaming: false, model: null,
} as unknown as TimelineItem);

/** The streaming reply, `lines` lines long, always the last item. */
const reply = (lines: number): TimelineItem => ({
  id: "reply", threadId: "t", turnId: "turn1", seq: 500, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: new Date().toISOString(), kind: "assistant",
  text: Array.from({ length: lines }, (_, i) => `reply ${i + 1}`).join("\n\n"),
  streaming: true, model: "claude",
} as unknown as TimelineItem);

function fakeStdin() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.setRawMode = () => s;
  s.ref = () => s;
  s.unref = () => s;
  return s as NodeJS.ReadStream & { write(chunk: string): boolean };
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const ESC = "";

/** Every `line N` and `reply N` the last frame painted, in order. */
function shown(frame: string): string[] {
  const plain = frame
    .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(\\u0007|${ESC}\\\\)`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
  return [...plain.matchAll(/(?:line|reply) \d+/g)].map((m) => m[0]);
}

async function mount(items: TimelineItem[]) {
  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "composer",
    selected: { machine: "m", threadId: "t" },
    view: {
      machine: "m", threadId: "t", thread: null,
      items: new Map(items.map((i) => [i.id, i])),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 200,
    },
  } as Store["state"];

  const stdin = fakeStdin();
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  const frames: string[] = [];
  stdout.write = (chunk: any) => { frames.push(String(chunk)); return true; };
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false,
    // Ink writes only a closing frame when it decides it is not interactive,
    // which is what a CI runner makes it decide. These cases read the frames.
    interactive: true,
  });
  await tick();
  /** One more line of the reply, the way the daemon re-sends the whole item. */
  const stream = async (lines: number) => {
    (store as any).applyThread("m", "t", { kind: "item.upserted", seq: 600 + lines, item: reply(lines) });
    await tick();
  };
  return {
    store, stdin, stream,
    // The newest frame that painted the screen. Ink also writes short control
    // sequences of its own — the cursor it hides and shows — and the last
    // write is one of those as often as not.
    lastFrame: () => [...frames].reverse().find((f) => f.length > 200) ?? "",
    unmount: () => app.unmount(),
  };
}

/** One SGR wheel report, over the transcript rather than the sidebar. */
const notch = (code: number) => `${ESC}[<${code};80;10M`;

/** A transcript with room to scroll, ending in the reply that streams. */
const transcript = () => [...Array.from({ length: 60 }, (_, i) => item(i + 1)), reply(1)];

test("a reply that streams leaves a scrolled-up reader on the lines they were reading", async () => {
  const m = await mount(transcript());
  try {
    m.stdin.write(notch(64).repeat(12)); // twelve notches up
    await tick();
    const before = shown(m.lastFrame());
    assert.ok(before.length > 0, "the transcript painted something to hold still");
    assert.ok(m.store.getState().scrollFromBottom > 0, "and the reader really is scrolled up");

    for (let n = 2; n <= 8; n++) await m.stream(n);

    assert.deepEqual(shown(m.lastFrame()), before,
      "every line on screen must be the line that was there before the reply grew");
  } finally { m.unmount(); }
});

test("the badge counts the growing reply, so the reader sees how far below the end is", async () => {
  const m = await mount(transcript());
  try {
    m.stdin.write(notch(64).repeat(12));
    await tick();
    const count = (f: string) => Number(/↓ (\d+) lines below/.exec(f)?.[1] ?? -1);
    const before = count(m.lastFrame());
    assert.ok(before > 0, `the badge names the lines below (read ${before})`);

    for (let n = 2; n <= 8; n++) await m.stream(n);

    assert.ok(count(m.lastFrame()) > before,
      "a reply that grew below the window puts more lines below it, not the same number");
  } finally { m.unmount(); }
});

test("a reader at the bottom still follows the reply", async () => {
  const m = await mount(transcript());
  try {
    assert.equal(m.store.getState().scrollFromBottom, 0, "the thread opens at the bottom");
    for (let n = 2; n <= 8; n++) await m.stream(n);
    assert.equal(m.store.getState().scrollFromBottom, 0, "and stays there");
    assert.ok(shown(m.lastFrame()).includes("reply 8"),
      "the newest line of the reply is on screen");
    assert.ok(!/↓ \d+ lines below/.test(m.lastFrame()), "and no badge says otherwise");
  } finally { m.unmount(); }
});

test("scrolling back to the bottom follows again", async () => {
  const m = await mount(transcript());
  try {
    m.stdin.write(notch(64).repeat(12));
    await tick();
    for (let n = 2; n <= 8; n++) await m.stream(n);
    // Back down, far enough to reach the end from wherever the reply left the
    // window. Each notch measures against the layout on screen, so a reader
    // who scrolls down through a growing reply still arrives at the bottom.
    m.stdin.write(notch(65).repeat(60));
    await tick();
    assert.equal(m.store.getState().scrollFromBottom, 0, "the notches reach the bottom");
    assert.equal(m.store.getState().scrollAnchor, null, "and the anchor goes with them");
    for (let n = 9; n <= 12; n++) await m.stream(n);
    assert.ok(shown(m.lastFrame()).includes("reply 12"), "and the screen follows the reply again");
  } finally { m.unmount(); }
});
