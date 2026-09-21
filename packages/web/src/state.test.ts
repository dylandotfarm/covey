import { test } from "node:test";
import assert from "node:assert/strict";
import type { MachineInfo, Project, ShellSnapshot, Thread, ThreadSnapshot, TimelineItem } from "@covey/protocol";
import { addressLink, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, emptyState, isCurrentAddress, openView, orderedItems, projectRows, relTime, threadStatusLabel, threadTone } from "./state.js";

const INFO: MachineInfo = {
  machineId: "m", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/x", daemonVersion: "t", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};
const project = (id: string, title: string): Project => ({ id, title, workspaceRoot: `/p/${id}`, repositoryIdentity: null, defaultModel: null, createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" });
const thread = (id: string, projectId: string, extra: Partial<Thread> = {}): Thread => ({
  id, projectId, title: id, provider: "claude", sessionId: `s-${id}`, model: null, permissionMode: "default", branch: null, worktreePath: null,
  status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", ...extra,
});
const item = (id: string, seq: number, text: string): TimelineItem => ({ id, threadId: "t1", turnId: null, seq, createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", kind: "assistant", text, streaming: false, model: null });

test("the list groups live threads by project, newest first, pinned on top, archived and moved left out", () => {
  const s = emptyState();
  const snap: ShellSnapshot = {
    seq: 5, machine: INFO,
    projects: [project("b", "beta"), project("a", "alpha")],
    threads: [
      thread("old", "a", { lastMessageAt: "2026-09-20T00:00:00Z" }),
      thread("new", "a", { lastMessageAt: "2026-09-21T00:00:00Z" }),
      thread("pin", "a", { lastMessageAt: "2026-09-19T00:00:00Z", pinnedAt: "2026-09-19T00:00:00Z" }),
      thread("gone", "a", { archivedAt: "2026-09-21T00:00:00Z" }),
      thread("moved", "b", { movedTo: { machineId: "z", threadId: "q" } }),
    ],
  };
  applyShellSnapshot(s, snap);
  const rows = projectRows(s);
  assert.deepEqual(rows.map((r) => r.project.title), ["alpha", "beta"]);
  assert.deepEqual(rows[0]!.threads.map((t) => t.id), ["pin", "new", "old"]);
  assert.deepEqual(rows[1]!.threads, []);
});

test("shell events fold in whole, and a thread on screen follows its own update", () => {
  const s = emptyState();
  applyShellSnapshot(s, { seq: 1, machine: INFO, projects: [project("a", "alpha")], threads: [thread("t1", "a")] });
  const v = openView(s, "t1");
  applyShellEvent(s, { seq: 2, kind: "thread.upserted", thread: thread("t1", "a", { status: "running" }) });
  assert.equal(v.thread?.status, "running");
  applyShellEvent(s, { seq: 3, kind: "project.upserted", project: project("c", "gamma") });
  assert.equal(projectRows(s).length, 2);
  applyShellEvent(s, { seq: 4, kind: "thread.removed", threadId: "t1" });
  assert.equal(s.threads.size, 0);
});

test("a re-sent item replaces its row, an event for another thread is dropped, and seq never goes backwards", () => {
  const s = emptyState();
  applyShellSnapshot(s, { seq: 1, machine: INFO, projects: [project("a", "alpha")], threads: [thread("t1", "a")] });
  const v = openView(s, "t1");
  assert.equal(v.loading, true);
  const snap: ThreadSnapshot = { seq: 10, thread: thread("t1", "a"), items: [item("i2", 8, "second"), item("i1", 7, "first")], hasMore: false, commands: null };
  applyThreadSnapshot(v, snap);
  assert.equal(v.loading, false);
  assert.deepEqual(orderedItems(v).map((i) => i.id), ["i1", "i2"]);
  assert.equal(applyThreadEvent(s, "t1", { seq: 11, kind: "item.upserted", item: item("i2", 8, "second, longer") }), true);
  assert.equal(v.items.size, 2);
  assert.equal((v.items.get("i2") as { text: string }).text, "second, longer");
  assert.equal(v.seq, 11);
  // A resent snapshot carries the item's own older seq.
  applyThreadEvent(s, "t1", { seq: 8, kind: "item.upserted", item: item("i2", 8, "again") });
  assert.equal(v.seq, 11);
  assert.equal(applyThreadEvent(s, "other", { seq: 12, kind: "item.removed", itemId: "i1" }), false);
  assert.equal(v.items.size, 2);
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
