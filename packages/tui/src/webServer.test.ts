/**
 * One web server across the fleet. A phone keeps one address, so the TUI
 * lets one machine serve the client and stops the others when a new one starts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-cfg-"));
const { Store } = await import("./store.js");

interface Sent { machine: string; type: string; webEnabled?: boolean | null }

function harness(machines: { key: string; conn: string; web: boolean; addr?: string }[]) {
  const sent: Sent[] = [];
  const notices: string[] = [];
  const store = new Store([]);
  const s = store as any;
  s.notify = (m: string) => notices.push(m);
  for (const m of machines) {
    s.state.machines.set(m.key, {
      key: m.key, saved: { name: m.key, url: m.key }, conn: m.conn,
      info: { name: m.key, settings: { webEnabled: m.web }, webAddresses: m.addr ? [{ kind: "tailnet", url: m.addr, reachable: true }] : [] },
      projects: new Map(), threads: new Map(), runs: new Map(),
    });
    s.clients.set(m.key, { state: m.conn, info: null, command: async (c: { type: string; webEnabled?: boolean | null }) => { sent.push({ machine: m.key, type: c.type, ...(c.type === "machine.settings" ? { webEnabled: c.webEnabled } : {}) }); return {}; } });
  }
  return { store, sent, notices };
}

test("starting the web server on one machine stops it on the connected machine that had it", async () => {
  const { store, sent, notices } = harness([
    { key: "a", conn: "connected", web: true },
    { key: "b", conn: "connected", web: false, addr: "http://b.tail.ts.net:3790/" },
  ]);
  await store.setWebServer("b", true);
  assert.deepEqual(sent, [
    { machine: "a", type: "machine.settings", webEnabled: false },
    { machine: "b", type: "machine.settings", webEnabled: true },
    // The new server is handed the fleet at once.
    { machine: "b", type: "machine.fleet" },
  ]);
  assert.ok(notices.some((n) => n.includes("a: web server stopped")), notices.join(" | "));
  assert.ok(notices.some((n) => n.includes("b: web server on at http://b.tail.ts.net:3790/")), notices.join(" | "));
});

test("a machine that cannot be reached keeps its setting, and the reader is told", async () => {
  const { store, sent, notices } = harness([
    { key: "a", conn: "offline", web: true },
    { key: "b", conn: "connected", web: false },
  ]);
  await store.setWebServer("b", true);
  assert.deepEqual(sent, [{ machine: "b", type: "machine.settings", webEnabled: true }, { machine: "b", type: "machine.fleet" }]);
  assert.ok(notices.some((n) => n.includes("a also serves the web client and is not connected")), notices.join(" | "));
});

test("stopping touches only the machine asked", async () => {
  const { store, sent } = harness([
    { key: "a", conn: "connected", web: true },
    { key: "b", conn: "connected", web: true },
  ]);
  await store.setWebServer("b", false);
  assert.deepEqual(sent, [{ machine: "b", type: "machine.settings", webEnabled: false }]);
});

test("the fleet a phone dials: every other machine, loopback rewritten to the tailnet, the server itself left out", async () => {
  const { store, sent } = harness([
    { key: "ws://127.0.0.1:3790", conn: "connected", web: false },
    { key: "ws://pi.tail.ts.net:3790", conn: "connected", web: false },
    { key: "ws://10.0.0.9:3790", conn: "offline", web: false },
  ]);
  const s = store as any;
  const local = s.state.machines.get("ws://127.0.0.1:3790");
  local.info = { ...local.info, machineId: "box-id", name: "box", tailnetName: "box.tail.ts.net", tailnetIps: ["100.64.0.1"] };
  const pi = s.state.machines.get("ws://pi.tail.ts.net:3790");
  pi.info = { ...pi.info, machineId: "pi-id", name: "pi", settings: { webEnabled: true } };
  s.state.machines.get("ws://10.0.0.9:3790").saved.token = "tok";

  assert.deepEqual(store.fleetFor("ws://pi.tail.ts.net:3790"), [
    { name: "box", url: "ws://box.tail.ts.net:3790", machineId: "box-id" },
    { name: "ws://10.0.0.9:3790", url: "ws://10.0.0.9:3790", token: "tok" },
  ]);
  // From box's own point of view the loopback entry is box, and pi is dialled as saved.
  assert.deepEqual(store.fleetFor("ws://127.0.0.1:3790").map((m: { url: string }) => m.url), ["ws://pi.tail.ts.net:3790", "ws://10.0.0.9:3790"]);

  // Starting the web server on pi hands it the fleet.
  await store.setWebServer("ws://pi.tail.ts.net:3790", true);
  assert.deepEqual(sent.filter((x) => x.machine === "ws://pi.tail.ts.net:3790").map((x) => x.type), ["machine.settings", "machine.fleet"]);
});

test("a loopback machine without a tailnet is left out of the fleet, not sent as loopback", () => {
  const { store } = harness([
    { key: "ws://127.0.0.1:3790", conn: "connected", web: false },
    { key: "ws://pi.tail.ts.net:3790", conn: "connected", web: true },
  ]);
  assert.deepEqual(store.fleetFor("ws://pi.tail.ts.net:3790"), []);
});
