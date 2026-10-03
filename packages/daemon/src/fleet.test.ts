/**
 * The machine's half of a fleet.
 *
 * A fleet is a setting on the daemon, so every client that dials the machine
 * groups it the same way. Two rules hold it together: a machine in the default
 * fleet writes nothing down, and a daemon that is updated does not lose the
 * list of machines its page dials — `peers` is what `fleet` used to mean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COVEY_HOME = mkdtempSync(join(tmpdir(), "covey-fleet-"));

const { dataDir, fleetName, fleetSetting, machineSettings, readPeers, savePeers } = await import("./config.js");

const file = () => join(dataDir(), "daemon.json");

test("the default fleet is written as nothing, and another name as it was typed", () => {
  assert.equal(fleetSetting(undefined), null);
  assert.equal(fleetSetting(""), null);
  assert.equal(fleetSetting("covey"), null, "the default name is the absence of a setting");
  assert.equal(fleetSetting("Covey"), null);
  assert.equal(fleetSetting("  work  "), "work");
});

test("a machine that names no fleet is in the default one", () => {
  assert.equal(machineSettings({}).fleet, null);
  assert.equal(machineSettings({ fleet: "work" }).fleet, "work");
  assert.equal(fleetName({ fleet: null }), "covey");
  assert.equal(fleetName({ fleet: "work" }), "work");
});

test("a daemon.json written before fleets took the word keeps its peer list and reads as the default fleet", () => {
  // What an older covey wrote: the machines its page dials, under `fleet`.
  writeFileSync(file(), JSON.stringify({ port: 3790, fleet: [{ name: "pi", url: "ws://pi:3790" }] }) + "\n");
  assert.deepEqual(readPeers(), [{ name: "pi", url: "ws://pi:3790" }], "the old key is read once more, so a phone keeps dialling");
  assert.equal(machineSettings(JSON.parse(readFileSync(file(), "utf8"))).fleet, null, "and a list is no fleet name");

  // The next write moves it to the key it belongs under.
  savePeers([{ name: "mac", url: "ws://mac:3790" }]);
  assert.deepEqual(readPeers(), [{ name: "mac", url: "ws://mac:3790" }]);
  assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")).peers, [{ name: "mac", url: "ws://mac:3790" }]);
});
