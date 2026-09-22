import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, ShellEvent, Thread } from "@covey/protocol";
import { KNOWN_MODELS } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { toChoices, type ClaudeModels, type SdkModelInfo } from "./models.js";

/**
 * The model list a machine offers, read from the Claude Code installed on it.
 *
 * A list covey ships goes stale the day a model ships. These tests hold the
 * answer a real `supportedModels` gave, so the mapping is checked against the
 * shape the SDK actually sends rather than one invented here, and they check
 * that the engine publishes the answer and reads it again when the install
 * under it changes. Nothing here starts a Claude Code: the engine takes the
 * reader as an option, and the test hands in a function.
 */

/** What `supportedModels()` answered on 2026-09-22, copied whole. */
const SDK_ANSWER: SdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];

test("an answer from Claude Code becomes the picker's rows, and its Default row becomes covey's empty id", () => {
  const read = toChoices(SDK_ANSWER);
  assert.ok(read);
  // The ids are Claude Code's own values, aliases and all. An alias is the
  // better thing to store: it names the newest model of its family, so a
  // thread pinned to it follows the install instead of freezing.
  assert.deepEqual(read.models.map((m) => m.id), ["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]);
  assert.deepEqual(read.models.map((m) => m.label), ["Opus (1M context)", "Fable", "Sonnet", "Haiku"]);
  // Which version each row is, in Claude Code's own words. This is what tells
  // a reader one Opus from the next.
  assert.equal(read.models[2]!.description, "Sonnet 5 · Efficient for routine tasks");
  assert.equal(read.models[2]!.resolved, "claude-sonnet-5");
  // Claude Code's "Default" is covey's "no model set", not a fifth model.
  assert.equal(read.claudeDefault?.id, "");
  assert.equal(read.claudeDefault?.description, "Opus 5 with 1M context · Best for everyday, complex tasks");
  assert.ok(!read.models.some((m) => m.id === ""), "and it is not offered twice");
});

test("an answer covey cannot use is no answer, so the fallback list stands", () => {
  assert.equal(toChoices([]), null);
  assert.equal(toChoices([{ value: "default", displayName: "Default" }]), null, "a default alone is nothing to pick from");
  // A row the SDK sends without the two fields covey needs is dropped, and the
  // rest of the answer still stands.
  const read = toChoices([{ value: "sonnet", displayName: "Sonnet" }, { displayName: "no value" }, { value: "no-name" }]);
  assert.deepEqual(read?.models.map((m) => m.id), ["sonnet"]);
});

test("the engine publishes the list it read, and a machine that cannot read one keeps the fallback", async () => {
  const h = setup({ readModels: async () => toChoices(SDK_ANSWER) });
  try {
    // Before the read answers, a picker still has rows to show.
    assert.deepEqual(h.engine.models(), KNOWN_MODELS);
    await h.engine.refreshModels();
    assert.deepEqual(h.engine.models().map((m) => m.id), ["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]);
    assert.equal(h.machine.claudeDefaultModel?.id, "");
    // Clients already connected are told, so a picker opened a moment too
    // early is corrected rather than left wrong.
    assert.deepEqual(h.events.map((e) => e.kind), ["machine.updated"]);
    assert.deepEqual((h.events[0] as { machine: MachineInfo }).machine.models, h.engine.models());
  } finally { h.cleanup(); }

  // A machine with no credentials, no `claude`, or a Claude Code too old to
  // answer keeps a shorter picker rather than no picker.
  const quiet = setup({ readModels: async () => null });
  try {
    await quiet.engine.refreshModels();
    assert.deepEqual(quiet.engine.models(), KNOWN_MODELS);
    assert.deepEqual(quiet.events, [], "and says nothing it does not know");
  } finally { quiet.cleanup(); }
});

test("a session that reports a newer Claude Code makes the daemon read the list again", async () => {
  let answer = toChoices(SDK_ANSWER);
  let reads = 0;
  const h = setup({ readModels: async () => { reads++; return answer; } });
  try {
    await h.engine.refreshModels();
    assert.equal(reads, 1);

    // The user updated Claude Code under the running daemon. The next session
    // says so, which is the one signal that costs nothing — without it the
    // daemon offers last week's models until somebody restarts it.
    answer = toChoices([...SDK_ANSWER, { value: "opus-next", resolvedModel: "claude-opus-6", displayName: "Opus (next)", description: "Opus 6" }]);
    await h.send("t1", "hello");
    assert.equal(reads, 2);
    assert.equal(h.machine.claudeCodeVersion, "9.9.9");
    assert.ok(h.engine.models().some((m) => m.id === "opus-next"), "the new model is offered without a covey release");

    // The version it already knows is not news, so a busy daemon does not
    // start a Claude Code per session to be told what it has.
    await h.send("t2", "hello");
    assert.equal(reads, 2);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------

const MACHINE = (): MachineInfo => ({
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, claudeCodeVersion: "1.0.0",
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

/** An engine whose sessions are stand-ins and whose model reader is a function. */
function setup(opts: { readModels: () => Promise<ClaudeModels | null> }) {
  const dir = mkdtempSync(join(tmpdir(), "covey-models-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const machine = MACHINE();
  const engine = new Engine(db, machine, { readModels: opts.readModels, spawn: ({ prompt, options }) => fakeCli(prompt, options) });
  // Only what a client would see, so the assertions are about the wire.
  const events: ShellEvent[] = [];
  engine.onShell((e) => { if (e.kind === "machine.updated") events.push(e); });
  return {
    db, engine, machine, events, dir,
    async send(threadId: string, text: string) {
      if (!db.getThread(threadId)) db.putThread(thread(threadId));
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text });
      for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * A stand-in for one CLI subprocess. It says hello the way the real one does —
 * an `init` message that names the Claude Code it is — and answers the turn.
 */
function fakeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
  options.abortController?.signal.addEventListener("abort", () => { done = true; wake?.(); });
  void (async () => {
    for await (const _ of prompt) {
      push({ type: "system", subtype: "init", model: "sonnet", claude_code_version: "9.9.9", permissionMode: "default" });
      push({ type: "result", subtype: "success", is_error: false, result: "hi", modelUsage: {}, user_message_uuid: null });
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (done) return;
        if (out.length === 0) { await new Promise<void>((r) => (wake = r)); continue; }
        yield out.shift() as never;
      }
    },
    supportedCommands: async () => [],
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
  } as unknown as Query;
}
