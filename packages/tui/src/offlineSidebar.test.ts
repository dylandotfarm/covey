/**
 * An offline machine in the sidebar, driven through the real component.
 *
 * The cap (issue #68) added a machine state that nothing else in the tree had
 * seen, and it landed after #74 took the sidebar out of the wheel's path and
 * #73 put nested run rows into the same list. `CLAUDE.md` says the painted line
 * list and the mouse hit test are one array: these cases click the terminal
 * output rather than ask `sidebarCells` where it thinks a row is.
 *
 * The machines sit in their own section below the projects (#89), furled by
 * default; these cases open it. A machine keeps the projects it had when it
 * answered, so they still show under their repository above.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-offline-"));

import React from "react";
import { render } from "ink";
import type { Project, Thread, TimelineItem } from "@covey/protocol";
import { Store, MACHINES_KEY, type MachineState } from "./store.js";
import { App } from "./components/App.js";

const OFF = "ws://steamdeck:3790";
const UP = "ws://pi:3790";

const project = (id: string, title: string): Project => ({
  id, title, workspaceRoot: "/w", repositoryIdentity: null, defaultModel: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Project);

const thread = (id: string, projectId: string, title: string): Thread => ({
  id, projectId, title, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  modeChosen: false, status: "idle", pendingApprovals: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:10Z",
  archivedAt: null, movedTo: null,
} as unknown as Thread);

const item = (n: number): TimelineItem => ({
  id: `i${n}`, threadId: "open", turnId: null, seq: n, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "assistant", text: `line ${n}`, streaming: false, model: null,
} as unknown as TimelineItem);

function machine(key: string, name: string, conn: MachineState["conn"], threads: Thread[]): MachineState {
  return {
    key, saved: { name, url: key }, conn, error: conn === "offline" ? "no answer after 3 tries" : null,
    info: conn === "connected" ? ({ name } as any) : null,
    projects: new Map([["p", project("p", `${name} project`)]]),
    threads: new Map(threads.map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
}

/** Mount App and hand back the frame it painted, plus a way to click and scroll it. */
async function paint(store: Store) {
  const stdin: any = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  const chunks: string[] = [];
  const stdout: any = new PassThrough();
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 30;
  stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
  // `interactive` on purpose: Ink writes only the last frame when it decides it
  // is in CI, and these cases read the frames.
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  await new Promise((r) => setTimeout(r, 200));
  const frame = chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  /** The sidebar line a piece of text was painted on, 1-based, as a terminal row. */
  const rowOf = (text: string) => {
    const at = frame.findIndex((l) => l.slice(0, 33).includes(text));
    assert.ok(at >= 0, `"${text}" was never painted — the frame was:\n${frame.join("\n")}`);
    return at + 1;
  };
  const lineAt = (row: number) => frame[row - 1]!.slice(0, 33);
  const click = async (row: number) => {
    stdin.write(`\x1b[<0;12;${row}M`);
    await new Promise((r) => setTimeout(r, 40));
    stdin.write(`\x1b[<0;12;${row}m`);
    await new Promise((r) => setTimeout(r, 120));
  };
  /** `n` wheel-up notches in one chunk, the way a terminal delivers a fast scroll. */
  const notches = async (n: number, row: number) => {
    stdin.write(`\x1b[<64;12;${row}M`.repeat(n));
    await new Promise((r) => setTimeout(r, 300)); // past PREVIEW_MS
  };
  return { rowOf, lineAt, click, notches, unmount: () => app.unmount() };
}

function twoMachines() {
  const store = new Store([]);
  store.state = {
    ...store.state,
    focus: "sidebar",
    machines: new Map([
      [OFF, machine(OFF, "steamdeck", "offline", [thread("gone", "p", "ZZ left behind")])],
      [UP, machine(UP, "pi", "connected", [thread("open", "p", "ZZ still here")])],
    ]),
    order: [OFF, UP],
    expanded: { [MACHINES_KEY]: true },
    view: {
      machine: UP, threadId: "open", thread: null,
      items: new Map(Array.from({ length: 200 }, (_, i) => item(i + 1)).map((i) => [i.id, i])),
      loading: false, error: null, hasMore: false, loadingOlder: false, seq: 200,
    },
  } as unknown as Store["state"];
  return store;
}

test("an offline machine says so on its row, and says what to press", async () => {
  const store = twoMachines();
  const { rowOf, lineAt, unmount } = await paint(store);
  try {
    const line = lineAt(rowOf("STEAMDECK"));
    assert.match(line, /✗/, "an offline machine shares no mark with one that is about to answer");
    assert.match(line, /offline · enter/, "and the row says the dialling has stopped and what starts it again");
  } finally { unmount(); }
});

test("a click below an offline machine opens what was painted there, not the machine", async () => {
  const store = twoMachines();
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };
  const retried: string[] = [];
  (store as any).retryMachine = (key: string) => { retried.push(key); };
  const panels: string[] = [];
  (store as any).setOverlay = (ov: any) => { if (ov) panels.push(ov.kind); };

  const { rowOf, lineAt, click, unmount } = await paint(store);
  try {
    const machineRow = rowOf("STEAMDECK");
    // Whatever the tree below it is, the click has to reach the row the
    // terminal drew on that line — a blank spacer line reaches nothing.
    const below = machineRow + 1;
    assert.match(lineAt(below), /PI/, "the line below an offline machine is the next machine");
    // The offline machine's project is still painted, above, under its repository.
    assert.ok(rowOf("steamdeck project") < rowOf("MACHINES"), "an offline machine's project stays in the tree above");

    // The thread first: the frame this reads was painted once, before any of
    // these clicks.
    await click(rowOf("ZZ still here"));
    assert.deepEqual(opened, ["open"], "the thread painted on that line is the one that opened");

    await click(below);
    assert.deepEqual(retried, [], "a click below the offline machine row is not a click on it");
    assert.deepEqual(opened, ["open"], "and a machine row opens its panel rather than a conversation");
    // The control panel is a pick over the machine's settings and actions.
    assert.deepEqual(panels, ["pick"], "the connected machine painted there is the one whose panel opened");
  } finally { unmount(); }
});

test("enter on an offline machine row asks for a retry", async () => {
  const store = twoMachines();
  const retried: string[] = [];
  (store as any).retryMachine = (key: string) => { retried.push(key); };
  const { rowOf, click, unmount } = await paint(store);
  try {
    await click(rowOf("STEAMDECK"));
    assert.deepEqual(retried, [OFF],
      "the one thing worth doing on a machine nobody is dialling is dialling it");
    assert.equal(store.getState().overlay, null, "and the control panel needs a daemon that answers");
  } finally { unmount(); }
});

test("wheel notches over an offline machine row do not change what is open", async () => {
  const store = twoMachines();
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };
  const retried: string[] = [];
  (store as any).retryMachine = (key: string) => { retried.push(key); };

  const { rowOf, notches, unmount } = await paint(store);
  try {
    await notches(5, rowOf("STEAMDECK"));
    assert.deepEqual(opened, [], "a scroll must never move the reader between things to read");
    assert.deepEqual(retried, [], "and a notch is not a press");
    assert.equal(store.getState().view?.threadId, "open", "the conversation that was open stayed open");
    assert.equal(store.getState().scrollFromBottom, 5, "the notches went to the transcript, one row each");
  } finally { unmount(); }
});
