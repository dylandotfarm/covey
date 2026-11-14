import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, Thread } from "@covey/protocol";
import { sidebarRows, archiveKey, tallyThreads, byRecency, type AppState, type MachineState, type SidebarRow } from "./store.js";
import { sidebarCells, sidebarTop, sidebarWindow, rowAtScreenRow, cursorIndex } from "./sidebar.js";

const project = (id: string, title = id): Project => ({
  id, title, workspaceRoot: `/repos/${id}`, repositoryIdentity: null, defaultModel: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
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
    runs: new Map(), update: null, restarting: false,
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
  assert.deepEqual(rows.map((r) => r.kind), ["project", "thread", "archived", "project", "archived", "machines"]);
  // a's folder sits below a's live threads and holds only a's archive
  assert.equal(rows[1]!.thread!.id, "live-a");
  assert.equal(rows[2]!.projectId, "a");
  assert.equal(rows[2]!.count, 1);
  assert.ok(rows[2]!.archived);
  assert.equal(rows[4]!.projectId, "b");
  assert.equal(rows[4]!.count, 1);
});

test("folding a project takes its archived folder with it", () => {
  const s = appState(
    [project("a")],
    [thread("live-a", "a"), thread("old-a", "a", { archivedAt: "2026-02-01T00:00:00Z" })],
    { "pi:a": false },
  );
  assert.deepEqual(sidebarRows(s).map((r) => r.kind), ["project", "machines"]);
});

test("unfurling the folder lists that project's archived threads, newest archive first", () => {
  const s = appState(
    [project("a"), project("b")],
    [
      thread("old-a1", "a", { archivedAt: "2026-02-01T00:00:00Z" }),
      thread("old-a2", "a", { archivedAt: "2026-03-01T00:00:00Z" }),
      thread("old-b", "b", { archivedAt: "2026-04-01T00:00:00Z" }),
    ],
    { [archiveKey("pi:a")]: true },
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
    { [archiveKey("pi:a")]: true },
  ));
  assert.deepEqual(rows.map((r) => r.kind), ["project", "machines"]);
});

// ---- archived projects (#204) ----------------------------------------------

const archivedProject = (id: string, title = id): Project => ({ ...project(id, title), archivedAt: "2026-05-01T00:00:00Z" });

test("an archived project leaves the list for a furled section at the foot of the tree", () => {
  const s = appState([project("a"), archivedProject("b")], [thread("t-a", "a"), thread("t-b", "b")]);
  const rows = sidebarRows(s);
  assert.deepEqual(rows.map((r) => r.kind), ["project", "thread", "archivedProjects", "machines"]);
  // Furled is the default: the section exists to take rows off the screen.
  const section = rows[2]!;
  assert.equal(section.count, 1);
  assert.equal(section.machine, "", "the section is nobody's machine, as the machines header is");
  // The archived project's threads go with it. A row with no project above it
  // would be work the reader cannot see and cannot fold away either.
  assert.ok(!rows.some((r) => r.thread?.id === "t-b"));
});

test("unfurling the section paints the archived projects, a level in, and marked as archived", () => {
  const s = appState(
    [project("a"), archivedProject("b")],
    [thread("t-a", "a"), thread("t-b", "b")],
    { "projects:archived": true },
  );
  const rows = sidebarRows(s);
  assert.deepEqual(rows.map((r) => r.kind), ["project", "thread", "archivedProjects", "project", "thread", "machines"]);
  assert.equal(rows[3]!.projectId, "b");
  assert.ok(rows[3]!.archived, "the row says it is inside the archive, so ← and x know where they are");
  assert.equal(rows[3]!.depth, rows[0]!.depth + 1, "a level under the section, the way a project sits under a fleet");
  assert.equal(rows[4]!.thread!.id, "t-b", "and its threads come with it");
});

test("a section that holds something working says so while it is furled", () => {
  // Archiving a project stops nothing, so the fold may not hide that a turn
  // is running or that something waits on a person.
  const s = appState([archivedProject("b")], [thread("busy", "b", { status: "running" })]);
  const section = sidebarRows(s).find((r) => r.kind === "archivedProjects")!;
  assert.equal(section.busy, true);
  assert.equal(section.waiting, false);

  const asking = appState([archivedProject("b")], [thread("asking", "b", { pendingApprovals: 1 })]);
  assert.equal(sidebarRows(asking).find((r) => r.kind === "archivedProjects")!.waiting, true);
});

test("no archived project means no section at all", () => {
  assert.ok(!sidebarRows(appState([project("a")], [thread("t", "a")])).some((r) => r.kind === "archivedProjects"));
});

test("a fleet whose every project is archived still says what to press, and says why it is empty", () => {
  // Nothing to work in is nothing to work in: the row that says `a` adds one
  // is painted, and the archived section sits below it.
  const rows = sidebarRows(appState([archivedProject("b")], []));
  assert.deepEqual(rows.map((r) => r.kind), ["empty", "archivedProjects", "machines"]);
  // "nothing here" and "nothing to work in" are different sentences, and the
  // row says which by the count it carries.
  assert.equal(rows[0]!.count, 1);
  assert.equal(sidebarRows(appState([], []))[0]!.count, 0, "a client with no project at all has none archived either");
});

const row = (kind: SidebarRow["kind"], key: string, depth = 1): SidebarRow => ({ key, kind, machine: "ws://m", depth });

/** One project with three threads, then the machines section: the shape the sidebar always has. */
const tree = (): SidebarRow[] => [
  row("project", "p", 0),
  row("thread", "t0"),
  row("thread", "t1"),
  row("thread", "t2"),
  row("machines", "machines", 0),
];

test("a top-level row after the first is preceded by a blank line, so rows and lines differ", () => {
  const cells = sidebarCells(tree());
  assert.deepEqual(cells, [
    { kind: "row", index: 0 },
    { kind: "row", index: 1 },
    { kind: "row", index: 2 },
    { kind: "row", index: 3 },
    { kind: "blank" },
    { kind: "row", index: 4 },
  ]);
});

test("the whole list is painted when it fits", () => {
  assert.equal(sidebarWindow(sidebarCells(tree()), 0, 6).length, 6);
  assert.equal(sidebarWindow(sidebarCells(tree()), 0, 0).length, 0);
});

/** A project, forty threads, and the machines section: taller than any pane. */
const longTree = () => [row("project", "p", 0), ...Array.from({ length: 40 }, (_, i) => row("thread", `t${i}`)), row("machines", "machines", 0)];

test("the window follows the cursor only as far as it must, and never past an end", () => {
  const cells = sidebarCells(longTree());
  // A cursor already on screen moves nothing. This is the whole of what a
  // click costs: the tree used to re-centre under the hand that clicked it.
  assert.equal(sidebarTop(cells, 5, 10, 0, true), 0);
  assert.equal(sidebarTop(cells, 5, 10, 3, true), 3, "the reader's window stands when the cursor is in it");
  // One row past the bottom edge is one line of scroll, not a new centre.
  assert.equal(sidebarTop(cells, 10, 10, 0, true), 1);
  // And above the top edge the window goes to the row itself.
  assert.equal(sidebarTop(cells, 2, 10, 8, true), 2);
  // The ends hold.
  assert.equal(sidebarTop(cells, 0, 10, -5, true), 0);
  assert.equal(sidebarTop(cells, 41, 10, 999, true), cells.length - 10);
});

test("a heading takes the blank line above it into the window", () => {
  // Two projects, so the second has a blank line above it saying it is a
  // heading. A window pulled to the row alone would cut that line off.
  const rows = [row("project", "a", 0), row("thread", "t0"), row("project", "b", 0), row("thread", "t1")];
  const cells = sidebarCells(rows);
  // The blank sits at line 2 and the second project at line 3.
  assert.deepEqual(cells[2], { kind: "blank" });
  assert.equal(sidebarTop(cells, 2, 2, 3, true), 2, "the blank comes with the heading");
});

test("the wheel moves the window and leaves the cursor where it is", () => {
  const cells = sidebarCells(longTree());
  // `follow` false is what a notch passes: the cursor on row 0 does not drag
  // the window back, or the sidebar could never be scrolled at all.
  assert.equal(sidebarTop(cells, 0, 10, 12, false), 12);
  assert.ok(!sidebarWindow(cells, 12, 10).some((c) => c.kind === "row" && c.index === 0));
  // It still stops at the ends.
  assert.equal(sidebarTop(cells, 0, 10, -3, false), 0);
  assert.equal(sidebarTop(cells, 0, 10, 999, false), cells.length - 10);
});

test("a window past the end of a list that shrank is clamped back, not painted empty", () => {
  const cells = sidebarCells(tree());
  const top = sidebarTop(cells, 0, 4, 40, false);
  assert.equal(sidebarWindow(cells, top, 4).length, 4);
});

test("a click lands on the row that is painted there, not on the nth row", () => {
  // The project is on line 2, its threads on 3 to 5, a blank on 6, the machines on 7.
  const cells = sidebarCells(tree());
  assert.equal(rowAtScreenRow(cells, 2, 2), 0);
  assert.equal(rowAtScreenRow(cells, 3, 2), 1);
  assert.equal(rowAtScreenRow(cells, 6, 2), null, "a blank line reaches nothing");
  assert.equal(rowAtScreenRow(cells, 7, 2), 4);
  assert.equal(rowAtScreenRow(cells, 40, 2), null, "below the list");
});

test("the cursor holds its thread when another thread's message re-sorts the list", () => {
  // a spoke last, then b, then c — the order the sidebar paints them in.
  const threads = (cLast: string) => [
    thread("a", "p", { lastMessageAt: "2026-01-03T00:00:00Z" }),
    thread("b", "p", { lastMessageAt: "2026-01-02T00:00:00Z" }),
    thread("c", "p", { lastMessageAt: cLast }),
  ];
  const at = (rows: SidebarRow[], id: string) => rows.findIndex((r) => r.thread?.id === id);

  const before = sidebarRows(appState([project("p")], threads("2026-01-01T00:00:00Z")));
  const index = at(before, "b");
  const key = before[index]!.key;

  // c takes a turn. It goes to the top of the project and pushes a and b down.
  const after = sidebarRows(appState([project("p")], threads("2026-01-04T00:00:00Z")));
  assert.deepEqual(after.filter((r) => r.kind === "thread").map((r) => r.thread!.id), ["c", "a", "b"]);
  assert.equal(after[index]!.thread!.id, "a", "the old index now points at another thread");
  assert.equal(cursorIndex(after, key, index), at(after, "b"));
  assert.equal(after[cursorIndex(after, key, index)]!.thread!.id, "b", "the key keeps the cursor on b");
});

test("a cursor whose row has gone falls back to the row that took its place", () => {
  assert.equal(cursorIndex(tree(), "t1", 0), 2, "the key wins over the remembered index");
  // t1 is archived away, so t2 moves up into row 2.
  const gone = [row("project", "p", 0), row("thread", "t0"), row("thread", "t2")];
  assert.equal(cursorIndex(gone, "t1", 2), 2);
  assert.equal(gone[cursorIndex(gone, "t1", 2)]!.key, "t2");
  // Nothing below it left: the cursor stops on the last row rather than running off.
  assert.equal(cursorIndex([row("project", "p", 0)], "t1", 3), 0);
  assert.equal(cursorIndex([], "t1", 3), 0, "an empty tree has no row to point at");
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
