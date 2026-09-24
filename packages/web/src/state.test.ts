import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubIssue, GitHubPullRequest, MachineInfo, ModelChoice, Project, ShellSnapshot, Thread, ThreadSnapshot, TimelineItem } from "@covey/protocol";
import type { TaggedAttachment } from "@covey/client";
import {
  addMachine, addressLink, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, checksLabel, connectionSummary, emptyState, findRefs, holderOf, isCurrentAddress,
  isGitHubAttachment, itemActions, itemHash, itemStateLabel, mediaKind, mediaSrc, openHomes, openView, orderedItems, projectRows, relTime, routeOf, rowSignature, sheetChoices, sheetKey, sheetNote, sheetRows, sheetTitle, viewRows, viewRowNumber,
  threadHash, threadRefs, threadStatusLabel, threadTone,
  attachmentRows, composerKey, httpBase, pendingAttachments, pendingBytes, sendableAttachments, setPendingAttachments, syncAttachments, threadFileSrc,
} from "./state.js";

// The model rows as a daemon sends them: its own Claude Code's list, aliases
// and all, with `resolved` naming the wire id each alias stands for.
const MODELS: ModelChoice[] = [
  { id: "opus[1m]", label: "Opus (1M context)", resolved: "claude-opus-5[1m]", description: "Opus 5 with 1M context · Best for everyday, complex tasks" },
  { id: "claude-fable-5-1[1m]", label: "Fable", resolved: "claude-fable-5-1", description: "Fable 5.1 · Most capable for your hardest tasks" },
  { id: "sonnet", label: "Sonnet", resolved: "claude-sonnet-5", description: "Sonnet 5 · Efficient for routine tasks" },
];
const CLAUDE_DEFAULT: ModelChoice = { id: "", label: "Default (recommended)", resolved: "claude-opus-5[1m]", description: "Opus 5 with 1M context" };
const info = (name: string): MachineInfo => ({
  machineId: `${name}-id`, name, os: "linux", arch: "arm64", homeDir: "/home/x", daemonVersion: "t", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
  models: MODELS, claudeDefaultModel: CLAUDE_DEFAULT,
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

test("one repository on two base branches is two rows, each with its own threads", () => {
  const s = emptyState();
  const pi = addMachine(s, "ws://pi:3790", "pi", true);
  const onMain = project("p-main", "covey", "github.com/dylandotfarm/covey");
  const onFeature = { ...project("p-feat", "covey", "github.com/dylandotfarm/covey"), baseBranch: "ui-rework" };
  applyShellSnapshot(pi, snap("pi", [onMain, onFeature], [thread("a", "p-main"), thread("b", "p-feat")]));
  pi.conn = "connected";
  const rows = projectRows(s);
  assert.deepEqual(rows.map((r) => [r.key, r.base]), [
    ["repo:github.com/dylandotfarm/covey", null],
    ["repo:github.com/dylandotfarm/covey#ui-rework", "ui-rework"],
  ], "the row on the remote's default branch keeps the key it always had");
  assert.deepEqual(rows.map((r) => r.threads.map((t) => t.thread.id)), [["a"], ["b"]]);
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

// ---------------------------------------------------------------------------
// The settings sheet (#117)
// ---------------------------------------------------------------------------

test("the conversation sheet says what the thread runs, and its pages tick what is in force", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p", "alpha")], [
    thread("t1", "p", { title: "fix the parser", model: "claude-sonnet-5", permissionMode: "acceptEdits", streaming: true }),
  ]));
  s.sheet = { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "" };

  assert.equal(sheetTitle(s, s.sheet), "fix the parser");
  // The thread was pinned by wire id; the machine offers the alias that covers
  // it, and `resolved` is what joins the two.
  assert.deepEqual(sheetRows(s, s.sheet).map((r) => [r.id, r.value ?? ""]), [
    ["model", "Sonnet"],
    ["mode", "Auto"],
    ["streaming", "On"],
    ["rename", ""],
    ["archive", ""],
  ]);
  // A row with no choices acts at once; the three settings open a page.
  assert.deepEqual(sheetRows(s, s.sheet).filter((r) => r.choices).map((r) => r.id), ["model", "mode", "streaming"]);

  s.sheet.page = "model";
  assert.equal(sheetTitle(s, s.sheet), "Model");
  const models = sheetChoices(s, s.sheet);
  assert.equal(models[0]!.id, "", "the first row hands the choice back to Claude's own settings");
  assert.equal(models[0]!.hint, "Opus 5 with 1M context", "and says which model that turns out to be");
  // The thread holds a wire id; the row that covers it is the alias, and it is
  // the row the page ticks.
  assert.deepEqual(models.filter((c) => c.current).map((c) => c.id), ["sonnet"]);
  // The rows are the machine's, not a list covey was built holding.
  assert.deepEqual(models.slice(1).map((c) => c.id), ["opus[1m]", "claude-fable-5-1[1m]", "sonnet"]);
  assert.equal(models[3]!.hint, "Sonnet 5 · Efficient for routine tasks", "each row says which version it is");

  // A thread always runs in one mode, so its page offers no "from Claude settings" row.
  s.sheet.page = "mode";
  const modes = sheetChoices(s, s.sheet);
  assert.ok(modes.every((c) => c.id !== ""));
  assert.deepEqual(modes.filter((c) => c.current).map((c) => c.id), ["acceptEdits"]);

  s.sheet.page = "streaming";
  assert.deepEqual(sheetChoices(s, s.sheet).filter((c) => c.current).map((c) => c.id), ["on"]);
});

test("the conversation sheet leads with the issue and the pull request a thread holds (#115)", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p", "alpha")], [
    thread("t1", "p", {
      title: "fix the parser",
      issue: { number: 94, title: null, url: null, takenAt: "2026-09-21T00:00:00Z" },
      pullRequest: { number: 12, url: "u", branch: "b", base: "main", openedAt: "2026-09-21T00:00:00Z" },
    }),
  ]));
  s.sheet = { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "" };
  const rows = sheetRows(s, s.sheet);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.id, r.label]), [
    ["view:94", "View issue #94"],
    ["view:12", "View pull request #12"],
  ]);
  // Each one acts at once, and none of them opens a page of choices.
  assert.ok(rows.slice(0, 2).every((r) => !r.choices));
  assert.deepEqual(rows.slice(2).map((r) => r.id), ["model", "mode", "streaming", "rename", "archive"]);

  assert.equal(viewRowNumber("view:94"), 94);
  assert.equal(viewRowNumber("model"), null);
  assert.equal(viewRowNumber("view:0"), null);
  assert.equal(viewRowNumber("view:x"), null);
});

test("a thread with no model of its own reads as the machine's Claude settings, and streaming absent reads as off", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p", "alpha")], [thread("t1", "p")]));
  s.sheet = { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "" };
  const rows = sheetRows(s, s.sheet);
  assert.equal(rows.find((r) => r.id === "model")!.value, "From Claude settings");
  assert.equal(rows.find((r) => r.id === "streaming")!.value, "Off");
  s.sheet.page = "streaming";
  assert.deepEqual(sheetChoices(s, s.sheet).filter((c) => c.current).map((c) => c.id), ["off"]);
});

test("the model page offers what the machine's own Claude Code offers, and says what no model of its own means", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p", "alpha")], [thread("t1", "p")]));
  s.sheet = { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "model" };
  // Nothing is pinned anywhere, so the first row is what Claude Code picks.
  assert.equal(sheetChoices(s, s.sheet)[0]!.hint, "Opus 5 with 1M context");

  // A default on the machine is what the thread inherits instead.
  const m = info("box");
  m.settings = { defaultModel: "sonnet", defaultPermissionMode: null, defaultStreaming: null };
  applyShellEvent(s, box, { seq: 2, kind: "machine.updated", machine: m });
  assert.equal(sheetChoices(s, s.sheet)[0]!.hint, "Sonnet");

  // And the project's own default beats the machine's.
  applyShellEvent(s, box, { seq: 3, kind: "project.upserted", project: { ...project("p", "alpha"), defaultModel: "claude-fable-5-1[1m]" } });
  assert.equal(sheetChoices(s, s.sheet)[0]!.hint, "Fable");
});

test("a machine that has not said which models it has keeps a picker, from the built-in list", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  // A daemon built before the model list existed, or one whose first read has
  // not answered yet. Either way the page still offers a model.
  const m = info("box");
  delete m.models;
  delete m.claudeDefaultModel;
  applyShellSnapshot(box, { seq: 1, machine: m, projects: [project("p", "alpha")], threads: [thread("t1", "p", { model: "claude-opus-5" })] });
  s.sheet = { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "model" };
  const choices = sheetChoices(s, s.sheet);
  assert.deepEqual(choices.map((c) => c.id), ["", "fable", "opus", "sonnet", "haiku"]);
  assert.equal(choices[0]!.hint, "the model the machine's Claude settings pick", "with nothing to say about what that resolves to");
  // A model no row covers is shown as itself. It is what the thread really
  // runs, and a wrong name would be worse than a plain one.
  assert.equal(sheetRows(s, s.sheet).find((r) => r.id === "model")!.value, "claude-opus-5");
});

test("the machine sheet is the defaults new threads there inherit, and may hand each one back to Claude's settings", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  const m = info("box");
  m.settings = { defaultModel: "claude-sonnet-5", defaultPermissionMode: null, defaultStreaming: true };
  applyShellSnapshot(box, { seq: 1, machine: m, projects: [], threads: [] });
  s.sheet = { target: { kind: "machine", machine: box.key }, page: "" };

  assert.equal(sheetTitle(s, s.sheet), "box");
  assert.deepEqual(sheetRows(s, s.sheet).map((r) => [r.id, r.value ?? ""]), [
    ["model", "Sonnet"],
    ["mode", "From Claude settings"],
    ["streaming", "On"],
  ]);
  assert.match(sheetNote(s, s.sheet), /Every new thread on box/, "a default is not what a running thread has");
  assert.equal(sheetNote(s, { target: { kind: "thread", machine: box.key, threadId: "t1" }, page: "" }), "", "a conversation's own settings need no caption");

  s.sheet.page = "mode";
  const modes = sheetChoices(s, s.sheet);
  assert.equal(modes[0]!.id, "", "a machine may hold no opinion on the mode");
  assert.deepEqual(modes.filter((c) => c.current).map((c) => c.id), [""]);
});

test("the web server row is offered on a fleet machine and withheld from the one serving the page", () => {
  const s = emptyState();
  const here = addMachine(s, "ws://here:3790", "here", true);
  const there = addMachine(s, "ws://there:3790", "there");
  for (const [slot, name] of [[here, "here"], [there, "there"]] as const) {
    const m = info(name);
    m.settings = { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, webEnabled: name === "here" ? true : null };
    applyShellSnapshot(slot, { seq: 1, machine: m, projects: [], threads: [] });
  }
  const ids = (key: string) => sheetRows(s, { target: { kind: "machine", machine: key }, page: "" }).map((r) => r.id);
  assert.ok(!ids(here.key).includes("web"), "the page must not offer to close itself");
  assert.deepEqual(ids(there.key), ["model", "mode", "streaming", "web"]);
});

test("the sheet's key changes with what the sheet says, and with nothing else", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  applyShellSnapshot(box, snap("box", [project("p", "alpha")], [thread("t1", "p", { model: "claude-opus-5" })]));
  const sheet = { target: { kind: "thread" as const, machine: box.key, threadId: "t1" }, page: "" };
  const before = sheetKey(s, sheet);
  // A turn re-sending items changes nothing the sheet says.
  assert.equal(sheetKey(s, sheet), before);
  applyShellEvent(s, box, { kind: "thread.upserted", seq: 2, thread: thread("t1", "p", { model: "claude-haiku-4-5-20251001" }) });
  assert.notEqual(sheetKey(s, sheet), before);
});

test("a sheet about a thread that is gone has nothing to show, and does not throw", () => {
  const s = emptyState();
  addMachine(s, "ws://box:3790", "box", true);
  const sheet = { target: { kind: "thread" as const, machine: "ws://box:3790", threadId: "ghost" }, page: "model" };
  assert.deepEqual(sheetRows(s, sheet), []);
  assert.deepEqual(sheetChoices(s, sheet), []);
  assert.equal(sheetTitle(s, sheet), "Conversation");
});

// ---------------------------------------------------------------------------
// A file on the draft (#135)
// ---------------------------------------------------------------------------

/** One file waiting on a draft, as `applyDrop` leaves it. */
const pending = (name: string, tag: string, extra: Partial<TaggedAttachment> = {}): TaggedAttachment =>
  ({ name, path: name, mimeType: "image/png", tag, data: "AAAA", ...extra });

test("the files waiting on a draft are held per conversation, and a draft that lost a tag drops its file (#135)", () => {
  const s = emptyState();
  const key = "ws://box:3790";
  assert.deepEqual(pendingAttachments(s, key, "t1"), []);
  setPendingAttachments(s, key, "t1", [pending("a.png", "[a.png]"), pending("b.png", "[b.png]")]);
  setPendingAttachments(s, key, "t2", [pending("c.png", "[c.png]")]);
  assert.equal(composerKey(key, "t1"), "ws://box:3790:t1");
  assert.equal(pendingAttachments(s, key, "t1").length, 2);

  // The tag is the only record of a file. Delete the word, lose the file.
  assert.deepEqual(syncAttachments(s, key, "t1", "look at [a.png]").map((a) => a.name), ["a.png"]);
  assert.deepEqual(pendingAttachments(s, key, "t1").map((a) => a.name), ["a.png"]);
  assert.deepEqual(pendingAttachments(s, key, "t2").map((a) => a.name), ["c.png"], "the other conversation is untouched");
  assert.deepEqual(syncAttachments(s, key, "t1", "never mind"), []);
  assert.equal(s.attachments.has(composerKey(key, "t1")), false, "nothing left is no entry");
});

test("what goes over the wire is the files, without their tag and without the chips that stand for nothing (#135)", () => {
  const good = pending("a.png", "[a.png]");
  const bad: TaggedAttachment = { name: "big.bin", path: "", mimeType: "", tag: "[big.bin — over the limit]", failed: true };
  const sendable = sendableAttachments([good, bad]);
  assert.equal(sendable.length, 1, "a chip for a file that did not attach has no bytes behind it");
  assert.deepEqual(Object.keys(sendable[0]!).sort(), ["data", "mimeType", "name", "path"]);
  assert.equal("tag" in sendable[0]!, false, "the tag never reaches the wire");
  assert.equal(pendingBytes(sendable), 3, "four characters of base64 are three bytes");
  assert.equal(pendingBytes([]), 0);
});

test("a file dropped on a thread loads from the daemon that holds the thread, with that machine's token (#135)", () => {
  const s = emptyState();
  const box = addMachine(s, "ws://box:3790", "box", true);
  const lan = addMachine(s, "ws://10.0.0.9:3790", "lan", false, "tok");
  assert.equal(httpBase("ws://box:3790"), "http://box:3790");
  assert.equal(httpBase("wss://box.tail.ts.net"), "https://box.tail.ts.net");

  const mine = threadFileSrc(box, "t1", "/w/.covey/threads/t1/files/shot.png");
  assert.equal(mine, "http://box:3790/file?thread=t1&path=%2Fw%2F.covey%2Fthreads%2Ft1%2Ffiles%2Fshot.png");
  // An `<img>` sends no header, so the token rides on the URL — and it is the
  // token of the machine that holds the thread, not the one that served the page.
  assert.match(threadFileSrc(lan, "t2", "/w/f.png"), /^http:\/\/10\.0\.0\.9:3790\/file\?thread=t2&path=%2Fw%2Ff\.png&token=tok$/);
  assert.equal(threadFileSrc(undefined, "t1", "/w/f.png"), "");
});

test("what a message's attachments are on the screen, with a dropped directory folded back into one (#135)", () => {
  const rows = attachmentRows([
    { name: "shot.png", path: "/f/shot.png", mimeType: "image/png" },
    { name: "clip.mp4", path: "/f/clip.mp4", mimeType: "video/mp4" },
    { name: "run.log", path: "/f/run.log", mimeType: "text/plain" },
    { name: "src/a.ts", path: "/f/tree/src/a.ts", mimeType: "text/plain", dir: "tree" },
    { name: "src/b.ts", path: "/f/tree/src/b.ts", mimeType: "text/plain", dir: "tree" },
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.label]), [
    ["image", "shot.png"],
    ["video", "clip.mp4"],
    ["file", "run.log"],
    ["file", "tree/ (2 files)"],
  ]);
  assert.deepEqual(attachmentRows([]), []);
});

// ---- the transcript's rows (#149) ------------------------------------------

const lodItem = (id: string, extra: Record<string, unknown> = {}): TimelineItem =>
  ({ id, threadId: "t", turnId: "a", seq: Number(id.slice(1)), createdAt: "", updatedAt: "u1", kind: "tool", toolUseId: id, toolName: "Read", input: {}, summary: `Read ${id}`, status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 10, ...extra }) as TimelineItem;

const lodView = (items: TimelineItem[]): View =>
  ({ machine: "m", threadId: "t", thread: null, items: new Map(items.map((i) => [i.id, i])), loading: false, error: null, hasMore: false, loadingOlder: false, seq: 0, commands: null, dirs: new Map() }) as unknown as View;

test("a new page reads transcripts compact", () => {
  assert.equal(emptyState().lod, "compact");
});

test("the level decides which rows the open thread paints", () => {
  const s = emptyState();
  const v = lodView([lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" })]);
  assert.deepEqual(viewRows(s, v).map((r) => r.kind), ["chain"]);
  s.lod = "steps";
  assert.deepEqual(viewRows(s, v).map((r) => r.kind), ["item", "item"]);
});

test("a chain's signature changes when anything under it does", () => {
  const s = emptyState();
  const one = viewRows(s, lodView([lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" })]))[0]!;
  const two = viewRows(s, lodView([lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" }), lodItem("c3", { groupId: "c1" })]))[0]!;
  assert.notEqual(rowSignature(one), rowSignature(two));
});

test("a chain's signature holds still when nothing under it changed", () => {
  const s = emptyState();
  const items = [lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" })];
  assert.equal(rowSignature(viewRows(s, lodView(items))[0]!), rowSignature(viewRows(s, lodView(items))[0]!));
});

test("the sentence a model wrote changes the signature, so the row repaints", () => {
  const s = emptyState();
  const plain = [lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" })];
  const named = [lodItem("c1", { groupId: "c1", groupSummary: "Read the parser" }), lodItem("c2", { groupId: "c1" })];
  assert.notEqual(rowSignature(viewRows(s, lodView(plain))[0]!), rowSignature(viewRows(s, lodView(named))[0]!));
});

test("a tapped row and the row it sits in have different keys", () => {
  const s = emptyState();
  const v = lodView([lodItem("c1", { groupId: "c1" }), lodItem("c2", { groupId: "c1" })]);
  s.toggledRows = new Set(["chain:c1"]);
  const rows = viewRows(s, v);
  assert.deepEqual(rows.map((r) => r.kind), ["chain", "item", "item"]);
  assert.equal(rows[0]!.key, "chain:c1");
  assert.equal(rows[1]!.key, "c1");
});

test("an item's signature follows the daemon's last write of it", () => {
  const s = emptyState();
  s.lod = "steps";
  const a = viewRows(s, lodView([lodItem("c1", { updatedAt: "u1" })]))[0]!;
  const b = viewRows(s, lodView([lodItem("c1", { updatedAt: "u2" })]))[0]!;
  assert.notEqual(rowSignature(a), rowSignature(b));
});
