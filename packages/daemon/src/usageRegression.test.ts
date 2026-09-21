/**
 * Regression tests for the figures covey records per turn.
 *
 * Each case here fails against the code as it was before this fix, and the
 * failure names the defect rather than a missing field. To keep that true the
 * stub sink reads through `turnFigures`, which understands both the old sink
 * payload (`costUsd` / `inputTokens` / `outputTokens`) and the new one
 * (`usage`). So reverting the fix changes the *numbers* a case sees, not the
 * shape, and the assertion still reports what went wrong.
 *
 * The defects, each with its own case:
 *  1. `total_cost_usd` is a running total for the session, and was stored as
 *     though it were one turn's cost.
 *  2. `usage` covers the main agent loop only, so subagent tokens were lost.
 *  3. The cache counts were never read, though they dominate a long thread.
 *  4. A finished turn was not kept anywhere, so nothing accumulated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, Thread, Project } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";

/** One entry of the SDK's `modelUsage`, which is cumulative for the session. */
function model(o: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number; cost?: number }) {
  return {
    inputTokens: o.input ?? 0,
    outputTokens: o.output ?? 0,
    cacheCreationInputTokens: o.cacheWrite ?? 0,
    cacheReadInputTokens: o.cacheRead ?? 0,
    webSearchRequests: 0,
    costUSD: o.cost ?? 0,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  };
}

/**
 * A `result` message as the SDK sends it in a streaming-input session.
 * `total_cost_usd` and `modelUsage` are running totals for the whole session;
 * `usage` is this turn's, but for the main agent loop only.
 */
function result(o: {
  totalCostUsd: number;
  modelUsage: Record<string, ReturnType<typeof model>>;
  mainLoop: { input: number; output: number };
}) {
  return {
    type: "result", subtype: "success", is_error: false, result: "ok",
    duration_ms: 1000, duration_api_ms: 900, num_turns: 1, stop_reason: "end_turn",
    total_cost_usd: o.totalCostUsd,
    usage: { input_tokens: o.mainLoop.input, output_tokens: o.mainLoop.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: o.modelUsage,
    permission_denials: [], uuid: "u1", session_id: "s1",
  } as any;
}

/**
 * What the sink was told this turn spent, read from either payload shape.
 * A missing figure reads as 0, so a case that the old code fails reports
 * "expected N, got 0" — the defect — and not a property access on undefined.
 */
function turnFigures(info: any) {
  const u = info?.usage;
  return {
    estimatedCostUsd: u?.estimatedCostUsd ?? info?.costUsd ?? 0,
    inputTokens: u?.inputTokens ?? info?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? info?.outputTokens ?? 0,
    cacheCreationInputTokens: u?.cacheCreationInputTokens ?? info?.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: u?.cacheReadInputTokens ?? info?.cacheReadInputTokens ?? 0,
  };
}

/** A session with a sink that only records, plus the turns it was told about. */
function session() {
  const turns: ReturnType<typeof turnFigures>[] = [];
  const sink: SessionSink = {
    upsertItem: () => {},
    getItemByToolUse: () => null,
    onStatus: () => {},
    onTurnComplete: (info) => { turns.push(turnFigures(info)); },
    onSessionInit: () => {},
    onModelUsed: () => {},
    onCommands: () => {},
    now: () => new Date().toISOString(),
  };
  const s = new ClaudeSession({
    threadId: "t1", sessionId: "s1", projectId: "p1", cwd: "/tmp", model: OPUS,
    permissionMode: "default", permissionModeExplicit: false, streaming: false, resume: false,
    sessionStore: { append: () => {}, load: () => null } as any,
  }, sink);
  // `handle` is the SDK message pump's body. Driving it directly exercises the
  // real translation without starting a subprocess.
  return { turns, feed: (msg: unknown) => (s as any).handle(msg) };
}

test("regression: a turn's cost is its own, not the session's running total", () => {
  const { turns, feed } = session();
  // Turn 1 cost $0.40. The SDK reports the session total, which is the same
  // thing while only one turn has run.
  feed(result({ totalCostUsd: 0.4, mainLoop: { input: 100, output: 50 }, modelUsage: { [OPUS]: model({ input: 100, output: 50, cost: 0.4 }) } }));
  // Turn 2 cost $0.70. The SDK reports $1.10 — the session so far.
  feed(result({ totalCostUsd: 1.1, mainLoop: { input: 30, output: 160 }, modelUsage: { [OPUS]: model({ input: 130, output: 210, cost: 1.1 }) } }));

  assert.equal(turns.length, 2);
  assert.ok(Math.abs(turns[0]!.estimatedCostUsd - 0.4) < 1e-9, `turn 1 cost $0.40, got $${turns[0]!.estimatedCostUsd}`);
  assert.ok(Math.abs(turns[1]!.estimatedCostUsd - 0.7) < 1e-9,
    `turn 2 cost $0.70 — the session total $1.10 less turn 1's $0.40 — but the turn reports $${turns[1]!.estimatedCostUsd}. ` +
    "Storing total_cost_usd per turn double counts every earlier turn.");

  // The real damage is what a sum does. Three turns, each counting every turn
  // before it, is why a month's total came out several times too large.
  const summed = turns.reduce((n, t) => n + t.estimatedCostUsd, 0);
  assert.ok(Math.abs(summed - 1.1) < 1e-9, `the turns must sum to the session's $1.10, not $${summed.toFixed(2)}`);
});

test("regression: a subagent's tokens are counted, not just the main agent loop", () => {
  const { turns, feed } = session();
  // The main loop spent 300 output tokens; a Task subagent on another model
  // spent 900 more. `usage` sees only the first, `modelUsage` sees both.
  feed(result({
    totalCostUsd: 3.02,
    mainLoop: { input: 40, output: 300 },
    modelUsage: { [OPUS]: model({ input: 40, output: 300, cost: 3 }), [HAIKU]: model({ input: 20, output: 900, cost: 0.02 }) },
  }));

  assert.equal(turns[0]!.outputTokens, 1200,
    `the turn spent 1200 output tokens (300 in the main loop, 900 in a subagent) but reports ${turns[0]!.outputTokens}. ` +
    "r.usage is documented as main-agent-loop only and misses every subagent.");
  assert.ok(Math.abs(turns[0]!.estimatedCostUsd - 3.02) < 1e-9, `the subagent's cost counts too, got $${turns[0]!.estimatedCostUsd}`);
});

test("regression: the cache counts are recorded, and they dwarf the plain input count", () => {
  const { turns, feed } = session();
  feed(result({
    totalCostUsd: 0.9,
    mainLoop: { input: 12, output: 300 },
    modelUsage: { [OPUS]: model({ input: 12, output: 300, cacheWrite: 4_000, cacheRead: 180_000, cost: 0.9 }) },
  }));

  assert.equal(turns[0]!.cacheReadInputTokens, 180_000,
    `180000 tokens were read from the cache, but the turn records ${turns[0]!.cacheReadInputTokens}. ` +
    "A total that leaves the cache out understates a long thread by orders of magnitude.");
  assert.equal(turns[0]!.cacheCreationInputTokens, 4_000,
    `4000 tokens were written to the cache, but the turn records ${turns[0]!.cacheCreationInputTokens}`);
  // The point of keeping them: the plain input count is a rounding error here.
  assert.ok(turns[0]!.cacheReadInputTokens > turns[0]!.inputTokens * 1_000);
});

// ---------------------------------------------------------------------------
// Nothing accumulated: a finished turn was kept nowhere
// ---------------------------------------------------------------------------

function tempEngine(): { engine: Engine; db: Db; dir: string; threadId: string } {
  const dir = mkdtempSync(join(tmpdir(), "covey-usage-reg-"));
  const db = new Db(dir);
  const machine: MachineInfo = {
    machineId: "m1", name: "test", os: "darwin", arch: "arm64", homeDir: "/tmp",
    daemonVersion: "0.0.1", protocolVersion: 1,
    capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
    settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
  };
  const now = new Date().toISOString();
  const project: Project = { id: "p1", title: "covey", workspaceRoot: "/tmp/p1", repositoryIdentity: null, defaultModel: null, createdAt: now, updatedAt: now };
  const thread: Thread = {
    id: "t1", projectId: "p1", title: "A thread", provider: "claude", sessionId: "s1", model: OPUS,
    permissionMode: "default", branch: null, worktreePath: null, status: "running", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: now, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: now, updatedAt: now,
  };
  db.putProject(project);
  db.putThread(thread);
  return { engine: new Engine(db, machine), db, dir, threadId: "t1" };
}

/** Finish one turn on the engine, the way the SDK session would. */
function completeTurn(engine: Engine, db: Db, threadId: string, turnId: string, cost: number) {
  const t = db.getThread(threadId)!;
  t.latestTurn = { turnId, state: "running", startedAt: new Date().toISOString(), completedAt: null };
  db.putThread(t);
  const sink = (engine as any).sinkFor(threadId);
  sink.onTurnComplete({
    usage: {
      inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 300, cacheReadInputTokens: 400,
      estimatedCostUsd: cost, byModel: [{ model: OPUS, inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 300, cacheReadInputTokens: 400, estimatedCostUsd: cost }],
    },
    isError: false, result: "ok", userMessageUuid: null,
  });
}

test("regression: every finished turn is kept, so a total outlives the turn after it", () => {
  const { engine, db, dir, threadId } = tempEngine();
  try {
    completeTurn(engine, db, threadId, "turn-1", 0.4);
    completeTurn(engine, db, threadId, "turn-2", 0.7);
    completeTurn(engine, db, threadId, "turn-3", 0.9);

    const total = db.usageTotals();
    assert.equal(total.turns, 3,
      `three turns finished but ${total.turns} were kept. A thread holds one latestTurn and the next turn ` +
      "overwrites it, so without a row per turn nothing accumulates.");
    assert.ok(Math.abs(total.estimatedCostUsd - 2.0) < 1e-9,
      `the three turns cost $2.00 in all, but the total reads $${total.estimatedCostUsd}`);
    // The figures survive in full, not just the cost.
    assert.equal(total.cacheReadInputTokens, 1200);
    assert.equal(total.outputTokens, 600);

    // And the thread itself still knows only about the last one, which is the
    // reason the table has to exist.
    assert.equal(db.getThread(threadId)!.latestTurn!.turnId, "turn-3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
