/**
 * The key row of the summary pane, for a project the reader put away.
 *
 * A project inside ARCHIVED is one row and holds no fold, so the pane beside
 * the cursor is where a reader reads it — and that row is the one place they
 * look for the keys. It names `x` and `n`, which are the two doors back in.
 *
 * What this holds is *which* flag it reads. A pool is archived only when every
 * machine of it says so, and `archiveProject` fails in that direction on
 * purpose: one machine that did not answer keeps the project in the live list.
 * `pool[0].project.archivedAt` is then true of a row standing in the list with
 * a caret over it, and the sentence would name two keys that do the opposite
 * of what it says — `x` would open the archive confirmation and `n` would
 * start a thread with no unarchive, because both read `SidebarRow.archived`.
 *
 * It mounts App rather than the pane, the way `moveArchived.test.ts` does,
 * because the flag is handed down inside a React closure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { MachineInfo, Project } from "@covey/protocol";
import { App } from "./App.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-archived-summary-"));
const { Store } = await import("../store.js");

const info = (name: string): MachineInfo => ({
  machineId: name, name, os: "linux", arch: "arm64", homeDir: "/home/x",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

/** One repository, so the two machines below are one pooled row. */
const project = (id: string, archivedAt: string | null): Project => ({
  id, title: "covey", workspaceRoot: `/p/${id}`, repositoryIdentity: "github.com/dylandotfarm/covey",
  kind: "clone", baseBranch: null, defaultModel: null, archivedAt,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
} as unknown as Project);

/**
 * `away` first in the order, so its project is `pool[0]` — which is the one
 * the pane used to read. A harness that put the live machine first would pass
 * with the bug in.
 */
function harness(onBox: string | null) {
  const store = new Store([]);
  const s = store as any;
  const mk = (key: string, p: Project) => {
    s.state.machines.set(key, {
      key, saved: { name: key, url: `ws://${key}:3790` }, conn: "connected", error: null,
      info: info(key), projects: new Map([[p.id, p]]),
      threads: new Map(), runs: new Map(), update: null, restarting: false,
    });
    s.clients.set(key, { state: "connected", info: info(key), command: async () => ({}), rpc: async () => ({}) });
  };
  mk("away", project("a", "2026-11-10T00:00:00Z"));
  mk("box", project("b", onBox));
  s.state.order = ["away", "box"];
  s.state.focus = "sidebar";
  // Nothing to open, and no daemon to open it from.
  s.select = async () => {};
  return store;
}

function mount(store: unknown) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store: store as never }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { stdout, stdin, ink };
}

test("a pool archived on one machine only keeps the live keys, whichever machine leads it", async () => {
  // `away` says archived and `box` does not, so the project stands in the
  // list with a caret and `enter` folds it. The pane must say so.
  const store = harness(null);
  const { stdout, ink } = mount(store);
  try {
    await until(() => stdout.lastFrame.includes("covey"));
    await settle(80);
    const frame = stdout.lastFrame;
    assert.match(frame, /enter fold/, frame);
    assert.ok(!frame.includes("brings it back"), frame);
  } finally { ink.unmount(); }
});

test("a pool every machine archived says which two keys bring it back", async () => {
  const store = harness("2026-11-10T00:00:00Z");
  (store as any).state.expanded["projects:archived"] = true;
  const { stdout, stdin, ink } = mount(store);
  try {
    await until(() => stdout.lastFrame.includes("ARCHIVED"));
    // The rows are `empty`, the section, the project, the machines.
    stdin.type("j");
    await settle(60);
    stdin.type("j");
    await until(() => stdout.lastFrame.includes("brings it back"), 4000);
    const frame = stdout.lastFrame;
    assert.match(frame, /x brings it back/, frame);
    assert.ok(!frame.includes("enter fold"), frame);
  } finally { ink.unmount(); }
});
