import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";

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
