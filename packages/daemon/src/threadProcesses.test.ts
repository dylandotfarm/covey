/**
 * The processes an archive stops.
 *
 * The list is the whole safety of this: a process on it gets `SIGKILL`, so a
 * process that is not the thread's work must never be on it. The fake `/proc`
 * holds each case that could put one there, and the engine test at the foot
 * starts a real process and archives the thread that owns it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { autoReply, fakeCli, settle } from "./claudeFake.js";
import { commandLabel, findThreadProcesses, processLabels, stopProcesses, stoppedNote, stoppedPreface } from "./threadProcesses.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fakeProc(entries: { pid: number; ppid: number; env: string[]; argv: string[]; comm?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "covey-proc-"));
  dirs.push(root);
  for (const e of entries) {
    const d = join(root, String(e.pid));
    mkdirSync(d);
    writeFileSync(join(d, "environ"), e.env.join("\0") + "\0");
    writeFileSync(join(d, "cmdline"), e.argv.join("\0") + "\0");
    writeFileSync(join(d, "stat"), `${e.pid} (${e.comm ?? "x"}) S ${e.ppid} ${e.pid} ${e.pid} 0 -1`);
  }
  mkdirSync(join(root, "self"));
  return root;
}

const WRAP = (cmd: string) =>
  `/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval '${cmd.replaceAll("'", `'"'"'`)}' && pwd -P >| /tmp/claude-1-cwd`;

test("only a tool call of this thread is on the list", () => {
  const mark = "COVEY_THREAD_ID=t1";
  const root = fakeProc([
    // The daemon, and the session it started: neither is a tool call.
    { pid: 10, ppid: 1, env: ["HOME=/h"], argv: ["node", "main.js"] },
    { pid: 20, ppid: 10, env: [mark], argv: ["claude", "--output-format", "stream-json"] },
    // A background task, and the server it started.
    { pid: 30, ppid: 20, env: [mark, "CLAUDECODE=1"], argv: [WRAP("npm run dev")] },
    { pid: 31, ppid: 30, env: [mark, "CLAUDECODE=1"], argv: ["node", "vite"], comm: "node (vite)" },
    // A `nohup … &` that left the tree, and a tool call of another thread.
    { pid: 40, ppid: 1, env: [mark, "CLAUDECODE=1"], argv: ["python3", "-m", "http.server", "8000"] },
    { pid: 50, ppid: 1, env: ["COVEY_THREAD_ID=t10", "CLAUDECODE=1"], argv: ["sleep", "100"] },
    // The daemon's own parent chain carries the mark when an agent started it.
    { pid: 60, ppid: 1, env: [mark, "CLAUDECODE=1"], argv: ["bash"] },
    { pid: 61, ppid: 60, env: [mark, "CLAUDECODE=1"], argv: ["node", "throwaway-daemon"] },
  ]);
  const ps = findThreadProcesses("t1", { procRoot: root, self: 61 });
  assert.deepEqual(ps.map((p) => p.pid), [30, 31, 40]);
  assert.deepEqual(processLabels(ps), ["npm run dev", "python3 -m http.server 8000"]);
});

test("a label is the command the agent wrote", () => {
  assert.equal(commandLabel(WRAP("cd web && pnpm dev --port 'a b'")), "cd web && pnpm dev --port 'a b'");
  assert.equal(commandLabel("node   server.js\n"), "node server.js");
  assert.equal(commandLabel("x".repeat(500)).length, 120);
});

test("the note and the preface name every command, up to a bound", () => {
  assert.equal(stoppedNote(["npm run dev"]), "Archived · stopped a process that this thread started: `npm run dev`");
  assert.match(stoppedNote(["npm run dev"], "Moved"), /^Moved · stopped a process/);
  const many = Array.from({ length: 10 }, (_, i) => `job ${i}`);
  assert.match(stoppedNote(many), /stopped 10 processes .*`job 7`, and 2 more$/);
  const preface = stoppedPreface(["npm run dev"]);
  assert.match(preface, /^covey: this thread was archived/);
  assert.match(preface, /^- npm run dev$/m);
  assert.match(preface, /start it again/);
});

test("a process that ignores SIGTERM is killed after the grace period", { skip: process.platform === "win32" }, async () => {
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100));
  const exited = new Promise((r) => child.once("exit", (_code, signal) => r(signal)));
  await stopProcesses([{ pid: child.pid!, ppid: process.pid, command: "sh" }], 200);
  assert.equal(await exited, "SIGKILL");
});

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

test("an archive stops the thread's server, and the next turn tells the agent", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-archive-proc-"));
  dirs.push(dir);
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const id = `t-${randomUUID()}`;
  db.putThread({
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Thread);
  const cli = fakeCli();
  const engine = new Engine(db, { ...MACHINE }, { spawn: autoReply(cli) });
  const command = (cmd: Record<string, unknown>) => engine.dispatch({ commandId: randomUUID(), ...cmd } as never);

  // What a `nohup … &` in a tool call leaves: its own session, the marks.
  const server = spawn("sleep", ["300"], {
    detached: true, stdio: "ignore",
    env: { ...process.env, COVEY_THREAD_ID: id, CLAUDECODE: "1" },
  });
  server.unref();
  const exited = new Promise((r) => server.once("exit", () => r(true)));
  await new Promise((r) => setTimeout(r, 100));

  await command({ type: "thread.archive", threadId: id, archived: true });
  assert.equal(await exited, true);
  assert.deepEqual(db.getThread(id)!.stoppedProcesses, ["sleep 300"]);
  const notes = db.listItems(id).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
  assert.ok(notes.includes("Archived · stopped a process that this thread started: `sleep 300`"), notes.join("\n"));

  // A turn that fails has not been read, so the next one carries the list too.
  cli.refusal = "API Error: 500 the server had an error";
  await command({ type: "turn.send", threadId: id, turnId: randomUUID(), text: "is the page up?" });
  await settle();
  assert.match(JSON.stringify(cli.sent[0]?.message.content), /- sleep 300/);
  assert.deepEqual(db.getThread(id)!.stoppedProcesses, ["sleep 300"]);
  cli.refusal = null;

  await command({ type: "turn.send", threadId: id, turnId: randomUUID(), text: "is the page up?" });
  await settle();
  const first = JSON.stringify(cli.sent[1]?.message.content);
  assert.match(first, /covey stopped the processes/);
  assert.match(first, /- sleep 300/);
  assert.match(first, /is the page up\?/);
  assert.equal(db.getThread(id)!.stoppedProcesses, null);
  // The reader's own message is what they wrote, and nothing more.
  const user = db.listItems(id).items.find((i) => i.kind === "user") as { text: string };
  assert.equal(user.text, "is the page up?");

  await command({ type: "turn.send", threadId: id, turnId: randomUUID(), text: "thanks" });
  await settle();
  assert.doesNotMatch(JSON.stringify(cli.sent.at(-1)?.message.content), /covey stopped/);
  engine.shutdown();
});
