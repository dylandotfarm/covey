/**
 * One thread subscription per socket, however many callers ask at once.
 *
 * The case is the phone's: it opens a conversation the moment a machine
 * answers, because a notification can be tapped before anything has been
 * dialled. `setState("connected")` is raised before `resubscribe` is awaited,
 * so that caller's `watchThread` is in flight when `resubscribe` reaches its
 * own `if (this.threadSub)`, and both used to ask. The second answer overwrote
 * the first id, which left a subscription nothing could close: every item of
 * that conversation arrived twice for the life of the socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MachineClient, type SocketLike } from "./client.js";

/**
 * A daemon that answers every call on a later tick.
 *
 * The tick is what makes the test worth having: the race is between two awaits,
 * and a socket that answered synchronously would run them in an order the real
 * one never takes.
 */
function fakeDaemon() {
  const sent: { id: number; method: string }[] = [];
  let listeners: { message: ((e: { data: unknown }) => void)[]; open: (() => void)[] } = { message: [], open: [] };
  let subs = 0;

  const socket: SocketLike = {
    readyState: 1,
    send(data: string) {
      const m = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
      sent.push({ id: m.id, method: m.method });
      const result =
        m.method === "hello" ? { machineId: "m", name: "rig", protocolVersion: 0 }
        : m.method === "shell.snapshot" ? { seq: 1, machine: {}, projects: [], threads: [], runs: [] }
        : m.method === "thread.snapshot" ? { thread: { id: "t1" }, items: [], seq: 7, hasMore: false, commands: null }
        : m.method === "shell.subscribe" || m.method === "thread.subscribe" ? { subscriptionId: `sub-${++subs}` }
        : {};
      setTimeout(() => { for (const l of listeners.message) l({ data: JSON.stringify({ id: m.id, ok: true, result }) }); }, 0);
    },
    close() {},
    addEventListener(type: string, listener: unknown) {
      if (type === "open") listeners.open.push(listener as () => void);
      if (type === "message") listeners.message.push(listener as (e: { data: unknown }) => void);
    },
  };

  return {
    sent,
    dial: () => { setTimeout(() => { for (const l of listeners.open) l(); }, 0); return socket; },
    /** Let every queued answer and the awaits behind it run. */
    settle: async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); },
    reset: () => { listeners = { message: [], open: [] }; },
  };
}

test("a thread watched from the connected callback is subscribed once", async () => {
  const daemon = fakeDaemon();
  const client = new MachineClient({ name: "rig", url: "ws://rig" }, {
    state: (s) => {
      // What the phone does: the conversation on screen is waiting for this
      // machine, so it is asked for the moment the machine is there.
      if (s === "connected") void client.watchThread("t1");
    },
    shellSnapshot: () => {},
    shellEvent: () => {},
    shellSynchronized: () => {},
    threadEvent: () => {},
    threadSynchronized: () => {},
    machineUpdate: () => {},
  }, { dial: daemon.dial });

  client.start();
  await daemon.settle();

  const opened = daemon.sent.filter((c) => c.method === "thread.subscribe");
  assert.equal(opened.length, 1,
    `${opened.length} thread.subscribe calls: the second orphans the first, and every item arrives twice`);
  // And the one that was opened is the one the client can close again.
  assert.equal(daemon.sent.filter((c) => c.method === "unsubscribe").length, 0);
  client.stop();
});

test("a thread is still subscribed when nothing else is racing", async () => {
  // The guard must not be a guard against the ordinary case.
  const daemon = fakeDaemon();
  const client = new MachineClient({ name: "rig", url: "ws://rig" }, {
    state: () => {}, shellSnapshot: () => {}, shellEvent: () => {}, shellSynchronized: () => {},
    threadEvent: () => {}, threadSynchronized: () => {}, machineUpdate: () => {},
  }, { dial: daemon.dial });

  client.start();
  await daemon.settle();
  await client.watchThread("t1");
  await daemon.settle();

  assert.equal(daemon.sent.filter((c) => c.method === "thread.subscribe").length, 1);
  client.stop();
});
