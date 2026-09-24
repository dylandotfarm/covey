/**
 * Regression test for issue #61: the client grew by about 5 KB for every event
 * it painted, reached 4.2 GB in a working day, and died with SIGABRT.
 *
 * The cause was React, not covey. React chooses its development or its
 * production copy from `NODE_ENV` when its module body runs, and the
 * development copy of the reconciler calls `performance.measure()` once per
 * commit, with a detail object that carries the props it compared. Node keeps
 * every user-timing entry for the life of the process — there is no cap and
 * nothing drops them — so one entry per render is a leak with no ceiling. The
 * timeline re-sends each item whole on every change, so the client commits once
 * per event, which is why the growth tracked the event rate rather than time.
 *
 * `packages/cli/src/index.ts` now sets `NODE_ENV=production` before it loads
 * anything, and `clientEnv.test.ts` is what holds it there. This file is the
 * other half: it says what that setting buys. The imports below are dynamic
 * because a static import is evaluated before any statement in this file, and
 * React would read `NODE_ENV` before the line that sets it.
 *
 * What it does not prove: that the client leaks nothing. It watches one
 * mechanism — the user-timing buffer — over a few hundred renders. A leak that
 * lives in covey's own state, or one that needs an hour to show, passes this
 * test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { Project, Thread, TimelineItem } from "@covey/protocol";
import type { AppState, MachineState, Store, ThreadView } from "./store.js";

process.env.NODE_ENV = "production";
const React = (await import("react")).default;
const { render } = await import("ink");
const { App } = await import("./components/App.js");

// ---- a terminal that is not a terminal --------------------------------------

/** Ink writes frames here instead of to a tty, and forgets them. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write(_s: string) { return true; }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return null; }
  ref() { return this; }
  unref() { return this; }
}

// ---- one thread, mid-turn ----------------------------------------------------

const project: Project = {
  id: "p", title: "p", workspaceRoot: "/repos/p", repositoryIdentity: null, defaultModel: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const thread: Thread = {
  id: "alpha", projectId: "p", title: "alpha", provider: "claude", sessionId: "alpha", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "running", lastError: null,
  pendingApprovals: 0, queuedTurns: 0,
  latestTurn: { turnId: "t1", state: "running", startedAt: "2026-01-01T00:00:00Z" },
  lastMessageAt: "2026-01-01T00:00:00Z", archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
} as Thread;

/** One streamed assistant message, at the length it has reached. */
const streamed = (text: string): TimelineItem => ({
  id: "i0", threadId: "alpha", turnId: "t1", seq: 1, kind: "assistant", text, streaming: true,
  model: "claude", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

function initialState(): AppState {
  const machine = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info: { name: "pi", os: "linux" }, projects: new Map([["p", project]]),
    threads: new Map([["alpha", thread]]), update: null, restarting: false,
  } as unknown as MachineState;
  const view: ThreadView = {
    machine: "pi", threadId: "alpha", thread, items: new Map([["i0", streamed("")]]),
    loading: false, error: null, hasMore: false, loadingOlder: false, seq: 1,
    commands: null, dirs: new Map(),
  };
  return {
    machines: new Map([["pi", machine]]), order: ["pi"], selected: { machine: "pi", threadId: "alpha" },
    view, focus: "composer", sidebarCollapsed: false, expanded: {}, toggledRows: new Set(),
    lod: "steps", overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null, drafts: new Map(),
    pendingAttachments: new Map(), tick: 0, diffView: null, attention: new Map(), selection: null,
    relaunch: null, clientBuild: null, clientStale: false,
  };
}

/** Enough of the store for App to paint, and a way to push an event into it. */
function fakeStore() {
  let state = initialState();
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getState: () => state,
    pendingRequest: () => null,
    attachments: () => [],
    draft: () => "",
    setDraft: () => {},
    setFocus: () => {},
    select: async () => {},
    loadOlder: async () => {},
    clearSelection: () => {},
    notify: () => {},
    setOverlay: () => {},
    isExpanded: () => true,
    toggleExpanded: () => {},
    shutdown: () => {},
  };
  return {
    store: store as unknown as Store,
    /** The daemon re-sends the whole item, with more text on it than last time. */
    stream(text: string) {
      const items = new Map(state.view!.items);
      items.set("i0", streamed(text));
      state = { ...state, view: { ...state.view!, items }, tick: state.tick + 1 };
      for (const l of listeners) l();
    },
  };
}

const measures = () => performance.getEntriesByType("measure").length;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("painting a streaming thread buffers no user timing", async () => {
  // First, that the buffer is real and that nothing empties it. Without this
  // the test below passes on a Node that never buffered anything, and says
  // nothing at all.
  const before = measures();
  for (let i = 0; i < 50; i++) performance.measure(`probe ${i}`, { start: 0, end: 1 });
  assert.equal(measures(), before + 50,
    "node buffers every user-timing entry and drops none, which is the whole reason " +
    "one entry per render is a leak. It did not here, so rewrite this test for what node does now");
  performance.clearMeasures();

  const { store, stream } = fakeStore();
  const ink = render(React.createElement(App, { store }), {
    stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    await settle();
    performance.clearMeasures();
    // 300 events on one item id: the shape the timeline actually has, because
    // a streamed message arrives again and again under the same id.
    let text = "";
    for (let n = 0; n < 300; n++) {
      text += "token ";
      stream(text);
      if (n % 50 === 0) await settle(1);
    }
    await settle();
    assert.equal(
      measures(), 0,
      `painting 300 events left ${measures()} user-timing entries in a buffer that is never emptied. ` +
      "React's development build measures every commit and node keeps every entry, so the client " +
      "grows once per event and never gives it back (issue #61). Is NODE_ENV still production here?",
    );
  } finally {
    ink.unmount();
  }
});
