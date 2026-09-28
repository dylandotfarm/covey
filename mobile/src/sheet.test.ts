/**
 * One choice on a sheet, as the command it stands for.
 *
 * The page has the same mapping in its `main.ts` and the two must stay in step.
 * The cases that matter are the ones where a value means "unset": a model of
 * `""` clears the setting and the thread falls back to what the machine, and
 * then Claude Code itself, says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetCommand } from "./sheet";

const thread = { kind: "thread", machine: "ws://pi:3790", threadId: "t1" } as const;
const machine = { kind: "machine", machine: "ws://pi:3790" } as const;

test("a thread's settings become the thread commands", () => {
  assert.deepEqual(sheetCommand(thread, "model", "opus"), { type: "thread.setModel", threadId: "t1", model: "opus" });
  assert.deepEqual(sheetCommand(thread, "mode", "plan"), { type: "thread.setPermissionMode", threadId: "t1", mode: "plan" });
  assert.deepEqual(sheetCommand(thread, "streaming", "on"), { type: "thread.setStreaming", threadId: "t1", streaming: true });
  assert.deepEqual(sheetCommand(thread, "streaming", "off"), { type: "thread.setStreaming", threadId: "t1", streaming: false });
});

test("an empty model clears the setting rather than naming a model called nothing", () => {
  assert.deepEqual(sheetCommand(thread, "model", ""), { type: "thread.setModel", threadId: "t1", model: null });
  assert.deepEqual(sheetCommand(machine, "model", ""), { type: "machine.settings", defaultModel: null });
  assert.deepEqual(sheetCommand(machine, "mode", ""), { type: "machine.settings", defaultPermissionMode: null });
});

test("a machine's settings become one machine.settings command each", () => {
  assert.deepEqual(sheetCommand(machine, "web", "on"), { type: "machine.settings", webEnabled: true });
  assert.deepEqual(sheetCommand(machine, "web", "off"), { type: "machine.settings", webEnabled: false });
  assert.deepEqual(sheetCommand(machine, "streaming", "on"), { type: "machine.settings", defaultStreaming: true });
});

test("the session limits go through budgetValue, so 'the daemon's default' is null", () => {
  const live = sheetCommand(machine, "live", "");
  assert.ok(live && "maxLiveSessions" in live);
  const idle = sheetCommand(machine, "idle", "");
  assert.ok(idle && "sessionIdleMinutes" in idle);
});

test("a page that names no setting is no command, on either kind of sheet", () => {
  assert.equal(sheetCommand(thread, "", "x"), null);
  assert.equal(sheetCommand(thread, "nonsense", "x"), null);
  assert.equal(sheetCommand(machine, "", "x"), null);
  assert.equal(sheetCommand(machine, "nonsense", "x"), null);
  // A thread's sheet has no web server row and no session limits: those belong
  // to the machine, and a thread page must not make a machine command.
  assert.equal(sheetCommand(thread, "web", "on"), null);
  assert.equal(sheetCommand(thread, "live", "4"), null);
});
