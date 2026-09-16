import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, SlashCommandInfo, Thread, ThreadEvent } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

const MACHINE = {
  machineId: "m1", name: "test", os: "darwin", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null },
} as MachineInfo;

const THREAD = {
  id: "t1", projectId: "p1", title: "t", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
} as Thread;

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
