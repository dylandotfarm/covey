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
