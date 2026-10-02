import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread, ThreadEvent } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

/**
 * `/clear`: empty the conversation and keep the thread (#16).
 *
 * The clients only send the command; everything the reader can see afterwards
 * is decided here, so this drives whole turns through the engine. Nothing
 * starts a Claude Code — the engine takes its spawn as an option — and nothing
 * reaches a model: the title and the chain sentence are both off for this
 * file, so a title here is always the derived one.
 */

process.env.COVEY_ACTIVITY_MODEL = "off";
process.env.COVEY_TITLE_MODEL = "off";

test("the conversation goes and the thread stays", async () => {
  const h = setup();
  try {
    await h.turn("t1", "fix the reconnect loop");
    assert.ok(h.db.listItems("t1", 500).items.length > 0, "the turn wrote items");
    const before = h.db.getThread("t1")!;

    await h.clear("t1");

    const after = h.db.getThread("t1")!;
    assert.deepEqual(h.db.listItems("t1", 500).items, [], "every item went");
    // What the thread *is* does not change: a cleared thread is the same
    // thread, in the same place, on the same branch.
    assert.equal(after.id, before.id);
    assert.equal(after.projectId, before.projectId);
    assert.equal(after.worktreePath, before.worktreePath);
    assert.equal(after.branch, before.branch);
    assert.equal(after.model, before.model);
    assert.equal(after.permissionMode, before.permissionMode);
    assert.equal(after.status, "idle");
    assert.equal(after.latestTurn, null);
  } finally { h.cleanup(); }
});

test("the next message names the thread again", async () => {
  const h = setup();
  try {
    await h.turn("t2", "fix the reconnect loop");
    assert.equal(h.db.getThread("t2")!.title, "fix the reconnect loop");

    await h.clear("t2");
    // Back to the automatic state, so the sidebar says what it says for a
    // thread nobody has written to yet.
    assert.equal(h.db.getThread("t2")!.title, "New thread");
    assert.equal(h.db.getThread("t2")!.titleAuto, true);

    await h.turn("t2", "now the backoff timer");
    assert.equal(h.db.getThread("t2")!.title, "now the backoff timer");
  } finally { h.cleanup(); }
});

test("a thread the reader named by hand keeps that name", async () => {
  const h = setup();
  try {
    await h.turn("t3", "fix the reconnect loop");
    await h.engine.dispatch({ commandId: randomUUID(), type: "thread.rename", threadId: "t3", title: "websockets" });
    assert.equal(h.db.getThread("t3")!.titleAuto, false);

    await h.clear("t3");
    // `titleAuto` says whose title it is, and a rename clears it. A name covey
    // took here would be a name nothing could give back: it is in no row, there
    // is no undo, and the next message would write its own first line over it.
    assert.equal(h.db.getThread("t3")!.title, "websockets");
    assert.equal(h.db.getThread("t3")!.titleAuto, false);

    await h.turn("t3", "now the backoff timer");
    assert.equal(h.db.getThread("t3")!.title, "websockets", "and the next message does not take it either");
  } finally { h.cleanup(); }
});

test("the thread keeps its place in the sidebar", async () => {
  const h = setup();
  try {
    await h.turn("t4", "fix the reconnect loop");
    const sent = h.db.getThread("t4")!.lastMessageAt;
    assert.ok(sent, "the turn stamped the thread");

    await h.clear("t4");
    // The sidebar orders a project's threads by `lastMessageAt`, so this field
    // is what holds the row where the reader left it. `startTurn` reads the
    // title to decide whether to name the thread, and needs nothing from here.
    assert.equal(h.db.getThread("t4")!.lastMessageAt, sent);
  } finally { h.cleanup(); }
});

test("the model is left with no memory of what was said", async () => {
  const h = setup();
  try {
    await h.turn("t5", "fix the reconnect loop");
    const old = h.db.getThread("t5")!.sessionId;
    // The mirror of the SDK's own transcript: what a resumed session reads
    // back, and the one copy of the conversation covey does not own.
    h.db.appendTranscript("t5", old, "", [{ type: "user", message: { content: "fix the reconnect loop" } }]);
    h.db.appendTranscript("t5", old, "sub-1", [{ type: "user", message: { content: "a subagent's own" } }]);
    assert.equal(h.db.transcriptHasMessages("t5", old), true);

    await h.clear("t5");

    const fresh = h.db.getThread("t5")!.sessionId;
    assert.notEqual(fresh, old, "a new session id, so the next turn starts rather than resumes");
    assert.equal(h.db.loadTranscript("t5", old, ""), null, "the transcript went");
    assert.equal(h.db.loadTranscript("t5", old, "sub-1"), null, "and so did the subagents'");
    assert.equal(h.db.loadTranscript("t5", fresh, ""), null, "and nothing stands behind the new id");
  } finally { h.cleanup(); }
});

test("one event says the transcript went, however long it was", async () => {
  const h = setup();
  try {
    await h.turn("t6", "fix the reconnect loop");
    h.events.length = 0;

    await h.clear("t6");
    await new Promise((r) => setTimeout(r, 2)); // the listeners run on a microtask

    // One `thread.cleared` rather than an `item.removed` per item: a long
    // transcript would be a thousand events for one act.
    assert.deepEqual(h.events.map((e) => e.kind), ["thread.cleared", "thread.updated"]);
  } finally { h.cleanup(); }
});

test("the checkpoints stay, because they name real commits", async () => {
  const h = setup();
  try {
    await h.turn("t7", "fix the reconnect loop");
    const turnId = h.db.getThread("t7")!.latestTurn!.turnId;
    assert.ok(h.db.getCheckpoint("t7", turnId));

    await h.clear("t7");
    // The clear empties the conversation and touches no file, so the git trees
    // of each turn still describe the working tree as it was.
    assert.ok(h.db.getCheckpoint("t7", turnId), "the turn's trees are still there");
  } finally { h.cleanup(); }
});

test("a clear is refused while the turn it would delete is running", async () => {
  const h = setup();
  try {
    h.db.putThread(thread("t8", h.dir));
    // Not awaited: the fake CLI holds this turn open until the test lets go.
    const running = h.turn("t8", "fix the reconnect loop", { hold: true });
    for (let i = 0; i < 40 && h.db.getThread("t8")!.latestTurn?.state !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(h.db.getThread("t8")!.latestTurn?.state, "running");

    await assert.rejects(
      h.clear("t8"),
      (e: any) => e.code === "busy" && /interrupt the running turn/.test(e.message),
    );
    h.release();
    await running;
  } finally { h.cleanup(); }
});

test("a thread nobody knows cannot be cleared", async () => {
  const h = setup();
  try {
    await assert.rejects(h.clear("nope"), (e: any) => e.code === "not_found");
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-clear-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  /** Set while a turn is meant to stay running, and how to let it go. */
  let holding = false;
  let letGo: (() => void) | null = null;
  const engine = new Engine(db, MACHINE(), {
    spawn: ({ prompt, options }) => fakeCli(prompt, options, () => (holding ? new Promise<void>((r) => { letGo = r; }) : null)),
  });
  const events: ThreadEvent[] = [];
  engine.onThread((_id, e: ThreadEvent) => events.push(e));
  return {
    db, engine, events, dir,
    /** Send one turn and wait for it to settle, unless `hold` keeps it open. */
    async turn(threadId: string, text: string, opts?: { hold?: boolean }) {
      holding = opts?.hold ?? false;
      if (!db.getThread(threadId)) db.putThread(thread(threadId, dir));
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text });
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 1));
    },
    /** Let a held turn finish. */
    release() { holding = false; letGo?.(); letGo = null; },
    clear(threadId: string) {
      return engine.dispatch({ commandId: randomUUID(), type: "thread.clear", threadId });
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const MACHINE = (): MachineInfo => ({
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, claudeCodeVersion: "1.0.0",
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

function thread(id: string, cwd: string): Thread {
  return {
    id, projectId: "p1", title: "New thread", titleAuto: true, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: `covey/${id}`, worktreePath: cwd, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * A stand-in for one CLI subprocess. It says one line and ends the turn, or
 * waits on `gate` first, which is how a test holds a turn open.
 */
function fakeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options, gate: () => Promise<void> | null): Query {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
  options.abortController?.signal.addEventListener("abort", () => { done = true; wake?.(); });
  void (async () => {
    for await (const _ of prompt) {
      push({ type: "system", subtype: "init", model: "sonnet", claude_code_version: "1.0.0", permissionMode: "default" });
      push({ type: "assistant", message: { id: `blk-${randomUUID().slice(0, 8)}`, model: "sonnet", content: [{ type: "text", text: "Looking." }] } });
      const held = gate();
      if (held) await held;
      if (done) return;
      push({ type: "result", subtype: "success", is_error: false, result: "done", modelUsage: {}, user_message_uuid: null });
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
