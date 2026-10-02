/**
 * The title bar as the client paints it, at the widths #87 was filed for.
 *
 * `titleBar.test.ts` measures the rule; this holds the wiring, because the
 * rule is only worth having if the row covey paints is the row
 * `layoutTitleBar` described. Below about 94 columns the title and the hint
 * used to shrink into each other and the reader kept
 * `al…  …  esc interr…rl+k commands`.
 *
 * A fresh mount per width, and no resize: the frame Ink writes on the signal
 * is laid out for the terminal that has gone, and the frame React then commits
 * is an *incremental* write — so only a real emulator composes the screen the
 * two make between them. `resize.test.ts` is where that frame is bounded.
 * `debug: true` turns the diff off, which is what makes `lastFrame` the whole
 * screen here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { App, SIDEBAR_W } from "./App.js";
import { FakeStdin, FakeStdout, until } from "./testTerminal.js";
import { layoutTitleBar, PART_GAP, RIGHT_GAP, type BarPart } from "../titleBar.js";
import { width } from "../lines.js";

process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-bar-"));
const { Store } = await import("../store.js");

const AT = "2026-01-01T00:00:00Z";
const PI = "ws://pi:3790";
/** The hints App offers for a sidebar that has the focus, longest form first. */
const BROWSE = ["↑↓ browse · enter open · click works too", "↑↓ browse · enter open", "enter open"];

const info: MachineInfo = {
  machineId: "m1", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/pi",
  daemonVersion: "abc1234", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};
const project: Project = {
  id: "p", title: "covey", workspaceRoot: "/src/covey", repositoryIdentity: null,
  defaultModel: null, createdAt: AT, updatedAt: AT,
};
function thread(title: string): Thread {
  return {
    id: "alpha", projectId: "p", title, provider: "claude", sessionId: "alpha",
    model: "claude-sonnet-4-5", permissionMode: "default", branch: "feature/x",
    worktreePath: "/src/covey/.covey/worktrees/abcd1234", status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0,
    latestTurn: { turnId: "t1", state: "completed", startedAt: AT, completedAt: AT },
    lastMessageAt: AT, archivedAt: null, pinnedAt: null, movedTo: null, createdAt: AT, updatedAt: AT,
  } as Thread;
}

/** One machine with one project and one thread, the cursor in the sidebar. */
function harness(title: string, focus: "sidebar" | "composer") {
  const store = new Store([]);
  const s = store as any;
  const threads = new Map([["alpha", thread(title)]]);
  s.state.machines.set(PI, {
    key: PI, saved: { name: "pi", url: PI }, conn: "connected", error: null, info,
    projects: new Map([[project.id, project]]), threads, runs: new Map(), update: null, restarting: false,
  });
  s.state.order = [PI];
  s.state.expanded[`${PI}:${project.id}`] = true;
  s.state.selected = { machine: PI, threadId: "alpha" };
  s.state.focus = focus;
  s.state.view = {
    machine: PI, threadId: "alpha", thread: threads.get("alpha"), items: new Map(),
    loading: false, error: null, hasMore: false, loadingOlder: false, seq: 0, commands: null, dirs: new Map(),
  };
  return store;
}

/** Paint at `cols` columns and hand back the bar beside the sidebar's rail. */
async function bar(store: unknown, cols: number): Promise<string> {
  const stdout = new FakeStdout();
  stdout.columns = cols; stdout.rows = 24;
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store: store as never }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    await until(() => stdout.lastFrame.includes("│"));
    const row = stdout.lastFrame.split("\n")[0] ?? "";
    return row.slice(row.indexOf("│") + 1).replace(/\s+$/, "");
  } finally {
    ink.unmount();
  }
}

/**
 * The two sides `layoutTitleBar` describes, for the same inputs.
 *
 * Two sides and not one string: `space-between` holds them apart by whatever
 * the row had over, so the run of spaces between them is no part of the
 * layout and nothing here should claim to know it. `RIGHT_GAP` is its floor
 * and the cases below measure the whole row against the pane, which is what
 * bounds it from the other end.
 */
function want(parts: BarPart[], forms: string[], cols: number): { left: string; right: string } {
  const out = layoutTitleBar(parts, { kind: "hint", forms }, cols - SIDEBAR_W - 4);
  let left = "";
  for (const p of out.parts) if (p) left += (p.gap ? " ".repeat(PART_GAP) : "") + p.text;
  return { left, right: out.right };
}

test("the bar names the project and steps the hint down a form, rather than cutting either", async () => {
  // The sidebar's cursor starts on the project row, which puts the project
  // summary on the bar and makes the browsing hint the one on the row.
  const store = harness("fix the title bar", "sidebar");
  const parts: BarPart[] = [{ text: "covey", keep: true }, { text: "pi" }];
  // 70 columns is as narrow as the sidebar goes; below it the pane is the
  // whole terminal and the bar names the open thread instead.
  for (const cols of [120, 100, 94, 90, 80, 70]) {
    const painted = await bar(store, cols);
    const { left, right } = want(parts, BROWSE, cols);
    const row = painted.trimStart();
    assert.ok(row.startsWith(left),
      `the bar at ${cols} columns does not open with the parts the layout described: ${JSON.stringify(row)}`);
    assert.equal(row.slice(left.length).trimStart(), right,
      `the hint at ${cols} columns is not the form the layout chose`);
    assert.ok(width(painted) + RIGHT_GAP <= cols - SIDEBAR_W,
      `the bar overran its pane at ${cols} columns`);
  }
});

test("a hint on the bar is one of its own forms, and the title beside it is whole", async () => {
  const store = harness("fix the title bar", "sidebar");
  for (const cols of [120, 100, 94, 90, 80, 70]) {
    const painted = await bar(store, cols);
    const form = BROWSE.find((f) => painted.includes(f));
    assert.ok(form, `no whole hint form on the bar at ${cols} columns: ${JSON.stringify(painted)}`);
    assert.ok(painted.includes("covey"), `the project's name went to make room for a hint at ${cols}`);
    assert.ok(!painted.includes("…"), `something on the bar was cut at ${cols}: ${JSON.stringify(painted)}`);
  }
});

test("a title too long for the row takes it, and the hint is the thing that goes", async () => {
  const long = "rework the parser so that it keeps the comments it reads";
  const store = harness(long, "composer");
  // 70 columns: a pane of 36, where the title alone overruns the row and not
  // even `ctrl+k` can stand beside it.
  const painted = await bar(store, 70);
  assert.ok(painted.includes("…"), `the title was truncated: ${JSON.stringify(painted)}`);
  assert.ok(painted.startsWith("  rework the parser"), `the title takes the row: ${JSON.stringify(painted)}`);
  assert.ok(painted.endsWith("…"), "and is truncated, which is the one part that is");
  assert.ok(!painted.includes("ctrl+k"), "no hint stands beside it");
  assert.ok(width(painted) <= 70 - SIDEBAR_W, "and the row still fits its pane");
});
