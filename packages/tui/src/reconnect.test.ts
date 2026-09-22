/**
 * Giving up on a machine that is not there (issue #68).
 *
 * The client used to dial for ever: a machine off since breakfast was still
 * being tried at teatime, every eight seconds, and every attempt repainted the
 * sidebar. These tests pin the three things that replaced it — the cap, the
 * retry the reader asks for, and the one case that must *not* be capped.
 *
 * Nothing here waits out a real backoff. The delays are injected
 * (`{ backoff: [...] }`), and every wait is on a condition with a ceiling, so
 * the tests take milliseconds and cannot race the machine they run on — which
 * is the defect issue #53 was about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as Socket } from "ws";
import type { MachineInfo, MachineUpdate } from "@covey/protocol";
import { MachineClient, TRIES, type ClientEvents, type ConnState } from "@covey/client";
import { Store } from "./store.js";

// ---- waiting, without waiting out a clock -----------------------------------

/**
 * Poll `cond` until it holds. The ceiling is a failure, not a schedule: every
 * caller passes a condition that the code under test reaches in milliseconds,
 * and the message says what never happened.
 */
async function waitFor(cond: () => boolean, what: string, ceilingMs = 5_000) {
  const until = Date.now() + ceilingMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waited ${ceilingMs}ms and ${what} never happened`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Long enough for several injected backoffs to fire, if any were going to. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a daemon that can be taken away and brought back ------------------------

const INFO: MachineInfo = {
  machineId: "fake-machine", name: "fake", os: "linux", arch: "arm64", homeDir: "/home/fake",
  daemonVersion: "test", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/**
 * Enough of a daemon to say hello and hold a shell subscription.
 *
 * `down` is a flag rather than a `close()` and a re-`listen()` on purpose: a
 * test that has to rebind a port before the client's budget runs out is a test
 * that races the machine's speed. Flipping a boolean takes no time at all, so
 * "the daemon comes back" happens exactly when the test says it does. The
 * client sees the handshake socket destroyed under it, which it treats the same
 * way as a refusal — silence.
 */
class FakeDaemon {
  private http: Server;
  private wss = new WebSocketServer({ noServer: true });
  private sockets = new Set<Socket>();
  down = false;
  /** What to refuse `hello` with, the way a daemon a protocol version behind does. */
  refuseHello: string | null = null;
  /** Take the socket back as soon as it is open, before `hello` can be answered. */
  dropAfterOpen = false;
  port = 0;

  constructor() {
    this.http = createServer();
    this.http.on("upgrade", (req, socket, head) => {
      if (this.down) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket as never, head, (ws) => {
        if (this.dropAfterOpen) { ws.close(); return; }
        this.serve(ws);
      });
    });
  }

  async listen() {
    await new Promise<void>((res) => this.http.listen(0, "127.0.0.1", res));
    this.port = (this.http.address() as { port: number }).port;
    return `ws://127.0.0.1:${this.port}`;
  }

  /** Take the daemon away, the way a restart does: drop what is open, refuse the rest. */
  goDown() {
    this.down = true;
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  comeBack() { this.down = false; }

  push(message: unknown) {
    for (const ws of this.sockets) ws.send(JSON.stringify(message));
  }

  async close() {
    this.goDown();
    this.wss.close();
    await new Promise<void>((res) => this.http.close(() => res()));
  }

  private serve(ws: Socket) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(raw.toString());
      if (method === "hello" && this.refuseHello) {
        ws.send(JSON.stringify({ id, ok: false, error: { code: "protocol", message: this.refuseHello } }));
        return;
      }
      const result =
        method === "hello" ? INFO
        : method === "shell.snapshot" ? { seq: 0, machine: INFO, projects: [], threads: [] }
        : { subscriptionId: `sub-${id}` };
      ws.send(JSON.stringify({ id, ok: true, result }));
    });
  }
}

/** A client that records every state it is told about. */
function probe(url: string, backoff: number[]) {
  const states: ConnState[] = [];
  const errors: (string | undefined)[] = [];
  const ev: ClientEvents = {
    state: (s, err) => { states.push(s); errors.push(err); },
    shellSnapshot: () => {}, shellEvent: () => {}, shellSynchronized: () => {},
    threadEvent: () => {}, threadSynchronized: () => {}, machineUpdate: () => {},
  };
  const client = new MachineClient({ name: "probe", url }, ev, { backoff });
  return { client, states, errors, dials: () => states.filter((s) => s === "connecting").length };
}

/** A port with nothing behind it: what a typo in the URL gives you. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  const { port } = s.address() as { port: number };
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

// ---- 1. the cap --------------------------------------------------------------

test("a machine that never answers is dialled a fixed number of times and then let alone", async (t) => {
  const port = await deadPort();
  const { client, states, errors, dials } = probe(`ws://127.0.0.1:${port}`, [1]);
  t.after(() => client.stop());

  client.start();
  // Either it stops where it should, or it runs past — and running past is the
  // defect, so the wait ends on it rather than on a timeout.
  await waitFor(() => client.state === "offline" || dials() > TRIES.first, "the client either gave up or overran its cap");

  assert.equal(dials(), TRIES.first,
    `the client dialled a machine that is not there ${dials()} times; the cap is ${TRIES.first}`);
  assert.equal(client.state, "offline",
    "none of connecting/disconnected/error means \"we have stopped trying\", which is why nobody noticed");

  // And it stays stopped. Sixty milliseconds is sixty injected backoffs.
  const settled = dials();
  await settle(60);
  assert.equal(dials(), settled, "the client went back to dialling after it said it had stopped");

  assert.equal(errors[errors.length - 1], `no answer after ${TRIES.first} tries`,
    "a silent row tells the reader nothing; the state has to carry the reason");
  assert.equal(states.at(-1), "offline");
});

// ---- 2. the retry the reader asks for ----------------------------------------

test("a retry the reader asks for starts the count again and can connect", async (t) => {
  const daemon = new FakeDaemon();
  const url = await daemon.listen();
  t.after(() => daemon.close());
  daemon.goDown(); // listening, but refusing — the machine is off

  const { client, dials } = probe(url, [1]);
  t.after(() => client.stop());
  client.start();
  await waitFor(() => client.state === "offline", "the client gave up");
  const gaveUpAfter = dials();

  daemon.comeBack();
  // Nothing brings it back on its own: that is the decision, not an oversight.
  await settle(30);
  assert.equal(client.state, "offline", "something was still dialling in the background");
  assert.equal(dials(), gaveUpAfter);

  client.retry();
  await waitFor(() => client.state === "connected" || client.state === "offline", "the retry reached the daemon");
  assert.equal(client.state, "connected", "the retry did not connect to a daemon that was answering");
  assert.equal(client.info?.name, "fake");
});

// ---- 3. a first connection is not a reconnection ------------------------------

test("a machine that has answered before is given more tries than one that never has", async (t) => {
  const daemon = new FakeDaemon();
  const url = await daemon.listen();
  t.after(() => daemon.close());

  const { client, dials } = probe(url, [1]);
  t.after(() => client.stop());
  client.start();
  await waitFor(() => client.state === "connected", "the first connection");

  daemon.goDown();
  await waitFor(() => client.state === "offline" || dials() > 1 + TRIES.again, "the client gave up on a machine that had answered");

  // One dial connected; the rest are the reconnect budget.
  assert.equal(dials() - 1, TRIES.again,
    `a machine that had been connected all day got ${dials() - 1} tries; a reconnect is worth ${TRIES.again}, not ${TRIES.first}`);
  assert.equal(client.state, "offline");
});

// ---- 4. the one that must not be capped ---------------------------------------

/** A store with its own config directory, so nothing real is read or written. */
function scratchStore(url: string, backoff: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "covey-reconnect-"));
  const old = process.env.COVEY_CONFIG;
  process.env.COVEY_CONFIG = dir;
  try {
    const store = new Store([{ name: "fake", url }], { client: { backoff } });
    return { store, cleanup: () => { store.shutdown(); rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.COVEY_CONFIG; else process.env.COVEY_CONFIG = old; } };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

const restarting = (): MachineUpdate => ({
  id: "u1", machineId: "fake-machine", state: "restarting", steps: [],
  startedAt: new Date().toISOString(), finishedAt: null, error: null,
  fromCommit: "aaaaaaa", toCommit: "bbbbbbb",
});

test("a restarting daemon is still reconnected to, so machine.update still reports success", async (t) => {
  const daemon = new FakeDaemon();
  const url = await daemon.listen();
  t.after(() => daemon.close());

  // Slower than the other tests on purpose: the restart budget has to outlast
  // the drop by a wide margin, and this makes the margin hundreds of
  // milliseconds rather than a handful.
  const { store, cleanup } = scratchStore(url, [10]);
  t.after(cleanup);
  const machine = () => store.getState().machines.get(url)!;
  const client = store.client(url)!;

  await waitFor(() => machine().conn === "connected", "the first connection");

  // What the daemon says last before it goes: the reconnect is the only way it
  // can report the restart worked.
  daemon.push({ push: "machine.update", update: restarting() });
  await waitFor(() => machine().restarting, "the store heard the restart");
  daemon.goDown();

  await waitFor(() => client.attempts > TRIES.again + 1 || machine().conn === "offline",
    "the client kept dialling past the ordinary cap");
  assert.notEqual(machine().conn, "offline",
    `the client gave up on a daemon it had asked to restart; every machine.update would report failure`);

  daemon.comeBack();
  await waitFor(() => machine().conn === "connected" || machine().conn === "offline", "the daemon was reached again");
  assert.equal(machine().conn, "connected");

  assert.equal(machine().update?.state, "succeeded",
    "the reconnect is how a restart reports success; without it the update sits at \"restarting\" for ever");
  assert.match(store.getState().notice?.text ?? "", /is back up/);
});

// ---- 5. a daemon that answers the socket but not the question ------------------

/**
 * The ordinary case of this is a version mismatch: a client updated ahead of a
 * daemon on a Pi. The daemon opens the socket and then throws on `hello`
 * (`packages/daemon/src/server.ts`), so every dial gets as far as an open
 * socket. A budget that counted an open socket as an answer would never run
 * out on it, and the client would dial as fast as the machine allowed.
 */
test("a daemon that opens the socket and refuses hello is capped too, and its words are kept", async (t) => {
  const daemon = new FakeDaemon();
  daemon.refuseHello = "daemon speaks v1, client v2";
  const url = await daemon.listen();
  t.after(() => daemon.close());

  const { client, errors, dials } = probe(url, [1]);
  t.after(() => client.stop());

  client.start();
  await waitFor(() => client.state === "offline" || dials() > TRIES.first, "the client either gave up or overran its cap");

  assert.equal(dials(), TRIES.first,
    `a daemon that refuses hello was dialled ${dials()} times; the cap is ${TRIES.first}`);
  const settled = dials();
  await settle(60);
  assert.equal(dials(), settled, "the client went back to dialling a daemon it had given up on");
  assert.equal(client.state, "offline");

  assert.equal(errors[errors.length - 1], "daemon speaks v1, client v2",
    "an old daemon is a different problem from a machine being off; flattening it loses the only clue the reader has");
});

// ---- 6. the wait after a drop --------------------------------------------------

/**
 * How much sooner than its delay a timer may come back, read with `Date.now()`.
 *
 * libuv counts a timer down from the loop time it cached, not from the moment
 * `setTimeout` ran, and both clocks cut to whole milliseconds. So a 50ms timer
 * reads as 49ms whenever the loop had work in hand. Measured on this project's
 * machine, at 50ms: never under 49ms, and 49ms in 38 of 40 runs once the
 * iteration that armed the timer did 5ms of work first. An idle loop gives 50ms
 * every time, which is why this cost a gate run and not a local one.
 */
const EARLY_MS = 1;

/**
 * A machine that has just connected has no failed dials behind it, so the index
 * into the backoff is the one before the first. Read at -1 an array gives
 * `undefined`, and `setTimeout` reads that as "now", which redials the drop on
 * the same tick.
 *
 * So the assertion has to tell no wait from a wait, and nothing finer. It does
 * not hold the client to the millisecond: a busy machine can make the measured
 * wait shorter, by `EARLY_MS` and no more.
 */
test("a connection that drops waits the first backoff before it is dialled again", async (t) => {
  const daemon = new FakeDaemon();
  const url = await daemon.listen();
  t.after(() => daemon.close());

  const WAIT = 50;
  const { client, dials } = probe(url, [WAIT]);
  t.after(() => client.stop());

  client.start();
  await waitFor(() => client.state === "connected", "the first connection");

  const dropped = Date.now();
  const before = dials();
  daemon.goDown();
  await waitFor(() => dials() > before, "the client dialled again");

  const waited = Date.now() - dropped;
  assert.ok(waited >= WAIT - EARLY_MS, `the drop was dialled again after ${waited}ms; the injected backoff is ${WAIT}ms`);
});

// ---- 7. the socket that goes before the answer ---------------------------------

/**
 * When the socket goes first, the pending `hello` rejects a tick later — after
 * `onClose` has already decided this was the last dial. The row must keep the
 * `offline` that decision wrote: an `error` painted over it says a dial failed
 * and another is coming, and no other dial is coming. That reading is the one
 * issue #68 was filed about.
 */
test("a daemon that drops the socket before it answers ends offline, not error", async (t) => {
  const daemon = new FakeDaemon();
  daemon.dropAfterOpen = true;
  const url = await daemon.listen();
  t.after(() => daemon.close());

  const { client, dials } = probe(url, [1]);
  t.after(() => client.stop());

  client.start();
  await waitFor(() => dials() >= TRIES.first, "the client dialled as far as its cap");
  // The rejection of the dropped `hello` lands after the close that gave up.
  await settle(30);

  assert.equal(dials(), TRIES.first);
  assert.equal(client.state, "offline",
    "the row said a dial had failed and another was coming, and no other dial was coming");
});
