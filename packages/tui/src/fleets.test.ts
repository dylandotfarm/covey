/**
 * Fleets: two sets of machines on one tailnet, kept apart.
 *
 * A fleet is the machine's own answer (`MachineSettings.fleet`), so every
 * client groups it the same way. The sidebar gains one level of fold above the
 * projects, and only when there is more than one fleet — a reader who never
 * makes a second one sees the tree they have always seen.
 *
 * The line is real and not a heading. These hold the four places it matters:
 * a project pools inside one fleet, the repositories offered come from a `gh`
 * in that fleet, a run places inside it, and a machine that is away keeps the
 * fleet it was in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-fleets-"));

import type { Project, Thread } from "@covey/protocol";
import {
  MACHINES_KEY, Store, fleetMachines, fleetRowKey, fleetsOf, machineFleet, machinesKey, projectGroups,
  sidebarRows, type AppState, type MachineState,
} from "./store.js";

const COVEY = "github.com/dylandotfarm/covey";

const project = (id: string, title: string, identity: string | null, over: Partial<Project> = {}): Project => ({
  id, title, workspaceRoot: `/repos/${id}`, repositoryIdentity: identity, defaultModel: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  kind: "clone", remoteUrl: `git@github.com:dylandotfarm/${title}.git`, ...over,
});

const thread = (id: string, projectId: string, over: Partial<Thread> = {}): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: "2026-01-03T00:00:00Z", archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

/** A machine, in a fleet it declares, with a `gh` unless told otherwise. */
function machine(key: string, name: string, fleet: string | null, projects: Project[], threads: Thread[], over: Partial<MachineState> = {}): MachineState {
  return {
    key, saved: { name, url: key }, conn: "connected", error: null,
    info: {
      machineId: `id-${name}`, name, os: "linux", arch: "x64",
      settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, fleet },
      resources: { cpuCount: 4, concurrency: 2, tmpDir: "/tmp", tools: [{ name: "gh" }] },
    } as any,
    projects: new Map(projects.map((p) => [p.id, p])), threads: new Map(threads.map((t) => [t.id, t])),
    runs: new Map(), update: null, restarting: false, ...over,
  } as unknown as MachineState;
}

const PI = "ws://pi:3790", MAC = "ws://mac:3790", BOX = "ws://box:3790";

function stateOf(ms: MachineState[], expanded: Record<string, boolean> = {}): AppState {
  return { machines: new Map(ms.map((m) => [m.key, m])), order: ms.map((m) => m.key), expanded } as unknown as AppState;
}

/** pi and the mac in the default fleet; box at work. */
function twoFleets(expanded: Record<string, boolean> = {}): AppState {
  return stateOf([
    machine(PI, "pi", null, [project("p-covey", "covey", COVEY)], [thread("on-pi", "p-covey")]),
    machine(MAC, "mac", null, [project("m-covey", "covey", COVEY)], []),
    machine(BOX, "box", "work", [project("b-covey", "covey", COVEY), project("b-api", "api", "github.com/acme/api")], [thread("on-box", "b-api")]),
  ], expanded);
}

// ---- the sidebar -----------------------------------------------------------

test("one fleet paints no fleet row, and every row keeps the depth it always had", () => {
  const s = stateOf([machine(PI, "pi", null, [project("p-covey", "covey", COVEY)], [thread("on-pi", "p-covey")])], { [MACHINES_KEY]: true });
  assert.deepEqual(sidebarRows(s).map((r) => `${r.kind}@${r.depth}`), ["project@0", "thread@1", "machines@0", "machine@1"]);
});

test("a machine in its own fleet makes two headings, and everything under them moves one level in", () => {
  const rows = sidebarRows(twoFleets());
  assert.deepEqual(rows.map((r) => `${r.kind}@${r.depth}`), [
    "fleet@0", "project@1", "thread@2", "machines@1",
    "fleet@0", "project@1", "thread@2", "project@1", "machines@1",
  ], "work holds api, with its thread, then covey");
  const [covey, work] = rows.filter((r) => r.kind === "fleet");
  assert.deepEqual([covey!.fleet, covey!.count, covey!.machineCount], ["covey", 1, 2], "one project over two machines");
  assert.deepEqual([work!.fleet, work!.count, work!.machineCount], ["work", 2, 1]);
  assert.equal(covey!.key, "f:covey");
});

test("the default fleet leads, and the rest are in name order", () => {
  const s = stateOf([
    machine(PI, "pi", "work", [], []),
    machine(MAC, "mac", "personal", [], []),
    machine(BOX, "box", null, [], []),
  ]);
  assert.deepEqual(fleetsOf(s), ["covey", "personal", "work"]);
  assert.deepEqual(sidebarRows(s).filter((r) => r.kind === "fleet").map((r) => r.fleet), ["covey", "personal", "work"]);
});

test("a furled fleet hides its work and still says what needs a person", () => {
  const s = twoFleets({ [fleetRowKey("work")]: false });
  s.machines.get(BOX)!.threads.get("on-box")!.pendingApprovals = 1;
  const rows = sidebarRows(s);
  assert.deepEqual(rows.map((r) => r.kind), ["fleet", "project", "thread", "machines", "fleet"], "nothing of work is painted");
  const work = rows[rows.length - 1]!;
  assert.equal(work.waiting, true, "but the fold may not hide that somebody is waiting on a person");
  assert.equal(work.count, 2, "and it still says how much is inside");
});

test("each fleet has its own machines section, and the default fleet keeps the fold key it always had", () => {
  assert.equal(machinesKey("covey"), MACHINES_KEY);
  assert.equal(machinesKey("Covey"), MACHINES_KEY, "the case the reader typed is not a second fleet");
  assert.equal(machinesKey("work"), `${MACHINES_KEY}:work`);
  const rows = sidebarRows(twoFleets({ [MACHINES_KEY]: true }));
  const machines = rows.filter((r) => r.kind === "machine");
  assert.deepEqual(machines.map((r) => `${r.machine}@${r.depth}`), [`${PI}@2`, `${MAC}@2`], "opening one section opens that fleet's alone");
});

test("a fleet with no machine in it is not painted, and a client with none still has a home", () => {
  const s = stateOf([machine(BOX, "box", "work", [], [])]);
  assert.deepEqual(sidebarRows(s).filter((r) => r.kind === "fleet").map((r) => r.fleet), [], "one fleet, so no heading at all");
  assert.deepEqual(fleetsOf(s), ["covey", "work"], "the default is still offered, so the machine can be moved back");
  const empty = stateOf([]);
  assert.deepEqual(sidebarRows(empty).map((r) => r.kind), ["machines"]);
});

// ---- the line itself -------------------------------------------------------

test("one repository in two fleets is two project rows, and the default fleet's fold key is unchanged", () => {
  const groups = projectGroups(twoFleets());
  assert.deepEqual(groups.map((g) => [g.title, g.fleet, g.key]), [
    ["api", "work", "work/github.com/acme/api"],
    ["covey", "covey", COVEY],
    ["covey", "work", `work/${COVEY}`],
  ], "the default fleet's key is the pool key it always was; a second fleet scopes its own");
  // The pool of the default fleet holds its own two machines and not box.
  const home = groups.find((g) => g.key === COVEY)!;
  assert.deepEqual(home.members.map((x) => x.machine), [PI, MAC]);
  assert.deepEqual(projectGroups(twoFleets(), "work").map((g) => g.title), ["api", "covey"]);
});

test("a machine declares its own fleet, and the cache answers while it is away", () => {
  const s = stateOf([
    machine(BOX, "box", "work", [], []),
    // A machine that has not answered: no `info`, but the client remembers.
    { ...machine(PI, "pi", null, [], []), conn: "offline", info: null, saved: { name: "pi", url: PI, fleet: "work" } } as MachineState,
  ]);
  assert.equal(machineFleet(s, BOX), "work");
  assert.equal(machineFleet(s, PI), "work", "an offline machine stays in the fleet the reader put it in");
  assert.deepEqual(fleetMachines(s, "work"), [BOX, PI]);
  // And the machine always wins: it says it moved back, the stale cache does not.
  const moved = stateOf([{ ...machine(MAC, "mac", "covey", [], []), saved: { name: "mac", url: MAC, fleet: "work" } } as MachineState]);
  assert.equal(machineFleet(moved, MAC), "covey");
});

test("a run places inside its own fleet, and the repository list is read there", () => {
  const store = new Store([]);
  for (const m of [
    machine(PI, "pi", null, [project("p-covey", "covey", COVEY)], []),
    machine(BOX, "box", "work", [project("b-covey", "covey", COVEY)], []),
  ]) { store.state.machines.set(m.key, m); store.state.order.push(m.key); }

  // Both machines hold the same repository, and they are in different fleets.
  assert.deepEqual(store.placementMachines(COVEY).map((m) => m.key), [PI, BOX], "with no fleet named, every machine is offered");
  assert.deepEqual(store.placementMachines(COVEY, "work").map((m) => m.key), [BOX], "work places on work machines");
  assert.deepEqual(store.placementMachines(COVEY, "covey").map((m) => m.key), [PI]);

  // The `gh` that lists repositories is a machine of the fleet, so a work
  // login never offers its repositories to the fleet at home.
  assert.deepEqual(store.ghMachines("work"), [BOX]);
  assert.deepEqual(store.ghMachines("covey"), [PI]);
  assert.deepEqual(store.ghMachines(), [PI, BOX]);
});

test("a machine the reader added to a fleet is told so at its first hello, once", async () => {
  const store = new Store([]);
  const sent: unknown[] = [];
  const ms = machine(BOX, "box", null, [], [], { joining: "work" } as Partial<MachineState>);
  store.state.machines.set(BOX, ms);
  store.state.order.push(BOX);
  (store as any).clients.set(BOX, { command: async (c: unknown) => { sent.push(c); return { ok: true }; }, rpc: async () => ({}), stop() {} });

  (store as any).settleFleet(ms);
  assert.deepEqual(sent, [{ type: "machine.settings", fleet: "work" }], "the fleet is the machine's setting, so the machine is told");
  assert.equal(ms.joining, undefined);
  (store as any).settleFleet(ms);
  assert.deepEqual(sent.length, 1, "and told once: a second hello is not a second write");
});
