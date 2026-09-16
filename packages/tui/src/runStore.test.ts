/**
 * Regression tests for what the client does with a run.
 *
 * Every case is a defect of the run of 2026-09-16:
 *
 *  1. "The operator sent the same correction to fifteen threads four separate
 *     times, each one a hand-written loop over thread ids." `sendToRun` is that
 *     loop, and the case here counts the messages that actually left.
 *  2. Fifteen agents were given the same throwaway port. `createRun` is what
 *     hands each member its own, so the case reads the ports off the record.
 *  3. Three members were legitimately blocked, and one task was cancelled after
 *     the agent had built it. Neither is a failure, and neither may be quietly
 *     overwritten by a pull request the client happens to read.
 *
 * No case dispatches to a real machine: every client here is a fake that
 * records what it was asked for. A run that fanned out during `pnpm test` would
 * start agents on the operator's own machines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-run-"));

import type { Command, MachineInfo, Project, Run, RunMember, Thread } from "@covey/protocol";
import { Store, nextStateForPr, sidebarRows, runKey, type AppState, type MachineState } from "./store.js";
import { sidebarCells } from "./sidebar.js";
import { parseTaskList } from "./run.js";

const MAC = "ws://mac:3790";
const PI = "ws://pi:3790";

/** A client that records the commands the store sends, and answers nothing. */
class FakeClient {
  commands: Command[] = [];
  snapshots: string[] = [];
  branch: string | null = "covey/aaaaaaaa";
  /** The run this fake keeps, so `run.member.patch` behaves as a daemon would. */
  run: Run | null = null;
  constructor(private store: Store, private key: string) {}
  async command(cmd: Command) {
    this.commands.push(cmd);
    this.apply(cmd);
    return { commandId: "c", ok: true as const, seq: this.commands.length };
  }
  async rpc(method: string, params: any): Promise<any> {
    if (method === "thread.snapshot") {
      this.snapshots.push(params.threadId);
      return { seq: 1, thread: { id: params.threadId, branch: this.branch, worktreePath: "/w" } as Thread, items: [], hasMore: false, commands: null };
    }
    if (method === "run.issues") return { issues: [], error: null };
    if (method === "run.pullRequest") return null;
    throw new Error(`unexpected rpc ${method}`);
  }
  /** The daemon's own behaviour, as far as these cases need it. */
  private apply(cmd: Command) {
    const ms = this.store.state.machines.get(this.key)!;
    if (cmd.type === "run.create") {
      const now = new Date().toISOString();
      this.run = {
        id: cmd.run.runId, machineId: "mac", name: cmd.run.name, goal: cmd.run.goal,
        briefTemplate: cmd.run.briefTemplate, workspaceMode: cmd.run.workspaceMode,
        members: cmd.run.members.map((m) => ({
          ...m, threadId: null, branch: null, worktreePath: null, pullRequest: null,
          state: "planned" as const, note: null, brief: null, dispatchedAt: null, updatedAt: now, review: null,
        })),
        closedAt: null, createdAt: now, updatedAt: now,
      };
    } else if (cmd.type === "run.member.patch" && this.run) {
      const at = this.run.members.findIndex((m) => m.id === cmd.memberId);
      if (at >= 0) this.run.members[at] = { ...this.run.members[at]!, ...cmd.patch } as RunMember;
    } else if (cmd.type === "run.member.add" && this.run) {
      const now = new Date().toISOString();
      this.run.members.push({
        ...cmd.member, threadId: null, branch: null, worktreePath: null, pullRequest: null,
        state: "planned", note: null, brief: null, dispatchedAt: null, updatedAt: now, review: null,
      });
    }
    if (this.run) ms.runs.set(this.run.id, structuredClone(this.run));
  }
  stop() {}
}

function machine(key: string, o: { name: string; os: string; cores: number; tools: readonly string[] }): MachineState {
  const info: MachineInfo = {
    machineId: o.name, name: o.name, os: o.os, arch: "arm64", homeDir: "/home",
    daemonVersion: "0.0.1", protocolVersion: 1,
    capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
    resources: {
      cpuCount: o.cores, totalMemoryBytes: o.cores * 8 * 1024 ** 3, concurrency: o.cores,
      tmpDir: o.os === "darwin" ? "/var/folders/xx" : "/tmp", path: "/usr/bin",
      tools: o.tools.map((t) => ({ name: t, path: `/usr/bin/${t}`, version: null })), readAt: "2026-09-16T00:00:00Z",
    },
    settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
  };
  const project: Project = {
    id: `p-${o.name}`, title: "covey", workspaceRoot: `/src/${o.name}`, repositoryIdentity: "github.com/dylandotfarm/covey",
    defaultModel: null, defaultWorkspaceMode: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  return {
    key, saved: { name: o.name, url: key }, conn: "connected", error: null, info,
    projects: new Map([[project.id, project]]), threads: new Map(), runs: new Map(),
    update: null, restarting: false,
  };
}

/** A store with two machines, both fakes: nothing here can reach a daemon. */
function twoMachines() {
  const store = new Store([]);
  const clients = new Map<string, FakeClient>();
  for (const [key, spec] of [
    [MAC, { name: "mac", os: "darwin", cores: 12, tools: ["git", "gh", "pnpm", "tmux"] }],
    [PI, { name: "pi", os: "linux", cores: 4, tools: ["git", "gh", "pnpm"] }],
  ] as const) {
    store.state.machines.set(key, machine(key, spec));
    store.state.order.push(key);
    const c = new FakeClient(store, key);
    clients.set(key, c);
    (store as any).clients.set(key, c);
  }
  return { store, mac: clients.get(MAC)!, pi: clients.get(PI)! };
}

async function runOf(store: Store, tasks: string) {
  const id = await store.createRun({
    machine: MAC, name: "covey issues", goal: "close the backlog",
    tasks: parseTaskList(tasks), repositoryIdentity: "github.com/dylandotfarm/covey",
  });
  assert.ok(id, "the run was created");
  return id!;
}

// ---------------------------------------------------------------------------

test("a run places its tasks and gives every member its own port", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15");
  const run = store.run(MAC, id)!;
  assert.equal(run.members.length, 15);
  const ports = run.members.map((m) => m.resources.port);
  assert.equal(new Set(ports).size, 15, "fifteen agents, fifteen ports — the defect this issue is about");
  assert.equal(new Set(run.members.map((m) => m.resources.coveyHome)).size, 15);
  assert.ok(!ports.includes(3790), "never the port the operator's own daemon listens on");
});

test("placement obeys a task's requirements, not the size of the machine", async () => {
  const { store } = twoMachines();
  // The Mac is filled first, so a placement that ignored `os=darwin` would put
  // the thirteenth task on the Pi — which cannot reveal a file in Finder.
  const filler = Array.from({ length: 12 }, (_, i) => `Task ${i}`).join("; ");
  const id = await runOf(store, `${filler}; Reveal a file in Finder os=darwin; Reproduce on the Pi machine=pi`);
  const run = store.run(MAC, id)!;
  assert.equal(run.members[11]!.machineId, "mac", "the Mac took its twelve first");
  assert.equal(run.members[12]!.machineId, "mac");
  assert.equal(run.members[13]!.machineId, "pi");
  // Each member is put in the project on *its own* machine, or the thread
  // would be made against a project id that machine has never heard of.
  assert.equal(run.members[12]!.projectId, "p-mac");
  assert.equal(run.members[13]!.projectId, "p-pi");
});

test("a member's directories belong to the machine it runs on", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "Do it on the Pi machine=pi");
  assert.match(store.run(MAC, id)!.members[0]!.resources.coveyHome, /^\/tmp\//);
});

test("creating a run dispatches nothing", async () => {
  const { store, mac, pi } = twoMachines();
  await runOf(store, "44 45 46");
  assert.equal(mac.commands.filter((c) => c.type === "thread.create").length, 0);
  assert.equal(pi.commands.filter((c) => c.type === "thread.create").length, 0);
  assert.equal(mac.commands.filter((c) => c.type === "turn.send").length, 0);
});

test("dispatch makes one thread per member and sends it its own brief", async () => {
  const { store, mac } = twoMachines();
  const id = await runOf(store, "44 45");
  await store.dispatchRun(MAC, id);
  const created = mac.commands.filter((c) => c.type === "thread.create");
  assert.equal(created.length, 2, "one thread each");
  assert.equal((created[0] as any).workspaceMode, "worktree-default", "never a shared checkout");
  const sends = mac.commands.filter((c) => c.type === "turn.send") as any[];
  assert.equal(sends.length, 2);
  const run = store.run(MAC, id)!;
  for (const m of run.members) {
    assert.equal(m.state, "dispatched");
    assert.ok(m.threadId, "the record knows which thread owns which task");
    assert.equal(m.branch, "covey/aaaaaaaa", "and which branch");
  }
  // Each brief names that member's own port, and mentions no other member's.
  const [a, b] = run.members;
  assert.ok(sends[0].text.includes(String(a!.resources.port)));
  assert.ok(!sends[1].text.includes(String(a!.resources.port)), "no member is told another member's port");
  assert.ok(sends[1].text.includes(String(b!.resources.port)));
});

test("dispatch does not start a member twice", async () => {
  const { store, mac } = twoMachines();
  const id = await runOf(store, "44 45");
  await store.dispatchRun(MAC, id);
  await store.dispatchRun(MAC, id);
  assert.equal(mac.commands.filter((c) => c.type === "thread.create").length, 2);
});

test("one message reaches every member — the largest manual cost of the real run", async () => {
  const { store, mac } = twoMachines();
  const id = await runOf(store, "44 45 46");
  await store.dispatchRun(MAC, id);
  const before = mac.commands.filter((c) => c.type === "turn.send").length;
  const run = store.run(MAC, id)!;
  await store.sendToRun(MAC, id, run.members.map((m) => m.id), "leave the root package.json alone");
  const sent = (mac.commands.filter((c) => c.type === "turn.send") as any[]).slice(before);
  assert.equal(sent.length, 3, "three members, three messages");
  assert.deepEqual(new Set(sent.map((s) => s.text)), new Set(["leave the root package.json alone"]));
  assert.equal(new Set(sent.map((s) => s.threadId)).size, 3, "each to its own thread");
});

test("a message to some members reaches only those members", async () => {
  const { store, mac } = twoMachines();
  const id = await runOf(store, "44 45 46");
  await store.dispatchRun(MAC, id);
  const run = store.run(MAC, id)!;
  const before = mac.commands.filter((c) => c.type === "turn.send").length;
  await store.sendToRun(MAC, id, [run.members[1]!.id], "you own the typecheck fix");
  const sent = (mac.commands.filter((c) => c.type === "turn.send") as any[]).slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, run.members[1]!.threadId);
});

test("a member's thread starting work moves it to working, once", async () => {
  const { store, mac } = twoMachines();
  const id = await runOf(store, "44");
  await store.dispatchRun(MAC, id);
  const threadId = store.run(MAC, id)!.members[0]!.threadId!;
  const thread = { id: threadId, status: "running", latestTurn: { state: "running" } } as unknown as Thread;
  const ms = store.state.machines.get(MAC)!;
  (store as any).applyShell(ms, { seq: 1, kind: "thread.upserted", thread });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.run(MAC, id)!.members[0]!.state, "working");
  const patches = mac.commands.filter((c) => c.type === "run.member.patch" && (c as any).patch.state === "working");
  (store as any).applyShell(ms, { seq: 2, kind: "thread.upserted", thread });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mac.commands.filter((c) => c.type === "run.member.patch" && (c as any).patch.state === "working").length, patches.length,
    "a second thread event must not send the same patch again");
});

test("a task added mid-run lands where there is room", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "1 2 3 4 5 6 7 8 9 10 11 12");
  // The Mac is at its twelve, so the next one goes to the Pi.
  await store.addTasks(MAC, id, parseTaskList("38"));
  const run = store.run(MAC, id)!;
  assert.equal(run.members.length, 13);
  assert.equal(run.members[12]!.machineId, "pi");
  assert.equal(run.members[12]!.state, "planned", "an added task is placed, not started");
  const ports = run.members.map((m) => m.resources.port);
  assert.equal(new Set(ports).size, 13, "the new member does not take a port a working one holds");
});

test("a member is moved to another machine before dispatch, with its resources", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "44");
  const m = store.run(MAC, id)!.members[0]!;
  assert.equal(m.machineId, "mac");
  await store.moveMember(MAC, id, m.id, "pi");
  const moved = store.run(MAC, id)!.members[0]!;
  assert.equal(moved.machineId, "pi");
  assert.equal(moved.projectId, "p-pi", "and the project on that machine");
  assert.match(moved.resources.coveyHome, /^\/tmp\//, "a home under the tmpdir of the machine it will run on");
});

test("a member that already has a thread is not moved", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "44");
  await store.dispatchRun(MAC, id);
  await store.moveMember(MAC, id, store.run(MAC, id)!.members[0]!.id, "pi");
  assert.equal(store.run(MAC, id)!.members[0]!.machineId, "mac");
});

// ---------------------------------------------------------------------------
// The states the operator owns
// ---------------------------------------------------------------------------

test("a pull request never overrules blocked or withdrawn", () => {
  // Three members of the real run were legitimately blocked, and one task was
  // cancelled after the agent had built it. Neither is a failure and neither is
  // the pull request's to decide.
  assert.equal(nextStateForPr("blocked", { state: "OPEN" }), "blocked");
  assert.equal(nextStateForPr("withdrawn", { state: "MERGED" }), "withdrawn");
  assert.equal(nextStateForPr("merged", null), "merged");
});

test("a pull request moves a working member to review, and a merged one to merged", () => {
  assert.equal(nextStateForPr("working", { state: "OPEN" }), "review");
  assert.equal(nextStateForPr("dispatched", { state: "OPEN" }), "review");
  assert.equal(nextStateForPr("review", { state: "MERGED" }), "merged");
  assert.equal(nextStateForPr("working", null), "working", "no pull request changes nothing");
});

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

test("a run is a sidebar row that opens to its members", async () => {
  const { store } = twoMachines();
  const id = await runOf(store, "44 45");
  const state = store.state as AppState;
  const rows = sidebarRows(state);
  const run = rows.find((r) => r.kind === "run");
  assert.ok(run, "the run has a row");
  assert.equal(run!.machine, MAC);
  const members = rows.filter((r) => r.kind === "member");
  assert.equal(members.length, 2);
  assert.equal(members[0]!.member!.task.key, "#44");
  // Furling the run takes its members off the list, as a project does.
  state.expanded[runKey(MAC, id)] = false;
  assert.equal(sidebarRows(state).filter((r) => r.kind === "member").length, 0);
});

test("the painted lines and the click hit test see the same rows", async () => {
  const { store } = twoMachines();
  await runOf(store, "44 45");
  const rows = sidebarRows(store.state as AppState);
  const cells = sidebarCells(rows, 0, 40);
  // Every row the painter draws maps back to the row a click would find, and
  // the run rows did not shift the threads under them by a line.
  const painted = cells.filter((c) => c.kind === "row").map((c) => (c as any).index);
  assert.deepEqual(painted, rows.map((_, i) => i));
});
