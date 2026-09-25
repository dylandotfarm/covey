/**
 * The two session limits, as a reader sees them.
 *
 * `maxLiveSessions` and `sessionIdleMinutes` decide how much memory a machine
 * spends on live Claude sessions, and a `null` in either means "the daemon's
 * own default". The whole point of this module is that neither reads as the
 * word "default" when the daemon said what the default resolves to: the live
 * ceiling comes from the machine's own memory, so 4 on a laptop and 8 on a
 * workstation are both "from memory" and a reader cannot act on that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionBudget } from "@covey/protocol";
import { budgetValue, idleChoices, idleLabel, idleValueLabel, liveChoices, liveValueLabel, sessionMemoryLabel } from "./sessionBudget.js";

const BUDGET: SessionBudget = { idleMinutes: 120, liveLimit: 8, sessionMemoryBytes: 300 * 1024 * 1024 };

test("an idle limit reads in the largest unit that divides it", () => {
  assert.equal(idleLabel(0), "never");
  assert.equal(idleLabel(1), "1 minute");
  assert.equal(idleLabel(30), "30 minutes");
  assert.equal(idleLabel(60), "1 hour");
  assert.equal(idleLabel(120), "2 hours");
  // 90 minutes is not a whole number of hours, so it stays minutes rather than
  // becoming "1.5 hours".
  assert.equal(idleLabel(90), "90 minutes");
});

test("no setting names the daemon's default and the number behind it", () => {
  assert.equal(idleValueLabel(null, BUDGET), "default (2 hours)");
  assert.equal(liveValueLabel(null, BUDGET), "from memory (8)");
  // A setting of its own is the whole answer; the default is beside the point.
  assert.equal(idleValueLabel(30, BUDGET), "30 minutes");
  assert.equal(idleValueLabel(0, BUDGET), "never");
  assert.equal(liveValueLabel(2, BUDGET), "2");
});

test("a daemon too old to send a budget says the word alone, never a guess", () => {
  assert.equal(idleValueLabel(null, undefined), "default");
  assert.equal(liveValueLabel(null, undefined), "from memory");
  assert.equal(sessionMemoryLabel(4, undefined), "", "no cost is known, so none is claimed");
  // The pickers still work: a reader on an old daemon can set a number, they
  // just cannot be told what the default was.
  assert.deepEqual(liveChoices(null, undefined).map((c) => c.id), ["", "1", "2", "3", "4", "6", "8", "12"]);
  assert.ok(liveChoices(null, undefined).every((c) => !c.hint.includes("GB")));
  assert.equal(liveChoices(null, undefined)[0]!.label, "From memory", "no figure to name, so none is named");
  assert.equal(idleChoices(null, undefined)[0]!.label, "Default");
});

test("every live-session row is priced, because the memory is what is being chosen", () => {
  const rows = liveChoices(null, BUDGET);
  assert.equal(rows.find((c) => c.id === "1")!.hint, "about 0.3 GB");
  assert.equal(rows.find((c) => c.id === "4")!.hint, "about 1.3 GB");
  assert.equal(rows.find((c) => c.id === "12")!.hint, "about 3.8 GB");
  // The figure is in the label, because a client writes "current" over the
  // hint of the row in force and that is exactly the row carrying the figure.
  assert.equal(rows[0]!.label, "From memory (8)");
});

test("the row in force is marked, and it is the only one", () => {
  assert.deepEqual(liveChoices(null, BUDGET).filter((c) => c.current).map((c) => c.id), [""]);
  assert.deepEqual(liveChoices(4, BUDGET).filter((c) => c.current).map((c) => c.id), ["4"]);
  assert.deepEqual(idleChoices(null, BUDGET).filter((c) => c.current).map((c) => c.id), [""]);
  assert.deepEqual(idleChoices(0, BUDGET).filter((c) => c.current).map((c) => c.id), ["0"]);
  assert.deepEqual(idleChoices(120, BUDGET).filter((c) => c.current).map((c) => c.id), ["120"]);
  // A value covey does not offer as a row — set from `daemon.json` or from
  // `COVEY_SESSION_IDLE_MINUTES` — marks nothing rather than the nearest row.
  assert.deepEqual(idleChoices(45, BUDGET).filter((c) => c.current).map((c) => c.id), []);
  assert.equal(idleValueLabel(45, BUDGET), "45 minutes", "but the row above still shows it");
});

test("never comes second, and its hint refuses to be read as no limit", () => {
  const rows = idleChoices(null, BUDGET);
  assert.deepEqual(rows.slice(0, 2).map((c) => c.label), ["Default (2 hours)", "Never"]);
  assert.match(rows[1]!.hint, /live-session limit/);
  // The price of a release is named on the short waits and nowhere else: a
  // resumed session cannot refresh its own token.
  assert.match(rows.find((c) => c.id === "15")!.hint, /cannot refresh/);
  assert.equal(rows.find((c) => c.id === "120")!.hint, "", "two hours needs no warning; it is the default");
});

test("an empty id is the one that clears the setting", () => {
  assert.equal(budgetValue(""), null);
  assert.equal(budgetValue("0"), 0);
  assert.equal(budgetValue("120"), 120);
});
