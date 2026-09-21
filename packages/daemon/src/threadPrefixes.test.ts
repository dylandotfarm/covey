import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, Project, SlashCommandInfo, Thread, ThreadEvent } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "darwin", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

const THREAD: Thread = {
  id: "t1", projectId: "p1", title: "t", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const COMPACT: SlashCommandInfo = { name: "compact", description: "Compact the conversation", argumentHint: "", source: "sdk" };
const USAGE: SlashCommandInfo = { name: "usage", description: "Cost and limits", argumentHint: "", source: "sdk" };

/** An engine on a throwaway database, holding one thread that has never run. */
function setup(): { dir: string; db: Db; engine: Engine; events: ThreadEvent[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "covey-commands-"));
  const db = new Db(dir);
  db.putThread(THREAD);
  const engine = new Engine(db, MACHINE);
  const events: ThreadEvent[] = [];
  engine.onThread((_id, ev) => events.push(ev));
  return { dir, db, engine, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Listeners are told after the commit, on the next microtask. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a thread that has never run says its commands are not known yet", (t) => {
  const s = setup();
  t.after(s.cleanup);
  assert.equal(s.engine.threadSnapshot("t1").commands, null);
});

test("the list the session reported reaches the snapshot and the subscribers", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.engine.setThreadCommands("t1", [COMPACT]);
  await settle();
  assert.deepEqual(s.engine.threadSnapshot("t1").commands, [COMPACT]);
  const ev = s.events.find((e) => e.kind === "commands.updated");
  assert.deepEqual(ev && ev.kind === "commands.updated" ? ev.commands : null, [COMPACT]);
});

test("a session that has no commands is not the same as a session nobody asked", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.engine.setThreadCommands("t1", []);
  await settle();
  assert.deepEqual(s.engine.threadSnapshot("t1").commands, []);
});

test("the same list again costs no event: every session start re-sends it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.engine.setThreadCommands("t1", [COMPACT]);
  await settle();
  const before = s.events.length;
  s.engine.setThreadCommands("t1", [{ ...COMPACT }]);
  await settle();
  assert.equal(s.events.length, before);
});

test("a longer list replaces the old one whole, the way the SDK pushes it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.engine.setThreadCommands("t1", [COMPACT]);
  s.engine.setThreadCommands("t1", [COMPACT, USAGE]);
  await settle();
  assert.deepEqual(s.engine.threadSnapshot("t1").commands, [COMPACT, USAGE]);
  assert.equal(s.events.filter((e) => e.kind === "commands.updated").length, 2);
});

test("a thread that has run keeps its menu when the daemon restarts", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.engine.setThreadCommands("t1", [COMPACT]);
  await settle();
  const again = new Engine(new Db(s.dir), MACHINE);
  assert.deepEqual(again.threadSnapshot("t1").commands, [COMPACT]);
});

// ---- the `@` menu ---------------------------------------------------------

/** A project directory with a few names in it, and a thread that works there. */
function withFiles(): { engine: Engine; root: string; cleanup: () => void } {
  const s = setup();
  const root = mkdtempSync(join(tmpdir(), "covey-files-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, ".gitignore"), "");
  s.db.putProject({
    id: "p1", title: "p", workspaceRoot: root, repositoryIdentity: null, defaultModel: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  return { engine: s.engine, root, cleanup: () => { s.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

test("the thread's own directory lists, directories before files", (t) => {
  const s = withFiles();
  t.after(s.cleanup);
  const r = s.engine.listThreadDir("t1", "");
  assert.deepEqual(r.entries, [
    { name: "src", isDir: true },
    { name: ".gitignore", isDir: false },
    { name: "README.md", isDir: false },
  ]);
  assert.equal(r.truncated, false);
});

test("a directory inside it lists too", (t) => {
  const s = withFiles();
  t.after(s.cleanup);
  assert.deepEqual(s.engine.listThreadDir("t1", "src/").entries, [{ name: "index.ts", isDir: false }]);
});

test("a name half typed is not an error: it is what typing looks like", (t) => {
  const s = withFiles();
  t.after(s.cleanup);
  assert.deepEqual(s.engine.listThreadDir("t1", "sr").entries, []);
  // A file is not a directory, and asking for its contents is the same case.
  assert.deepEqual(s.engine.listThreadDir("t1", "README.md").entries, []);
});

test("a mention cannot walk out of the thread's directory", (t) => {
  const s = withFiles();
  t.after(s.cleanup);
  assert.throws(() => s.engine.listThreadDir("t1", "../"), /outside the thread/);
  assert.throws(() => s.engine.listThreadDir("t1", "src/../../"), /outside the thread/);
});

test("a directory larger than the cap comes back short, and says so", (t) => {
  const s = withFiles();
  t.after(s.cleanup);
  for (let i = 0; i < 12; i++) writeFileSync(join(s.root, `f${i}.ts`), "");
  const r = s.engine.listThreadDir("t1", "", 5);
  assert.equal(r.entries.length, 5);
  assert.equal(r.truncated, true);
});
