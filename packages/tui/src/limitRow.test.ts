/**
 * What the terminal shows about a thread held on the plan's usage limit.
 *
 * It is the timer's case under another name — nothing happens and nothing is
 * wrong — with one difference the screen has to carry: a timer is the thread's
 * own doing and will be over in minutes, and this one is the account's and may
 * run until Friday. So the list says the row need not be read, and the
 * conversation says which limit and how much longer.
 *
 * The thing this must never paint is the `✗` of a turn that failed. The turn
 * *did* fail, and covey is coming back to it, and a red row every five hours
 * for a thread nobody has to touch is what the whole feature exists to stop.
 *
 * The glyph is proven against a real paint, because colour alone fails the
 * reader this rule is for — covey runs over ssh, in tmux, and on terminals
 * with a narrow palette.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-limit-"));

import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread, ThreadUsageLimit } from "@covey/protocol";
import { Store, type MachineState } from "./store.js";
import { App } from "./components/App.js";
import { LIMIT_MARK, TIMER_MARK, threadMark, threadTitleColor } from "./components/Sidebar.js";
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

/** A wait due `hours` from now, so the row paints a real countdown. */
const limit = (hours: number, over: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit => ({
  message: "You've hit your session limit · resets 12:10am (UTC)",
  turnId: "x",
  setAt: new Date(Date.now() - 60_000).toISOString(),
  dueAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
  resetsAt: new Date(Date.now() + hours * 3_600_000 - 60_000).toISOString(),
  firedAt: null,
  round: 1,
  ...over,
});

/** The row of a thread whose last turn died on the limit. */
function thread(id: string, at: string, over: Partial<Thread> = {}): Thread {
  return {
    id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
    branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" },
    lastMessageAt: at, archivedAt: null, pinnedAt: null, movedTo: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

const held = (id: string, at: string, hours = 8): Thread => thread(id, at, {
  usageLimit: limit(hours),
  lastError: "You've hit your session limit · resets 12:10am (UTC)",
  latestTurn: { turnId: "x", state: "error", startedAt: "", completedAt: "" },
});

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
  // `interactive` on purpose: Ink writes only the final frame when it thinks
  // it is in CI, and this reads the frames.
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  await new Promise((r) => setTimeout(r, 250));
  const frame = () => (chunks.filter((c) => c.includes("covey")).at(-1) ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  return { frame, unmount: () => app.unmount() };
}

// ---- the list ---------------------------------------------------------------

test("the row of a thread held on the limit carries the mark, and no other row does", async () => {
  const store = storeWith([held("limited", "2026-01-09T00:00:00Z"), thread("plain", "2026-01-08T00:00:00Z")]);
  const { frame, unmount } = await paint(store);
  try {
    const lineOf = (text: string) => frame().find((l) => l.slice(0, 33).includes(text)) ?? "";
    assert.ok(lineOf("limited").includes(LIMIT_MARK), `no mark on the held row: "${lineOf("limited")}"`);
    assert.ok(!lineOf("limited").includes("✗"), `the held row read as a failure: "${lineOf("limited")}"`);
    assert.ok(!lineOf("plain").includes(LIMIT_MARK), `a thread with no wait was marked: "${lineOf("plain")}"`);
  } finally { unmount(); }
});

/**
 * The two waits are different glyphs because they ask different things of a
 * reader: one is minutes of a build, the other is the account's and may run
 * until Friday.
 */
test("the limit and the timer are told apart", () => {
  const at = "2026-01-09T00:00:00Z";
  assert.equal(threadMark(held("t", at), undefined, false).glyph, LIMIT_MARK);
  assert.notEqual(LIMIT_MARK, TIMER_MARK);
  assert.equal(threadMark(thread("t", at), "done", false).glyph, "✓");
  // The `✓` says the thread is the reader's again, and a thread covey will
  // send work to tonight is not.
  assert.equal(threadMark(held("t", at), "done", false).glyph, LIMIT_MARK);
  // What the reader has to act on is still painted first.
  assert.equal(threadMark({ ...held("t", at), pendingApprovals: 1 }, undefined, false).glyph, "●");
  // A wait covey has already sent the work for is not one that runs: covey
  // gave the row back, so it reads like any other.
  const fired = thread("t", at, { usageLimit: limit(-1, { firedAt: new Date().toISOString() }) });
  assert.equal(threadMark(fired, "done", false).glyph, "✓");
});

test("a thread held on the limit is dimmed, and the open one never is", () => {
  const at = "2026-01-09T00:00:00Z";
  assert.equal(threadTitleColor(held("t", at), { active: false, archived: false }), T.faint);
  assert.equal(threadTitleColor(thread("t", at), { active: false, archived: false }), T.muted);
  assert.equal(threadTitleColor(held("t", at), { active: true, archived: false }), T.text,
    "the pane beside the sidebar is this conversation; a dim title over it reads as the wrong row being open");
});

// ---- the conversation -------------------------------------------------------

/**
 * The composer's status row, where the reader is already looking. The
 * sidebar's dim says the thread is held; this says for how much longer, which
 * is the one thing the reader cannot work out for themselves.
 *
 * The reset comes with it, on this terminal's own clock. Claude Code wrote the
 * hour in the daemon's zone and named it — `resets 12:10am (UTC)` — and a
 * reader whose daemon is a server would have to do the sum.
 */
test("the open thread's wait is in the status row, with how long is left", async () => {
  const store = storeWith([held("limited", "2026-01-09T00:00:00Z")]);
  store.state.view = { machine: PI, threadId: "limited", thread: store.state.machines.get(PI)!.threads.get("limited")!, items: [], loading: false, error: null } as never;
  const { frame, unmount } = await paint(store);
  try {
    const status = frame().filter((l) => l.includes("@pi")).at(-1) ?? "";
    assert.ok(status.includes(`${LIMIT_MARK} limit 8h`), `the status row says nothing about the wait: "${status}"`);
    assert.match(status, /· resets (tomorrow )?\d{1,2}(:\d{2})?[ap]m/, `no reset on this terminal's clock: "${status}"`);
    assert.ok(!status.includes("UTC"), `a zone the reader has to translate: "${status}"`);
  } finally { unmount(); }
});

test("a thread with no wait says nothing about one", async () => {
  const store = storeWith([thread("plain", "2026-01-09T00:00:00Z")]);
  store.state.view = { machine: PI, threadId: "plain", thread: store.state.machines.get(PI)!.threads.get("plain")!, items: [], loading: false, error: null } as never;
  const { frame, unmount } = await paint(store);
  try {
    const status = frame().filter((l) => l.includes("@pi")).at(-1) ?? "";
    assert.ok(!status.includes(LIMIT_MARK), `a thread with no wait showed one: "${status}"`);
  } finally { unmount(); }
});
