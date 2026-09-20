/**
 * A thread an agent started, nested under the thread that started it —
 * issues #49 and #69.
 *
 * On 2026-09-16 an operator ran fifteen agents over two machines. All fifteen
 * threads appeared in the sidebar as peers of the threads the user had opened
 * by hand, with nothing to tell them apart but their titles. #49 records who
 * asked for a thread; #69 is the sidebar half of the same fact.
 *
 * Two rules decide these cases, and each has one here that fails without it:
 *
 *  1. **The arrow keys furl, the click never does.** A user clicks a thread row
 *     to open the conversation, and the row that most wants clicking is the
 *     manager — the one with everything under it. The click case drives a real
 *     SGR press through the hit test, on the line the row was really painted
 *     on, because `sidebarCells` is the hit test's own idea of the list and
 *     asking it where a row is proves nothing (the case PR #66 replaced).
 *  2. **Quiet while it works, loud when it needs a person.** A furled group
 *     hides the children that are working. It never hides one that failed or is
 *     blocked, because nobody else is watching those.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-group-"));

import React from "react";
import { render } from "ink";
import type { MachineInfo, Project, Run, RunMember, RunMemberState, Thread, ThreadOrigin } from "@covey/protocol";
import { Store, archiveKey, pendingTasks, projectRuns, runIsBusy, sidebarRows, runKey, threadGroupKey, needsPerson, type AppState, type MachineState } from "./store.js";
import { sidebarCells, rowAtScreenRow } from "./sidebar.js";
import { App } from "./components/App.js";
import { AGENT_MARK } from "./components/Sidebar.js";

const PI = "ws://pi:3790";

const project: Project = {
  id: "p", title: "covey", workspaceRoot: "/src/covey", repositoryIdentity: null,
  defaultModel: null, defaultWorkspaceMode: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const info: MachineInfo = {
  machineId: "m-pi", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/pi",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/**
 * `at` is the last message. The sidebar sorts by it, so it also fixes the order
 * the rows come out in and keeps every case below reading top to bottom.
 */
function thread(id: string, at: string, over: Partial<Thread> = {}): Thread {
  return {
    id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
    branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
    latestTurn: null, lastMessageAt: at, archivedAt: null, pinnedAt: null, movedTo: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

/** A thread a program started, under `parent` when one is named. */
const started = (id: string, at: string, parent: string | null, over: Partial<Thread> = {}): Thread => {
  const origin: ThreadOrigin = { by: "agent", client: "covey-ctl", ...(parent ? { parentThreadId: parent } : {}) };
  return thread(id, at, { origin, ...over });
};

/**
 * A run of this machine's project, with one member per state given. `parent`
 * is the thread that asked for it, which is what puts the run inside that
 * thread's group rather than under the project.
 */
function run(id: string, states: RunMemberState[], parent?: string): Run {
  const members: RunMember[] = states.map((state, i) => ({
    id: `${id}-m${i}`, task: { key: `#${i}`, title: `task ${i}`, issue: null, url: null, requires: [] },
    machineId: info.machineId, projectId: project.id, threadId: null, branch: null, worktreePath: null,
    pullRequest: null, state, note: null, brief: null, dispatchedAt: null,
    updatedAt: "2026-01-01T00:00:00Z", review: null,
  } as unknown as RunMember));
  return {
    id, machineId: info.machineId, name: id, goal: "", briefTemplate: "", workspaceMode: "worktree-default",
    members, closedAt: null, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    ...(parent ? { parentThreadId: parent } : {}),
  };
}

function storeWith(threads: Thread[], runs: Run[] = []) {
  const store = new Store([]);
  const m: MachineState = {
    key: PI, saved: { name: "pi", url: PI }, conn: "connected", error: null, info,
    projects: new Map([[project.id, project]]), threads: new Map(threads.map((t) => [t.id, t])),
    runs: new Map(runs.map((r) => [r.id, r])), update: null, restarting: false,
  } as unknown as MachineState;
  store.state.machines.set(PI, m);
  store.state.order.push(PI);
  // Every case here starts with the project open. `expanded` is loaded from
  // the config, which every Store in this file shares, so a case that furled a
  // project would otherwise furl the next case's tree as well.
  store.state.expanded[`${PI}:${project.id}`] = true;
  return store;
}

/** The thread rows the sidebar paints, in order, as `id@depth`. */
const painted = (s: AppState) =>
  sidebarRows(s).filter((r) => r.kind === "thread").map((r) => `${r.thread!.id}@${r.depth}`);

/**
 * A manager thread with three agents under it, and a thread the user opened.
 * The manager spoke most recently, so without nesting the four rows would
 * interleave with `mine` by time — which is exactly the flat list of
 * 2026-09-16.
 */
const tree = (over: Partial<Thread>[] = []) => [
  thread("manager", "2026-01-09T00:00:00Z"),
  started("agent-a", "2026-01-08T00:00:00Z", "manager", over[0]),
  thread("mine", "2026-01-07T00:00:00Z"),
  started("agent-b", "2026-01-06T00:00:00Z", "manager", over[1]),
  started("agent-c", "2026-01-05T00:00:00Z", "manager", over[2]),
];

// ---- the tree ----------------------------------------------------------------

test("a thread a program started paints under the thread that started it, indented", () => {
  const store = storeWith(tree());
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  assert.deepEqual(painted(store.state as AppState), [
    "manager@2", "agent-a@3", "agent-b@3", "agent-c@3", "mine@2",
  ], "the children sit under their parent at a deeper level, not beside it as peers");
});

test("fifteen dispatched threads become one row: a group is furled until it is opened", () => {
  const store = storeWith([
    thread("manager", "2026-01-09T00:00:00Z"),
    ...Array.from({ length: 15 }, (_, i) => started(`agent-${i}`, `2026-01-0${(i % 8) + 1}T00:00:00Z`, "manager")),
  ]);
  const rows = sidebarRows(store.state as AppState);
  const threads = rows.filter((r) => r.kind === "thread");
  assert.deepEqual(threads.map((r) => r.thread!.id), ["manager"], "fifteen rows the user never needed to read");
  assert.equal(threads[0]!.group, true);
  assert.equal(threads[0]!.hidden, 15, "the row says what it is holding, so there is a way in");
});

test("a parent the sidebar cannot find leaves its child a row of its own", () => {
  // The parent is archived, so it is not in the live list at all. A thread must
  // never be lost behind a link that leads nowhere.
  const store = storeWith([
    thread("gone", "2026-01-09T00:00:00Z", { archivedAt: "2026-02-01T00:00:00Z" }),
    started("orphan", "2026-01-08T00:00:00Z", "gone"),
    started("stranger", "2026-01-07T00:00:00Z", "not-a-thread-on-this-machine"),
  ]);
  assert.deepEqual(painted(store.state as AppState), ["orphan@2", "stranger@2"]);
});

test("two threads naming each other as parent still each get exactly one row", () => {
  // Neither has a parent outside the pair, so neither is a root by the ordinary
  // rule. One of them has to become one or both threads vanish.
  const store = storeWith([
    started("a", "2026-01-09T00:00:00Z", "b"),
    started("b", "2026-01-08T00:00:00Z", "a"),
  ]);
  assert.deepEqual(painted(store.state as AppState), ["a@2"], "the first of the pair is a row of its own");
  store.state.expanded[threadGroupKey(PI, "a")] = true;
  store.state.expanded[threadGroupKey(PI, "b")] = true;
  assert.deepEqual(painted(store.state as AppState), ["a@2", "b@3"], "and the walk stops rather than looping");
});

// ---- a run in the tree --------------------------------------------------------

/**
 * Where a run sits, which is the other half of "a child sits under its parent".
 *
 * A run used to be painted under the machine, above every project, wherever its
 * members worked. So a run of five threads in one project stood beside the
 * project those five threads were in, and the thread that asked for the run had
 * nothing under it at all — the reader had to know the two were the same piece
 * of work. A run goes where its work goes: inside the project its members work
 * in, and inside the thread that asked for it when a thread did.
 */
const shape = (s: AppState) => sidebarRows(s).map((r) => `${r.kind}@${r.depth}`);

test("a run sits in the project its members work in, above that project's threads", () => {
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["working", "working"])]);
  assert.deepEqual(shape(store.state as AppState), [
    "machine@0", "project@1", "run@2", "member@3", "member@3", "thread@2",
  ], "the run is a child of the project, and its members are a level below it again");
});

test("a run a thread asked for sits inside that thread's group", () => {
  const store = storeWith(tree(), [run("build", ["working"], "manager")]);
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  assert.deepEqual(shape(store.state as AppState), [
    "machine@0", "project@1",
    "thread@2", "run@3", "member@4", "thread@3", "thread@3", "thread@3",
    "thread@2",
  ], "the run comes first inside the group, then the threads the manager started");
});

test("a run whose parent thread has no row of its own falls back to the project", () => {
  // The thread that asked for the run is archived, so the sidebar cannot paint
  // it. A run is never hidden behind a link that leads nowhere, exactly as a
  // thread is not.
  const store = storeWith(
    [thread("gone", "2026-01-09T00:00:00Z", { archivedAt: "2026-02-01T00:00:00Z" })],
    [run("build", ["working"], "gone")],
  );
  assert.deepEqual(shape(store.state as AppState).slice(0, 3), ["machine@0", "project@1", "run@2"]);
});

test("a furled thread holds its run as it holds its children, and counts it", () => {
  const store = storeWith(tree(), [run("build", ["working"], "manager")]);
  const rows = sidebarRows(store.state as AppState);
  assert.deepEqual(rows.filter((r) => r.kind === "run"), [], "the run is inside the fold");
  const manager = rows.find((r) => r.kind === "thread" && r.thread!.id === "manager")!;
  assert.equal(manager.group, true);
  assert.equal(manager.hidden, 4, "three threads and the run — the row says what it is holding");
});

/**
 * The deadlock rule of #69, one fold deeper. A run furled inside a thread group
 * is two folds away from the operator, and a member blocked on an approval
 * stops the whole run until somebody answers it.
 */
test("a furled thread never hides a run whose member needs a person", () => {
  const store = storeWith(tree(), [run("build", ["working", "blocked"], "manager")]);
  const rows = sidebarRows(store.state as AppState);
  assert.deepEqual(rows.filter((r) => r.kind === "run").map((r) => r.run!.id), ["build"], "the run is let through");
  assert.deepEqual(rows.filter((r) => r.kind === "member").map((r) => r.member!.state), ["working", "blocked"],
    "open, as a run is until the operator furls it, so both members are on screen");

  // Furled as well, and the two folds still let the one member through.
  store.state.expanded[runKey(PI, "build")] = false;
  const furled = sidebarRows(store.state as AppState);
  assert.deepEqual(furled.filter((r) => r.kind === "member").map((r) => r.member!.state), ["blocked"]);
});

test("a run this client cannot place in one project keeps its old row under the machine", () => {
  // A member dispatched to another machine: a project id only means anything
  // on the machine that holds the project, so there is no honest place for the
  // run inside this tree. One level too high is a run the operator can still
  // find; a run filed under a project it does not work in is a lie.
  const away = run("build", ["working"]);
  away.members[0]!.machineId = "m-elsewhere";
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [away]);
  assert.deepEqual(shape(store.state as AppState), ["machine@0", "run@1", "member@2", "project@1", "thread@2"]);

  // The contrast, in the same case, because the shape above is also the shape
  // this file had before runs moved at all: bring the member home and the run
  // has to move into the project.
  away.members[0]!.machineId = info.machineId;
  store.state.machines.get(PI)!.runs.set(away.id, { ...away });
  assert.deepEqual(shape(store.state as AppState), ["machine@0", "project@1", "run@2", "member@3", "thread@2"]);
});

/**
 * The deadlock rule, as far out as the tree goes.
 *
 * A group hides its children whole, so a thread that is quietly working takes
 * everything under it into the fold — including a run with a member blocked on
 * an approval. Two folds deep, the run is not furled, it is *absent*: no row,
 * and no count on any row to say it is there. `wantsPerson` is what walks the
 * subtree, so a thread holding something that needs a person comes through its
 * own parent's fold and the path below it comes with it.
 */
test("a blocked run three levels down still reaches the screen", () => {
  const store = storeWith([
    thread("root", "2026-01-09T00:00:00Z"),
    started("mid", "2026-01-08T00:00:00Z", "root"),
  ], [run("build", ["working", "blocked"], "mid")]);

  // Both groups furled, which is how they start.
  const rows = sidebarRows(store.state as AppState);
  assert.deepEqual(rows.map((r) => `${r.kind}@${r.depth}`), [
    "machine@0", "project@1", "thread@2", "thread@3", "run@4", "member@5", "member@5",
  ], "the quiet thread is painted because of what it is holding, and the run with it");
  assert.equal(rows.find((r) => r.thread?.id === "root")!.hidden, 0, "nothing is held back");

  // Nothing needs a person, and the same tree is one row again.
  const quiet = storeWith([
    thread("root", "2026-01-09T00:00:00Z"),
    started("mid", "2026-01-08T00:00:00Z", "root"),
  ], [run("build", ["working", "working"], "mid")]);
  assert.deepEqual(shape(quiet.state as AppState), ["machine@0", "project@1", "thread@2"]);
  assert.equal(sidebarRows(quiet.state as AppState)[2]!.hidden, 1);
});

test("a run in planning sits with the thread that asked for it, not under the machine", () => {
  // Most of a run's life is before dispatch: named, planned, looked at. It has
  // no member to read a project off until then, and a run that spends that
  // time under the machine and then jumps into a furled group is a run that
  // leaves the screen at the moment work starts.
  const planned = run("build", [], "manager");
  const store = storeWith([thread("manager", "2026-01-09T00:00:00Z")], [planned]);
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  assert.deepEqual(shape(store.state as AppState), ["machine@0", "project@1", "thread@2", "run@3"]);
});

/**
 * The sidebar of 2026-09-18, the whole tree, in one case.
 *
 * The operator's screenshot: a thread they opened by hand ("Create issues for
 * zoom-scaled outline…") had started five run members and six review threads,
 * and the sidebar painted the run beside the project its members worked in,
 * the review threads beside the thread that asked for them, and nothing under
 * the thread at all. Three rows of one piece of work, on three levels, none of
 * them pointing at the others.
 *
 * Every id an agent's thread needs to nest was already on the wire; nothing
 * filled it in, because no agent knew which thread it was — see
 * `packages/daemon/src/threadOrigin.test.ts` for the other half.
 */
test("the tree of 2026-09-18: one project, one thread, and everything it started under it", () => {
  const store = storeWith([
    thread("create-issues", "2026-01-09T00:00:00Z"),
    started("review-278", "2026-01-08T00:00:00Z", "create-issues"),
    started("review-277", "2026-01-07T00:00:00Z", "create-issues"),
    thread("mine", "2026-01-06T00:00:00Z"),
  ], [run("pre-release", ["working", "working"], "create-issues")]);

  // Furled, which is how a group starts: one row for the eleven.
  assert.deepEqual(shape(store.state as AppState), ["machine@0", "project@1", "thread@2", "thread@2"]);
  const head = sidebarRows(store.state as AppState).find((r) => r.thread?.id === "create-issues")!;
  assert.equal(head.hidden, 3, "two review threads and the run");

  store.state.expanded[threadGroupKey(PI, "create-issues")] = true;
  const rows = sidebarRows(store.state as AppState);
  assert.deepEqual(rows.map((r) => `${r.kind}@${r.depth}`), [
    "machine@0", "project@1",
    "thread@2", "run@3", "member@4", "member@4", "thread@3", "thread@3",
    "thread@2",
  ]);
  const run278 = rows.find((r) => r.thread?.id === "review-278")!;
  const preRelease = rows.find((r) => r.kind === "run")!;
  assert.equal(run278.depth, preRelease.depth, "the review threads and the run are siblings under the thread");
  assert.ok(rows.indexOf(preRelease) < rows.indexOf(run278), "and the run comes first");
  assert.deepEqual(rows.filter((r) => r.depth === 2 && r.kind === "thread").map((r) => r.thread!.id),
    ["create-issues", "mine"], "nothing an agent started is a row of the project any more");
});

// ---- the attention rule (#49) -------------------------------------------------

test("a furled group hides the agents that are working and never one that needs a person", () => {
  const store = storeWith(tree([{ status: "error", lastError: "build failed" }, { status: "waiting" }, {}]));
  const rows = sidebarRows(store.state as AppState).filter((r) => r.kind === "thread");
  assert.deepEqual(rows.map((r) => r.thread!.id), ["manager", "agent-a", "agent-b", "mine"],
    "the failed agent and the blocked agent are painted; only the working one is quiet");
  assert.equal(rows[0]!.hidden, 1, "one of the three is held back");
  // agent-c, the one that is quietly working, is the only one missing.
  assert.ok(!rows.some((r) => r.thread!.id === "agent-c"));
});

test("an approval counts as blocked even while the turn is still running", () => {
  assert.equal(needsPerson(thread("x", "2026-01-01T00:00:00Z", { status: "running", pendingApprovals: 1 })), true);
  assert.equal(needsPerson(thread("x", "2026-01-01T00:00:00Z", { status: "error" })), true);
  assert.equal(needsPerson(thread("x", "2026-01-01T00:00:00Z", { status: "waiting" })), true);
  assert.equal(needsPerson(thread("x", "2026-01-01T00:00:00Z", { status: "running" })), false);
  assert.equal(needsPerson(thread("x", "2026-01-01T00:00:00Z", { status: "idle" })), false);
});

// ---- the mark (#49) -----------------------------------------------------------

test("the row of a thread a program started is marked, and a user's thread is untouched", () => {
  const store = storeWith(tree());
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  const rows = sidebarRows(store.state as AppState).filter((r) => r.kind === "thread");
  const mark = new Map(rows.map((r) => [r.thread!.id, r.agent ?? false]));
  assert.deepEqual([...mark], [["manager", false], ["agent-a", true], ["agent-b", true], ["agent-c", true], ["mine", false]]);
});

test("the mark is painted on the screen, on the agent's line and on no other", async () => {
  // A glyph the terminal was really sent, not a flag on a row. Colour alone
  // would satisfy the case above and fail every reader this rule is for.
  const store = storeWith(tree());
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  const { frame, unmount } = await paint(store);
  try {
    const lineOf = (text: string) => frame().find((l) => l.slice(0, 33).includes(text)) ?? "";
    assert.ok(lineOf("agent-a").includes(AGENT_MARK), `the agent's row carries no mark: "${lineOf("agent-a")}"`);
    assert.ok(!lineOf("mine").includes(AGENT_MARK), `the user's own row was marked: "${lineOf("mine")}"`);
    assert.ok(!lineOf("manager").includes(AGENT_MARK), "and so was the thread they opened by hand");
  } finally { unmount(); }
});

/**
 * The indent is the sidebar's one way of saying "under", and nothing else may
 * spend it. The mark used to sit between the status dot and the title, which
 * pushed an agent's title two columns right: a thread that is nobody's child
 * read as somebody's child, sorted into the project by recency with no parent
 * above it and no caret to furl it with. The mark now shares the caret's cell,
 * so every thread title in the tree starts in the same column.
 */
test("the mark does not indent the row it is on", async () => {
  const store = storeWith([
    thread("mine", "2026-01-09T00:00:00Z"),
    started("loner", "2026-01-08T00:00:00Z", null),
  ]);
  const { frame, unmount } = await paint(store);
  try {
    const lines = frame();
    const columnOf = (id: string) => (lines.find((l) => l.slice(0, 33).includes(id)) ?? "").slice(0, 33).indexOf(id);
    assert.ok(columnOf("mine") > 0, "both rows were painted");
    assert.equal(columnOf("loner"), columnOf("mine"), "the agent's title starts where every other title starts");
  } finally { unmount(); }
});

// ---- furl state survives a restart (#69) --------------------------------------

test("a group the user furled is still furled after a restart", () => {
  const key = threadGroupKey(PI, "manager");
  const first = storeWith(tree());
  first.toggleExpanded(key, false);
  assert.equal(first.isExpanded(key, false), true, "it opened");
  first.toggleExpanded(key, false);
  assert.equal(first.isExpanded(key, false), false, "and furled again");

  // A second Store on the same COVEY_CONFIG is what a restart of the client is.
  const again = storeWith(tree());
  assert.equal(again.isExpanded(key, false), false);
  assert.equal(again.getState().expanded[key], false, "the furl was written to the config, not only to memory");
  assert.deepEqual(painted(again.state as AppState), ["manager@2", "mine@2"], "and it is still furled on screen");
});

// ---- App: the real frame, the real click, the real keys -----------------------

/**
 * Mount App over a store and hand back the frame the terminal was sent.
 *
 * This reads the *terminal output* — the thing a person clicks — and clicks the
 * line a row was really drawn on. A thread row that grew a second line, which
 * is what a new row type or a count on its own line invites, would move every
 * row below it and fail here. That is why `CLAUDE.md` says to change the
 * renderer and the hit test together or not at all.
 */
async function paint(store: Store) {
  const stdin: any = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  const chunks: string[] = [];
  const stdout: any = new PassThrough();
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 30;
  stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
  // `interactive` on purpose: Ink writes only the final frame when it thinks it
  // is in CI, and this reads the frames. Without it the case passes on a laptop
  // and fails on the runner, which is worse than no case at all.
  const app = render(React.createElement(App, { store }), {
    stdin, stdout, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  await settle();
  /**
   * The last frame the terminal was sent, line by line, without escapes.
   *
   * Ink writes one frame per chunk, so the newest chunk that holds the
   * sidebar's own header is the screen as it stands now. Joining every chunk
   * would search every frame ever painted, and after a group unfurls that
   * finds a row on the line it used to be on — which is the mistake this whole
   * file exists to catch.
   */
  const frame = () => (chunks.filter((c) => c.includes("covey")).at(-1) ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  /** The 1-based terminal row a piece of text was drawn on, in the sidebar. */
  const rowOf = (text: string) => {
    const lines = frame();
    const at = lines.findIndex((l) => l.slice(0, 33).includes(text));
    assert.ok(at >= 0, `"${text}" was never painted — the frame was:\n${lines.join("\n")}`);
    return at + 1;
  };
  /** One SGR press and release, in the sidebar's columns. */
  const click = async (row: number) => {
    stdin.write(`\x1b[<0;12;${row}M`);
    await settle(40);
    stdin.write(`\x1b[<0;12;${row}m`);
    await settle(150);
  };
  // Longer than it looks it needs to be: moving the cursor onto a thread opens
  // it through a 120ms debounce (`PREVIEW_MS`), and a case that reads what the
  // cursor landed on reads it from that. 150ms left 30ms for React, Ink and a
  // write to the stream, which is enough on a laptop and not on a Pi.
  const key = async (seq: string) => { stdin.write(seq); await settle(260); };
  return { rowOf, frame, click, key, settle, unmount: () => app.unmount() };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** A click on a thread opens it and moves focus to the composer, the way it
 *  always has. Tab is how the keyboard gets back to the sidebar. */
const TAB = "\t";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

test("→ unfurls and ← furls, and a click on the parent opens it without furling anything", async () => {
  const store = storeWith(tree());
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };
  const gk = threadGroupKey(PI, "manager");

  const { rowOf, click, key, unmount } = await paint(store);
  try {
    // Rows: pi, covey, manager, mine. The group is furled, so no agent shows.
    assert.equal(store.isExpanded(gk, false), false);

    // Down twice puts the cursor on the manager, then → unfurls.
    await key(DOWN); await key(DOWN);
    await key(RIGHT);
    assert.equal(store.isExpanded(gk, false), true, "→ on the manager unfurled its group");
    assert.ok(rowOf("agent-a") > rowOf("manager"), "and the children are now painted under it");

    // ← furls it again.
    await key(LEFT);
    assert.equal(store.isExpanded(gk, false), false, "← on the manager furled it");

    // Now the point of the issue. Open the group, then click the manager's own
    // row. It opens the conversation and leaves the group exactly as it was —
    // otherwise the one row that most wants clicking could not be clicked.
    await key(RIGHT);
    assert.equal(store.isExpanded(gk, false), true);
    const before = opened.length;
    await click(rowOf("manager"));
    assert.equal(opened.at(-1), "manager", "the click opened the manager's conversation");
    assert.ok(opened.length > before);
    assert.equal(store.isExpanded(gk, false), true, "and the group is still open — a click must never furl");
    assert.ok(rowOf("agent-a") > rowOf("manager"), "the children are still on the screen after the click");

    // The same click on a furled group must not unfurl it either. Opening the
    // thread moved the focus to the composer, so tab brings the keyboard back.
    await key(TAB);
    await key(LEFT);
    assert.equal(store.isExpanded(gk, false), false);
    await click(rowOf("manager"));
    assert.equal(opened.at(-1), "manager");
    assert.equal(store.isExpanded(gk, false), false, "a click on a furled group leaves it furled");
  } finally { unmount(); }
});

test("← on a child moves to its parent, so ←← is the way out of a group", async () => {
  const store = storeWith(tree());
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };

  const { key, unmount } = await paint(store);
  try {
    // pi, covey, manager, agent-a, agent-b, agent-c, mine — four downs is agent-b.
    for (let i = 0; i < 4; i++) await key(DOWN);
    assert.equal(opened.at(-1), "agent-b", "the cursor is on a child");

    // One ← moves to the parent. It does not furl: the child had no group.
    await key(LEFT);
    assert.equal(opened.at(-1), "manager", "← on a child put the cursor on the thread that started it");
    assert.equal(store.isExpanded(threadGroupKey(PI, "manager"), false), true, "and furled nothing on the way");

    // The second ← furls the group the cursor was just inside.
    await key(LEFT);
    assert.equal(store.isExpanded(threadGroupKey(PI, "manager"), false), false);
  } finally { unmount(); }
});

test("a click below a furled group opens the row that is painted there", async () => {
  // `mine` sits below the manager. Furled, it is the fourth row; unfurled, the
  // seventh. A hit test that counted rows instead of painted lines would open
  // an agent's thread here — the regression this file pair invites.
  const store = storeWith(tree());
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };

  const { rowOf, click, key, unmount } = await paint(store);
  try {
    await click(rowOf("mine"));
    assert.equal(opened.at(-1), "mine", "furled: the click landed on the user's own thread");

    // Unfurl the group, which pushes `mine` three lines down, and click it
    // again. The click put the focus in the composer, so tab takes the keyboard
    // back to the sidebar, and the cursor is on `mine` — one up is the manager.
    await key(TAB);
    await key(UP);
    await key(RIGHT);
    assert.equal(store.isExpanded(threadGroupKey(PI, "manager"), false), true);
    await click(rowOf("mine"));
    assert.equal(opened.at(-1), "mine", "unfurled: the click still landed on the user's own thread");

    // And the line the middle child was painted on opens that child.
    await click(rowOf("agent-b"));
    assert.equal(opened.at(-1), "agent-b");
  } finally { unmount(); }
});

/**
 * The indent is the sidebar's one way of saying "under", and a run has to spell
 * it the same way a thread does or the tree reads as two lists.
 *
 * Every kind of row spends a different number of columns before its title — a
 * thread keeps a two-column gutter for its caret or its `◇`, a run and a
 * project spend two on a caret and a space — so the three indents are worked
 * out against each other (`threadIndent`, `runIndent`, `memberIndent`) and this
 * reads the columns the terminal was really sent.
 */
test("a run's title starts in the same column as the title of a thread beside it", async () => {
  const store = storeWith(tree(), [run("build", ["working"])]);
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  const { frame, unmount } = await paint(store);
  try {
    const lines = frame();
    const columnOf = (text: string) => {
      const line = lines.find((l) => l.slice(0, 33).includes(text));
      assert.ok(line, `"${text}" was never painted — the frame was:\n${lines.join("\n")}`);
      return line!.slice(0, 33).indexOf(text);
    };
    assert.equal(columnOf("build"), columnOf("manager"), "the run sits at the level of the project's own threads");
    assert.equal(columnOf("#0 task 0"), columnOf("agent-a"), "and its members at the level of a thread's children");
  } finally { unmount(); }
});

/**
 * A row that asks for more columns than it has does not overflow and does not
 * wrap: Ink gives the extra back by shrinking one of the cells, and nothing
 * says which. A member row asked for four too many and paid with its state
 * mark, so the one glyph that tells a blocked member from a working one at a
 * glance was never painted at any width.
 */
test("a run member row paints its state mark, not only the word", async () => {
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["blocked"])]);
  const { frame, unmount } = await paint(store);
  try {
    const line = frame().find((l) => l.slice(0, 33).includes("#0 task 0")) ?? "";
    assert.ok(line.includes("◼"), `the blocked member lost its mark: "${line.slice(0, 33)}"`);
    assert.ok(line.includes("blocked"), "and it still says so in words");
  } finally { unmount(); }
});

/**
 * The same row, with the cell that is nobody's to bound.
 *
 * A member dispatched elsewhere says so — `blocked · <machine>` — and a machine
 * is named by whoever set it up. The title has a floor under it, so a long
 * enough name puts the two past the width however the sum is written, and Ink
 * pays for an overfull row by shrinking a cell: the state mark went first, and
 * what was left bled into the row below. The title keeps its floor; the state
 * takes the room left and no more.
 */
test("a member on a machine with a very long name keeps its mark, and stays inside the pane", async () => {
  const far: MachineInfo = { ...info, machineId: "m-far", name: "a-machine-with-a-really-long-name" };
  const blocked = run("build", ["blocked"]);
  blocked.members[0]!.machineId = "m-far";
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("home", ["blocked"]), blocked]);
  // A second machine, so the row has a name to print beside the state.
  store.state.machines.set("ws://far:3790", {
    key: "ws://far:3790", saved: { name: far.name, url: "ws://far:3790" }, conn: "connected", error: null,
    info: far, projects: new Map(), threads: new Map(), runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState);

  const { frame, unmount } = await paint(store);
  try {
    const lines = frame();
    const line = lines.find((l) => l.slice(0, 33).includes("a-machin")) ?? "";
    assert.ok(line.includes("◼"), `the mark went to pay for the machine name: "${line.slice(0, 40)}"`);
    // Nothing may cross into the pane beside it: the sidebar's own border is
    // the column every line ends at.
    for (const l of lines) {
      const bar = l.indexOf("│");
      if (bar >= 0) assert.ok(bar === 33 || bar === 0, `a row overflowed its pane: "${l.slice(0, 40)}"`);
    }
  } finally { unmount(); }
});

/**
 * A run folds away with its project now that it lives inside one, and a fold
 * may never hide the fact that something in it is waiting on a person. A
 * member the operator or the tracker called `blocked` has no thread status for
 * the project row to read, so the row reads its runs as well.
 */
test("a furled project says that a run inside it is waiting on somebody", async () => {
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["blocked"])]);
  store.state.expanded[`${PI}:${project.id}`] = false;
  const { frame, unmount } = await paint(store);
  try {
    // The project's own row, not the pane's header, which is also "covey".
    const line = frame().find((l) => l.slice(0, 33).indexOf("covey") === 4) ?? "";
    assert.ok(line.length > 0, "the project row was painted");
    assert.ok(line.includes("●"), `the fold swallowed the blocked member without a word: "${line.slice(0, 33)}"`);
  } finally { unmount(); }
});

test("a furled project says that a run inside it is working, as it does for a thread", () => {
  // The dot and the count are the whole of what a furled project tells the
  // reader. A run whose member is working, or dispatched to a machine this
  // client has not heard from, has no thread here for the row to read.
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["working"])]);
  const m = store.state.machines.get(PI)!;
  assert.equal(projectRuns(m, project.id).some(runIsBusy), true);
  assert.equal(runIsBusy(run("build", ["planned", "merged"])), false, "a run nobody has started is not work in flight");
});

test("a project counts the tasks of its runs that are not threads yet", () => {
  // One thread and a run of five, none dispatched: the row read "1" and a
  // furled project hid the other five behind it.
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["planned", "planned", "planned"])]);
  const m = store.state.machines.get(PI)!;
  assert.equal(pendingTasks(m, project.id), 3);

  // A task that became a thread is already counted as that thread, and a task
  // that is over is not work at all.
  const mixed = run("mixed", ["planned", "merged", "withdrawn", "working"]);
  mixed.members[3]!.threadId = "mine";
  store.state.machines.get(PI)!.runs.set(mixed.id, mixed);
  assert.equal(pendingTasks(m, project.id), 4, "three planned in the first run, one in the second");
});

/**
 * `←` walks one step out, and a run row is a step of its own.
 *
 * `sidebarRows` sets `run` on a member row as well as on the run's own row, so
 * a branch that asks "does this row have a run?" answers yes for both — and a
 * member of a furled run was walked straight past the run row painted directly
 * above it, out to the thread. One ← is one level.
 *
 * The cursor is App's own state, so each case is read from what the next key
 * does: the second ← lands on the manager without furling it, and only the
 * third — the one pressed *on* the manager — folds its group away.
 */
test("← from a member reaches its run first, and the thread only after it", async () => {
  const store = storeWith(tree(), [run("build", ["blocked"], "manager")]);
  const gk = threadGroupKey(PI, "manager");
  store.state.expanded[gk] = true;
  store.state.expanded[runKey(PI, "build")] = false;   // the member shows because it is blocked
  const { key, unmount } = await paint(store);
  try {
    // pi, covey, manager, build, the blocked member — four downs.
    for (let i = 0; i < 4; i++) await key(DOWN);

    await key(LEFT);   // onto the run, which is already furled
    await key(LEFT);   // onto the manager
    assert.equal(store.isExpanded(gk, false), true,
      "two ← furled the manager's group, so the first one skipped the run row and left one key too many");

    await key(LEFT);   // and now on the manager, which furls
    assert.equal(store.isExpanded(gk, false), false, "the walk did reach the manager");
  } finally { unmount(); }
});

test("← on a run never jumps the cursor into another part of the tree", async () => {
  // The run names a parent that is archived, so it sits under its project. The
  // thread it names still has a row — inside the open Archived folder — and a
  // search over every row on the machine would move the cursor into it, where
  // the next ← folds the archive away.
  const store = storeWith([
    thread("gone", "2026-01-09T00:00:00Z", { archivedAt: "2026-02-01T00:00:00Z" }),
    thread("mine", "2026-01-08T00:00:00Z"),
  ], [run("build", ["working"], "gone")]);
  const ak = archiveKey(PI, project.id);
  store.state.expanded[ak] = true;
  const { key, unmount } = await paint(store);
  try {
    await key(DOWN); await key(DOWN);   // pi, covey, then the run
    await key(LEFT);                    // furls the run
    await key(LEFT);                    // nowhere to go from here
    await key(LEFT);
    assert.equal(store.isExpanded(ak, false), true,
      "the cursor walked into the Archived folder and the next ← folded it away");
    assert.equal(store.isExpanded(runKey(PI, "build")), false, "and the run is where it was left");
  } finally { unmount(); }
});

test("a furled project paints the dot and the count for what its runs hold", async () => {
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [run("build", ["working", "planned", "planned"])]);
  store.state.expanded[`${PI}:${project.id}`] = false;
  const { frame, unmount } = await paint(store);
  try {
    const line = frame().find((l) => l.slice(0, 33).indexOf("covey") === 4) ?? "";
    assert.ok(line.includes("●"), `the fold said nothing about the run working inside it: "${line.slice(0, 33)}"`);
    assert.ok(/covey 4\b/.test(line), `one thread and three tasks that are not threads yet: "${line.slice(0, 33)}"`);
  } finally { unmount(); }
});

/**
 * The run row's own width sum, which nothing held.
 *
 * Every cell the row spends is counted in one place — the caret, its space,
 * the two before the meta, and the padding on the right — and the only way to
 * see the sum is wrong is to paint a name long enough to reach the edge. A sum
 * that asks for too little truncates every long run name early and wastes the
 * columns; one that asks for too much makes Ink shrink a cell, which is what
 * cost the member row its state mark.
 */
test("a run row with a long name fills its pane exactly", async () => {
  const long = run("a run name long enough to reach the edge of the pane and go on", ["working"]);
  const store = storeWith([thread("mine", "2026-01-09T00:00:00Z")], [long]);
  const { frame, unmount } = await paint(store);
  try {
    const line = frame().find((l) => l.slice(0, 33).includes("a run name lo")) ?? "";
    assert.ok(line.length > 0, "the run row was painted");
    const last = line.slice(0, 33).replace(/\s+$/, "").length - 1;
    assert.equal(last, 31, `the run row ends at column ${last}, so its width sum is out by ${31 - last}`);
    assert.ok(line.includes("…"), "the name is cut, not the meta");
    assert.ok(line.includes("1 of 1 left"), "and the meta is whole");
  } finally { unmount(); }
});

test("a marked row is still one line, so the hit test and the renderer agree", async () => {
  // The oldest rake in this repository: `sidebarCells` gives every row exactly
  // one line, and hands the same list to the renderer and to the hit test. A
  // row painted any other height — a group head given a second line for its
  // count, say — moves every row below it and the click lands on the wrong
  // thread, with nothing on screen to say so.
  //
  // A long title is here because it is the shape most likely to make a row
  // grow: the mark, the caret and the indent all come out of the width the
  // title is measured against.
  const long = "a title long enough to fill the sidebar twice over and then some more";
  const store = storeWith([
    thread("manager", "2026-01-09T00:00:00Z", { title: long }),
    started("agent-a", "2026-01-08T00:00:00Z", "manager", { title: long }),
    thread("mine", "2026-01-07T00:00:00Z", { title: "mine" }),
  ]);
  store.state.expanded[threadGroupKey(PI, "manager")] = true;
  const opened: string[] = [];
  (store as any).select = async (sel: { threadId: string }) => { opened.push(sel.threadId); };

  const rows = sidebarRows(store.state as AppState);
  const cells = sidebarCells(rows, 0, 28);
  const { rowOf, click, unmount } = await paint(store);
  try {
    // What the hit test believes, against what the terminal was actually sent.
    // `SIDEBAR_TOP` in App is 2, the row the first cell is painted on.
    const line = rowOf("mine");
    const idx = rowAtScreenRow(cells, line, 2);
    assert.equal(rows[idx!]?.thread?.id, "mine",
      "the hit test and the painted frame disagree about which row sits on that line");
    await click(line);
    assert.equal(opened.at(-1), "mine");
  } finally { unmount(); }
});
