/**
 * What the terminal shows about a thread's timer.
 *
 * A timer is the one state covey can be in where nothing happens and nothing
 * is wrong. So the screen has to say two things: in the list, that this thread
 * is asleep and need not be read; in the conversation, how much longer. Without
 * the first a reader cannot tell a thread waiting on a clock from a thread that
 * stalled. Without the second they cannot tell whether to wait.
 *
 * The glyph is proven against a real paint, because colour alone fails the
 * reader this rule is for — covey runs over ssh, in tmux, and on terminals with
 * a narrow palette.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-timer-"));

import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread, ThreadTimer } from "@covey/protocol";
import { Store, type MachineState } from "./store.js";
import { App } from "./components/App.js";
import { TIMER_MARK, threadMark, threadTitleColor } from "./components/Sidebar.js";
import { T } from "./theme.js";

const PI = "ws://pi:3790";

const project: Project = {
  id: "p", title: "covey", workspaceRoot: "/src/covey", repositoryIdentity: null,
  defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const info: MachineInfo = {
  machineId: "m-pi", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/pi",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/** A timer due `minutes` from now, so the row paints a real countdown. */
const timer = (minutes: number, over: Partial<ThreadTimer> = {}): ThreadTimer => ({
  note: "the CI run on main",
  everyMs: 10 * 60_000,
  setAt: new Date(Date.now() - 60_000).toISOString(),
  dueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  firedAt: null,
  round: 1,
  ...over,
});

function thread(id: string, at: string, over: Partial<Thread> = {}): Thread {
  return {
    id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
    branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" },
    lastMessageAt: at, archivedAt: null, pinnedAt: null, movedTo: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

function storeWith(threads: Thread[]) {
  const store = new Store([]);
  const m: MachineState = {
    key: PI, saved: { name: "pi", url: PI }, conn: "connected", error: null, info,
    projects: new Map([[project.id, project]]), threads: new Map(threads.map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  store.state.machines.set(PI, m);
  store.state.order.push(PI);
  store.state.expanded[`${PI}:${project.id}`] = true;
  return store;
}

async function paint(store: Store) {
  const stdin: any = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  const chunks: string[] = [];
  const stdout: any = new PassThrough();
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 30;
  stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
  // `interactive` on purpose: Ink writes only the final frame when it thinks it
  // is in CI, and this reads the frames.
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  await new Promise((r) => setTimeout(r, 250));
  const frame = () => (chunks.filter((c) => c.includes("covey")).at(-1) ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  return { frame, unmount: () => app.unmount() };
}

// ---- the list ---------------------------------------------------------------

test("the row of a thread on a timer carries the mark, and no other row does", async () => {
  const store = storeWith([
    thread("waiting", "2026-01-09T00:00:00Z", { timer: timer(7) }),
    thread("plain", "2026-01-08T00:00:00Z"),
  ]);
  const { frame, unmount } = await paint(store);
  try {
    const lineOf = (text: string) => frame().find((l) => l.slice(0, 33).includes(text)) ?? "";
    assert.ok(lineOf("waiting").includes(TIMER_MARK), `no mark on the sleeping row: "${lineOf("waiting")}"`);
    assert.ok(!lineOf("plain").includes(TIMER_MARK), `a thread with no timer was marked: "${lineOf("plain")}"`);
  } finally { unmount(); }
});

/**
 * The `✓` says the thread is the reader's again — settle it, ask more of it, or
 * leave it — and a thread waiting on a clock is none of those. It is the
 * review's rule (`REVIEW_MARK`) under another name, and `threadIsFinished` is
 * where both live.
 */
test("a thread on a timer carries the timer and never the check", () => {
  const sleeping = thread("t", "2026-01-09T00:00:00Z", { timer: timer(7) });
  assert.equal(threadMark(sleeping, "done", false).glyph, TIMER_MARK);
  assert.equal(threadMark(sleeping, undefined, false).glyph, TIMER_MARK);
  assert.equal(threadMark(thread("t", "2026-01-09T00:00:00Z"), "done", false).glyph, "✓");
  // What the reader has to act on is still painted first.
  assert.equal(threadMark({ ...sleeping, pendingApprovals: 1 }, undefined, false).glyph, "●");
  assert.equal(threadMark(sleeping, "error", false).glyph, "✗");
  // A timer that has fired is not one that runs: the row is the reader's again.
  const fired = thread("t", "2026-01-09T00:00:00Z", { timer: timer(-5, { firedAt: new Date().toISOString() }) });
  assert.equal(threadMark(fired, "done", false).glyph, "✓");
});

test("a thread asleep on a timer is dimmed, and the open one never is", () => {
  const sleeping = thread("t", "2026-01-09T00:00:00Z", { timer: timer(7) });
  const plain = thread("t", "2026-01-09T00:00:00Z");
  assert.equal(threadTitleColor(plain, { active: false, archived: false }), T.muted);
  assert.equal(threadTitleColor(sleeping, { active: false, archived: false }), T.faint);
  assert.equal(threadTitleColor(sleeping, { active: true, archived: false }), T.text,
    "the pane beside the sidebar is this conversation; a dim title over it reads as the wrong row being open");
  assert.equal(threadTitleColor(plain, { active: false, archived: true }), T.faint, "the archived row keeps the dim it had");
});

// ---- the conversation -------------------------------------------------------

/**
 * The composer's status row, where the reader is already looking while they
 * read the conversation. The sidebar's dim says a thread is asleep; this says
 * for how much longer, which is the one thing the reader cannot work out for
 * themselves.
 */
test("the open thread's timer is in the status row, with how long is left", async () => {
  const store = storeWith([thread("waiting", "2026-01-09T00:00:00Z", { timer: timer(7) })]);
  store.state.view = { machine: PI, threadId: "waiting", thread: store.state.machines.get(PI)!.threads.get("waiting")!, items: [], loading: false, error: null } as never;
  const { frame, unmount } = await paint(store);
  try {
    const status = frame().filter((l) => l.includes("@pi")).at(-1) ?? "";
    assert.ok(status.includes(`${TIMER_MARK} 7m`), `the status row says nothing about the timer: "${status}"`);
  } finally { unmount(); }
});

test("a thread with no timer says nothing about one", async () => {
  const store = storeWith([thread("plain", "2026-01-09T00:00:00Z")]);
  store.state.view = { machine: PI, threadId: "plain", thread: store.state.machines.get(PI)!.threads.get("plain")!, items: [], loading: false, error: null } as never;
  const { frame, unmount } = await paint(store);
  try {
    const status = frame().filter((l) => l.includes("@pi")).at(-1) ?? "";
    assert.ok(!status.includes(TIMER_MARK), `a thread with no timer showed one: "${status}"`);
  } finally { unmount(); }
});
