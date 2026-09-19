/**
 * What a resize is allowed to paint.
 *
 * Drag a terminal narrower and covey used to come apart: rows doubled, the
 * sidebar slid out from under its own tree, and it stayed that way — nothing
 * short of quitting put it back.
 *
 * The cause is one invariant, and it is not about wrapping text. Ink's
 * incremental renderer writes one screen row per line of its frame and finds
 * the next frame with `cursorUp(lines - 1)`. A line the *terminal* has to wrap
 * costs a second row that Ink never counted, so every frame after it is written
 * one row too high, and because the diff skips the lines it calls unchanged,
 * nothing ever paints over the wreckage.
 *
 * A resize is where covey handed Ink such a line. Ink registers its own SIGWINCH
 * handler inside `render()` — before App's, and React has not re-rendered yet —
 * so it repaints from the tree committed for the terminal that has just gone
 * away. At 120 columns that tree is 120 columns wide, and the terminal is now
 * 80.
 *
 * So: no line covey writes may be wider than the terminal it is written to,
 * including the one frame painted from stale state. That is the whole claim,
 * and it is what these cases measure — the bytes, not the layout.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-resize-"));

import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread, TimelineItem } from "@covey/protocol";
import { Store, type MachineState, type ThreadView } from "./store.js";
import { App } from "./components/App.js";
import { inkOptions } from "./index.js";
import { width } from "./lines.js";

const PI = "ws://pi:3790";
const AT = "2026-01-01T00:00:00Z";
const PROSE = "The quick brown fox jumps over the lazy dog, again and again, for as long as the turn runs. ";

const project: Project = {
  id: "p", title: "covey", workspaceRoot: "/src/covey", repositoryIdentity: null,
  defaultModel: null, defaultWorkspaceMode: null, createdAt: AT, updatedAt: AT,
};

const info: MachineInfo = {
  machineId: "m-pi", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/pi",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

function thread(id: string): Thread {
  return {
    id, projectId: "p", title: `${id} — a title long enough to need the room it is given`,
    provider: "claude", sessionId: id, model: null,
    permissionMode: "default", branch: null, worktreePath: null,
    status: "running", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: { turnId: "t1", state: "running", startedAt: AT },
    lastMessageAt: AT, archivedAt: null, pinnedAt: null, movedTo: null, createdAt: AT, updatedAt: AT,
  } as Thread;
}

/** A transcript wide enough that its lines are wrapped, not merely short. */
function transcript(n: number): Map<string, TimelineItem> {
  const items = new Map<string, TimelineItem>();
  for (let i = 0; i < n; i++) {
    const base = { id: `i${i}`, threadId: "alpha", turnId: `t${Math.floor(i / 6)}`, seq: i, createdAt: AT, updatedAt: AT };
    items.set(base.id, i % 3 === 0
      ? { ...base, kind: "tool", toolUseId: `u${i}`, toolName: "Read", input: { file: "/src/covey/x.ts" }, summary: "Read x.ts", status: "completed", output: PROSE, isError: false, parentToolUseId: null, durationMs: 120 }
      : { ...base, kind: "assistant", text: PROSE.repeat(3), streaming: false, model: "claude" } as TimelineItem);
  }
  return items;
}

/** One machine, several threads, one of them open — the client with work on it. */
function storeWithWork() {
  const store = new Store([], {});
  const threads = new Map<string, Thread>();
  threads.set("alpha", thread("alpha"));
  for (let i = 1; i < 6; i++) threads.set(`agent-${i}`, thread(`agent-${i}`));
  const m: MachineState = {
    key: PI, saved: { name: "pi", url: PI }, conn: "connected", error: null, info,
    projects: new Map([[project.id, project]]), threads, runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  store.state.machines.set(PI, m);
  store.state.order.push(PI);
  store.state.expanded[`${PI}:${project.id}`] = true;
  store.state.selected = { machine: PI, threadId: "alpha" };
  store.state.focus = "composer";
  store.state.view = {
    machine: PI, threadId: "alpha", thread: threads.get("alpha")!, items: transcript(8),
    loading: false, error: null, hasMore: false, loadingOlder: false, seq: 8, commands: null, dirs: new Map(),
  } as ThreadView;
  return store;
}

const ESC = "\u001b";
/** A hyperlink costs no columns, so it comes out before anything is measured. */
const OSC8 = new RegExp(ESC + "\\]8;;[^" + ESC + "\\u0007]*(?:" + ESC + "\\\\|\\u0007)", "g");
const CSI = new RegExp(ESC + "\\[[0-9;:?>=!]*[A-Za-z]", "g");

/**
 * The rows a terminal would be asked to hold for one write.
 *
 * Per write, not over the lot joined together: a frame that fills the screen
 * ends without a newline, so the last row of one and the first row of the next
 * would read as a single over-wide row once the cursor moves between them are
 * taken out. Ink writes a frame in one call, which is what makes this the right
 * unit.
 */
function rows(bytes: string): string[] {
  return bytes.replace(OSC8, "").replace(CSI, "").split("\n");
}

/**
 * Mount the App the way `runTui` does, over a stdout whose size we can change.
 *
 * `inkOptions` is the production object rather than a copy, because the setting
 * this file is about — incremental rendering — is exactly the one that makes an
 * over-wide line permanent instead of merely ugly.
 *
 * One mount for the file, on a small screen and a short transcript. Every case
 * here lays out a real Ink tree, which on this project's Pi is dear enough that
 * a file of them crowds the timing-sensitive tests the runner has in flight
 * beside it — and those fail as flakes, a long way from anything this changed.
 */
async function mount(cols: number, rowCount: number) {
  const store = storeWithWork();
  const stdin: any = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  const stdout: any = new PassThrough();
  stdout.isTTY = true; stdout.columns = cols; stdout.rows = rowCount;
  let writes: string[] = [];
  stdout.on("data", (c: Buffer) => { writes.push(c.toString()); });
  const app = render(React.createElement(App, { store }), {
    ...inkOptions(store), stdin, stdout, patchConsole: false, interactive: true,
  });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  await settle(300);
  return {
    /** Change the terminal under the client, and hand back only what it then wrote. */
    async resize(nextCols: number, nextRows = rowCount) {
      writes = [];
      stdout.columns = nextCols; stdout.rows = nextRows;
      stdout.emit("resize");
      await settle();
      return writes;
    },
    unmount: () => app.unmount(),
  };
}

/** Every row Ink wrote that the terminal would have had to wrap. */
function tooWide(writes: string[], cols: number): string[] {
  return writes.flatMap(rows).filter((r) => width(r) > cols);
}

/** The widths of the rows that overflowed, for an assertion that names them. */
const overflow = (writes: string[], cols: number) => tooWide(writes, cols).map(width);

let app: Awaited<ReturnType<typeof mount>>;
before(async () => { app = await mount(120, 30); });
after(() => { app.unmount(); });

test("a narrowed terminal is never sent a line wider than itself", async () => {
  assert.deepEqual(overflow(await app.resize(80), 80), [],
    "rows too wide for the 80 columns the terminal now has");
});

test("the same holds for a shrink small enough to drop the sidebar", async () => {
  await app.resize(120);
  assert.deepEqual(overflow(await app.resize(60, 20), 60), [],
    "rows too wide for the 60 columns the terminal now has");
});

test("and for a drag that narrows a few columns at a time", async () => {
  await app.resize(140, 30);
  for (const cols of [130, 110, 90, 70, 66]) {
    assert.deepEqual(overflow(await app.resize(cols), cols), [], `rows too wide at ${cols} columns`);
  }
});
