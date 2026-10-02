import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { threadIsBusy, type MachineInfo, type Project, type Thread, type TimelineItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

/**
 * A turn for the work a background task wakes (#156).
 *
 * The CLI starts work covey never asked for: a task reports, the agent reads
 * files and writes prose, and covey holds no turn. These drive the messages of
 * that run past a `ClaudeSession` and watch which turn each item lands under.
 */

const INIT = {
  type: "system", subtype: "init", model: "claude-opus-5", claude_code_version: "2.1.0",
  permissionMode: "default", slash_commands: [], cwd: "/tmp", tools: [], mcp_servers: [],
  apiKeySource: "none", output_style: "default", skills: [], plugins: [], uuid: "u0", session_id: "s1",
};

function says(id: string, text: string) {
  return {
    type: "assistant",
    message: { id, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] },
    parent_tool_use_id: null, session_id: "s1", uuid: `u-${id}`,
  };
}

const RESULT = {
  type: "result", subtype: "success", is_error: false, result: "done",
  duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: "s1", uuid: "u-r",
  total_cost_usd: 0, usage: {}, modelUsage: {},
};

/** A query the test feeds one message at a time. */
function driver() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const q = {
    async *[Symbol.asyncIterator]() {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield queue.shift()!;
      }
    },
    supportedCommands: async () => [],
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    backgroundTasks: async () => true,
  } as unknown as Query;
  const kick = () => { const w = wake; wake = null; w?.(); };
  return {
    q,
    async push(...msgs: unknown[]) {
      queue.push(...msgs);
      kick();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    },
    end() { done = true; kick(); },
  };
}

interface Seen {
  items: TimelineItem[];
  /** The turn ids covey minted for work no message asked for. */
  opened: string[];
  completed: number;
}

function harness(opts: { openTurns?: boolean } = {}) {
  const seen: Seen = { items: [], opened: [], completed: 0 };
  const sink: SessionSink = {
    now: () => "2026-01-01T00:00:00Z",
    upsertItem: (item) => { seen.items.push(item); },
    getItemByToolUse: () => null,
    onStatus: () => {},
    onTurnComplete: () => { seen.completed++; },
    onUnpromptedTurn: () => {
      if (opts.openTurns === false) return null;
      const id = `bg${seen.opened.length + 1}`;
      seen.opened.push(id);
      return id;
    },
    onSessionInit: () => {},
    onModelUsed: () => {},
    onCommands: () => {},
  };
  const store = { append: () => {}, load: () => null, listSessions: () => [] } as unknown as SessionStore;
  const d = driver();
  const session = new ClaudeSession(
    { threadId: "t1", sessionId: "s1", projectId: "p1", cwd: "/tmp", model: null, permissionMode: "default", permissionModeExplicit: false, streaming: false, resume: false, sessionStore: store },
    sink,
    () => d.q,
  );
  return { seen, session, d };
}

/** The turn ids of the assistant rows, in the order they were written. */
function turnsOf(seen: Seen): (string | null)[] {
  return seen.items.filter((i) => i.kind === "assistant").map((i) => i.turnId);
}

test("work after the result lands under a turn covey opens", async () => {
  const { seen, session, d } = harness();
  session.start();
  session.sendTurn("t-1", "do the thing");
  await d.push(INIT, says("m1", "started the build"), RESULT);
  assert.deepEqual(turnsOf(seen), ["t-1"], "the asked-for turn carries its own id");
  assert.equal(seen.opened.length, 0, "a turn in flight needs no second one");
  assert.equal(session.busy, false, "the result ended the turn");

  // The build finishes and the CLI hands the notification to the agent.
  await d.push(says("m2", "the build passed"));
  assert.equal(seen.opened.length, 1, "the first line of the work opens a turn");
  assert.deepEqual(turnsOf(seen), ["t-1", "bg1"], "the work is filed under it");
  assert.equal(session.activeTurnId, "bg1");
  assert.equal(session.busy, true, "the thread reads busy while the agent writes");

  // The same result path ends it, and accounts for it.
  await d.push(RESULT);
  assert.equal(seen.completed, 2, "each turn reports its own figures");
  assert.equal(session.activeTurnId, null);
  assert.equal(session.busy, false);

  // One turn per stretch of work, not one per message.
  await d.push(says("m3", "and the tests"), says("m4", "pass"));
  assert.equal(seen.opened.length, 2);
  assert.deepEqual(turnsOf(seen).slice(-2), ["bg2", "bg2"]);
  d.end();
});

test("the tail of an interrupted turn opens no turn", async () => {
  const { seen, session, d } = harness();
  session.start();
  session.sendTurn("t-1", "do the thing");
  await d.push(INIT, says("m1", "working"));
  await session.interrupt();
  assert.equal(session.busy, false, "esc ended the turn");

  // Whatever the CLI was part way through writing still arrives.
  await d.push(says("m2", "half a sentence"));
  assert.equal(seen.opened.length, 0, "esc must not leave the thread running");
  await d.push(RESULT);

  // The next wake is real work again.
  await d.push(says("m3", "the task finished"));
  assert.equal(seen.opened.length, 1, "the flag does not stick");
  d.end();
});

test("a thread that is gone leaves the items under no turn", async () => {
  const { seen, session, d } = harness({ openTurns: false });
  session.start();
  await d.push(INIT, says("m1", "woken"));
  assert.deepEqual(turnsOf(seen), [null], "no turn, and no crash");
  d.end();
});

// ---------------------------------------------------------------------------
// The same run through a whole engine, which is where the thread's status and
// the `turns` row come from.
// ---------------------------------------------------------------------------

const MACHINE = (): MachineInfo => ({
  machineId: "m1", name: "test", os: "linux", arch: "x64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

/** One stand-in for a CLI subprocess, which the test writes for. */
function makeCli(options: Options) {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); const w = wake; wake = null; w?.(); };
  const query = {
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
    backgroundTasks: async () => true,
  } as unknown as Query;
  options.abortController?.signal.addEventListener("abort", () => { done = true; const w = wake; wake = null; w?.(); });
  return {
    query,
    say(text: string) { push({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: "opus", content: [{ type: "text", text }] } }); },
    /** `outputTokens` is the session's running total, which is what the SDK
     *  reports; the engine differences it per turn. */
    end(text: string, outputTokens: number) { push({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: { opus: { inputTokens: outputTokens, outputTokens, costUSD: 0.01 } }, user_message_uuid: null }); },
  };
}

const settle = async () => { for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0)); };

test("a background task that wakes the agent gives the thread a turn to read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-woken-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  db.putThread({
    id: "t1", projectId: "p1", title: "t1", provider: "claude", sessionId: "sess-t1", model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Thread);
  let cli: ReturnType<typeof makeCli> | null = null;
  const engine = new Engine(db, MACHINE(), {
    spawn: ({ options }) => { cli = makeCli(options); return cli.query; },
  });
  try {
    await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId: "t1", turnId: "turn-1", text: "start the build in the background" });
    await settle();
    cli!.say("The build is running. I will report when it lands.");
    cli!.end("started", 20);
    await settle();
    assert.equal(db.getThread("t1")!.status, "idle", "the turn ended");
    assert.equal(db.listTurns("t1").length, 1);

    // The task reports and the CLI hands the notification to the agent.
    cli!.say("The build passed, so I am opening the pull request.");
    await settle();
    const woken = db.getThread("t1")!;
    assert.equal(woken.status, "running", "the thread must not read idle while the agent writes");
    assert.equal(woken.latestTurn!.state, "running");
    assert.equal(woken.latestTurn!.unprompted, true, "and it says no message asked for the work");
    assert.equal(threadIsBusy(woken), true);
    assert.notEqual(woken.latestTurn!.turnId, "turn-1");

    const said = engine.threadSnapshot("t1").items.filter((i) => i.kind === "assistant");
    assert.equal(said.at(-1)!.turnId, woken.latestTurn!.turnId, "the work is filed under the new turn");

    // It ends and is accounted for like any other turn.
    cli!.end("opened", 50);
    await settle();
    const rows = db.listTurns("t1");
    assert.equal(rows.length, 2, "the work has a row of its own");
    assert.equal(rows[0]!.outputTokens, 20);
    assert.equal(rows[1]!.outputTokens, 30, "with the tokens it alone spent");
    assert.equal(db.getThread("t1")!.status, "idle");
  } finally {
    engine.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
