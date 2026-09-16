/**
 * The usage overlay's arithmetic and formatting. Every machine answers for
 * itself, so the client's job is to add the answers up and say plainly that
 * the cost is an estimate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageReport, UsageTotals } from "@covey/protocol";
import { USAGE_WINDOWS, usageWindow, sumUsage, usageRows, fmtTokens, fmtCost } from "./store.js";

function totals(o: Partial<UsageTotals>): UsageTotals {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0, ...o };
}

function report(machineId: string, machineName: string, groups: { key: string; label: string; total: Partial<UsageTotals> }[]): UsageReport {
  const full = groups.map((g) => ({ key: g.key, label: g.label, ...totals(g.total) }));
  return { machineId, machineName, since: null, until: null, groupBy: "thread", total: sumUsage(full), groups: full };
}

test("a window starts at the reader's own midnight", () => {
  const now = new Date(2026, 8, 15, 14, 30); // 15 September 2026, local
  const today = usageWindow(0, now);
  assert.equal(today.until, null, "the window runs up to now, with no upper bound");
  assert.equal(new Date(today.since!).getTime(), new Date(2026, 8, 15).getTime());

  // "Last 7 days" covers today and the six days before it.
  const week = usageWindow(1, now);
  assert.equal(new Date(week.since!).getTime(), new Date(2026, 8, 9).getTime());
  const month = usageWindow(2, now);
  assert.equal(new Date(month.since!).getTime(), new Date(2026, 7, 17).getTime());

  // All time has no bound at either end.
  assert.deepEqual(usageWindow(3, now), { since: null, until: null });
  // An index out of range falls back rather than throwing.
  assert.deepEqual(usageWindow(99, now), usageWindow(0, now));
  assert.equal(USAGE_WINDOWS.length, 4);
});

test("a window crossing a month boundary still lands on a midnight", () => {
  const now = new Date(2026, 2, 3, 9, 0); // 3 March 2026
  assert.equal(new Date(usageWindow(1, now).since!).getTime(), new Date(2026, 1, 25).getTime());
});

test("machine answers add up", () => {
  const a = totals({ turns: 3, inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 900, estimatedCostUsd: 1.5 });
  const b = totals({ turns: 2, inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 100, estimatedCostUsd: 0.5 });
  assert.deepEqual(sumUsage([a, b]), totals({ turns: 5, inputTokens: 14, outputTokens: 26, cacheReadInputTokens: 1000, estimatedCostUsd: 2 }));
  assert.deepEqual(sumUsage([]), totals({}));
});

test("rows from several machines sort together, biggest first, and keep the machine name", () => {
  const rows = usageRows([
    report("m1", "laptop", [{ key: "t1", label: "Cheap", total: { estimatedCostUsd: 1 } }, { key: "t2", label: "Dear", total: { estimatedCostUsd: 9 } }]),
    report("m2", "desktop", [{ key: "t1", label: "Middling", total: { estimatedCostUsd: 4 } }]),
  ], "thread");
  assert.deepEqual(rows.map((r) => r.label), ["Dear", "Middling", "Cheap"]);
  assert.deepEqual(rows.map((r) => r.machine), ["laptop", "desktop", "laptop"]);
  // Two machines can use the same thread id; the rows must stay apart.
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
});

test("grouping by machine drops the machine tag, since the label already is it", () => {
  const rows = usageRows([
    report("m1", "laptop", [{ key: "m1", label: "laptop", total: { estimatedCostUsd: 2 } }]),
    report("m2", "desktop", [{ key: "m2", label: "desktop", total: { estimatedCostUsd: 5 } }]),
  ], "machine");
  assert.deepEqual(rows.map((r) => [r.label, r.machine]), [["desktop", ""], ["laptop", ""]]);
});

test("one model on two machines is one row", () => {
  const rows = usageRows([
    report("m1", "laptop", [{ key: "opus", label: "opus", total: { turns: 2, estimatedCostUsd: 3 } }]),
    report("m2", "desktop", [
      { key: "opus", label: "opus", total: { turns: 1, estimatedCostUsd: 4 } },
      { key: "haiku", label: "haiku", total: { turns: 5, estimatedCostUsd: 0.1 } },
    ]),
  ], "model");
  assert.deepEqual(rows.map((r) => [r.label, r.total.turns, r.total.estimatedCostUsd]), [["opus", 3, 7], ["haiku", 5, 0.1]]);
  // A model is not a machine's, so no row claims one — not even the model
  // that only one machine happened to run.
  assert.deepEqual(rows.map((r) => r.machine), ["", ""]);
});

test("token counts stay narrow enough for a column", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(812), "812");
  assert.equal(fmtTokens(1_200), "1.2k");
  assert.equal(fmtTokens(42_300), "42k");
  assert.equal(fmtTokens(1_240_000), "1.2M");
  assert.equal(fmtTokens(12_400_000), "12M");
  for (const n of [0, 999, 1_000, 999_999, 1_000_000, 987_654_321]) assert.ok(fmtTokens(n).length <= 6, `${n} → ${fmtTokens(n)}`);
});

test("every cost carries a ~, so it never reads as a bill", () => {
  assert.equal(fmtCost(0), "~$0");
  assert.equal(fmtCost(0.0004), "~$0.01", "a real but tiny spend is not rounded away to nothing");
  assert.equal(fmtCost(1.234), "~$1.23");
  assert.equal(fmtCost(412.7), "~$413");
  for (const n of [0, 0.001, 1.5, 99.99, 1234]) assert.ok(fmtCost(n).startsWith("~$"), `${n} → ${fmtCost(n)}`);
});
