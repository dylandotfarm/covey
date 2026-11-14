/**
 * Moving a thread into a project the reader put away (#204).
 *
 * `n` and a move are the only two doors into a project, and a move is the one
 * where the reader cannot otherwise see the state they are choosing: the
 * destination pick lists every project on the target machine by title. Without
 * the two halves below, a reader picks a project by name, the move reports
 * success, and the thread is inside a furled section — and the section's
 * attention dot lights only for work that is running or waiting, so an idle
 * thread goes off the screen with nothing said.
 *
 * Both halves live inside a React closure, so this mounts App and types, the
 * way `machinePanel.test.ts` does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { App } from "./App.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-move-archived-"));
const { Store } = await import("../store.js");

const info = (name: string): MachineInfo => ({
  machineId: name, name, os: "linux", arch: "arm64", homeDir: "/home/x",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

const project = (id: string, title: string, over: Partial<Project> = {}): Project => ({
  id, title, workspaceRoot: `/p/${id}`, repositoryIdentity: null, kind: "local", localId: id,
  defaultModel: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
});

const thread = (id: string, projectId: string): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: "2026-11-01T00:00:00Z", archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
} as unknown as Thread);

/**
 * Two connected machines. `pi` holds the thread; `box` holds one project in
 * the list and one the reader archived.
 */
function harness() {
  const sent: { machine: string; name: string; cmd: Record<string, unknown> }[] = [];
  const store = new Store([]);
  const s = store as any;
  const mk = (key: string, projects: Project[], threads: Thread[]) => {
    s.state.machines.set(key, {
      key, saved: { name: key, url: `ws://${key}:3790` }, conn: "connected", error: null,
      info: info(key), projects: new Map(projects.map((p) => [p.id, p])),
      threads: new Map(threads.map((t) => [t.id, t])), runs: new Map(), update: null, restarting: false,
    });
    // A move goes over `rpc`, not `command`, so both are recorded: what is
    // being asserted is the *order* of the unarchive and the move.
    s.clients.set(key, {
      state: "connected", info: info(key),
      command: async (cmd: Record<string, unknown>) => { sent.push({ machine: key, name: String(cmd.type), cmd }); return {}; },
      rpc: async (name: string, params: Record<string, unknown>) => {
        sent.push({ machine: key, name, cmd: params });
        return name === "thread.import" ? { threadId: "moved" } : {};
      },
    });
  };
  mk("pi", [project("here", "here")], [thread("t1", "here")]);
  mk("box", [project("live", "live"), project("away", "away", { archivedAt: "2026-11-10T00:00:00Z" })], []);
  s.state.order = ["pi", "box"];
  s.state.focus = "sidebar";
  s.state.selected = { machine: "pi", threadId: "t1" };
  // The move ends by opening the thread where it landed; there is no daemon
  // here to fetch it from.
  s.select = async () => {};
  return { store, sent };
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

/** Open the destination pick: cursor to the thread row, `m`, then the machine. */
async function toDestinations(stdin: FakeStdin, stdout: FakeStdout) {
  stdin.type("j"); // the project row is first; the thread sits under it
  await settle(60);
  stdin.type("m");
  await until(() => stdout.lastFrame.includes("Move thread to machine"));
  stdin.type("box");
  await settle(60);
  stdin.type("\r");
  await until(() => stdout.lastFrame.includes("Destination project on box"));
}

test("an archived project is still a destination, and the row says it is archived", async () => {
  const { store } = harness();
  const { stdout, stdin, ink } = mount(store);
  try {
    await toDestinations(stdin, stdout);
    const frame = stdout.lastFrame;
    // The reader may be naming exactly that project, so it is offered — but
    // never silently, the way `kin` never hides the base it works from.
    assert.match(frame, /away/, frame);
    assert.match(frame, /archived/, frame);
    // And the project that is in the list says nothing of the sort.
    assert.ok(!/live.*archived/.test(frame.split("\n").find((l) => l.includes("live")) ?? ""), frame);
  } finally { ink.unmount(); }
});

test("moving into an archived project brings it back first, so the thread is never inside a fold", async () => {
  const { store, sent } = harness();
  const { stdout, stdin, ink } = mount(store);
  try {
    await toDestinations(stdin, stdout);
    stdin.type("away");
    await settle(60);
    stdin.type("\r");
    await until(() => sent.some((x) => x.name === "thread.import"), 4000);
    // The unarchive comes first and goes to the machine that holds the
    // project; the move follows it, so the notice the reader is left with is
    // the move's own answer and not the unarchive's.
    assert.deepEqual(sent.map((x) => `${x.machine}:${x.name}`), [
      "box:project.archive",
      "pi:thread.export",
      "box:thread.import",
      "pi:thread.markMoved",
    ]);
    assert.deepEqual([sent[0]!.cmd.projectId, sent[0]!.cmd.archived], ["away", false]);
    assert.equal(sent[2]!.cmd.projectId, "away", "and the thread lands in the project the reader named");
  } finally { ink.unmount(); }
});

test("moving into a project that is in the list archives nothing", async () => {
  const { store, sent } = harness();
  const { stdout, stdin, ink } = mount(store);
  try {
    await toDestinations(stdin, stdout);
    stdin.type("live");
    await settle(60);
    stdin.type("\r");
    await until(() => sent.some((x) => x.name === "thread.import"), 4000);
    await settle(120);
    assert.ok(!sent.some((x) => x.name === "project.archive"), sent.map((x) => x.name).join(", "));
    assert.equal(sent.find((x) => x.name === "thread.import")!.cmd.projectId, "live");
  } finally { ink.unmount(); }
});
