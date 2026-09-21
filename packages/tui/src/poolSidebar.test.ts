/**
 * Projects at the top of the sidebar, pooled across machines (#89).
 *
 * A repository is one row however many machines hold it. The threads of every
 * machine sit under it, each row tagged with its machine when the pool has
 * more than one, and the machines themselves sit in a section of their own,
 * below the projects and furled by default.
 *
 * A machine that is not connected can still join a pool: the clone it was
 * asked for waits in the client's config and is sent when it next answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-pool-"));

import type { Command, Project, Thread } from "@covey/protocol";
import { Store, MACHINES_KEY, archiveKey, projectGroups, sidebarRows, type AppState, type MachineState } from "./store.js";
import { loadConfig } from "./config.js";

const project = (id: string, title: string, identity: string | null, over: Partial<Project> = {}): Project => ({
  id, title, workspaceRoot: `/repos/${id}`, repositoryIdentity: identity, defaultModel: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

const thread = (id: string, projectId: string, at: string, over: Partial<Thread> = {}): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: at, archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

function machine(key: string, name: string, conn: MachineState["conn"], projects: Project[], threads: Thread[]): MachineState {
  return {
    key, saved: { name, url: key }, conn, error: null,
    info: conn === "connected" ? ({ machineId: `id-${name}`, name, os: "linux", projectsDir: `/home/${name}/.covey/projects` } as any) : null,
    projects: new Map(projects.map((p) => [p.id, p])), threads: new Map(threads.map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
}

const PI = "ws://pi:3790", MAC = "ws://mac:3790";

/** Two machines that both hold `covey`; only the mac holds `other`. */
function fleet(expanded: Record<string, boolean> = {}): AppState {
  const pi = machine(PI, "pi", "connected",
    [project("p-covey", "covey", "github.com/dylandotfarm/covey", { kind: "clone", remoteUrl: "git@github.com:dylandotfarm/covey.git" })],
    [thread("on-pi", "p-covey", "2026-01-03T00:00:00Z"), thread("old-pi", "p-covey", "2026-01-01T00:00:00Z", { archivedAt: "2026-02-01T00:00:00Z" })]);
  const mac = machine(MAC, "mac", "connected",
    [project("m-covey", "covey", "github.com/dylandotfarm/covey", { kind: "clone", remoteUrl: "https://github.com/dylandotfarm/covey.git" }), project("m-other", "other", null)],
    [thread("on-mac", "m-covey", "2026-01-02T00:00:00Z"), thread("lone", "m-other", "2026-01-04T00:00:00Z")]);
  return { machines: new Map([[PI, pi], [MAC, mac]]), order: [PI, MAC], expanded } as unknown as AppState;
}

test("one repository on two machines is one project row, with the threads of both under it", () => {
  const rows = sidebarRows(fleet());
  assert.deepEqual(rows.map((r) => `${r.kind}@${r.depth}`), [
    "project@0", "thread@1", "thread@1", "archived@1",
    "project@0", "thread@1",
    "machines@0",
  ], "the tree is projects first, then the machines section");
  const covey = rows[0]!;
  assert.equal(covey.project!.title, "covey");
  assert.deepEqual(covey.pool!.map((x) => `${x.machine}:${x.projectId}`), [`${PI}:p-covey`, `${MAC}:m-covey`], "the pool lists every machine that holds it, in machine order");
  assert.equal(covey.groupKey, "github.com/dylandotfarm/covey", "the fold key is the repository");
  // Threads from both machines, by recency, each naming its own machine.
  assert.deepEqual(rows.slice(1, 3).map((r) => [r.thread!.id, r.machine, r.tag]), [["on-pi", PI, "pi"], ["on-mac", MAC, "mac"]]);
  // The archived folder gathers both machines' archives under the one fold key.
  assert.equal(rows[3]!.groupKey, "github.com/dylandotfarm/covey");
  assert.equal(rows[3]!.count, 1);
});

test("a project with no remote is a group of its own, keyed by machine and id, and its threads carry no tag", () => {
  const rows = sidebarRows(fleet());
  const other = rows.find((r) => r.kind === "project" && r.project!.title === "other")!;
  assert.equal(other.groupKey, `${MAC}:m-other`, "the same string a project fold always used, so an old fold still holds");
  assert.equal(other.pool!.length, 1);
  const lone = rows.find((r) => r.thread?.id === "lone")!;
  assert.equal(lone.tag, undefined, "one machine needs no tag");
});

test("folding a pooled project folds the threads of every machine in it, and the archive opens under the group key", () => {
  const furled = sidebarRows(fleet({ "github.com/dylandotfarm/covey": false }));
  assert.deepEqual(furled.map((r) => r.kind), ["project", "project", "thread", "machines"]);
  const open = sidebarRows(fleet({ [archiveKey("github.com/dylandotfarm/covey")]: true }));
  const archived = open.filter((r) => r.kind === "thread" && r.archived);
  assert.deepEqual(archived.map((r) => [r.thread!.id, r.tag]), [["old-pi", "pi"]]);
});

test("the machines section is furled by default and lists every machine when opened", () => {
  assert.deepEqual(sidebarRows(fleet()).filter((r) => r.kind === "machine"), []);
  const rows = sidebarRows(fleet({ [MACHINES_KEY]: true }));
  const tail = rows.slice(rows.findIndex((r) => r.kind === "machines"));
  assert.deepEqual(tail.map((r) => `${r.kind}@${r.depth}:${r.machine}`), ["machines@0:", `machine@1:${PI}`, `machine@1:${MAC}`]);
});

test("projectGroups sorts by title and keeps a machine's own order inside a group", () => {
  const groups = projectGroups(fleet());
  assert.deepEqual(groups.map((g) => g.title), ["covey", "other"]);
  assert.deepEqual(groups[0]!.members.map((x) => x.machine), [PI, MAC]);
});

// ---- a machine that is away joins the pool later ---------------------------

class FakeClient {
  commands: Command[] = [];
  /** What `project.create` answers: nothing, or the error it throws. */
  fail: Error | null = null;
  async command(cmd: Command) {
    this.commands.push(cmd);
    if (this.fail) throw this.fail;
    return { commandId: "c", ok: true as const, seq: this.commands.length };
  }
  async rpc(): Promise<any> { throw new Error("unexpected rpc"); }
  stop() {}
}

function storeWith(states: MachineState[]) {
  const store = new Store([]);
  const clients = new Map<string, FakeClient>();
  for (const m of states) {
    store.state.machines.set(m.key, m);
    store.state.order.push(m.key);
    const c = new FakeClient();
    clients.set(m.key, c);
    (store as any).clients.set(m.key, c);
  }
  return { store, clients };
}

test("a clone asked of a machine that is away waits in the config, and is sent when the machine answers", async () => {
  const { store, clients } = storeWith([
    machine(PI, "pi", "connected", [], []),
    machine(MAC, "mac", "offline", [], []),
  ]);
  const url = "git@github.com:acme/api.git";
  await store.createProjectOn([PI, MAC], url);
  assert.deepEqual(clients.get(PI)!.commands.map((c) => c.type), ["project.create"], "the connected machine is asked now");
  assert.deepEqual(clients.get(MAC)!.commands, [], "the machine that is away is not");
  assert.deepEqual(store.pendingFor(url), [MAC], "and the request waits for it");
  assert.deepEqual(loadConfig().prefs.pendingProjects, [{ machine: MAC, url }], "in the config, so it survives the client");

  // The mac answers. What it owed is sent, and the list is clear.
  store.state.machines.get(MAC)!.conn = "connected";
  await (store as any).drainPending(MAC);
  assert.deepEqual(clients.get(MAC)!.commands, [{ type: "project.create", url }]);
  assert.deepEqual(store.pendingFor(url), []);
  assert.deepEqual(loadConfig().prefs.pendingProjects, []);
});

test("a clone the machine refuses stays pending, unless the machine already has the project", async () => {
  const { store, clients } = storeWith([machine(MAC, "mac", "offline", [], [])]);
  await store.createProject(MAC, "git@github.com:acme/api.git");
  await store.createProject(MAC, "git@github.com:acme/web.git");
  const mac = clients.get(MAC)!;
  store.state.machines.get(MAC)!.conn = "connected";

  // Both refused: the network is down on the far side. Both wait.
  mac.fail = new Error("could not clone: no route to host");
  await (store as any).drainPending(MAC);
  assert.deepEqual(store.pendingFor("git@github.com:acme/api.git"), [MAC], "a clone that failed is tried again next time");
  assert.deepEqual(store.pendingFor("git@github.com:acme/web.git"), [MAC]);

  // Already there: the request is done, not owed.
  mac.fail = Object.assign(new Error("this machine already has api for github.com/acme/api"), { code: "exists" });
  await (store as any).drainPending(MAC);
  assert.deepEqual(store.pendingFor("git@github.com:acme/api.git"), []);
  assert.deepEqual(store.pendingFor("git@github.com:acme/web.git"), []);
  assert.equal(mac.commands.length, 4, "every pending clone was sent each time");
});
