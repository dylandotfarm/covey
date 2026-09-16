import { test } from "node:test";
import assert from "node:assert/strict";
import { rewindAction, INTERRUPT_SETTLE_MS, REWIND_CHORD_MS, type RewindContext } from "./rewind.js";

/** An idle thread, nothing waiting, no esc pressed before this one. */
const ctx = (over: Partial<RewindContext> = {}): RewindContext => ({
  running: false,
  pending: false,
  sinceInterruptMs: Number.POSITIVE_INFINITY,
  sinceArmMs: Number.POSITIVE_INFINITY,
  ...over,
});

test("one esc interrupts a running turn, as it always has", () => {
  assert.equal(rewindAction(ctx({ running: true })), "interrupt");
  // Even armed: a turn that runs is what esc is for.
  assert.equal(rewindAction(ctx({ running: true, sinceArmMs: 10 })), "interrupt");
});

test("esc esc on an idle thread opens the rewind picker", () => {
  assert.equal(rewindAction(ctx()), "arm");
  assert.equal(rewindAction(ctx({ sinceArmMs: 0 })), "open");
  assert.equal(rewindAction(ctx({ sinceArmMs: REWIND_CHORD_MS - 1 })), "open");
});

test("two presses further apart than the chord window do not chord", () => {
  assert.equal(rewindAction(ctx({ sinceArmMs: REWIND_CHORD_MS })), "arm");
});

test("a second esc after an interrupt does not offer a rewind", () => {
  // The trap. The turn has stopped by now, so nothing else holds this press.
  assert.equal(rewindAction(ctx({ sinceInterruptMs: 0 })), "none");
  assert.equal(rewindAction(ctx({ sinceInterruptMs: 250 })), "none");
  assert.equal(rewindAction(ctx({ sinceInterruptMs: INTERRUPT_SETTLE_MS - 1 })), "none");
  // …and it cannot open one even if a press before the interrupt armed it.
  assert.equal(rewindAction(ctx({ sinceInterruptMs: 100, sinceArmMs: 100 })), "none");
});

test("the chord comes back after the interrupt has settled", () => {
  assert.equal(rewindAction(ctx({ sinceInterruptMs: INTERRUPT_SETTLE_MS })), "arm");
});

test("a waiting approval or question holds esc", () => {
  assert.equal(rewindAction(ctx({ pending: true })), "none");
  assert.equal(rewindAction(ctx({ pending: true, sinceArmMs: 10 })), "none");
  // A turn still runs under the request: interrupting it stays the first job.
  assert.equal(rewindAction(ctx({ pending: true, running: true })), "interrupt");
});
