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
import { App, SIDEBAR_W } from "./components/App.js";
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

/**
 * A thread with everything that makes a row long on it.
 *
 * The `branch` and the `model` are not decoration: they are what the composer's
 * status row is made of, and with them null that row fits any terminal and the
 * case below cannot see it overflow. A review of the first version of this file
 * found exactly that hole, and a 99-column row going into an 80-column terminal
 * through it.
 */
function thread(id: string): Thread {
  return {
    id, projectId: "p", title: `${id} — a title long enough to need the room it is given`,
    provider: "claude", sessionId: id, model: "claude-sonnet-4-5",
    permissionMode: "default", branch: "feature/JIRA-1234-rework-the-parser-completely", worktreePath: "/src/covey/.covey/worktrees/abcd1234",
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
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A write tall enough to be a frame rather than a cursor move. */
  const painted = () => writes.some((w) => rows(w).length > 10);
  /**
   * Wait for the client to paint, rather than for a fixed spell.
   *
   * A fixed wait measures the runner. On this project's Pi, with the rest of
   * the suite laying out Ink trees on the other cores, a frame can take longer
   * than any number short enough to keep this file quick — and a case that
   * measures nothing passes, because no row it did not see was too wide. That
   * is the worse direction to fail in, so the wait is on the frame.
   */
  const untilPainted = async (ms = 4000) => {
    const deadline = Date.now() + ms;
    while (!painted() && Date.now() < deadline) await settle(25);
    await settle(50); // let a second frame, if the resize causes one, land too
  };
  await untilPainted();
  return {
    /** Change the terminal under the client, and hand back only what it then wrote. */
    async resize(nextCols: number, nextRows = rowCount) {
      writes = [];
      stdout.columns = nextCols; stdout.rows = nextRows;
      stdout.emit("resize");
      await untilPainted();
      return writes;
    },
    /** Everything written since the last resize, for a wait on a condition. */
    written: () => writes,
    settle,
    store,
    unmount: () => app.unmount(),
  };
}

/** Every row Ink wrote that the terminal would have had to wrap. */
function tooWide(writes: string[], cols: number): string[] {
  return writes.flatMap(rows).filter((r) => width(r) > cols);
}

/** The widths of the rows that overflowed, for an assertion that names them. */
const overflow = (writes: string[], cols: number) => tooWide(writes, cols).map(width);

/**
 * Paint the pane a case is about, and prove it is on screen.
 *
 * Both halves matter. Setting state on the store does not render anything by
 * itself, so without the paint a case asserts on the tree the *previous* case
 * left committed — which is how the first version of this file managed to check
 * the transcript three times over and call one of them an overlay. And without
 * the marker a case goes on passing when the state stops reaching the screen for
 * some reason that has nothing to do with a resize.
 */
async function show(cols: number, marker: string) {
  await app.resize(cols);
  // On the condition, not on a spell — see `untilPainted`. The pane may take
  // more than one frame to arrive when the runner is busy.
  const deadline = Date.now() + 4000;
  let painted = "";
  while (Date.now() < deadline) {
    painted = app.written().flatMap(rows).join("\n");
    if (painted.includes(marker)) return;
    await app.settle(50);
  }
  assert.fail(`expected ${JSON.stringify(marker)} on screen before the resize under test, got:\n${painted.slice(0, 400)}`);
}

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
  for (const cols of [130, 110, 90, 70, 66, 40, 20]) {
    assert.deepEqual(overflow(await app.resize(cols), cols), [], `rows too wide at ${cols} columns`);
  }
});

/**
 * The three cases above paint the transcript, because that is what a client with
 * a conversation open shows. Every other pane is a different tree with its own
 * boxes in it, and the same mistake in any of them costs the same screen — so
 * each one is put on screen and the terminal taken out from under it.
 *
 * The state is set on the store and the resize does the rendering: it is the
 * frame *after* the size changes that these are about, and it reads the state
 * as it stands when Ink asks for it.
 */
/**
 * The other way a resize can go wrong, and the one no width check can see.
 *
 * Every row here fits the terminal; they are simply in the wrong columns. The
 * pane beside the sidebar is sized by what is left over, which makes its natural
 * width the width of its *content* — and two flexible children whose natural
 * widths overrun the terminal shrink together, rail included. The sidebar is a
 * rail: it is the one part of this screen that is the same width at every
 * terminal size, and the mouse hit test in `App.tsx` reads that width as a
 * constant.
 */
test("the sidebar keeps its rail when the pane beside it cannot", async () => {
  await app.resize(120);
  // The settled frame, not everything the resize wrote: the frame in front of
  // it is the one measured for the terminal that has gone, and at a width with
  // no sidebar in it at all the composer's own border is the only `|` there is.
  const frames = (await app.resize(80)).map(rows).filter((r) => r.length > 10);
  const settled = frames.at(-1) ?? [];
  const painted = settled.filter((r) => r.includes("\u2502"));
  assert.ok(painted.length > 5, `expected the sidebar's border on most rows, saw ${painted.length} of ${settled.length}`);
  const columns = [...new Set(painted.map((r) => r.indexOf("\u2502")))];
  assert.deepEqual(columns, [SIDEBAR_W - 1],
    `the rail should stand in one column, ${SIDEBAR_W - 1}, on every row that has it`);
});

test("the machine summary is bounded too", async () => {
  // `summaryRow` needs the focus in the sidebar with the cursor on a machine
  // row, which is where it starts. Through the store's own setter, not by
  // writing to `state`: a bare write notifies nobody, and the client goes on
  // painting whatever it last committed.
  app.store.setFocus("sidebar");
  await show(120, "threads in");
  assert.deepEqual(overflow(await app.resize(80), 80), [],
    "rows too wide for 80 columns with the machine summary on screen");
});

test("so is an overlay", async () => {
  app.store.setOverlay({ kind: "help" });
  await show(120, "shift+tab");
  assert.deepEqual(overflow(await app.resize(80), 80), [],
    "rows too wide for 80 columns with the help overlay open");
});

test("so is the diff panel", async () => {
  app.store.setOverlay(null);
  // No setter for this one — the real path fetches the diff from a machine, and
  // there is no machine here. Written, then a setter called to notify, which
  // also takes the focus out of the sidebar: the preview effect that follows a
  // sidebar cursor closes the diff panel on its way past.
  app.store.state.diffView = {
    threadId: "alpha",
    loading: false,
    scroll: 0,
    diff: {
      turnId: "t1", additions: 12, deletions: 3,
      files: [
        { path: "packages/tui/src/components/App.tsx", additions: 9, deletions: 2, status: "M" },
        { path: "packages/tui/src/components/Transcript.tsx", additions: 3, deletions: 1, status: "M" },
      ],
      patch: [
        "diff --git a/packages/tui/src/components/App.tsx b/packages/tui/src/components/App.tsx",
        "@@ -1571,7 +1571,30 @@ export function App({ store }: { store: Store }) {",
        "-    <Box width={size.cols} height={size.rows} flexDirection=\"row\">",
        "+    <Box width=\"100%\" height={size.rows} flexDirection=\"row\">",
        "       {sidebarVisible && <Sidebar state={state} rows={rows} cells={cells} cursor={cursor} width={SIDEBAR_W} />}",
      ].join("\n"),
    },
  };
  app.store.setFocus("composer");
  await show(120, "Changes");
  assert.deepEqual(overflow(await app.resize(80), 80), [],
    "rows too wide for 80 columns with the diff panel open");
});
