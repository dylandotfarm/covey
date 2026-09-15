import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, Thread } from "@covey/protocol";
import { sidebarRows, archiveKey, tallyThreads, byRecency, type AppState, type MachineState, type SidebarRow } from "./store.js";
import { sidebarCells, rowAtScreenRow } from "./sidebar.js";

const project = (id: string, title = id): Project => ({
  id, title, workspaceRoot: `/repos/${id}`, repositoryIdentity: null, defaultModel: null,
  defaultWorkspaceMode: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

const thread = (id: string, projectId: string, over: Partial<Thread> = {}): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: "2026-01-01T00:00:00Z", archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

function appState(projects: Project[], threads: Thread[], expanded: Record<string, boolean> = {}): AppState {
  const m = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null, info: null,
    projects: new Map(projects.map((p) => [p.id, p])), threads: new Map(threads.map((t) => [t.id, t])),
    update: null, restarting: false,
  } as unknown as MachineState;
  return { machines: new Map([["pi", m]]), order: ["pi"], expanded } as unknown as AppState;
}

test("archived threads leave their project's list for a furled folder inside it", () => {
  const s = appState(
    [project("a"), project("b")],
    [
      thread("live-a", "a"),
      thread("old-a", "a", { archivedAt: "2026-02-01T00:00:00Z" }),
      thread("old-b", "b", { archivedAt: "2026-03-01T00:00:00Z" }),
    ],
  );
  const rows = sidebarRows(s);
  assert.deepEqual(rows.map((r) => r.kind), ["machine", "project", "thread", "archived", "project", "archived"]);
  // a's folder sits below a's live threads and holds only a's archive
  assert.equal(rows[2]!.thread!.id, "live-a");
  assert.equal(rows[3]!.projectId, "a");
  assert.equal(rows[3]!.count, 1);
  assert.ok(rows[3]!.archived);
  assert.equal(rows[5]!.projectId, "b");
  assert.equal(rows[5]!.count, 1);
});

test("folding a project takes its archived folder with it", () => {
  const s = appState(
    [project("a")],
    [thread("live-a", "a"), thread("old-a", "a", { archivedAt: "2026-02-01T00:00:00Z" })],
    { "pi:a": false },
  );
  assert.deepEqual(sidebarRows(s).map((r) => r.kind), ["machine", "project"]);
});

test("unfurling the folder lists that project's archived threads, newest archive first", () => {
  const s = appState(
    [project("a"), project("b")],
    [
      thread("old-a1", "a", { archivedAt: "2026-02-01T00:00:00Z" }),
      thread("old-a2", "a", { archivedAt: "2026-03-01T00:00:00Z" }),
      thread("old-b", "b", { archivedAt: "2026-04-01T00:00:00Z" }),
    ],
    { [archiveKey("pi", "a")]: true },
  );
  const rows = sidebarRows(s).filter((r) => r.kind === "thread");
  // b's folder stays furled, so only a's archive is listed
  assert.deepEqual(rows.map((r) => r.thread!.id), ["old-a2", "old-a1"]);
  // they keep their project, so `n` still makes a thread in the right place
  assert.deepEqual(rows.map((r) => r.projectId), ["a", "a"]);
  assert.ok(rows.every((r) => r.archived));
});

test("no archived threads means no folder row", () => {
  const rows = sidebarRows(appState([project("a")], [thread("live", "a")]));
  assert.ok(!rows.some((r) => r.kind === "archived"));
});

test("moved threads are tombstones, not archive — they stay out of both lists", () => {
  const rows = sidebarRows(appState(
    [project("a")],
    [thread("gone", "a", { archivedAt: "2026-02-01T00:00:00Z", movedTo: { machineId: "mac", threadId: "x" } })],
    { [archiveKey("pi", "a")]: true },
  ));
  assert.deepEqual(rows.map((r) => r.kind), ["machine", "project"]);
});

const row = (kind: SidebarRow["kind"], key: string): SidebarRow => ({ key, kind, machine: "ws://m", depth: 0 });

/** One machine, one project, three threads: the shape the sidebar always has. */
const tree = (): SidebarRow[] => [
  row("machine", "m"),
  row("project", "p"),
  row("thread", "t0"),
  row("thread", "t1"),
  row("thread", "t2"),
];

test("a machine header is preceded by a blank line, so rows and lines differ", () => {
  const cells = sidebarCells(tree(), 0, 20);
  assert.deepEqual(cells, [
    { kind: "blank" },
    { kind: "row", index: 0 },
    { kind: "row", index: 1 },
    { kind: "row", index: 2 },
    { kind: "row", index: 3 },
    { kind: "row", index: 4 },
  ]);
});

test("the whole list is painted when it fits", () => {
  assert.equal(sidebarCells(tree(), 4, 6).length, 6);
  assert.equal(sidebarCells(tree(), 0, 0).length, 0);
});

test("a list taller than the pane scrolls to keep the cursor on screen", () => {
  const rows = [row("machine", "m"), ...Array.from({ length: 40 }, (_, i) => row("thread", `t${i}`))];
  const cells = sidebarCells(rows, 30, 10);
  assert.equal(cells.length, 10);
  assert.ok(cells.some((c) => c.kind === "row" && c.index === 30), "cursor row is visible");
});

test("scrolling stops at the ends rather than running past them", () => {
  const rows = [row("machine", "m"), ...Array.from({ length: 40 }, (_, i) => row("thread", `t${i}`))];
  const top = sidebarCells(rows, 0, 10);
  assert.deepEqual(top[0], { kind: "blank" });
  const bottom = sidebarCells(rows, 40, 10);
  assert.deepEqual(bottom[bottom.length - 1], { kind: "row", index: 40 });
});

test("a click lands on the row that is painted there, not on the nth row", () => {
  // Line 2 is the blank above the machine; the machine itself is on line 3.
  const cells = sidebarCells(tree(), 0, 20);
  assert.equal(rowAtScreenRow(cells, 2, 2), null);
  assert.equal(rowAtScreenRow(cells, 3, 2), 0);
  assert.equal(rowAtScreenRow(cells, 4, 2), 1);
  assert.equal(rowAtScreenRow(cells, 7, 2), 4);
  assert.equal(rowAtScreenRow(cells, 40, 2), null, "below the list");
});

test("tallyThreads counts an approval as waiting even while the turn runs", () => {
  const t = tallyThreads([
    thread("a", "p", { status: "running" }),
    thread("b", "p", { status: "running", pendingApprovals: 1 }),
    thread("c", "p", { status: "waiting" }),
    thread("d", "p", { status: "idle", queuedTurns: 2 }),
  ]);
  assert.deepEqual([t.total, t.running, t.waiting, t.idle, t.queued], [4, 1, 2, 1, 2]);
});

test("tallyThreads sums the latest turns' diffs and ignores unavailable ones", () => {
  const diff = (a: number, d: number, unavailable?: string) => ({
    turnId: "x", state: "completed" as const, startedAt: "", completedAt: null,
    diff: { files: [{ path: "a", additions: a, deletions: d, status: "M" as const }], additions: a, deletions: d, ...(unavailable ? { unavailable } : {}) },
  });
  const t = tallyThreads([
    thread("a", "p", { latestTurn: diff(10, 2) }),
    thread("b", "p", { latestTurn: diff(5, 1) }),
    thread("c", "p", { latestTurn: diff(99, 99, "not a git repository") }),
    thread("d", "p", { latestTurn: null }),
  ]);
  assert.deepEqual([t.additions, t.deletions, t.files], [15, 3, 2]);
});

test("byRecency pins first, then orders by the last message", () => {
  const a = thread("a", "p", { lastMessageAt: "2026-01-02T00:00:00Z" });
  const b = thread("b", "p", { lastMessageAt: "2026-01-03T00:00:00Z" });
  const c = thread("c", "p", { lastMessageAt: "2026-01-01T00:00:00Z", pinnedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual([a, b, c].sort(byRecency).map((t) => t.id), ["c", "b", "a"]);
});
