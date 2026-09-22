import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubIssue, GitHubPullRequest, MachineInfo, Project, ShellSnapshot, Thread, ThreadSnapshot, TimelineItem } from "@covey/protocol";
import {
  addMachine, addressLink, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, checksLabel, connectionSummary, emptyState, findRefs, holderOf, isCurrentAddress,
  isGitHubAttachment, itemActions, itemHash, itemStateLabel, mediaKind, mediaSrc, openHomes, openView, orderedItems, projectRows, relTime, routeOf, threadHash, threadRefs, threadStatusLabel, threadTone,
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

test("the banner speaks for the primary alone; a fleet machine that is down is the settings page's business", () => {
  const s = emptyState();
  assert.equal(connectionSummary(s).state, "connecting");
  const pi = addMachine(s, "ws://pi:3790", "pi", true);
  const box = addMachine(s, "ws://box:3790", "box");
  pi.conn = "offline"; pi.connError = "no answer after 3 tries";
  assert.deepEqual(connectionSummary(s), { state: "offline", text: "offline · no answer after 3 tries · tap to retry" });
  pi.conn = "connected"; box.conn = "offline";
  assert.deepEqual(connectionSummary(s), { state: "connected", text: "" });
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

test("the hash names a thread, an item, or the list (#108)", () => {
  assert.deepEqual(routeOf(""), null);
  assert.deepEqual(routeOf("#/t/ws%3A%2F%2Fbox%3A3790/t1"), { kind: "thread", machine: "ws://box:3790", threadId: "t1" });
  assert.deepEqual(routeOf("#/gh/ws%3A%2F%2Fbox%3A3790/p1/12"), { kind: "item", machine: "ws://box:3790", projectId: "p1", number: 12 });
  assert.deepEqual(routeOf("#/gh/m/p/x"), null);
  assert.equal(routeOf(itemHash("ws://box:3790", "p1", 12))?.kind, "item");
  assert.equal(routeOf(threadHash("ws://box:3790", "t1"))?.kind, "thread");
});

test("the #N references in a piece of text, with their offsets (#108)", () => {
  assert.deepEqual(findRefs("Took #94 (#95). Not item#3, not #123456."), [{ start: 5, end: 8, number: 94 }, { start: 10, end: 13, number: 95 }]);
  assert.deepEqual(findRefs("#1"), [{ start: 0, end: 2, number: 1 }]);
  assert.deepEqual(findRefs("no refs"), []);
});

test("a thread's chips, an item's state word, its checks in one line, and the acts it offers (#108)", () => {
  const t = thread("t1", "p1", { issue: { number: 94, title: null, url: null, takenAt: "2026-09-21T00:00:00Z" }, pullRequest: { number: 12, url: "u", branch: "b", base: "main", openedAt: "2026-09-21T00:00:00Z" } });
  assert.deepEqual(threadRefs(t).map((r) => r.label), ["#94", "PR #12"]);
  // The sheet a hold raises has room to say what each one is (#115).
  assert.deepEqual(threadRefs(t).map((r) => r.menuLabel), ["View issue #94", "View pull request #12"]);
  assert.deepEqual(threadRefs(thread("t2", "p1")), []);
  const watched = thread("t3", "p1", { watch: { number: 7, state: "watching", reason: null, merge: "manual", mergeMethod: "merge", rounds: 0, maxRounds: 3, quiet: 0, cursor: { head: null, checks: null, reviews: [], comments: [], lineComments: [], state: "OPEN", mergeTried: null }, startedAt: "t", polledAt: null, endedAt: null, error: null } as never });
  assert.deepEqual(threadRefs(watched).map((r) => r.label), ["PR #7"]);

  const base = { number: 12, title: "t", url: "u", author: "a", body: "", createdAt: null, closedAt: null, labels: [], comments: [], viewer: "me", readAt: "r" };
  const pull = (over: Partial<GitHubPullRequest>): GitHubPullRequest => ({ kind: "pull", ...base, state: "OPEN", isDraft: false, headRefName: "b", baseRefName: "main", mergeable: "MERGEABLE", reviewDecision: "", additions: 1, deletions: 0, files: [], checks: [], reviews: [], mergedAt: null, ...over });
  const issue = (over: Partial<GitHubIssue>): GitHubIssue => ({ kind: "issue", ...base, state: "OPEN", ...over });
  assert.equal(itemStateLabel(pull({})), "open");
  assert.equal(itemStateLabel(pull({ isDraft: true })), "draft");
  assert.equal(itemStateLabel(pull({ state: "MERGED" })), "merged");
  assert.equal(itemStateLabel(pull({ state: "CLOSED" })), "closed");
  assert.equal(itemStateLabel(issue({ state: "CLOSED" })), "closed");

  const check = (state: "success" | "failure" | "pending" | "neutral") => ({ name: state, workflow: null, state, startedAt: null, url: null });
  assert.deepEqual(checksLabel(pull({})), { state: "none", text: "no checks" });
  assert.deepEqual(checksLabel(pull({ checks: [check("success"), check("neutral")] })), { state: "success", text: "1 passed, 1 skipped" });
  assert.deepEqual(checksLabel(pull({ checks: [check("success"), check("success")] })), { state: "success", text: "2 checks passed" });
  assert.deepEqual(checksLabel(pull({ checks: [check("success"), check("pending")] })), { state: "pending", text: "1 of 2 checks running" });
  assert.deepEqual(checksLabel(pull({ checks: [check("failure"), check("pending")] })), { state: "failure", text: "1 of 2 checks failed" });

  assert.deepEqual(itemActions(pull({})).map((a) => a.label), ["Approve", "Request changes", "Comment", "Merge", "Close"]);
  assert.deepEqual(itemActions(pull({ state: "MERGED" })).map((a) => a.label), ["Comment"]);
  assert.deepEqual(itemActions(pull({ state: "CLOSED" })).map((a) => a.label), ["Comment", "Reopen"]);
  assert.deepEqual(itemActions(issue({})).map((a) => a.label), ["Comment", "Close"]);
  assert.deepEqual(itemActions(issue({ state: "CLOSED" })).map((a) => a.label), ["Comment", "Reopen"]);
});

test("the thread that holds a number is found on its machine, and an archived one is not (#108)", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p1", "one")], [
    thread("t1", "p1", { issue: { number: 94, title: null, url: null, takenAt: "t" } }),
    thread("t2", "p1", { pullRequest: { number: 12, url: "u", branch: "b", base: "main", openedAt: "t" }, archivedAt: "t" }),
  ]));
  assert.equal(holderOf(s, "ws://box:3790", "p1", 94)?.id, "t1");
  assert.equal(holderOf(s, "ws://box:3790", "p1", 12), null);
  assert.equal(holderOf(s, "ws://box:3790", "p2", 94), null);
  assert.equal(holderOf(s, "ws://nope", "p1", 94), null);
});

test("a GitHub attachment loads through the daemon with the page's token; anything else loads as it is (#110)", () => {
  const a = "https://github.com/user-attachments/assets/abc";
  assert.equal(isGitHubAttachment(a), true);
  assert.equal(isGitHubAttachment("https://private-user-images.githubusercontent.com/1/2.png?jwt=x"), true);
  assert.equal(isGitHubAttachment("https://github.com/o/r/blob/main/x.png"), false);
  assert.equal(isGitHubAttachment("https://x.example/a.png"), false);
  assert.equal(isGitHubAttachment("not a url"), false);
  assert.equal(mediaSrc(a, "tok"), `/media?url=${encodeURIComponent(a)}&token=tok`);
  assert.equal(mediaSrc(a, undefined), `/media?url=${encodeURIComponent(a)}`);
  assert.equal(mediaSrc("https://x.example/a.png", "tok"), "https://x.example/a.png");
  assert.equal(mediaKind("https://x.example/a.PNG?x=1"), "image");
  assert.equal(mediaKind("https://x.example/a.webm"), "video");
  assert.equal(mediaKind(a), "video", "a bare attachment is a video; an image comes in an image tag");
  assert.equal(mediaKind("https://x.example/page"), null);
});
