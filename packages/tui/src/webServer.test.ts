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

interface Sent { machine: string; webEnabled?: boolean | null }

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
    s.clients.set(m.key, { command: async (c: { type: string; webEnabled?: boolean | null }) => { sent.push({ machine: m.key, webEnabled: c.webEnabled }); return {}; } });
  }
  return { store, sent, notices };
}

test("starting the web server on one machine stops it on the connected machine that had it", async () => {
  const { store, sent, notices } = harness([
    { key: "a", conn: "connected", web: true },
    { key: "b", conn: "connected", web: false, addr: "http://b.tail.ts.net:3790/" },
  ]);
  await store.setWebServer("b", true);
  assert.deepEqual(sent, [{ machine: "a", webEnabled: false }, { machine: "b", webEnabled: true }]);
  assert.ok(notices.some((n) => n.includes("a: web server stopped")), notices.join(" | "));
  assert.ok(notices.some((n) => n.includes("b: web server on at http://b.tail.ts.net:3790/")), notices.join(" | "));
});

test("a machine that cannot be reached keeps its setting, and the reader is told", async () => {
  const { store, sent, notices } = harness([
    { key: "a", conn: "offline", web: true },
    { key: "b", conn: "connected", web: false },
  ]);
  await store.setWebServer("b", true);
  assert.deepEqual(sent, [{ machine: "b", webEnabled: true }]);
  assert.ok(notices.some((n) => n.includes("a also serves the web client and is not connected")), notices.join(" | "));
});

test("stopping touches only the machine asked", async () => {
  const { store, sent } = harness([
    { key: "a", conn: "connected", web: true },
    { key: "b", conn: "connected", web: true },
  ]);
  await store.setWebServer("b", false);
  assert.deepEqual(sent, [{ machine: "b", webEnabled: false }]);
});
