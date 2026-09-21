/**
 * What the wheel is allowed to do, and what a drag past an edge does.
 *
 * Both live inside a React closure, so both need the real component: a test
 * that called the handler itself would be free to invent the geometry, and the
 * geometry is half of what is being asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-mousescroll-"));

import React from "react";
import { render } from "ink";
import type { Project, Thread, TimelineItem } from "@covey/protocol";
import { App, DRAG_SCROLL_MS } from "./components/App.js";
import { Store, selectionBounds, type DirEntry, type MachineState } from "./store.js";

const item = (n: number): TimelineItem => ({
  id: `i${n}`, threadId: "t", turnId: null, seq: n, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "assistant", text: `line ${n}`, streaming: false, model: null,
} as unknown as TimelineItem);

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

async function mount(patch: Partial<Store["state"]> = {}) {
  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "composer",
    view: {
      machine: "m", threadId: "t", thread: null,
      items: new Map(Array.from({ length: 200 }, (_, i) => item(i + 1)).map((i) => [i.id, i])),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 200,
    },
    ...patch,
  } as Store["state"];

  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const written: string[] = [];
  const realWrite = stdout.write.bind(stdout);
  (stdout as any).write = (chunk: any, ...rest: any[]) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false,
    // Ink writes only the final frame when it decides it is not interactive,
    // which is what it decides on a CI runner. Force the live path, or these
    // pass here and fail there.
    interactive: true,
  });
  await tick(120);
  return { store, stdin, written, unmount: () => app.unmount() };
}

/**
 * Watch the repeating timers a test creates, so the teardown can be asserted
 * as a teardown.
 *
 * `dragScrollStep` also gives up when the selection stops dragging, so a
 * missing `clearInterval` does not show up as a scroll. It shows up as a timer
 * that is still registered, and that is the leak the issue names — so this
 * counts the timers rather than the rows.
 */
function trackIntervals(period: number) {
  const live = new Set<unknown>();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: any, ms?: number, ...rest: any[]) => {
    const t = (realSet as any)(fn, ms, ...rest);
    if (ms === period) live.add(t);
    return t;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((t: any) => { live.delete(t); return (realClear as any)(t); }) as typeof globalThis.clearInterval;
  return {
    count: () => live.size,
    restore: () => {
      for (const t of live) (realClear as any)(t);
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}

const ESC = "\u001b";
/** One SGR report. Column 10 is inside the 34-column sidebar; 80 is past it. */
const notch = (code: number, col = 80, row = 10) => `${ESC}[<${code};${col};${row}M`;
const press = (col: number, row: number) => `${ESC}[<0;${col};${row}M`;
const drag = (col: number, row: number) => `${ESC}[<32;${col};${row}M`;
const release = (col: number, row: number) => `${ESC}[<0;${col};${row}m`;

// ---------------------------------------------------------------------------
// A scroll never changes what is open
// ---------------------------------------------------------------------------

const thread = (n: number): Thread => ({
  id: `t${n}`, projectId: "p", title: `thread ${n}`, provider: "claude", sessionId: `s${n}`,
  model: null, permissionMode: "default", modeChosen: false, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: `2026-01-01T00:00:${String(60 - n).padStart(2, "0")}Z`, archivedAt: null, movedTo: null,
} as unknown as Thread);

function machineWithThreads(n: number): MachineState {
  const project = { id: "p", title: "proj", workspaceRoot: "/w", repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z" } as unknown as Project;
  return {
    key: "m", saved: { name: "m", url: "ws://127.0.0.1:1" }, conn: "connected", error: null,
    info: { name: "m" } as any, projects: new Map([["p", project]]),
    threads: new Map(Array.from({ length: n }, (_, i) => thread(i + 1)).map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
}

// This replaces "a chunk of wheel notches over the sidebar moves one row a
// notch". That behaviour was deliberate and is now reversed: the sidebar
// cursor opens the thread it lands on, so moving it from the wheel opened a
// conversation nobody asked for.
test("a wheel notch over the sidebar does not move the cursor and opens nothing", async () => {
  const picked: string[] = [];
  const { store, stdin, unmount } = await mount({
    machines: new Map([["m", machineWithThreads(10)]]), order: ["m"],
  } as Partial<Store["state"]>);
  // The preview opens whatever the cursor settles on; record it instead.
  (store as any).select = async (sel: { threadId: string }) => { picked.push(sel.threadId); };
  try {
    stdin.write(notch(65, 10).repeat(4)); // four down notches, inside the sidebar
    await tick(300); // past PREVIEW_MS, so a preview would have fired by now
    assert.deepEqual(picked, [], "a scroll must never change which conversation is open");
    assert.equal(store.getState().focus, "composer", "scrolling is not a click, so it takes no focus");
  } finally { unmount(); }
});

test("a wheel notch over the sidebar scrolls the conversation, like any other notch", async () => {
  const over = await mount({ machines: new Map([["m", machineWithThreads(10)]]), order: ["m"] } as Partial<Store["state"]>);
  try {
    over.stdin.write(notch(64, 10).repeat(4));
    await tick(150);
    assert.equal(over.store.getState().scrollFromBottom, 4, "the notch goes to the conversation");
  } finally { over.unmount(); }

  const inside = await mount();
  try {
    inside.stdin.write(notch(64, 80).repeat(4));
    await tick(150);
    assert.equal(inside.store.getState().scrollFromBottom, 4, "and by the same amount as one over the transcript");
  } finally { inside.unmount(); }
});

const entries = (n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => ({ name: `dir${String(i + 1).padStart(2, "0")}`, isRepo: false } as DirEntry));

test("a wheel notch over a folder browser moves that list and leaves the conversation alone", async () => {
  const { store, stdin, unmount } = await mount({
    overlay: { kind: "browse", machine: "m", path: "/w", entries: entries(30), onPick: () => {} },
  } as Partial<Store["state"]>);
  // Which row the cursor is on is React state. What it *means* is the row
  // enter opens, so ask that rather than reading the paint: ink strips the
  // colours when stdout is a pipe, which is what a test runner gives it.
  const opened: string[] = [];
  (store as any).browse = async (_m: string, path: string) => { opened.push(path); };
  try {
    stdin.write(notch(65, 60).repeat(3)); // three down notches over the list
    await tick(150);
    assert.equal(store.getState().scrollFromBottom, 0, "the conversation behind the overlay did not move");
    stdin.write("\r");
    await tick(150);
    // The rows are `..`, then the directories. Three down from `..` is dir03.
    assert.deepEqual(opened, ["/w/dir03"], "the notch moved the list by three rows");
  } finally { unmount(); }
});

// `handleMouse` used to begin with `if (state.overlay) return;`. It now lets
// the wheel through, and a door held open for one kind of event is a door: a
// press that reached the transcript underneath would select text nobody can
// see, and its release would copy it.
test("an overlay lets no click or drag through to the transcript", async () => {
  const { store, stdin, written, unmount } = await mount({
    scrollFromBottom: 5,
    overlay: { kind: "browse", machine: "m", path: "/w", entries: entries(30), onPick: () => {} },
  } as Partial<Store["state"]>);
  try {
    stdin.write(press(50, 6));
    await tick(60);
    assert.equal(store.getState().selection, null, "a press behind an overlay starts no selection");
    stdin.write(drag(70, 9));
    await tick(60);
    assert.equal(store.getState().selection, null, "and a drag extends none");
    stdin.write(release(70, 9));
    await tick(80);
    assert.equal(store.getState().selection, null, "and the release leaves none behind");
    assert.equal(written.join("").includes(`${ESC}]52;c;`), false, "nothing reached the clipboard");
    assert.equal(store.getState().scrollFromBottom, 5, "and the conversation did not move");
    assert.equal(store.getState().overlay?.kind, "browse", "the overlay is still up");
  } finally { unmount(); }
});

// ---------------------------------------------------------------------------
// A drag past the edge scrolls
// ---------------------------------------------------------------------------

test("a drag below the bottom edge keeps scrolling while the pointer is still", async () => {
  // Part-scrolled, so there is somewhere to go in both directions.
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 50 });
  try {
    stdin.write(press(80, 10));
    await tick(60);
    const anchor = store.getState().selection!.anchor.line;
    // Row 30 is the last row of a 30-row terminal, below the transcript box.
    // One event, then nothing: a terminal reports the mouse only while it
    // moves, so everything after this has to come from the timer.
    stdin.write(drag(80, 30));
    await tick(400);
    const state = store.getState();
    assert.ok(state.scrollFromBottom < 50 - 1, `the drag kept scrolling on its own (at ${state.scrollFromBottom})`);
    const { from, to } = selectionBounds(state.selection!);
    assert.ok(to.line - from.line > 1, "and the selection covers the lines it scrolled past");
    assert.equal(from.line, anchor, "the anchor stays on the line it was put down on");
  } finally { unmount(); }
});

test("a drag above the top edge scrolls the other way", async () => {
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 50 });
  try {
    stdin.write(press(80, 10));
    await tick(60);
    stdin.write(drag(80, 1)); // above TRANSCRIPT_TOP
    await tick(400);
    assert.ok(store.getState().scrollFromBottom > 51, "towards the older lines");
  } finally { unmount(); }
});

// The leak. A timer left running after the button comes up scrolls for ever,
// and nothing on screen says why.
test("a drag released outside the pane clears the repeating scroll", async () => {
  const timers = trackIntervals(DRAG_SCROLL_MS);
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 50 });
  // `dragScrollStep` has a second stop in it: it gives up when the selection
  // is no longer dragging, and a release ends the drag. That stop answers a
  // release within one 60 ms tick whether or not the release cleared the
  // timer itself, so it stands in for the teardown this test is about — and
  // it does: measured, `stopDragScroll()` can be deleted from the release
  // branch and every assertion below still passes.
  //
  // So hold the selection dragging across the release. `endSelection` says
  // the drag was a real one, which is what makes the app copy it, but leaves
  // `dragging` alone. Now the only thing that can clear the timer is the
  // teardown on the release, and waiting longer only gives a missing one more
  // chances to show itself.
  (store as any).endSelection = () => store.getState().selection != null;
  try {
    stdin.write(press(80, 10));
    await tick(60);
    stdin.write(drag(80, 30));
    await tick(200);
    assert.equal(timers.count(), 1, "the drag really started a repeating scroll");
    assert.ok(store.getState().scrollFromBottom < 50, "and it really was scrolling");

    stdin.write(release(80, 30)); // released outside the pane
    await tick(200);
    assert.equal(timers.count(), 0, "the release cleared the timer, not just the scrolling");
    const atRelease = store.getState().scrollFromBottom;
    await tick(400);
    assert.equal(store.getState().scrollFromBottom, atRelease, "and nothing scrolled after it");
  } finally { unmount(); timers.restore(); }
});

test("unmounting mid-drag clears the repeating scroll", async () => {
  // The button may never come up at all: the app can be torn down under it.
  const timers = trackIntervals(DRAG_SCROLL_MS);
  const { stdin, unmount } = await mount({ scrollFromBottom: 50 });
  try {
    stdin.write(press(80, 10));
    await tick(60);
    stdin.write(drag(80, 30));
    await tick(150);
    assert.equal(timers.count(), 1);
    unmount();
    await tick(60);
    assert.equal(timers.count(), 0, "no timer outlives the component");
  } finally { timers.restore(); }
});

test("a drag back inside the pane stops scrolling and points again", async () => {
  const { store, stdin, unmount } = await mount({ scrollFromBottom: 50 });
  try {
    stdin.write(press(80, 10));
    await tick(60);
    stdin.write(drag(80, 30));
    await tick(200);
    stdin.write(drag(80, 12)); // back inside
    await tick(60);
    const back = store.getState().scrollFromBottom;
    await tick(400);
    assert.equal(store.getState().scrollFromBottom, back, "re-entering the pane stops the timer too");
  } finally { unmount(); }
});
