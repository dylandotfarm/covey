/**
 * Regression test for the composer footer.
 *
 * The footer printed `$0.420`. Two things were wrong with that: the figure was
 * `total_cost_usd`, which is the whole session and not the turn it sat under,
 * and a bare `$` reads as money charged. On a subscription plan nothing of the
 * sort is charged — the number is the SDK's own estimate at list prices.
 *
 * The first half is fixed in the daemon and covered by
 * `packages/daemon/src/usageRegression.test.ts`. This covers the label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LatestTurn } from "@covey/protocol";
import { turnStats } from "./components/Composer.js";

function turn(o: Partial<LatestTurn>): LatestTurn {
  return {
    turnId: "turn-1", state: "completed",
    startedAt: "2026-09-15T10:00:00.000Z", completedAt: "2026-09-15T10:00:12.000Z",
    ...o,
  };
}

test("regression: the footer cost is marked as an estimate, never as a bill", () => {
  const s = turnStats(turn({ costUsd: 0.42 }));
  assert.ok(s.startsWith("~$"),
    `the footer reads "${s}". A bare "$" reads as money charged; on a subscription plan ` +
    "this figure is the SDK's list-price estimate and nothing is billed.");
  assert.match(s, /^~\$0\.420 · /);
});

test("the footer still reports the cost and the duration it always did", () => {
  assert.equal(turnStats(turn({ costUsd: 1.5 })), "~$1.500 · 12.0s");
  // Nothing to say while the turn runs, or when the daemon sent no figure.
  assert.equal(turnStats(turn({ state: "running", costUsd: 1.5 })), "");
  assert.equal(turnStats(turn({})), "");
  assert.equal(turnStats(null), "");
  assert.equal(turnStats(undefined), "");
});
