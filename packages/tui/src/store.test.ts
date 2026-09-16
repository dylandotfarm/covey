import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimelineItem } from "@covey/protocol";
import { Store, type ThreadView } from "./store.js";
import { CACHE_ITEMS, CACHE_VIEWS, type ViewCache } from "./viewCache.js";

/** A store with no machines and its own config directory, so nothing connects. */
function scratchStore(opts: { watchBuild?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "covey-store-"));
  const old = process.env.COVEY_CONFIG;
  process.env.COVEY_CONFIG = dir;
  try {
    const store = new Store([], { ...opts, buildPollMs: 5 });
    return { store, cleanup: () => { store.shutdown(); rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.COVEY_CONFIG; else process.env.COVEY_CONFIG = old; } };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a rebuild while the client runs turns it stale", async (t) => {
  let newest = 1_000;
  const { store, cleanup } = scratchStore({ watchBuild: () => newest });
  t.after(cleanup);

  await settle(30);
  assert.equal(store.getState().clientStale, false, "nothing has been rebuilt yet");

  newest = 2_000;
  await settle(30);
  assert.equal(store.getState().clientStale, true,
    "somebody rebuilt while the client ran; the client keeps its code in memory and cannot feel it, so it has to be told");
  assert.match(store.getState().notice?.text ?? "", /newer build/,
    "and the reader is told once, in words, not only by a mark in the header");
});

test("a client with no build to watch never claims to be stale", async (t) => {
  const { store, cleanup } = scratchStore({ watchBuild: () => 0 });
  t.after(cleanup);
  await settle(30);
  assert.equal(store.getState().clientStale, false);
});

/** A client that answers a command the way the daemon does: silence or a refusal. */
class CommandClient {
  sent: unknown[] = [];
  constructor(private refusal: string | null = null) {}
  async command(cmd: unknown) {
    this.sent.push(cmd);
    if (this.refusal) throw new Error(this.refusal);
  }
  stop() {}
}

/** The store with one machine, answered by a client we control, and a thread open. */
function storeWithClient(store: Store, client: CommandClient) {
  (store as any).clients.set("ws://fake", client);
  store.state.selected = { machine: "ws://fake", threadId: "t" };
}

test("a rewind the daemon refuses never says it reverted", async (t) => {
  const { store, cleanup } = scratchStore();
  t.after(cleanup);
  // What `turn.revert` throws while the thread is busy (daemon engine.ts).
  const c = new CommandClient("interrupt the running turn first");
  storeWithClient(store, c);

  const ok = await store.revertTurn("t", "turn-1");
  // The notice first: it is what the reader sees, and a green "reverted" over
  // the red refusal tells them the opposite of what happened.
  assert.equal(store.getState().notice?.text, "interrupt the running turn first",
    "the refusal is the answer the reader gets, and nothing may paint over it");
  assert.equal(store.getState().notice?.tone, "error");
  assert.equal(ok, false);
});

test("a rewind that goes through says it reverted", async (t) => {
  const { store, cleanup } = scratchStore();
  t.after(cleanup);
  const c = new CommandClient();
  storeWithClient(store, c);

  assert.equal(await store.revertTurn("t", "turn-1"), true);
  assert.deepEqual(c.sent, [{ type: "turn.revert", threadId: "t", turnId: "turn-1" }]);
  assert.equal(store.getState().notice?.text, "reverted");
  assert.equal(store.getState().notice?.tone, "success");
});

// ---- what the client keeps for every event it receives (issue #61) -----------

/**
 * A timeline item carries no delta channel by design: a streamed message
 * arrives again and again under the same id, with more text on it each time.
 * So the client sees one event per token and one item per message, and the two
 * numbers must not be confused. `item()` is the same message at the length it
 * has reached.
 */
const item = (id: string, text: string): TimelineItem => ({
  id, threadId: "t", turnId: "turn-1", seq: 1, kind: "assistant", text, streaming: true,
  model: "claude", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

/** A thread the reader has open, with nothing in it yet. */
const openThread = (threadId: string): ThreadView => ({
  machine: "ws://fake", threadId, thread: null, items: new Map(), loading: false, error: null,
  hasMore: false, loadingOlder: false, seq: 1, commands: null, dirs: new Map(),
});

test("a thousand events on one message leave one item behind", async (t) => {
  const { store, cleanup } = scratchStore();
  t.after(cleanup);
  store.state.selected = { machine: "ws://fake", threadId: "t" };
  store.state.view = openThread("t");

  let text = "";
  for (let n = 0; n < 1000; n++) {
    text += "token ";
    (store as any).applyThread("ws://fake", "t", { seq: n + 2, kind: "item.upserted", item: item("i0", text) });
  }

  assert.equal(store.getState().view?.items.size, 1,
    "the streamed message is one item that keeps being resent, so the view holds one of it. " +
    "Anything that appends instead of replacing by id grows once per event, which is what took " +
    "the client to 4.2 GB (issue #61)");
  const held = store.getState().view?.items.get("i0");
  assert.equal(held?.kind === "assistant" ? held.text : null, text,
    "and what it holds is the latest text, not the first");
});

/** A client that answers `select()` the way a daemon does, and remembers what it was asked. */
class WatchingClient {
  /** The thread this client has a subscription open on, or null. */
  open: string | null = null;
  constructor(private items: number) {}
  async watchThread(threadId: string, limit: number) {
    await this.unwatchThread();
    this.open = threadId;
    return {
      seq: 1, thread: null as any, hasMore: false, commands: null,
      items: Array.from({ length: Math.min(this.items, limit) }, (_, i) => item(`${threadId}-${i}`, "hello")),
    };
  }
  resumeThread(threadId: string) { this.open = threadId; }
  async unwatchThread() { this.open = null; }
  stop() {}
}

test("browsing a hundred threads leaves the cache and the subscription where they started", async (t) => {
  const { store, cleanup } = scratchStore();
  t.after(cleanup);
  const client = new WatchingClient(60);
  (store as any).clients.set("ws://fake", client);
  const cache = (store as any).viewCache as ViewCache;

  for (let n = 0; n < 100; n++) await store.select({ machine: "ws://fake", threadId: `t${n}` });

  assert.ok(cache.size <= CACHE_VIEWS,
    `the view cache holds ${cache.size} threads after a hundred were opened, and its cap is ${CACHE_VIEWS}`);
  assert.ok(cache.itemCount <= CACHE_ITEMS,
    `the view cache holds ${cache.itemCount} items, and its cap is ${CACHE_ITEMS}`);
  assert.equal(client.open, "t99", "one thread is open: the one the reader is on");

  await store.select(null);
  assert.equal(store.getState().view, null, "and closing the last one leaves no view behind");
});

/**
 * Neither test above proves the client does not leak. They pin two shapes a
 * leak takes — an item map that grows per event, and a cache that keeps every
 * thread the reader visited — and a leak anywhere else passes both. The leak
 * this file was written for was in neither place; it was in React, and
 * `render.leak.test.ts` is what watches for it.
 */
