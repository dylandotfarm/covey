import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FLEET, cleanFleet, fleetKey, fleetNameError, fleetOf, fleetScope, isDefaultFleet, sortFleets } from "./fleets.js";

test("a machine with nothing to say is in the default fleet", () => {
  assert.equal(fleetOf(), DEFAULT_FLEET);
  assert.equal(fleetOf(null, null), DEFAULT_FLEET);
  assert.equal(fleetOf("  ", ""), DEFAULT_FLEET);
});

test("the machine's own answer wins; the cache answers for a machine that is away", () => {
  assert.equal(fleetOf("work", "personal"), "work");
  assert.equal(fleetOf(null, "personal"), "personal");
  // A machine that was moved back into the default fleet says so, and the
  // stale cache must not pull it out again.
  assert.equal(fleetOf(DEFAULT_FLEET, "work"), DEFAULT_FLEET);
});

test("one fleet whatever the case was typed in", () => {
  assert.equal(fleetKey("Work"), fleetKey("work"));
  assert.equal(fleetKey(""), DEFAULT_FLEET);
  assert.ok(isDefaultFleet("Covey"));
  assert.ok(!isDefaultFleet("work"));
});

test("the default fleet leads, and the rest are in name order", () => {
  assert.deepEqual(sortFleets(["work", "covey", "personal"]), ["covey", "personal", "work"]);
  // One name, however many machines said it, and the first spelling is kept.
  assert.deepEqual(sortFleets(["Work", "work", "WORK"]), ["Work"]);
});

test("a fleet name is a label, not a key", () => {
  assert.equal(fleetNameError("work"), null);
  assert.equal(fleetNameError("  home lab "), null);
  assert.ok(fleetNameError(""));
  assert.ok(fleetNameError("a".repeat(25)));
  assert.ok(fleetNameError("work:1"));
  assert.ok(fleetNameError("work\n2"));
});

test("a fold the reader made before fleets existed still applies", () => {
  // The default fleet scopes nothing, so a project's key is the pool key it
  // always was; a second fleet scopes its own.
  assert.equal(fleetScope(DEFAULT_FLEET), "");
  assert.equal(fleetScope("Covey"), "");
  assert.equal(fleetScope("Work"), "work/");
  assert.notEqual(fleetScope("work"), fleetScope("personal"));
});

test("a name keeps the spaces out of it", () => {
  assert.equal(cleanFleet("  work  "), "work");
  assert.equal(cleanFleet("   "), null);
  assert.equal(cleanFleet(undefined), null);
});
