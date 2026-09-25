/**
 * Integration test: boots two daemons on loopback with throwaway data dirs and
 * exercises the protocol (projects, threads, export → import → markMoved)
 * without talking to Claude. Set COVEY_LIVE_TESTS=1 to also run a real turn.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import type { RpcMethodName, RpcMethods } from "@covey/protocol";
import { startDaemon, stopAll, tempDir, waitForExit, type TestDaemon } from "./daemons.js";
import { scratchRemote, git, head, type ScratchRemote } from "../src/scratch.js";
import { normaliseRemote, isBareRepo, projectSlug } from "../src/git.js";

const here = dirname(fileURLToPath(import.meta.url));

/** How long any one wait on the daemon may take before it is a failure rather
 *  than a hang. Every call here answers in well under a second when measured,
 *  and `pnpm test` runs every file at once on four cores, so this is set for
 *  contention and is the bound rather than the expectation. See #53: an
 *  unbounded wait on a daemon that has died looks exactly like slow hardware. */
const REPLY_BUDGET_MS = 60_000;

class Client {
  private ws?: WebSocket; private id = 0; private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  pushes: any[] = [];
  async connect(port: number) {
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("push" in m) { this.pushes.push(m); return; } const w = this.waits.get(m.id); this.waits.delete(m.id); m.ok ? w?.res(m.result) : w?.rej(Object.assign(new Error(m.error.message), { code: m.error.code })); });
    // A socket that closes owes every call on it an answer. Without this a
    // daemon that dies mid-test leaves each pending rpc waiting for ever.
    const fail = (why: string) => { for (const [, w] of this.waits) w.rej(new Error(why)); this.waits.clear(); };
    ws.on("close", () => fail(`the daemon on port ${port} closed the connection`));
    ws.on("error", (e) => fail(`the connection to port ${port} failed: ${e.message}`));
    await new Promise<void>((res, rej) => {
      // Waiting on `open` or `error` alone is not enough: a handshake the
      // daemon refuses arrives as `close`, and a machine under load can be slow
      // enough to lose any of the three. Every outcome settles this, and the
      // timer is the floor under all of them.
      const settle = (fn: () => void) => () => {
        clearTimeout(timer);
        for (const [event, handler] of handlers) ws.off(event, handler);
        fn();
      };
      const timer = setTimeout(settle(() => rej(new Error(`no websocket to port ${port} within ${REPLY_BUDGET_MS / 1000}s`))), REPLY_BUDGET_MS);
      const handlers: [string, () => void][] = [
        ["open", settle(res)],
        ["error", settle(() => rej(new Error(`the websocket to port ${port} failed`)))],
        ["close", settle(() => rej(new Error(`the websocket to port ${port} closed before it opened`)))],
      ];
      for (const [event, handler] of handlers) ws.once(event, handler);
    });
  }
  rpc<M extends RpcMethodName>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const timer = setTimeout(() => { this.waits.delete(i); rej(new Error(`rpc ${method} got no answer in ${REPLY_BUDGET_MS / 1000}s`)); }, REPLY_BUDGET_MS);
      this.waits.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      this.ws!.send(JSON.stringify({ id: i, method, params }));
    });
  }
  command(cmd: any) { return this.rpc("command", { ...cmd, commandId: randomUUID() }); }
  /** Tolerates never having connected: `before` can throw before `connect`. */
  close() { this.ws?.close(); }
}

let A: TestDaemon, B: TestDaemon;
/** The one repository both daemons clone: a bare remote on disk, so a project
 *  reaches no network. */
let remote: ScratchRemote;
const a = new Client(), b = new Client();

before(async () => {
  remote = await scratchRemote("covey-daemon-remote-");
  // If one of these throws the other is still reachable — `startDaemon`
  // registers a daemon before it waits on it, so `stopAll` below finds it.
  [A, B] = await Promise.all([
    startDaemon({ name: "alpha", env: { COVEY_STREAM: "" } }),
    startDaemon({ name: "beta", env: { COVEY_STREAM: "" } }),
  ]);
  await Promise.all([a.connect(A.port), b.connect(B.port)]);
});

after(async () => {
  // Every step runs whatever the step before it did. One throw at the top of
  // this hook skipping the rest is what left five daemons listening in #53.
  for (const step of [() => a.close(), () => b.close()]) {
    try { step(); } catch (e) { console.error(`covey test teardown: ${e}`); }
  }
  await stopAll();
  remote?.drop();
});

// Issue #8: every daemon runs `node <dir>/index.js daemon`, so a pattern such
// as `pkill -f "index.js daemon"` matches all of them. A session killed the
// daemon that hosted it that way, and the stop left no line in the log.

/** A daemon must be gone this long after SIGTERM, or something is wrong with
 *  the stop path rather than with the machine. */
const EXIT_BUDGET_MS = 30_000;

test("a daemon writes a pid file for its port, and takes it away when it stops", async () => {
  // The pid file is the name that `covey stop --port N` uses, in place of a
  // pattern over the command line.
  const d = await startDaemon({ name: "stoppable" });
  const { proc, home, port } = d;
  try {
    const pidFile = join(home, `daemon-${port}.pid`);
    assert.ok(existsSync(pidFile), `expected a pid file at ${pidFile}\n${d.log()}`);
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(rec.pid, proc.pid, "the pid file names the daemon process");
    assert.equal(rec.port, port, "and the port it listens on");
    // A daemon on another port keeps its own file, under its own data dir.
    assert.equal(existsSync(join(A.home, `daemon-${A.port}.pid`)), true);
    assert.notEqual(join(A.home, `daemon-${A.port}.pid`), pidFile);

    proc.kill("SIGTERM");
    assert.ok(await waitForExit(proc, EXIT_BUDGET_MS), `the daemon on ${port} did not exit within ${EXIT_BUDGET_MS / 1000}s\n${d.log()}`);
    assert.equal(existsSync(pidFile), false, "the pid file goes when the daemon goes");
  } finally {
    await d.stop();
  }
});

test("a daemon says why it stopped, so the log does not just end", async () => {
  // The stop used to be silent. The log ended in the middle of the work with
  // no error and no shutdown line, and the daemon looked like it vanished.
  const d = await startDaemon({ name: "stoppable" });
  try {
    d.proc.kill("SIGTERM");
    assert.ok(await waitForExit(d.proc, EXIT_BUDGET_MS), `the daemon on ${d.port} did not exit within ${EXIT_BUDGET_MS / 1000}s\n${d.log()}`);
    assert.match(d.log(), new RegExp(`stopping: signal=SIGTERM pid=${d.proc.pid} port=${d.port} at \\d{4}-`),
      `a silent stop costs hours to explain; the log must name the signal, the pid and the time. Got:\n${d.log()}`);
  } finally {
    await d.stop();
  }
});

test("hello reports protocol + capabilities", async () => {
  const info = await a.rpc("hello", { protocolVersion: 1, client: "test" });
  assert.equal(info.name, "alpha");
  assert.ok(info.capabilities.moveThreads);
  await assert.rejects(a.rpc("hello", { protocolVersion: 99, client: "test" }), /speaks v1/);
});

test("projects: create clones the repository under the projects directory, once per repository, and streams shell events", async () => {
  await a.rpc("shell.subscribe", {});
  await a.command({ type: "project.create", url: remote.url });
  await assert.rejects(a.command({ type: "project.create", url: remote.url }), /already has shared/, "one project per repository, and the second create says so");
  const snap = await a.rpc("shell.snapshot", {});
  assert.equal(snap.projects.length, 1);
  const p = snap.projects[0]!;
  const identity = normaliseRemote(remote.url);
  assert.equal(p.repositoryIdentity, identity);
  assert.equal(p.kind, "clone");
  assert.equal(p.remoteUrl, remote.url);
  assert.equal(p.title, "shared", "named after the repository");
  assert.equal(snap.machine.projectsDir, join(A.home, "projects"), "under COVEY_HOME, so a throwaway daemon never clones into the real directory");
  assert.equal(p.workspaceRoot, join(A.home, "projects", projectSlug(identity), "repo.git"));
  assert.equal(projectSlug("github.com/acme/api"), "github.com/acme/api", "the host stays in the path, so two hosts' acme/api never share a clone");
  assert.ok(await isBareRepo(p.workspaceRoot), "nothing is checked out in the project itself");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(a.pushes.some((p) => p.push === "shell" && p.event.kind === "project.upserted"));
  await assert.rejects(a.command({ type: "project.create", url: join(remote.dir, "nope.git") }), /could not clone/);
  assert.equal((await a.rpc("shell.snapshot", {})).projects.length, 1, "a clone that failed is no project");
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

test("a thread that has never run reports no `/` menu, which is not an empty one", async () => {
  const snap = await a.rpc("shell.snapshot", {});
  const threadId = snap.threads[0]!.id;
  // null is "nobody has asked the SDK yet". The composer says so rather than
  // showing a menu with nothing in it.
  assert.equal((await a.rpc("thread.snapshot", { threadId })).commands, null);
});

test("export → import on another daemon → markMoved tombstones the source", async () => {
  const snapA = await a.rpc("shell.snapshot", {});
  const threadId = snapA.threads[0]!.id;
  await b.command({ type: "project.create", url: remote.url });
  const exp = await a.rpc("thread.export", { threadId });
  assert.equal(exp.version, 1);
  assert.equal(exp.thread.title, "renamed");
  const imported = await b.rpc("thread.import", { export: exp }); // matched by repositoryIdentity
  const snapB = await b.rpc("shell.snapshot", {});
  assert.equal(snapB.projects[0]!.repositoryIdentity, normaliseRemote(remote.url));
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

test("project.git reports live branch state", async () => {
  const projectId = (await a.rpc("shell.snapshot", {})).projects[0]!.id;
  const root = (await a.rpc("shell.snapshot", {})).projects[0]!.workspaceRoot;
  const git = await a.rpc("project.git", { projectId });
  // A bare clone has no branch of its own checked out. Its default branch is
  // the remote's, and that is its history.
  assert.deepEqual(git, { isRepo: true, root, currentBranch: null, defaultBranch: "origin/main", hasCommits: true });
});

test("thread.create puts every thread in its own worktree beside the clone, from origin/main", async () => {
  const project = (await a.rpc("shell.snapshot", {})).projects[0]!;
  // What the clone knows of origin/main. A fetch within the last minute is
  // reused across threads, so this test does not move the remote and expect
  // the very next thread to see it; `cleanStart.test.ts` covers freshness.
  const ahead = await git(project.workspaceRoot, "rev-parse", "--short", "origin/main");

  const wt = randomUUID();
  await a.command({ type: "thread.create", projectId: project.id, threadId: wt, sessionId: randomUUID() });
  const inWorktree = (await a.rpc("thread.snapshot", { threadId: wt })).thread;
  assert.equal(inWorktree.branch, `covey/${wt.slice(0, 8)}`);
  assert.equal(inWorktree.worktreePath, join(dirname(project.workspaceRoot), wt.slice(0, 8)), "beside repo.git, not inside it");
  assert.ok(existsSync(join(inWorktree.worktreePath!, "README.md")), "worktree is checked out");
  assert.equal(await head(inWorktree.worktreePath!), ahead, "the thread starts at origin/main");
  const notes = (await a.rpc("thread.snapshot", { threadId: wt })).items.filter((i) => i.kind === "note");
  assert.equal(notes.length, 1);
  assert.match((notes[0] as any).text, new RegExp(`Branched from origin/main at ${ahead}, fetched from origin`));

  // Every thread gets one. There is no option to share the checkout: the
  // project has none.
  const second = randomUUID();
  await a.command({ type: "thread.create", projectId: project.id, threadId: second, sessionId: randomUUID() });
  const t2 = (await a.rpc("thread.snapshot", { threadId: second })).thread;
  assert.notEqual(t2.worktreePath, inWorktree.worktreePath);
  assert.equal(t2.branch, `covey/${second.slice(0, 8)}`);
});

test("a moved thread keeps its branch when the remote has it, and starts fresh when it does not", async () => {
  // On origin: the branch of a thread that pushed its work before the move.
  const pushed = randomUUID();
  const branch = `covey/${pushed.slice(0, 8)}`;
  const tip = await remote.pushBranch(branch, "thread work");
  await a.command({ type: "thread.create", projectId: (await a.rpc("shell.snapshot", {})).projects[0]!.id, threadId: pushed, sessionId: randomUUID() });
  // The daemon's own record of the branch is the name; the commits are on origin.
  const exp = await a.rpc("thread.export", { threadId: pushed });
  assert.equal(exp.thread.branch, branch);
  assert.ok(exp.project.remoteUrl, "the export carries the URL, so a machine with no project can clone");
  const imported = await b.rpc("thread.import", { export: exp });
  const moved = (await b.rpc("thread.snapshot", { threadId: imported.threadId })).thread;
  assert.equal(moved.branch, branch, "the same branch, on the other machine");
  assert.equal(await head(moved.worktreePath!), tip, "with the commits that were pushed");
  // The thread's own items came along, its clean-start note among them; the
  // move's note is the one written here.
  const moveNote = (items: any[]) => items.find((i) => i.kind === "note" && /Moved here/.test(i.text));
  const note = moveNote((await b.rpc("thread.snapshot", { threadId: imported.threadId })).items);
  assert.ok(note, "the move left a note");
  assert.match(note.text, new RegExp(`The thread works in a worktree on ${branch}, fetched from origin`));
  await a.rpc("thread.markMoved", { threadId: pushed, machineId: (await b.rpc("hello", { protocolVersion: 1, client: "test" })).machineId, newThreadId: imported.threadId });
  await new Promise((r) => setTimeout(r, 200));
  const source = (await a.rpc("thread.snapshot", { threadId: pushed })).thread;
  assert.ok(!existsSync(source.worktreePath!), "the source gives its worktree back once the move is marked");
  assert.equal(await git((await a.rpc("shell.snapshot", {})).projects[0]!.workspaceRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false), true, "and keeps the branch");

  // Back again. The branch is still here from the first visit, and the
  // worktree opens on it at what origin has, not on a second branch.
  const back = await a.rpc("thread.import", { export: await b.rpc("thread.export", { threadId: imported.threadId }) });
  const returned = (await a.rpc("thread.snapshot", { threadId: back.threadId })).thread;
  assert.equal(returned.branch, branch, "the same branch on the way back");
  assert.equal(await head(returned.worktreePath!), tip);
  assert.notEqual(returned.worktreePath, source.worktreePath, "in a worktree named for the new thread");

  // Not on origin: the thread starts from the default branch and is told.
  const local = randomUUID();
  await a.command({ type: "thread.create", projectId: (await a.rpc("shell.snapshot", {})).projects[0]!.id, threadId: local, sessionId: randomUUID() });
  const exp2 = await a.rpc("thread.export", { threadId: local });
  const imported2 = await b.rpc("thread.import", { export: exp2 });
  const fresh = (await b.rpc("thread.snapshot", { threadId: imported2.threadId })).thread;
  assert.equal(fresh.branch, `covey/${imported2.threadId.slice(0, 8)}`, "a new branch, named for the new thread");
  const note2 = moveNote((await b.rpc("thread.snapshot", { threadId: imported2.threadId })).items);
  assert.match(note2.text, new RegExp(`The branch covey/${local.slice(0, 8)} is not on origin, so its commits are still on alpha`));
});

test("machine defaults are machine-wide, persisted, and inherited by new threads", async () => {
  const settings = async () => (await a.rpc("hello", { protocolVersion: 1, client: "test" })).settings;
  assert.deepEqual(await settings(), { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null, webEnabled: null, bind: "loopback" }, "no opinion until one is set");

  await a.rpc("shell.subscribe", {});
  a.pushes.length = 0;
  await a.command({ type: "machine.settings", defaultModel: "claude-opus-5", defaultPermissionMode: "bypassPermissions", defaultStreaming: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    a.pushes.some((p) => p.push === "shell" && p.event.kind === "machine.updated" && p.event.machine.settings.defaultModel === "claude-opus-5"),
    "the change is broadcast, so every client's panel follows",
  );
  assert.deepEqual((await a.rpc("shell.snapshot", {})).machine.settings, { defaultModel: "claude-opus-5", defaultPermissionMode: "bypassPermissions", defaultStreaming: true, sessionIdleMinutes: null, maxLiveSessions: null, webEnabled: null, bind: "loopback" });
  const onDisk = JSON.parse(readFileSync(join(A.home, "daemon.json"), "utf8"));
  assert.equal(onDisk.defaultModel, "claude-opus-5", "settings survive a daemon restart");
  assert.ok(onDisk.machineId, "writing settings does not clobber the rest of daemon.json");

  const projectId = (await a.rpc("shell.snapshot", {})).projects[0]!.id;
  const inherited = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: inherited, sessionId: randomUUID() });
  const t = (await a.rpc("thread.snapshot", { threadId: inherited })).thread;
  assert.equal(t.model, "claude-opus-5");
  assert.equal(t.permissionMode, "bypassPermissions");
  assert.equal(t.permissionModeExplicit, true, "a machine default is a choice, so the SDK is told about it");
  assert.equal(t.streaming, true);

  const explicit = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId: explicit, sessionId: randomUUID(), model: "claude-haiku-4-5-20251001", permissionMode: "plan", streaming: false });
  const e = (await a.rpc("thread.snapshot", { threadId: explicit })).thread;
  assert.equal(e.model, "claude-haiku-4-5-20251001", "an explicit model still wins");
  assert.equal(e.permissionMode, "plan");
  assert.equal(e.streaming, false, "an explicit choice still wins");

  // What a `null` resolves to, so a control panel can print the number behind
  // the word "default". No client can work this out: the live ceiling is read
  // from this machine's memory.
  const budget = async () => (await a.rpc("shell.snapshot", {})).machine.sessionBudget;
  const fresh = await budget();
  assert.equal(fresh!.idleMinutes, 120, "the default idle limit, said out loud");
  assert.ok(fresh!.liveLimit >= 2 && fresh!.liveLimit <= 8, `a ceiling from this machine's memory, got ${fresh!.liveLimit}`);
  assert.equal(fresh!.sessionMemoryBytes, 300 * 1024 * 1024, "what one session costs, so a panel can price a ceiling before it is set");

  // The session limits live beside the rest, and a nonsense value reads as "no
  // opinion" rather than as a limit that would release every session at once.
  await a.command({ type: "machine.settings", sessionIdleMinutes: 30, maxLiveSessions: 0 });
  assert.equal((await settings()).sessionIdleMinutes, 30);
  assert.equal((await settings()).maxLiveSessions, 1, "one live session is the smallest budget there is");
  assert.equal(JSON.parse(readFileSync(join(A.home, "daemon.json"), "utf8")).sessionIdleMinutes, 30, "and survives a restart");
  assert.deepEqual(await budget(), { idleMinutes: 30, liveLimit: 1, sessionMemoryBytes: 300 * 1024 * 1024 }, "the resolved figures follow the settings");

  await a.command({ type: "machine.settings", defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null });
  assert.deepEqual(await settings(), { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null, webEnabled: null, bind: "loopback" }, "and can be cleared again");
  assert.deepEqual(await budget(), fresh, "and the resolved figures come back with them");
});

test("streaming is a per-thread switch that needs no restart", async () => {
  const projectId = (await a.rpc("shell.snapshot", {})).projects[0]!.id;
  const threadId = randomUUID();
  await a.command({ type: "thread.create", projectId, threadId, sessionId: randomUUID() });
  assert.equal((await a.rpc("thread.snapshot", { threadId })).thread.streaming, false, "off until asked for");

  await a.rpc("thread.subscribe", { threadId, sinceSeq: 0 });
  a.pushes.length = 0;
  await a.command({ type: "thread.setStreaming", threadId, streaming: true });
  assert.equal((await a.rpc("thread.snapshot", { threadId })).thread.streaming, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    a.pushes.some((p) => p.push === "shell" && p.event.kind === "thread.upserted" && p.event.thread.id === threadId && p.event.thread.streaming),
    "the switch is broadcast, so a second client's palette agrees",
  );

  await a.command({ type: "thread.setStreaming", threadId, streaming: false });
  assert.equal((await a.rpc("thread.snapshot", { threadId })).thread.streaming, false);
  await a.command({ type: "thread.delete", threadId });
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

/**
 * Regression test for the first half of issue #7. Put `daemonVersion: "0.0.1"`
 * back in `runDaemon` and this fails: the package version never moves, so no
 * client can tell that a machine runs older code than it does.
 */
test("a machine reports the build it runs, not a package version that never moves", async () => {
  const info = (await a.rpc("shell.snapshot", {})).machine;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: here, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "--short", "HEAD");
  const expected = git("status", "--porcelain") ? `${commit}-dirty` : commit;

  assert.notEqual(info.daemonVersion, "0.0.1", "the package version identifies no build");
  assert.equal(info.daemonVersion, expected, "daemonVersion is the commit of the build the daemon runs");

  assert.ok(info.build, "MachineInfo.build is what lets a client order two machines");
  assert.equal(info.build!.commit, commit);
  assert.ok(info.build!.committedAt && Number.isFinite(Date.parse(info.build!.committedAt)),
    "the commit date is the only field that orders builds across machines with their own clocks");

  // Two daemons out of one checkout run the same build, and the client says so
  // rather than guessing from a local mtime.
  const other = (await b.rpc("shell.snapshot", {})).machine;
  assert.equal(other.build!.commit, info.build!.commit);
});

// It waits on a real model twice, up to 180s and then 120s, so it needs far
// more than the suite-wide `--test-timeout`. It says so here rather than
// forcing that bound up for every other test in the repo.
test("live: a real turn streams items, folds a second message in, and captures a diff", { skip: !process.env.COVEY_LIVE_TESTS, timeout: 600_000 }, async () => {
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
  const tree = (await b.rpc("thread.snapshot", { threadId })).thread.worktreePath!;
  assert.match(readFileSync(join(tree, "README.md"), "utf8"), /second/);
  await b.command({ type: "turn.revert", threadId, turnId: editTurn });
  assert.equal(readFileSync(join(tree, "README.md"), "utf8"), "hello\n", "README restored");
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
