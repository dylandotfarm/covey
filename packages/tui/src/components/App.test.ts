/**
 * Regression test for the sidebar cursor (issue #17).
 *
 * The cursor used to be an index into a list that re-sorts under it, so a
 * message in one thread moved the cursor onto another. The visible symptom was
 * the preview: it opened the thread the cursor had slid onto, a conversation
 * nobody asked for.
 *
 * `sidebar.test.ts` covers `cursorIndex` on its own, but the defect lived in
 * App — the component held the cursor. A unit test of the helper passes even
 * with `const [cursor, setCursor] = useState(0)` put back, so it protects
 * nothing. This mounts App on a fake terminal, types into it, and watches what
 * the preview opens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import type { Project, Thread } from "@covey/protocol";
import { App } from "./App.js";
import type { AppState, MachineState, Store } from "../store.js";

// ---- a terminal that is not a terminal --------------------------------------

/** Ink writes frames here instead of to a tty. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  frames: string[] = [];
  write(s: string) { this.frames.push(s); return true; }
  get lastFrame() { return this.frames.at(-1) ?? ""; }
}

/**
 * Ink reads keys from here. It drives stdin the way node streams do — a
 * `readable` event, then `read()` until it returns null — so `type` queues the
 * keystroke and rings the bell.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return this.queue.shift() ?? null; }
  ref() { return this; }
  unref() { return this; }
  type(s: string) { this.queue.push(s); this.emit("readable"); }
}

// ---- the tree the sidebar paints --------------------------------------------

const project = (id: string): Project => ({
  id, title: id, workspaceRoot: `/repos/${id}`, repositoryIdentity: null, defaultModel: null,
  defaultWorkspaceMode: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

const thread = (id: string, lastMessageAt: string): Thread => ({
  id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt, archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

function appState(threads: Thread[]): AppState {
  const m = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info: { name: "pi", os: "linux" }, projects: new Map([["p", project("p")]]),
    threads: new Map(threads.map((t) => [t.id, t])), runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  return {
    machines: new Map([["pi", m]]), order: ["pi"], selected: null, view: null, focus: "sidebar",
    sidebarCollapsed: false, expanded: {}, expandedItems: new Set(), toolsExpanded: false,
    overlay: null, notice: null, scrollFromBottom: 0, drafts: new Map(), pendingAttachments: new Map(),
    tick: 0, diffView: null, attention: new Map(), selection: null, relaunch: null,
    // A client that does not run from a checkout, which is what Store starts
    // with. This test says nothing about builds.
    clientBuild: null, clientStale: false,
  };
}

/**
 * Enough of the store for the sidebar: it holds the state, tells App when it
 * changes, and records what the preview asked to open. `publish` is a daemon
 * push — a new thread list, sorted the way the daemon sorted it.
 */
function fakeStore(initial: AppState) {
  let state = initial;
  const listeners = new Set<() => void>();
  /** Every thread the preview opened, oldest first. */
  const opened: string[] = [];
  const store = {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getState: () => state,
    pendingRequest: () => null,
    attachments: () => [],
    draft: () => "",
    setDraft: () => {},
    setFocus: () => {},
    select: async (sel: { machine: string; threadId: string }) => { opened.push(sel.threadId); },
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
    opened,
    publish(next: AppState) { state = next; for (const l of listeners) l(); },
  };
}

const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the thing an assertion is about, rather than for a fixed spell.
 *
 * What these cases claim is *which* thread the preview opened, never how long
 * covey took to open it — and a fixed wait measures the runner. On this
 * project's Pi, with the rest of the suite painting Ink trees on the other
 * cores, a keystroke and the render it causes can take longer than any number
 * short enough to keep the file quick, and the case then fails a long way from
 * anything it covers. Waiting on the condition is both quicker and honest: it
 * returns as soon as the state is there, and the timeout only bounds a case
 * that is genuinely broken. A case that asserts nothing *happened* still has to
 * wait a spell — there is no condition to watch for that.
 */
async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await settle(20);
}

// ---- the test ----------------------------------------------------------------

/**
 * Sorted the way the daemon sorts: most recently spoken to first. `alphaAt`
 * moves the *last* thread, so when it speaks it jumps over the cursor and
 * pushes the row under the cursor down. A thread that re-sorts above the
 * cursor would not move it, and would not catch this defect.
 */
const tree = (alphaAt: string) => [
  thread("delta", "2026-01-04T00:00:00Z"),
  thread("charlie", "2026-01-03T00:00:00Z"),
  thread("bravo", "2026-01-02T00:00:00Z"),
  thread("alpha", alphaAt),
];

test("a message in another thread does not move the sidebar cursor", async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const { store, opened, publish } = fakeStore(appState(tree("2026-01-01T00:00:00Z")));
  const ink = render(React.createElement(App, { store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    // Rows: machine, project, delta, charlie, bravo, alpha. Four downs puts the
    // cursor on bravo, with one thread below it.
    for (let i = 0; i < 4; i++) { stdin.type("j"); await settle(20); }
    await until(() => opened.at(-1) === "bravo");
    assert.equal(opened.at(-1), "bravo", "the preview opens the thread under the cursor");

    // alpha takes a turn. It goes to the top of the project, so bravo moves
    // from row 4 to row 5 and charlie takes row 4. The user has touched
    // nothing: whatever the cursor points at, it is still bravo.
    const settled = opened.length;
    publish(appState(tree("2026-01-05T00:00:00Z")));
    await settle();

    assert.deepEqual(
      opened.slice(settled), [],
      "the cursor slid off bravo when alpha spoke, and the preview opened " +
      `${opened.slice(settled).join(" → ")} — a conversation nobody asked for`,
    );
  } finally {
    ink.unmount();
  }
});

/**
 * The other half of the fix, and the easier half to throw away. When the row a
 * key names goes, App falls back to the index that row was on *and writes the
 * key of whatever is there back*. Drop the write-back and the fallback still
 * looks right — the cursor lands in the right place once — but the key is dead
 * from then on, so the cursor is an index again and the first defect returns.
 */
test("after the row under the cursor goes, the cursor holds the row it fell onto", async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const { store, opened, publish } = fakeStore(appState(tree("2026-01-01T00:00:00Z")));
  const ink = render(React.createElement(App, { store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    for (let i = 0; i < 4; i++) { stdin.type("j"); await settle(20); }
    await until(() => opened.at(-1) === "bravo");
    assert.equal(opened.at(-1), "bravo", "the preview opens the thread under the cursor");

    // bravo is deleted from under the cursor. alpha moves up into its row.
    publish(appState(tree("2026-01-01T00:00:00Z").filter((t) => t.id !== "bravo")));
    await until(() => opened.at(-1) === "alpha");
    assert.equal(opened.at(-1), "alpha", "the cursor falls onto the row that took bravo's place");

    // Now alpha speaks and goes to the top, which moves its row. The cursor has
    // to have taken alpha's key when it landed there, or it is an index again.
    const settled = opened.length;
    publish(appState([
      thread("delta", "2026-01-04T00:00:00Z"),
      thread("charlie", "2026-01-03T00:00:00Z"),
      thread("alpha", "2026-01-05T00:00:00Z"),
    ]));
    await settle();
    assert.deepEqual(
      opened.slice(settled), [],
      "the cursor did not take the key of the row it fell onto, so the next re-sort " +
      `moved it again and the preview opened ${opened.slice(settled).join(" → ")}`,
    );
  } finally {
    ink.unmount();
  }
});
