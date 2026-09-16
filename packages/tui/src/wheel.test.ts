import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// The store loads prefs the moment it is constructed, so point the config at a
// throwaway directory before it is ever imported.
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-wheel-"));

import React from "react";
import { render } from "ink";
import type { Project, Thread, TimelineItem, TurnDiff } from "@covey/protocol";
import { App } from "./components/App.js";
import { Store, type MachineState } from "./store.js";

/**
 * These are regression tests for a defect that only exists inside the React
 * closure, so they drive the real component. `handleMouse` used to read the
 * scroll offset from `state`, the last render's snapshot. A chunk of wheel
 * notches is replayed one notch at a time inside a single `useInput` call, and
 * the snapshot does not move inside that loop, so every notch measured from the
 * same base and the last one won. Nothing short of mounting App can see that:
 * a test that folds the deltas itself passes either way.
 */

const item = (n: number): TimelineItem => ({
  id: `i${n}`, threadId: "t", turnId: null, seq: n, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "assistant", text: `line ${n}`, streaming: false, model: null,
} as unknown as TimelineItem);

/** Ink needs a TTY-shaped stdin it can put in raw mode and `read()` from. */
function fakeStdin() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.setRawMode = () => s;
  s.ref = () => s;
  s.unref = () => s;
  return s as NodeJS.ReadStream & { write(chunk: string): boolean };
}

function fakeStdout(cols = 120, rows = 30) {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  s.resume();
  return s as NodeJS.WriteStream;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A patch long enough that the diff panel has somewhere to scroll to. */
const turnDiff = (): TurnDiff => ({
  turnId: "turn1",
  files: [{ path: "f", additions: 40, deletions: 0, status: "M" }],
  additions: 40,
  deletions: 0,
  patch: ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,40 +1,40 @@",
    ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join("\n"),
} as unknown as TurnDiff);

/** Mount App over a transcript long enough to scroll, and return the pieces. */
async function mount(patch: Partial<Store["state"]> = {}) {
  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "sidebar",
    view: {
      machine: "m", threadId: "t", thread: null,
      items: new Map(Array.from({ length: 200 }, (_, i) => item(i + 1)).map((i) => [i.id, i])),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 200,
    },
    ...patch,
  } as Store["state"];

  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false,
  });
  await tick(120);
  return { store, stdin, unmount: () => app.unmount() };
}

/** One SGR wheel report. Column 80 is past the 34-column sidebar. */
const notch = (code: number, col = 80) => `\x1b[<${code};${col};10M`;

test("a chunk of wheel notches scrolls the transcript once per notch", async () => {
  const { store, stdin, unmount } = await mount();
  try {
    // Five wheel-up reports in one write, the way a terminal delivers a fast
    // scroll. Ink hands the whole chunk to one `useInput` call.
    stdin.write(notch(64).repeat(5));
    await tick(120);
    assert.equal(store.getState().scrollFromBottom, 5,
      "five notches in one chunk must move five rows, not one");
  } finally { unmount(); }
});

test("a chunk of wheel notches scrolls the diff panel once per notch", async () => {
  const diff = turnDiff();
  const { store, stdin, unmount } = await mount({
    diffView: { threadId: "t", loading: false, diff, scroll: 0 },
  });
  try {
    stdin.write(notch(65).repeat(5)); // wheel down: towards the end of the diff
    await tick(120);
    assert.equal(store.getState().diffView!.scroll, 5,
      "five notches in one chunk must move five rows, not one");
  } finally { unmount(); }
});

// `scrollPane` is the keyboard path and had the same defect. A held key arrives
// as one batched chunk too, and App replays it key by key.
test("a held key scrolls the diff panel once per repeat", async () => {
  const diff = turnDiff();
  const { store, stdin, unmount } = await mount({
    diffView: { threadId: "t", loading: false, diff, scroll: 0 },
  });
  try {
    // Focus is the sidebar, so a multi-character chunk is replayed key by key
    // rather than treated as a paste into the composer.
    stdin.write("jjjjj");
    await tick(120);
    assert.equal(store.getState().diffView!.scroll, 5,
      "five repeats in one chunk must move five rows, not one");
  } finally { unmount(); }
});

// A sideways notch must not scroll, and must not be read as a vertical one.
// Each direction is asserted on its own: three lefts and three rights in one
// chunk cancel out under the old parser, so a mixed chunk proves nothing. The
// transcript starts part-scrolled so that neither direction clamps at an end.
test("a chunk of left notches scrolls nothing", async () => {
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 20 });
  try {
    stdin.write(notch(66).repeat(3));
    await tick(120);
    assert.equal(store.getState().scrollFromBottom, 20,
      "a left notch is not a wheel up");
  } finally { unmount(); }
});

test("a chunk of right notches scrolls nothing", async () => {
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 20 });
  try {
    stdin.write(notch(67).repeat(3));
    await tick(120);
    assert.equal(store.getState().scrollFromBottom, 20,
      "a right notch is not a wheel down");
  } finally { unmount(); }
});

// The reported symptom. A trackpad puts a left notch into the middle of a slow
// scroll down. Read as a wheel up, each one threw the transcript back against
// the direction of travel, which is the flicker people see.
test("a left notch mixed into a scroll down does not throw the view back up", async () => {
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 20 });
  try {
    stdin.write(notch(65) + notch(66) + notch(65) + notch(66) + notch(65));
    await tick(120);
    assert.equal(store.getState().scrollFromBottom, 17,
      "three down notches move three rows down, whatever sideways arrives with them");
  } finally { unmount(); }
});

// ---- the sidebar branch -----------------------------------------------------

// #26 made the sidebar cursor a row key rather than an index, and the wheel
// branch calls its `moveCursor`. That update is functional, so it should not
// have the defect above — but "should" is not evidence, and the cursor is React
// state that no assertion can reach directly. The preview timer can: it opens
// the thread the cursor is sitting on, so a stub on `select` reports the row it
// landed on.
const thread = (n: number): Thread => ({
  id: `t${n}`, projectId: "p", title: `thread ${n}`, provider: "claude", sessionId: `s${n}`,
  model: null, permissionMode: "default", modeChosen: false, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: `2026-01-01T00:00:${String(60 - n).padStart(2, "0")}Z`, archivedAt: null, movedTo: null,
} as unknown as Thread);

function machineWithThreads(n: number): MachineState {
  const project = { id: "p", title: "proj", workspaceRoot: "/w", repositoryIdentity: null,
    defaultModel: null, defaultWorkspaceMode: null, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z" } as unknown as Project;
  return {
    key: "m", saved: { name: "m", url: "ws://127.0.0.1:1" }, conn: "connected", error: null,
    info: { name: "m" } as any, projects: new Map([["p", project]]),
    threads: new Map(Array.from({ length: n }, (_, i) => thread(i + 1)).map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
}

test("a chunk of wheel notches over the sidebar moves one row a notch", async () => {
  const picked: string[] = [];
  const { store, stdin, unmount } = await mount({
    machines: new Map([["m", machineWithThreads(10)]]), order: ["m"],
  });
  // The preview opens whatever the cursor settles on; record it instead.
  (store as any).select = async (sel: { threadId: string }) => { picked.push(sel.threadId); };
  try {
    // Column 10 is inside the 34-column sidebar. Four notches down in one chunk.
    stdin.write(notch(65, 10).repeat(4));
    await tick(300); // past PREVIEW_MS
    // The cursor starts on row 0. Rows are the machine, the project, then the
    // threads in recency order, so four rows down lands on the third thread.
    // One notch a row, and the chunk does not collapse to a single step.
    assert.equal(picked.at(-1), "t3",
      "four notches in one chunk must move four rows, not one");
  } finally { unmount(); }
});
