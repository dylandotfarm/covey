/**
 * The daemon's ping has a deadline (#217).
 *
 * A client whose computer goes to sleep leaves the connection half open: no FIN
 * arrives, the kernel keeps it in `ESTABLISHED`, and `readyState` reads `OPEN`
 * for as long as anybody cares to look. The daemon pinged every twenty seconds
 * and read no pong, so it learned the truth only when its own kernel ran out of
 * retransmissions — and held the connection, its subscriptions and its thread
 * stream until then, pushing into it all the while.
 *
 * `pause()` is the sleeping computer, exactly: the `ws` package answers a ping
 * frame in the runtime, so the only way to stop a client answering is to stop
 * it reading. Nothing is closed and nothing is destroyed, which is what makes
 * this the bug rather than an ordinary drop.
 *
 * Both halves are here because the dangerous one is the second. A daemon that
 * terminated a client which *was* answering would drop every reader in the
 * fleet every two ping periods.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { startServer } from "./server.js";
import { Updater } from "./update.js";
import { AppBuilder } from "./appBuild.js";

/** Short enough that the test is milliseconds, long enough not to race the loop. */
const PING_MS = 60;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  const { port } = s.address() as { port: number };
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

async function waitFor(cond: () => boolean, what: string, ceilingMs = 5_000) {
  const until = Date.now() + ceilingMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waited ${ceilingMs}ms and ${what} never happened`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A server with no engine behind it. Nothing here calls an rpc, and the ping
 * loop is set up when the connection opens, so the engine is never reached.
 */
async function serve(t: { after: (fn: () => unknown) => void }) {
  const port = await freePort();
  const server = await startServer({
    config: {
      machineId: "m1", name: "test", token: "t", port, bind: "loopback",
      createdAt: "2026-01-01T00:00:00Z", defaultModel: null, defaultPermissionMode: null,
      defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null,
    } as any,
    engine: {} as any,
    updater: new Updater("m1", () => {}),
    builder: new AppBuilder("m1", () => {}),
    host: "127.0.0.1",
    log: () => {},
    pingMs: PING_MS,
  });
  t.after(() => server.close());
  return server.port;
}

async function dial(port: number, t: { after: (fn: () => unknown) => void }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  t.after(() => ws.terminate());
  return ws;
}

test("a connection that stops answering pings is terminated", async (t) => {
  const port = await serve(t);
  const ws = await dial(port, t);

  let closed = false;
  ws.on("close", () => { closed = true; });

  // The computer goes to sleep: the socket is untouched and the client stops
  // reading, so no pong is written.
  ws.pause();
  await settle(PING_MS * 4);
  // Read again, so the close the daemon sent can be delivered. Without the
  // deadline there is nothing waiting to be read.
  ws.resume();

  await waitFor(() => closed, "the daemon terminated a connection that missed its pong");
});

test("a connection that answers its pings is left alone", async (t) => {
  const port = await serve(t);
  const ws = await dial(port, t);

  let closed = false;
  ws.on("close", () => { closed = true; });

  // Several periods, so a daemon that terminated on the pong it had just
  // received would have done it by now.
  await settle(PING_MS * 5);

  assert.equal(closed, false, "the daemon terminated a connection that was answering");
  assert.equal(ws.readyState, WebSocket.OPEN);
});
