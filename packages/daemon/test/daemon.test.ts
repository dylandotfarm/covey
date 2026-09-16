/**
 * Integration test: boots two daemons on loopback with throwaway data dirs and
 * exercises the protocol (projects, threads, export → import → markMoved)
 * without talking to Claude. Set COVEY_LIVE_TESTS=1 to also run a real turn.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import type { RpcMethodName, RpcMethods } from "@covey/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = join(here, "..", "src", "main.ts");

/** A throwaway directory, with every symlink already resolved. macOS makes
 *  /var a link to /private/var, and git reports the resolved path, so a raw
 *  mkdtemp path never compares equal to the one the daemon sends back. */
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

class Client {
  private ws!: WebSocket; private id = 0; private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  pushes: any[] = [];
  async connect(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("push" in m) { this.pushes.push(m); return; } const w = this.waits.get(m.id); this.waits.delete(m.id); m.ok ? w?.res(m.result) : w?.rej(Object.assign(new Error(m.error.message), { code: m.error.code })); });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
  }
  rpc<M extends RpcMethodName>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    return new Promise((res, rej) => { const i = ++this.id; this.waits.set(i, { res, rej }); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  command(cmd: any) { return this.rpc("command", { ...cmd, commandId: randomUUID() }); }
  close() { this.ws.close(); }
}

async function startDaemon(port: number, name: string): Promise<{ proc: ChildProcess; home: string }> {
  const home = tempDir("covey-test-");
  const proc = spawn(process.execPath, ["--import", "tsx", daemonEntry, "--bind", "loopback", "--port", String(port), "--name", name], { env: { ...process.env, COVEY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stderr!.on("data", (d) => { log += d.toString(); });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { proc, home }; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon ${name} did not start:\n${log}`);
}

const PORT_A = 3900 + Math.floor(Math.random() * 50), PORT_B = PORT_A + 50;
let A: { proc: ChildProcess; home: string }, B: { proc: ChildProcess; home: string };
let repoA: string, repoB: string;
const a = new Client(), b = new Client();

before(async () => {
  repoA = tempDir("covey-repo-a-");
  repoB = tempDir("covey-repo-b-");
  for (const r of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: r });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:example/shared.git"], { cwd: r });
    writeFileSync(join(r, "README.md"), "hello\n");
    // a real commit: worktrees (and checkpoints) need a HEAD to branch from
    execFileSync("git", ["add", "README.md"], { cwd: r });
    execFileSync("git", ["-c", "user.email=test@covey", "-c", "user.name=covey test", "commit", "-qm", "init"], { cwd: r });
  }
  [A, B] = await Promise.all([startDaemon(PORT_A, "alpha"), startDaemon(PORT_B, "beta")]);
  await Promise.all([a.connect(PORT_A), b.connect(PORT_B)]);
});

after(() => {
  a.close(); b.close();
  A?.proc.kill(); B?.proc.kill();
  for (const d of [A?.home, B?.home, repoA, repoB]) if (d) rmSync(d, { recursive: true, force: true });
});

test("hello reports protocol + capabilities", async () => {
  const info = await a.rpc("hello", { protocolVersion: 1, client: "test" });
  assert.equal(info.name, "alpha");
  assert.ok(info.capabilities.moveThreads);
  await assert.rejects(a.rpc("hello", { protocolVersion: 99, client: "test" }), /speaks v1/);
});

test("projects: create derives repositoryIdentity, is idempotent per path, and streams shell events", async () => {
  await a.rpc("shell.subscribe", {});
  await a.command({ type: "project.create", workspaceRoot: repoA });
  await a.command({ type: "project.create", workspaceRoot: repoA });
  const snap = await a.rpc("shell.snapshot", {});
  assert.equal(snap.projects.length, 1);
  assert.equal(snap.projects[0]!.repositoryIdentity, "github.com/example/shared");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(a.pushes.some((p) => p.push === "shell" && p.event.kind === "project.upserted"));
  await assert.rejects(a.command({ type: "project.create", workspaceRoot: join(repoA, "nope") }), /not a directory/);
});

test("commands are idempotent by commandId", async () => {
  const snap = await a.rpc("shell.snapshot", {});
  const projectId = snap.projects[0]!.id;
  const cmd = { commandId: randomUUID(), type: "thread.create", projectId, threadId: randomUUID(), sessionId: randomUUID() };
  const r1 = await a.rpc("command", cmd as any);
  const r2 = await a.rpc("command", cmd as any);
  assert.equal(r1.seq, r2.seq);
  assert.equal((await a.rpc("shell.snapshot", {})).threads.length, 1);
});

test("thread subscription replays after a seq and synchronizes", async () => {
  const snap = await a.rpc("shell.snapshot", {});
  const threadId = snap.threads[0]!.id;
  await a.command({ type: "thread.rename", threadId, title: "renamed" });
  a.pushes.length = 0;
  await a.rpc("thread.subscribe", { threadId, afterSeq: 0 });
  await new Promise((r) => setTimeout(r, 50));
  const kinds = a.pushes.filter((p) => p.push === "thread").map((p) => p.event.kind);
  assert.ok(kinds.includes("thread.updated"));
  assert.ok(a.pushes.some((p) => p.push === "thread.synchronized"));
});

test("export → import on another daemon → markMoved tombstones the source", async () => {
  const snapA = await a.rpc("shell.snapshot", {});
  const threadId = snapA.threads[0]!.id;
  await b.command({ type: "project.create", workspaceRoot: repoB });
  const exp = await a.rpc("thread.export", { threadId });
  assert.equal(exp.version, 1);
  assert.equal(exp.thread.title, "renamed");
  const imported = await b.rpc("thread.import", { export: exp }); // matched by repositoryIdentity
  const snapB = await b.rpc("shell.snapshot", {});
  assert.equal(snapB.projects[0]!.workspaceRoot, repoB);
  assert.equal(snapB.threads[0]!.id, imported.threadId);
  assert.equal(snapB.threads[0]!.sessionId, exp.thread.sessionId, "session id survives the move");
  const detail = await b.rpc("thread.snapshot", { threadId: imported.threadId });
  assert.ok(detail.items.some((i) => i.kind === "note" && /Moved here from alpha/.test((i as any).text)));
  const infoB = await b.rpc("hello", { protocolVersion: 1, client: "test" });
  await a.rpc("thread.markMoved", { threadId, machineId: infoB.machineId, newThreadId: imported.threadId });
  const moved = (await a.rpc("shell.snapshot", {})).threads[0]!;
  assert.deepEqual(moved.movedTo, { machineId: infoB.machineId, threadId: imported.threadId });
  await assert.rejects(a.command({ type: "turn.send", threadId, turnId: randomUUID(), text: "hi" }), /moved/);
});

test("fs.listDir lists directories and flags git repos", async () => {
  mkdirSync(join(repoA, "sub", "inner"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: join(repoA, "sub", "inner") });
  const r = await a.rpc("fs.listDir", { path: join(repoA, "sub") });
  assert.deepEqual(r.entries.map((e) => [e.name, e.isRepo]), [["inner", true]]);
});

test("fs.mkdir creates a folder to start a project in, and refuses to escape", async () => {
  const made = await a.rpc("fs.mkdir", { path: repoA, name: "fresh" });
  assert.equal(made.path, join(repoA, "fresh"));
  assert.ok(existsSync(made.path));
  // Nesting is allowed; making one that is already there is not an error.
  assert.equal((await a.rpc("fs.mkdir", { path: repoA, name: "fresh/deeper" })).path, join(repoA, "fresh", "deeper"));
  assert.equal((await a.rpc("fs.mkdir", { path: repoA, name: "fresh" })).path, join(repoA, "fresh"));
  for (const name of ["", "  ", "..", "../escaped", "a/../../escaped"])
    await assert.rejects(a.rpc("fs.mkdir", { path: repoA, name }), /folder/, `refused ${JSON.stringify(name)}`);
  assert.ok(!existsSync(join(repoA, "..", "escaped")));
  // A new project can be added in what was just created.
  await a.command({ type: "project.create", workspaceRoot: made.path, title: "fresh" });
  assert.ok((await a.rpc("shell.snapshot", {})).projects.some((pr) => pr.workspaceRoot === made.path));
});

test("project.git reports live branch state", async () => {
  const projectId = (await a.rpc("shell.snapshot", {})).projects.find((p) => p.workspaceRoot === repoA)!.id;
  const git = await a.rpc("project.git", { projectId });
  assert.deepEqual(git, { isRepo: true, root: repoA, currentBranch: "main", defaultBranch: "main", hasCommits: true });
});

test("thread.create puts a thread in a worktree, or in the checkout", async () => {
  const projectId = (await a.rpc("shell.snapshot", {})).projects.find((p) => p.workspaceRoot === repoA)!.id;

  const wt = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: wt, sessionId: randomUUID(), workspaceMode: "worktree-head" });
  const inWorktree = (await a.rpc("thread.snapshot", { threadId: wt })).thread;
  assert.equal(inWorktree.branch, `covey/${wt.slice(0, 8)}`);
  assert.equal(inWorktree.worktreePath, join(repoA, ".covey", "worktrees", wt.slice(0, 8)));
  assert.ok(existsSync(join(inWorktree.worktreePath!, "README.md")), "worktree is checked out");
  assert.doesNotMatch(execFileSync("git", ["status", "--porcelain"], { cwd: repoA, encoding: "utf8" }), /\.covey/, "worktrees stay out of the main checkout's status");

  const plain = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: plain, sessionId: randomUUID(), workspaceMode: "checkout" });
  const inCheckout = (await a.rpc("thread.snapshot", { threadId: plain })).thread;
  assert.equal(inCheckout.worktreePath, null);
  assert.equal(inCheckout.branch, "main");

  // a worktree that cannot be made is reported, not silently downgraded
  const plainDir = tempDir("covey-nogit-");
  await a.command({ type: "project.create", workspaceRoot: plainDir });
  const plainId = (await a.rpc("shell.snapshot", {})).projects.find((p) => p.workspaceRoot === plainDir)!.id;
  await assert.rejects(
    a.command({ type: "thread.create", projectId: plainId, threadId: randomUUID(), sessionId: randomUUID(), workspaceMode: "worktree-default" }),
    /not a git repository/,
  );
  rmSync(plainDir, { recursive: true, force: true });
});

test("a project remembers where new threads should run", async () => {
  const projectId = (await a.rpc("shell.snapshot", {})).projects.find((p) => p.workspaceRoot === repoA)!.id;
  const project = async () => (await a.rpc("shell.snapshot", {})).projects.find((p) => p.id === projectId)!;
  await a.command({ type: "project.update", projectId, defaultWorkspaceMode: "worktree-default" });
  assert.equal((await project()).defaultWorkspaceMode, "worktree-default");

  const id = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: id, sessionId: randomUUID() });
  assert.equal((await a.rpc("thread.snapshot", { threadId: id })).thread.branch, `covey/${id.slice(0, 8)}`, "remembered default applied without asking");

  await a.command({ type: "project.update", projectId, defaultWorkspaceMode: null });
  assert.equal((await project()).defaultWorkspaceMode, null);
  const after = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: after, sessionId: randomUUID() });
  assert.equal((await a.rpc("thread.snapshot", { threadId: after })).thread.worktreePath, null, "forgetting returns to the checkout");
});

test("machine defaults are machine-wide, persisted, and inherited by new threads", async () => {
  const settings = async () => (await a.rpc("hello", { protocolVersion: 1, client: "test" })).settings;
  assert.deepEqual(await settings(), { defaultModel: null, defaultPermissionMode: null }, "no opinion until one is set");

  await a.rpc("shell.subscribe", {});
  a.pushes.length = 0;
  await a.command({ type: "machine.settings", defaultModel: "claude-opus-5", defaultPermissionMode: "bypassPermissions" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    a.pushes.some((p) => p.push === "shell" && p.event.kind === "machine.updated" && p.event.machine.settings.defaultModel === "claude-opus-5"),
    "the change is broadcast, so every client's panel follows",
  );
  assert.deepEqual((await a.rpc("shell.snapshot", {})).machine.settings, { defaultModel: "claude-opus-5", defaultPermissionMode: "bypassPermissions" });
  const onDisk = JSON.parse(readFileSync(join(A.home, "daemon.json"), "utf8"));
  assert.equal(onDisk.defaultModel, "claude-opus-5", "settings survive a daemon restart");
  assert.ok(onDisk.machineId, "writing settings does not clobber the rest of daemon.json");

  const projectId = (await a.rpc("shell.snapshot", {})).projects.find((p) => p.workspaceRoot === repoA)!.id;
  const inherited = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: inherited, sessionId: randomUUID(), workspaceMode: "checkout" });
  const t = (await a.rpc("thread.snapshot", { threadId: inherited })).thread;
  assert.equal(t.model, "claude-opus-5");
  assert.equal(t.permissionMode, "bypassPermissions");
  assert.equal(t.permissionModeExplicit, true, "a machine default is a choice, so the SDK is told about it");

  const explicit = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: explicit, sessionId: randomUUID(), workspaceMode: "checkout", model: "claude-haiku-4-5-20251001", permissionMode: "plan" });
  const e = (await a.rpc("thread.snapshot", { threadId: explicit })).thread;
  assert.equal(e.model, "claude-haiku-4-5-20251001", "an explicit model still wins");
  assert.equal(e.permissionMode, "plan");

  await a.command({ type: "machine.settings", defaultModel: null, defaultPermissionMode: null });
  assert.deepEqual(await settings(), { defaultModel: null, defaultPermissionMode: null }, "and can be cleared again");
});

test("machine.source points at the checkout the daemon runs from", async () => {
  const src = await a.rpc("machine.source", {});
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  assert.equal(src.root, root);
  assert.equal(typeof src.commit, "string");
  assert.equal(src.canUpdate, !!src.remote, "nothing to pull from without a remote");
});

test("usage.report answers for its own machine, with an empty total before any turn", async () => {
  const info = await a.rpc("hello", { protocolVersion: 1, client: "test" });
  const r = await a.rpc("usage.report", { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z", groupBy: "thread" });
  assert.equal(r.machineId, info.machineId);
  assert.equal(r.machineName, "alpha");
  assert.equal(r.since, "2026-01-01T00:00:00.000Z");
  assert.equal(r.groupBy, "thread");
  assert.deepEqual(r.total, { turns: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0 });
  assert.deepEqual(r.groups, []);

  // One database holds one machine's turns, so grouping by machine is that
  // machine's own total under its own name.
  const byMachine = await a.rpc("usage.report", { groupBy: "machine" });
  assert.equal(byMachine.groups.length, 1);
  assert.equal(byMachine.groups[0]!.key, info.machineId);
  assert.equal(byMachine.groups[0]!.label, "alpha");
  assert.deepEqual(byMachine.groups[0]!.turns, byMachine.total.turns);
  // No window is open ended, not an error.
  assert.equal(byMachine.since, null);
  assert.equal(byMachine.until, null);
});

test("live: a real turn streams items, folds a second message in, and captures a diff", { skip: !process.env.COVEY_LIVE_TESTS }, async () => {
  const snapB = await b.rpc("shell.snapshot", {});
  const projectId = snapB.projects[0]!.id;
  const threadId = randomUUID();
  await b.command({ type: "thread.create", projectId, threadId, sessionId: randomUUID(), permissionMode: "acceptEdits" });
  // Archived up front, so the first message has to bring the thread back.
  await b.command({ type: "thread.archive", threadId, archived: true });
  await b.rpc("thread.subscribe", { threadId });
  b.pushes.length = 0;
  const editTurn = randomUUID(), pongTurn = randomUUID();
  await b.command({ type: "turn.send", threadId, turnId: editTurn, text: "Append the line 'second' to README.md using the Edit tool, then say done." });
  await b.command({ type: "turn.send", threadId, turnId: pongTurn, text: "Reply with the single word: pong" });
  const deadline = Date.now() + 180_000;
  const threadState = () => [...b.pushes].reverse().find((p) => p.push === "thread" && p.event.kind === "thread.updated")?.event.thread;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const t = threadState();
    if (t && t.latestTurn?.state === "completed" && b.pushes.filter((p) => p.event?.item?.kind === "assistant").length >= 2) break;
  }
  const t = threadState();
  assert.equal(t.archivedAt, null, "sending a message unarchived the thread");
  assert.equal(t.queuedTurns, 0, "nothing waits behind a running turn any more");
  assert.equal(t.latestTurn.state, "completed");
  // The turn carries what it alone spent, cache figures and model split
  // included — not the session's running total.
  assert.ok(t.latestTurn.usage, "the turn reports its usage");
  assert.ok(t.latestTurn.usage.outputTokens > 0, "a turn that replied spent output tokens");
  assert.ok(t.latestTurn.usage.byModel.length > 0, "the split names at least one model");
  const used = await b.rpc("usage.report", { groupBy: "thread" });
  assert.ok(used.total.turns > 0, "the turn was recorded");
  assert.ok(used.total.outputTokens >= t.latestTurn.usage.outputTokens);
  const mine = used.groups.find((g) => g.key === threadId);
  assert.ok(mine, "the thread shows in the totals");
  const byModel = await b.rpc("usage.report", { groupBy: "model" });
  assert.ok(Math.abs(byModel.groups.reduce((n, g) => n + g.estimatedCostUsd, 0) - byModel.total.estimatedCostUsd) < 1e-6,
    "the model split adds up to the total");
  const folded = b.pushes.map((p) => p.event?.item).filter((i) => i?.kind === "user" && i.text.startsWith("Reply with"));
  assert.ok(folded.some((i) => i.folded === true), "the second message went into the running turn");
  assert.ok(folded.every((i) => i.turnId === editTurn), "and belongs to that turn, not one of its own");
  assert.equal(folded.at(-1).folded, undefined, "the marker clears once the turn has read it");
  assert.equal(t.latestTurn.turnId, editTurn, "one turn covered both messages");
  const edit = await b.rpc("turn.diff", { threadId, turnId: editTurn });
  assert.ok(edit && edit.files.some((f) => f.path === "README.md"), "README.md shows in the edit turn's diff");
  assert.match(edit!.patch, /\+second/);
  assert.equal(await b.rpc("turn.diff", { threadId, turnId: pongTurn }), null, "a folded message has no turn, so no diff of its own");

  // revert to before the edit turn: file restored, transcript truncated, items dropped
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(repoB, "README.md"), "utf8"), /second/);
  await b.command({ type: "turn.revert", threadId, turnId: editTurn });
  assert.equal(readFileSync(join(repoB, "README.md"), "utf8"), "hello\n", "README restored");
  const after = await b.rpc("thread.snapshot", { threadId });
  assert.ok(!after.items.some((i) => i.kind === "user" && (i as any).text.includes("Append")), "edit turn's user message removed");
  assert.ok(after.items.some((i) => i.kind === "note" && /Reverted to before/.test((i as any).text)));
  assert.equal(after.thread.latestTurn, null);
  // the conversation no longer knows about the edit
  b.pushes.length = 0;
  await b.command({ type: "turn.send", threadId, turnId: randomUUID(), text: "Without using tools: have you edited any files in this conversation? Answer yes or no and name the file if yes." });
  const d2 = Date.now() + 120_000;
  while (Date.now() < d2 && threadState()?.latestTurn?.state !== "completed") await new Promise((r) => setTimeout(r, 500));
  assert.equal(threadState()?.latestTurn?.state, "completed", "post-revert turn completed");
  const reply = [...b.pushes].reverse().find((p) => p.event?.item?.kind === "assistant" && !p.event.item.streaming)?.event.item.text ?? "";
  assert.ok(reply.length > 0, "post-revert turn produced a reply");
  assert.doesNotMatch(reply, /README/i, `model should not remember the reverted edit, got: ${reply}`);
});
