import { test } from "node:test";
import assert from "node:assert/strict";
import type { MachineInfo, Project, ShellSnapshot, Thread, ThreadSnapshot, TimelineItem } from "@covey/protocol";
import {
  addMachine, addressLink, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, connectionSummary, emptyState, isCurrentAddress,
  openHomes, openView, orderedItems, projectRows, relTime, threadStatusLabel, threadTone,
} from "./state.js";

const info = (name: string): MachineInfo => ({
  machineId: `${name}-id`, name, os: "linux", arch: "arm64", homeDir: "/home/x", daemonVersion: "t", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});
const project = (id: string, title: string, repo: string | null = null): Project => ({ id, title, workspaceRoot: `/p/${id}`, repositoryIdentity: repo, defaultModel: null, createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" });
const thread = (id: string, projectId: string, extra: Partial<Thread> = {}): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: `s-${id}`, model: null, permissionMode: "default", branch: null, worktreePath: null,
  status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", ...extra,
});
const item = (id: string, seq: number, text: string): TimelineItem => ({ id, threadId: "t1", turnId: null, seq, createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", kind: "assistant", text, streaming: false, model: null });
const snap = (name: string, projects: Project[], threads: Thread[]): ShellSnapshot => ({ seq: 1, machine: info(name), projects, threads });

test("the list groups live threads by project, newest first, pinned on top, archived and moved left out", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("b", "beta"), project("a", "alpha")], [
    thread("old", "a", { lastMessageAt: "2026-09-20T00:00:00Z" }),
    thread("new", "a", { lastMessageAt: "2026-09-21T00:00:00Z" }),
    thread("pin", "a", { lastMessageAt: "2026-09-19T00:00:00Z", pinnedAt: "2026-09-19T00:00:00Z" }),
    thread("gone", "a", { archivedAt: "2026-09-21T00:00:00Z" }),
    thread("moved", "b", { movedTo: { machineId: "z", threadId: "q" } }),
  ]));
  const rows = projectRows(s);
  assert.deepEqual(rows.map((r) => r.title), ["alpha", "beta"]);
  assert.deepEqual(rows[0]!.threads.map((t) => t.thread.id), ["pin", "new", "old"]);
  assert.deepEqual(rows[1]!.threads, []);
});

test("one repository on two machines is one row, with a home per machine and the threads of both", () => {
  const s = emptyState();
  const pi = addMachine(s, "ws://pi:3790", "pi", true);
  const box = addMachine(s, "ws://box:3790", "box");
  applyShellSnapshot(pi, snap("pi", [project("p1", "covey", "github.com/d/covey")], []));
  applyShellSnapshot(box, snap("box", [project("p9", "covey", "GitHub.com/d/covey"), project("s1", "slug-src", "github.com/d/slug")], [
    thread("web", "p9", { status: "running" }),
    thread("slug", "s1"),
  ]));
  pi.conn = "connected"; box.conn = "connected";
  const rows = projectRows(s);
  assert.deepEqual(rows.map((r) => r.title), ["covey", "slug-src"]);
  const covey = rows[0]!;
  assert.deepEqual(covey.homes.map((h) => h.machineName), ["pi", "box"]);
  assert.deepEqual(covey.threads.map((t) => `${t.machineName}/${t.thread.id}`), ["box/web"]);
  assert.equal(covey.active, 1);
  assert.deepEqual(openHomes(covey).map((h) => h.machine), ["ws://pi:3790", "ws://box:3790"]);
  // A machine that is not connected cannot take a new thread.
  box.conn = "offline";
  assert.deepEqual(openHomes(projectRows(s)[0]!).map((h) => h.machine), ["ws://pi:3790"]);
  // A project with no remote is its own row, keyed by its machine.
  applyShellEvent(s, box, { seq: 2, kind: "project.upserted", project: project("l", "scratch") });
  applyShellEvent(s, pi, { seq: 2, kind: "project.upserted", project: project("l", "scratch") });
  assert.equal(projectRows(s).filter((r) => r.title === "scratch").length, 2);
});

test("a thread whose project the machine does not list is shown, not dropped", () => {
  const s = emptyState();
  const m = addMachine(s, "ws://m:3790", "m", true);
  applyShellSnapshot(m, snap("m", [], [thread("orphan", "nope")]));
  const rows = projectRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.threads[0]!.thread.id, "orphan");
  assert.equal(rows[0]!.homes.length, 0);
});

test("shell events fold in whole, and a thread on screen follows its own update on its own machine", () => {
  const s = emptyState();
  const a = addMachine(s, "ws://a:3790", "a", true);
  const b = addMachine(s, "ws://b:3790", "b");
  applyShellSnapshot(a, snap("a", [project("p", "alpha")], [thread("t1", "p")]));
  applyShellSnapshot(b, snap("b", [project("p", "alpha")], [thread("t1", "p")]));
  const v = openView(s, "ws://a:3790", "t1");
  applyShellEvent(s, b, { seq: 2, kind: "thread.upserted", thread: thread("t1", "p", { status: "running" }) });
  assert.equal(v.thread?.status, "idle", "the same thread id on another machine is another thread");
  applyShellEvent(s, a, { seq: 2, kind: "thread.upserted", thread: thread("t1", "p", { status: "running" }) });
  assert.equal(v.thread?.status, "running");
  applyShellEvent(s, a, { seq: 3, kind: "thread.removed", threadId: "t1" });
  assert.equal(a.threads.size, 0);
});

test("a re-sent item replaces its row, an event for another thread or machine is dropped, and seq never goes backwards", () => {
  const s = emptyState();
  const a = addMachine(s, "ws://a:3790", "a", true);
  applyShellSnapshot(a, snap("a", [project("p", "alpha")], [thread("t1", "p")]));
  const v = openView(s, "ws://a:3790", "t1");
  assert.equal(v.loading, true);
  const ts: ThreadSnapshot = { seq: 10, thread: thread("t1", "p"), items: [item("i2", 8, "second"), item("i1", 7, "first")], hasMore: false, commands: null };
  applyThreadSnapshot(v, ts);
  assert.equal(v.loading, false);
  assert.deepEqual(orderedItems(v).map((i) => i.id), ["i1", "i2"]);
  assert.equal(applyThreadEvent(s, "ws://a:3790", "t1", { seq: 11, kind: "item.upserted", item: item("i2", 8, "second, longer") }), true);
  assert.equal((v.items.get("i2") as { text: string }).text, "second, longer");
  assert.equal(v.seq, 11);
  applyThreadEvent(s, "ws://a:3790", "t1", { seq: 8, kind: "item.upserted", item: item("i2", 8, "again") });
  assert.equal(v.seq, 11);
  assert.equal(applyThreadEvent(s, "ws://a:3790", "other", { seq: 12, kind: "item.removed", itemId: "i1" }), false);
  assert.equal(applyThreadEvent(s, "ws://b:3790", "t1", { seq: 12, kind: "item.removed", itemId: "i1" }), false);
  assert.equal(v.items.size, 2);
});

test("the banner speaks for the primary first, then names the fleet machines that are down", () => {
  const s = emptyState();
  assert.equal(connectionSummary(s).state, "connecting");
  const pi = addMachine(s, "ws://pi:3790", "pi", true);
  const box = addMachine(s, "ws://box:3790", "box");
  pi.conn = "offline"; pi.connError = "no answer after 3 tries";
  assert.deepEqual(connectionSummary(s), { state: "offline", text: "offline · no answer after 3 tries · tap to retry" });
  pi.conn = "connected"; box.conn = "connecting";
  assert.deepEqual(connectionSummary(s), { state: "connecting", text: "box: connecting…" });
  box.conn = "offline";
  assert.deepEqual(connectionSummary(s), { state: "offline", text: "box offline · tap to retry" });
  box.conn = "connected";
  assert.deepEqual(connectionSummary(s), { state: "connected", text: "" });
});

test("the tone and the label read the same facts the TUI reads", () => {
  const running = thread("t", "a", { status: "running", latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null } });
  assert.equal(threadTone(running), "busy");
  assert.equal(threadStatusLabel(running), "working");
  assert.equal(threadStatusLabel({ ...running, queuedTurns: 2 }), "working · 2 queued");
  const approval = { ...running, pendingApprovals: 1 };
  assert.equal(threadTone(approval), "waiting");
  assert.equal(threadStatusLabel(approval), "needs approval");
  const failed = thread("t", "a", { status: "error", lastError: "boom" });
  assert.equal(threadTone(failed), "error");
  assert.equal(threadStatusLabel(failed), "error: boom");
  const done = thread("t", "a", { latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" } });
  assert.equal(threadTone(done), "done");
  assert.equal(threadStatusLabel(done), "idle");
});

test("relTime says now, minutes, hours, days", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  assert.equal(relTime("2026-09-21T11:59:30Z", now), "now");
  assert.equal(relTime("2026-09-21T11:30:00Z", now), "30m");
  assert.equal(relTime("2026-09-21T09:00:00Z", now), "3h");
  assert.equal(relTime("2026-09-18T12:00:00Z", now), "3d");
  assert.equal(relTime(null, now), "");
});

test("a link to another address carries the token, and the tailnet one does not", () => {
  assert.equal(addressLink({ kind: "lan", url: "http://192.168.1.2:3790/", reachable: true }, "tok"), "http://192.168.1.2:3790/?token=tok");
  assert.equal(addressLink({ kind: "mdns", url: "http://box.local:3790/", reachable: true }, "tok"), "http://box.local:3790/?token=tok");
  assert.equal(addressLink({ kind: "tailnet", url: "http://box.tail.ts.net:3790/", reachable: true }, "tok"), "http://box.tail.ts.net:3790/");
});

test("the page knows which address it is on", () => {
  assert.equal(isCurrentAddress("http://box.local:3790/", "http://box.local:3790"), true);
  assert.equal(isCurrentAddress("http://Box.local:3790/", "http://box.local:3790"), true);
  assert.equal(isCurrentAddress("http://192.168.1.2:3790/", "http://box.local:3790"), false);
});
