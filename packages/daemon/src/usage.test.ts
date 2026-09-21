/**
 * Usage accounting: the SDK reports running totals for a whole session, so a
 * turn's own spend is a difference. These tests pin that arithmetic and the
 * `turns` table that stores the result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Thread, TurnRecord } from "@covey/protocol";
import { turnUsageDelta, type ModelUsageLike } from "./claude.js";
import { Db } from "./db.js";

const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";

function usage(o: Partial<ModelUsageLike>): ModelUsageLike {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0, ...o };
}

test("a turn's figures are the difference from the session's running total", () => {
  // Turn 1: the session has spent this much in all.
  const first = turnUsageDelta({}, {
    [OPUS]: usage({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 900, cacheReadInputTokens: 0, costUSD: 0.4 }),
  });
  assert.equal(first.inputTokens, 100);
  assert.equal(first.estimatedCostUsd, 0.4);

  // Turn 2 reports the total so far, not the turn. The turn spent the rest.
  const base = { [OPUS]: usage({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 900, cacheReadInputTokens: 0, costUSD: 0.4 }) };
  const second = turnUsageDelta(base, {
    [OPUS]: usage({ inputTokens: 130, outputTokens: 210, cacheCreationInputTokens: 1500, cacheReadInputTokens: 12_000, costUSD: 1.1 }),
  });
  assert.equal(second.inputTokens, 30);
  assert.equal(second.outputTokens, 160);
  assert.equal(second.cacheCreationInputTokens, 600);
  assert.equal(second.cacheReadInputTokens, 12_000);
  assert.ok(Math.abs(second.estimatedCostUsd - 0.7) < 1e-9);

  // The two turns add up to the session total, which is the whole point.
  assert.ok(Math.abs(first.estimatedCostUsd + second.estimatedCostUsd - 1.1) < 1e-9);
});

test("cache figures are kept, and they can dominate the input count", () => {
  const d = turnUsageDelta({}, {
    [OPUS]: usage({ inputTokens: 12, outputTokens: 300, cacheCreationInputTokens: 4_000, cacheReadInputTokens: 180_000, costUSD: 0.9 }),
  });
  assert.equal(d.cacheReadInputTokens, 180_000);
  assert.equal(d.cacheCreationInputTokens, 4_000);
  assert.ok(d.cacheReadInputTokens > d.inputTokens * 1000);
});

test("a turn that used several models keeps the split, busiest first", () => {
  const base = { [OPUS]: usage({ outputTokens: 100, costUSD: 1 }) };
  const d = turnUsageDelta(base, {
    [OPUS]: usage({ outputTokens: 400, costUSD: 3 }),
    [HAIKU]: usage({ outputTokens: 900, costUSD: 0.02 }),
  });
  assert.deepEqual(d.byModel.map((m) => m.model), [HAIKU, OPUS]);
  assert.equal(d.byModel[0]!.outputTokens, 900);
  assert.equal(d.byModel[1]!.outputTokens, 300);
  assert.equal(d.outputTokens, 1200);
});

test("a model the turn did not touch contributes nothing", () => {
  const base = { [OPUS]: usage({ outputTokens: 100, costUSD: 1 }), [HAIKU]: usage({ outputTokens: 40, costUSD: 0.01 }) };
  const d = turnUsageDelta(base, { ...base, [OPUS]: usage({ outputTokens: 180, costUSD: 1.6 }) });
  assert.deepEqual(d.byModel.map((m) => m.model), [OPUS]);
  assert.equal(d.outputTokens, 80);
});

test("a counter that went down means the session reset, so the new value is the delta", () => {
  // A resumed session starts its totals fresh. Without this the turn would
  // report a negative — or, worse, a number clamped to zero and lost.
  const base = { [OPUS]: usage({ inputTokens: 5_000, outputTokens: 9_000, costUSD: 12 }) };
  const d = turnUsageDelta(base, { [OPUS]: usage({ inputTokens: 40, outputTokens: 70, costUSD: 0.05 }) });
  assert.equal(d.inputTokens, 40);
  assert.equal(d.outputTokens, 70);
  assert.equal(d.estimatedCostUsd, 0.05);
});

// ---------------------------------------------------------------------------
// The turns table
// ---------------------------------------------------------------------------

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "covey-usage-"));
  return { db: new Db(dir), dir };
}

function project(id: string, title: string): Project {
  const now = new Date().toISOString();
  return { id, title, workspaceRoot: `/tmp/${id}`, repositoryIdentity: null, defaultModel: null, createdAt: now, updatedAt: now };
}

function thread(id: string, projectId: string, title: string): Thread {
  const now = new Date().toISOString();
  return {
    id, projectId, title, provider: "claude", sessionId: `s-${id}`, model: OPUS,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: now, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: now, updatedAt: now,
  };
}

function turn(o: Partial<TurnRecord> & { turnId: string; threadId: string; projectId: string; endedAt: string }): TurnRecord {
  const cost = o.estimatedCostUsd ?? 1;
  return {
    startedAt: o.endedAt, state: "completed", model: OPUS,
    inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40,
    estimatedCostUsd: cost, byModel: [{ model: OPUS, inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40, estimatedCostUsd: cost }],
    ...o,
  };
}

test("turns accumulate, and a window selects them by end time", () => {
  const { db, dir } = tempDb();
  try {
    db.putProject(project("p1", "covey"));
    db.putThread(thread("t1", "p1", "First thread"));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "a", endedAt: "2026-09-01T10:00:00.000Z", estimatedCostUsd: 0.5 }));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "b", endedAt: "2026-09-10T10:00:00.000Z", estimatedCostUsd: 0.25 }));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "c", endedAt: "2026-09-15T10:00:00.000Z", estimatedCostUsd: 2 }));

    const all = db.usageTotals();
    assert.equal(all.turns, 3);
    assert.equal(all.estimatedCostUsd, 2.75);
    assert.equal(all.cacheReadInputTokens, 120);
    assert.equal(all.inputTokens, 30);

    const recent = db.usageTotals("2026-09-05T00:00:00.000Z");
    assert.equal(recent.turns, 2);
    assert.equal(recent.estimatedCostUsd, 2.25);

    const middle = db.usageTotals("2026-09-05T00:00:00.000Z", "2026-09-12T00:00:00.000Z");
    assert.equal(middle.turns, 1);
    assert.equal(middle.estimatedCostUsd, 0.25);

    // An empty window answers zero rather than failing.
    const none = db.usageTotals("2027-01-01T00:00:00.000Z");
    assert.equal(none.turns, 0);
    assert.equal(none.estimatedCostUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row is written once per turn, so a rewrite does not double the total", () => {
  const { db, dir } = tempDb();
  try {
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "a", endedAt: "2026-09-01T10:00:00.000Z", estimatedCostUsd: 0.5 }));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "a", endedAt: "2026-09-01T10:00:00.000Z", estimatedCostUsd: 0.5 }));
    assert.equal(db.usageTotals().turns, 1);
    assert.equal(db.usageTotals().estimatedCostUsd, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("totals group by thread, by project and by model", () => {
  const { db, dir } = tempDb();
  try {
    db.putProject(project("p1", "covey"));
    db.putProject(project("p2", "other"));
    db.putThread(thread("t1", "p1", "First thread"));
    db.putThread(thread("t2", "p1", "Second thread"));
    db.putThread(thread("t3", "p2", "Elsewhere"));
    const at = "2026-09-10T10:00:00.000Z";
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "a", endedAt: at, estimatedCostUsd: 1 }));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "b", endedAt: at, estimatedCostUsd: 2 }));
    db.putTurn(turn({ threadId: "t2", projectId: "p1", turnId: "c", endedAt: at, estimatedCostUsd: 4 }));
    db.putTurn(turn({
      threadId: "t3", projectId: "p2", turnId: "d", endedAt: at, estimatedCostUsd: 8, model: HAIKU,
      byModel: [
        { model: HAIKU, inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 3 },
        { model: OPUS, inputTokens: 9, outputTokens: 18, cacheCreationInputTokens: 30, cacheReadInputTokens: 40, estimatedCostUsd: 5 },
      ],
    }));

    const threads = db.usageGroups("thread");
    assert.deepEqual(threads.map((g) => [g.key, g.label, g.turns, g.estimatedCostUsd]), [
      ["t3", "Elsewhere", 1, 8],
      ["t2", "Second thread", 1, 4],
      ["t1", "First thread", 2, 3],
    ]);

    const projects = db.usageGroups("project");
    assert.deepEqual(projects.map((g) => [g.key, g.label, g.turns, g.estimatedCostUsd]), [
      ["p2", "other", 1, 8],
      ["p1", "covey", 3, 7],
    ]);

    // The model split comes from `byModel`: one turn can span two models, so
    // its row cannot be charged to just one of them.
    const models = db.usageGroups("model");
    assert.deepEqual(models.map((g) => [g.key, g.estimatedCostUsd]), [[OPUS, 12], [HAIKU, 3]]);
    assert.equal(models.reduce((n, g) => n + g.estimatedCostUsd, 0), db.usageTotals().estimatedCostUsd);

    // A window applies to a grouped total too.
    assert.equal(db.usageGroups("thread", "2027-01-01T00:00:00.000Z").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the thread keeps the turns: the tokens were still spent", () => {
  const { db, dir } = tempDb();
  try {
    db.putProject(project("p1", "covey"));
    db.putThread(thread("t1", "p1", "First thread"));
    db.putTurn(turn({ threadId: "t1", projectId: "p1", turnId: "a", endedAt: "2026-09-10T10:00:00.000Z", estimatedCostUsd: 3 }));
    db.deleteThread("t1");

    assert.equal(db.usageTotals().estimatedCostUsd, 3);
    const groups = db.usageGroups("thread");
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.label, "(deleted thread)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn keeps its per-model split for a later re-price", () => {
  const { db, dir } = tempDb();
  try {
    db.putTurn(turn({
      threadId: "t1", projectId: "p1", turnId: "a", endedAt: "2026-09-10T10:00:00.000Z", model: OPUS,
      byModel: [
        { model: OPUS, inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: 7, cacheReadInputTokens: 8, estimatedCostUsd: 1 },
        { model: HAIKU, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0.01 },
      ],
    }));
    const rows = db.listTurns("t1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.model, OPUS);
    assert.deepEqual(rows[0]!.byModel.map((m) => m.model), [OPUS, HAIKU]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
