/**
 * The daemon serves the phone's client. This starts a real daemon and asks
 * for the page, its modules, and a few paths it must refuse.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, stopAll } from "./daemons.js";

after(stopAll);

test("the daemon serves the web client beside /health", async () => {
  const d = await startDaemon({ name: "web", env: { COVEY_WEB: "1" } });
  const base = `http://127.0.0.1:${d.port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  const html = await page.text();
  assert.match(html, /importmap/);
  assert.match(html, /\/app\/main\.js/);

  // Every module the page asks for, by the paths the page and the import map name.
  const importMap = JSON.parse(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html)![1]!) as { imports: Record<string, string> };
  for (const path of ["/app/main.js", "/static/app.css", "/static/manifest.webmanifest", "/static/icon.svg", ...Object.values(importMap.imports)]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    if (path.endsWith(".js")) {
      const body = await r.text();
      // A bare specifier the import map does not know would fail in the browser.
      for (const m of body.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        assert.ok(spec.startsWith(".") || spec in importMap.imports, `${path} imports ${spec}`);
      }
    }
  }

  // What must not be reachable.
  for (const path of ["/static/../../daemon/package.json", "/app/../package.json", "/lib/daemon/index.js", "/static/nope.css", "/etc/passwd"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, path);
  }
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);

  // The media route (#110) refuses anything that is not a GitHub attachment
  // before it makes a request, so nothing here reaches the network.
  for (const bad of ["/media", "/media?url=", "/media?url=https://example.com/x.png", "/media?url=https://github.com/dylandotfarm/covey"]) {
    const r = await fetch(base + bad);
    assert.equal(r.status, 400, bad);
    assert.match(await r.text(), /user attachment/);
  }
  assert.equal((await fetch(`${base}/media?url=https://github.com/user-attachments/assets/x`, { method: "POST" })).status, 405);
});

/** One request over the socket, on a fresh connection. */
async function rpc(port: number, method: string, params: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("dial")); });
  const ask = (id: number, m: string, p: unknown) => new Promise<any>((res) => {
    const on = (ev: MessageEvent) => { const r = JSON.parse(String(ev.data)); if (r.id === id) { ws.removeEventListener("message", on); res(r); } };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
  await ask(1, "hello", { protocolVersion: 1, client: "covey-tui" });
  const r = await ask(2, method, params);
  ws.close();
  return r;
}

test("the web client is off until the control panel turns it on, and stops when it turns it off", async () => {
  const d = await startDaemon({ name: "quiet" });
  const base = `http://127.0.0.1:${d.port}`;
  const off = await fetch(`${base}/`);
  assert.equal(off.status, 404);
  assert.match(await off.text(), /off on quiet/);
  assert.equal((await fetch(`${base}/app/main.js`)).status, 404);
  assert.equal((await fetch(`${base}/media?url=https://example.com/x.png`)).status, 404, "the media route is off with the client");
  assert.equal((await fetch(`${base}/health`)).status, 200);

  const hello = await rpc(d.port, "hello", { protocolVersion: 1, client: "covey-tui" });
  assert.ok(Array.isArray(hello.result.webAddresses), "a daemon reports where the client would be served");
  assert.equal(hello.result.settings.webEnabled, null);

  const on = await rpc(d.port, "command", { commandId: "w1", type: "machine.settings", webEnabled: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/app/main.js`)).status, 200);

  await rpc(d.port, "command", { commandId: "w2", type: "machine.settings", webEnabled: false });
  assert.equal((await fetch(`${base}/`)).status, 404);
  const again = await rpc(d.port, "hello", { protocolVersion: 1, client: "covey-tui" });
  assert.equal(again.result.settings.webEnabled, null);
});

test("the fleet the TUI hands over comes back to the page in machine.access, whole and without extras", async () => {
  const d = await startDaemon({ name: "fleet", env: { COVEY_WEB: "1" } });
  const before = await rpc(d.port, "machine.access", {});
  assert.deepEqual(before.result.fleet, [], "nothing until the TUI sends a list");
  const sent = await rpc(d.port, "command", { commandId: "f1", type: "machine.fleet", machines: [
    { name: "box", url: "ws://box.tail.ts.net:3790", machineId: "box-id", extra: "dropped" },
    { name: "lan", url: "ws://10.0.0.9:3790", token: "tok" },
    { name: "bad" },
  ] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const after = await rpc(d.port, "machine.access", {});
  assert.deepEqual(after.result.fleet, [
    { name: "box", url: "ws://box.tail.ts.net:3790", machineId: "box-id" },
    { name: "lan", url: "ws://10.0.0.9:3790", token: "tok" },
  ]);
  // The whole list, every time: an empty one clears it.
  await rpc(d.port, "command", { commandId: "f2", type: "machine.fleet", machines: [] });
  assert.deepEqual((await rpc(d.port, "machine.access", {})).result.fleet, []);
});

test("bind changes while the daemon runs, the socket that asked stays open, and a bind that fails leaves the old one listening", async () => {
  const d = await startDaemon({ name: "mover" });
  const base = `http://127.0.0.1:${d.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("dial")); });
  let id = 0;
  const ask = (m: string, p: unknown) => new Promise<any>((res) => {
    const my = ++id;
    const on = (ev: MessageEvent) => { const r = JSON.parse(String(ev.data)); if (r.id === my) { ws.removeEventListener("message", on); res(r); } };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: my, method: m, params: p }));
  });
  const hello = await ask("hello", { protocolVersion: 1, client: "covey-tui" });
  assert.equal(hello.result.settings.bind, "loopback", "the flag the test started it with, not the file");

  const toAll = await ask("command", { commandId: "b1", type: "machine.settings", bind: "all" });
  assert.equal(toAll.ok, true, JSON.stringify(toAll));
  // The same socket, after its listener closed.
  const after = await ask("hello", { protocolVersion: 1, client: "covey-tui" });
  assert.equal(after.result.settings.bind, "all");
  assert.ok(after.result.webAddresses.every((a: { reachable: boolean }) => a.reachable), "bound to all, every address is reachable");
  assert.equal((await fetch(`${base}/health`)).status, 200, "loopback still answers through the wildcard listener");
  // A new connection reaches the new listener.
  const fresh = await rpc(d.port, "hello", { protocolVersion: 1, client: "covey-tui" });
  assert.equal(fresh.result.settings.bind, "all");

  // An address nobody has cannot be bound, and the old bind comes back.
  const bad = await ask("command", { commandId: "b2", type: "machine.settings", bind: "203.0.113.7" });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /cannot listen on 203\.0\.113\.7/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await ask("hello", { protocolVersion: 1, client: "covey-tui" })).result.settings.bind, "all");

  const back = await ask("command", { commandId: "b3", type: "machine.settings", bind: "loopback" });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal((await rpc(d.port, "hello", { protocolVersion: 1, client: "covey-tui" })).result.settings.bind, "loopback");
  ws.close();
});
