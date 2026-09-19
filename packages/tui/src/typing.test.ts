/**
 * Typing while the machines talk.
 *
 * The complaint: with the machine busy, covey crawled and text became
 * impossible to type, while everything else on the desk — a browser, a text
 * editor — still took input at the speed of a hand. The cause was not the load.
 * It was that covey spent its one thread on the screen and left nothing for the
 * keyboard:
 *
 *   - Every event a daemon sent notified React on the spot, and every notify
 *     was a full render and a full paint. Measured on this project's Pi with a
 *     two-hundred-item transcript at 120×45: 30–45 ms a paint. A streamed reply
 *     arrives sixteen times a second per item, and a run has eight agents in
 *     it, so the thread was spoken for before anybody touched a key. Typing
 *     measured 111 ms a character; with the frame budget, 51 ms.
 *   - Laying the transcript out cost ten of those milliseconds and was redone
 *     in full whenever any single item changed — two hundred items rendered to
 *     follow one paragraph growing.
 *   - The spinner ticked every 700 ms whether or not anything was spinning, so
 *     a client with nothing connected still burned 4% of a core painting a
 *     screen identical to the one already up.
 *
 * These are the three, end to end, through the App the user actually runs. They
 * count paints rather than time: a stopwatch here would measure the runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-typing-"));

import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread, TimelineItem } from "@covey/protocol";
import { Store, type MachineState, type ThreadView } from "./store.js";
import { App } from "./components/App.js";
import { inkOptions } from "./index.js";
import { ItemLines } from "./lines.js";
import { layoutTranscript } from "./components/Transcript.js";

const PI = "ws://pi:3790";
const AT = "2026-01-01T00:00:00Z";

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

function thread(id: string, running: boolean): Thread {
  return {
    id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null,
    permissionMode: "default", branch: null, worktreePath: null,
    status: running ? "running" : "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: running ? { turnId: "t1", state: "running", startedAt: AT } : null,
    lastMessageAt: AT, archivedAt: null, pinnedAt: null, movedTo: null, createdAt: AT, updatedAt: AT,
  } as Thread;
}

const PROSE = "The quick brown fox jumps over the lazy dog, again and again, for as long as the turn runs. ";

/** A transcript the size of a real one: prose, tool calls and the odd question. */
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

/**
 * A store with one machine, eight agents at work on it, and one of their
 * threads open — the shape of a run in flight.
 */
function storeWithRun(items = 200) {
  const store = new Store([]);
  const threads = new Map<string, Thread>();
  threads.set("alpha", thread("alpha", true));
  for (let i = 1; i < 8; i++) threads.set(`agent-${i}`, thread(`agent-${i}`, true));
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
    machine: PI, threadId: "alpha", thread: threads.get("alpha")!, items: transcript(items),
    loading: false, error: null, hasMore: false, loadingOlder: false, seq: items, commands: null, dirs: new Map(),
  } as ThreadView;
  return { store, machine: m, items };
}

/**
 * Mount the App the way `runTui` does and count what Ink paints.
 *
 * `inkOptions` is the production options object, not a copy: the two settings
 * this file is about — the hook the frame budget reads paints back through, and
 * incremental rendering — both look like they do nothing, and a copy here would
 * let either be tidied out of the client while these cases went on passing.
 * `store.painted` is wrapped *before* the options are built, because that is
 * the property they carry.
 */
async function mount(store: Store) {
  let paints = 0;
  const real = store.painted;
  store.painted = () => { paints++; real(); };
  // Every notification is a full re-render of App: `useSyncExternalStore` puts
  // the change on React's synchronous lane and the state object is new every
  // time, so the snapshot always differs and the render always happens. This is
  // the number that used to track the daemons' event rate, and it is the one
  // Ink's own 30 fps throttle does *not* bound — the throttle covers the paint
  // that follows, never the render in front of it.
  let renders = 0;
  store.subscribe(() => { renders++; });

  const stdin: any = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  let bytes = 0;
  const stdout: any = new PassThrough();
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 45;
  stdout.on("data", (c: Buffer) => { bytes += c.length; });
  // `interactive`, for the reason `threadGroup.test.ts` gives: Ink writes only
  // a closing frame when it believes it is in CI, and this counts frames.
  const app = render(React.createElement(App, { store }), {
    ...inkOptions(store), stdin, stdout, patchConsole: false, interactive: true,
  });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  await settle(300);
  return {
    settle,
    reset() { paints = 0; renders = 0; bytes = 0; },
    get paints() { return paints; },
    get renders() { return renders; },
    get bytes() { return bytes; },
    /** Type `s`, running `between` before each character — the daemons talking. */
    type: async (s: string, between: () => void = () => {}) => {
      for (const ch of s) { between(); stdin.write(ch); await settle(60); }
    },
    unmount: () => app.unmount(),
  };
}

/**
 * One turn's worth of daemon traffic, at the rate a daemon really sends it.
 *
 * These are the two calls the websocket handler makes one line after it parses
 * a frame (`shellEvent` and `threadEvent` in `addMachine`), so this is the
 * client's own event path with the socket taken out — what it is not is proof
 * about the wire, which `reconnect.test.ts` covers.
 */
function storm(store: Store, machine: MachineState) {
  let seq = 1000;
  let text = PROSE;
  let events = 0;
  return {
    get events() { return events; },
    /** One round: the open thread grows its reply, seven others report progress. */
    round() {
      text += "another few words ";
      (store as any).applyThread(PI, "alpha", {
        kind: "item.upserted", seq: ++seq,
        item: { id: "streaming", threadId: "alpha", turnId: "t1", seq: 999, kind: "assistant", text, streaming: true, model: "claude", createdAt: AT, updatedAt: new Date().toISOString() },
      });
      for (let i = 1; i < 8; i++) {
        (store as any).applyShell(machine, {
          kind: "thread.upserted", seq: ++seq,
          thread: { ...machine.threads.get(`agent-${i}`)!, updatedAt: new Date().toISOString() },
        });
      }
      events += 8;
    },
  };
}

test("a storm from eight agents costs the typist nothing: the characters all land, and the paints are the typist's", async () => {
  const { store, machine } = storeWithRun();
  const ink = await mount(store);
  const s = storm(store, machine);
  const TYPED = "hello covey";
  // Twenty rounds between each keystroke — 160 events, delivered the way a poll
  // that had several frames waiting on it delivers them, all before the key is
  // read. A count rather than a clock: a wall-clock flood measures whichever
  // machine the test runs on, and this case is about a ratio, not a rate.
  try {
    ink.reset();
    await ink.type(TYPED, () => { for (let i = 0; i < 20; i++) s.round(); });
    await ink.settle(400);

    assert.equal(s.events, TYPED.length * 160);
    assert.equal(store.getState().drafts.get("alpha"), TYPED, "every character reached the composer");
    // The number that mattered. One render per event is what spent the thread:
    // laying the transcript out, rebuilding the sidebar tree and reconciling
    // the screen, seventeen hundred times, for eleven characters of typing.
    assert.ok(ink.renders <= TYPED.length * 4,
      `${s.events} daemon events and ${TYPED.length} keystrokes cost ${ink.renders} renders of App. ` +
      "A render is tens of milliseconds of the one thread covey has and the keyboard waits behind " +
      "it, so this is the client rendering per event again rather than per frame (frames.ts)");
    // And the paints those renders would have asked for.
    assert.ok(ink.paints <= TYPED.length * 3,
      `and ${ink.paints} paints for ${TYPED.length} keystrokes`);
  } finally { ink.unmount(); store.shutdown(); }
});

test("a keystroke rewrites the line it changed, not the screen", async () => {
  // covey runs over ssh and inside tmux, and something at the other end has to
  // parse every byte. A full frame of this screen is about 12 KB of escape
  // codes; Ink writes one per paint unless it is told to write only the lines
  // that differ. A keystroke changes one line of the composer.
  const { store } = storeWithRun();
  const ink = await mount(store);
  try {
    ink.reset();
    await ink.type("x");
    await ink.settle(300);
    assert.ok(ink.bytes > 0, "the character reached the terminal");
    assert.ok(ink.bytes < 3_000,
      `one keystroke wrote ${ink.bytes} bytes. That is a whole frame, so incremental ` +
      "rendering is off (see `inkOptions`) and every character typed is repainting " +
      "the screen down the wire");
  } finally { ink.unmount(); store.shutdown(); }
});

test("an idle client paints nothing at all: no machine, nothing running, no spinner to turn", async () => {
  // The whole client, with nothing connected — a covey left open on a second
  // monitor. It used to repaint the screen every 700 ms for ever.
  const store = new Store([]);
  const ink = await mount(store);
  try {
    ink.reset();
    await ink.settle(2_500);
    assert.equal(ink.renders, 0,
      `an idle client re-rendered ${ink.renders} times in 2.5 s. The spinner tick is running ` +
      "with nothing to animate, which costs a full render and a full paint of an unchanged screen");
    assert.equal(ink.paints, 0, "and painted nothing");
    assert.equal(ink.bytes, 0, "and wrote nothing to the terminal");
  } finally { ink.unmount(); store.shutdown(); }
});

test("a thread that is running still turns the spinner", async () => {
  // The other half of the same rule: quiet when nothing moves is only right if
  // the things that do move still move.
  const { store } = storeWithRun(4);
  const ink = await mount(store);
  try {
    ink.reset();
    await ink.settle(2_500);
    assert.ok(ink.paints >= 2,
      `a running turn painted ${ink.paints} times in 2.5 s — the spinner has stopped, ` +
      "so a reader watching an agent work cannot tell it apart from one that has died");
    assert.ok(ink.bytes > 0, "and the frames reached the terminal");
  } finally { ink.unmount(); store.shutdown(); }
});

test("one item changing lays out one item, not the two hundred around it", () => {
  // The cache is keyed on the item object, which is sound only because the
  // daemon re-sends an item whole on every change. If that ever became a delta
  // channel, this is the case that says so.
  const { store } = storeWithRun(200);
  const view = store.getState().view!;
  const cache = new ItemLines();
  const opts = { width: 118, expanded: new Set<string>(), question: { cursor: 0, answered: [] } };

  const first = layoutTranscript(view, 118, opts.expanded, opts.question, false, undefined, cache);
  // Not two hundred: the tool calls of finished turns are folded into one row
  // each, and a folded call is never drawn. What is drawn is what is held.
  const drawn = first.itemStarts.filter((i) => view.items.has(i.id)).length;
  assert.ok(drawn > 100, `only ${drawn} items were drawn — this is not a transcript worth caching`);
  assert.equal(cache.size, drawn, "the first layout holds every item it drew");

  // Count what a second layout actually renders by watching for new arrays:
  // a cached item hands back the very array it handed back before.
  const before = first.lines.length;
  const again = layoutTranscript(view, 118, opts.expanded, opts.question, false, undefined, cache);
  assert.equal(again.lines.length, before, "the same transcript lays out the same");

  // Now one item changes, the way a streamed reply does.
  const grown = { ...(view.items.get("i7") as any), text: PROSE.repeat(4), updatedAt: "2026-01-02T00:00:00Z" };
  view.items.set("i7", grown);
  const third = layoutTranscript(view, 118, opts.expanded, opts.question, false, undefined, cache);
  assert.ok(third.lines.length > before, "the item that changed was laid out again");
  assert.equal(cache.render(view.items.get("i9")!, opts), cache.render(view.items.get("i9")!, opts),
    "and an item that did not change hands back the lines it had");

  // A width change is not something a cache can survive, so it empties.
  layoutTranscript(view, 60, opts.expanded, opts.question, false, undefined, cache);
  const narrow = cache.render(view.items.get("i9")!, { ...opts, width: 60 });
  const wide = cache.render(view.items.get("i9")!, { ...opts, width: 118 });
  assert.notEqual(narrow, wide, "a resize re-lays-out rather than painting the old width");

  // And a thread the reader leaves is not held for ever.
  cache.prune(new Map());
  assert.equal(cache.size, 0);
});
