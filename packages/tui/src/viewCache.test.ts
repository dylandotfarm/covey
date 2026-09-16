import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The store writes prefs on every select(), so point the config at a throwaway
// directory before it is ever loaded.
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-cache-"));

import type { Thread, ThreadSnapshot, TimelineItem } from "@covey/protocol";
import { ViewCache } from "./viewCache.js";
import { Store, previewPage, FULL_PAGE, type MachineState } from "./store.js";

const item = (n: number, threadId = "t"): TimelineItem => ({
  id: `i${n}`, threadId, turnId: null, seq: n, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "assistant", text: `line ${n}`, streaming: false, model: null,
} as unknown as TimelineItem);

const items = (n: number, threadId = "t") =>
  new Map(Array.from({ length: n }, (_, i) => item(i + 1, threadId)).map((i) => [i.id, i]));

const entry = (n: number, seq = n) => ({ thread: null, items: items(n), hasMore: false, seq });

// ---- the cache itself -------------------------------------------------------

test("a cached view comes back once, and the cache keeps no copy", () => {
  const c = new ViewCache();
  c.put("m", "t", entry(3));
  const got = c.take("m", "t");
  assert.equal(got?.items.size, 3);
  assert.equal(c.size, 0, "the live view owns the items map, so no entry may alias it");
  assert.equal(c.take("m", "t"), null);
});

test("an empty view is not worth a slot", () => {
  const c = new ViewCache();
  c.put("m", "t", { thread: null, items: new Map(), hasMore: false, seq: 4 });
  assert.equal(c.size, 0);
});

test("the least recent view goes first when the view cap is passed", () => {
  const c = new ViewCache(3, 1000);
  for (const id of ["a", "b", "c", "d"]) c.put("m", id, entry(2));
  assert.equal(c.size, 3);
  assert.equal(c.take("m", "a"), null, "a was the least recent");
  for (const id of ["b", "c", "d"]) assert.ok(c.take("m", id), `${id} survived`);
});

test("a second put moves a view back to the recent end", () => {
  const c = new ViewCache(3, 1000);
  c.put("m", "a", entry(2)); c.put("m", "b", entry(2)); c.put("m", "c", entry(2));
  c.put("m", "a", entry(2)); // the reader went back to a
  c.put("m", "d", entry(2)); // …so b is now the least recent
  assert.equal(c.take("m", "b"), null);
  assert.ok(c.take("m", "a"));
});

test("the item cap bounds the memory that a count of views cannot", () => {
  const c = new ViewCache(8, 100);
  c.put("m", "a", entry(60));
  c.put("m", "b", entry(60));
  assert.equal(c.itemCount, 60, "a went, because the two together passed the cap");
  assert.equal(c.take("m", "a"), null);
  assert.ok(c.take("m", "b"));
});

test("a view larger than the item cap is dropped, not held", () => {
  // A miss costs one page. The scrollback that made the view large does not
  // come back with it, so holding it buys little and costs a lot.
  const c = new ViewCache(8, 100);
  c.put("m", "big", entry(400));
  assert.equal(c.size, 0);
});

test("dropping a machine leaves the other machines alone", () => {
  const c = new ViewCache();
  c.put("m1", "t", entry(2));
  c.put("m2", "t", entry(2));
  c.dropMachine("m1");
  assert.equal(c.take("m1", "t"), null);
  assert.ok(c.take("m2", "t"));
});

// ---- the store's use of it --------------------------------------------------

const MACHINE = "ws://127.0.0.1:1/fake";

/** A client that counts what the store asks the daemon for. */
class FakeClient {
  snapshots: { threadId: string; limit: number }[] = [];
  resumes: { threadId: string; afterSeq: number }[] = [];
  fail = false;
  constructor(private size = 4, private seq = 40) {}
  async watchThread(threadId: string, limit: number): Promise<ThreadSnapshot> {
    this.snapshots.push({ threadId, limit });
    if (this.fail) throw new Error("not connected");
    return { seq: this.seq, thread: { id: threadId } as Thread, items: [...items(this.size, threadId).values()], hasMore: true };
  }
  async unwatchThread() {}
  resumeThread(threadId: string, afterSeq: number) { this.resumes.push({ threadId, afterSeq }); }
  stop() {}
}

function storeWith(client: FakeClient) {
  const store = new Store([]);
  (store as any).clients.set(MACHINE, client);
  const ms: MachineState = {
    key: MACHINE, saved: { name: "fake", url: MACHINE }, conn: "connected", error: null,
    info: null, projects: new Map(), threads: new Map(), update: null, restarting: false,
  };
  store.state.machines.set(MACHINE, ms);
  store.state.order.push(MACHINE);
  return store;
}

const open = (store: Store, threadId: string, limit?: number) =>
  store.select({ machine: MACHINE, threadId }, limit);

test("a revisit paints from the cache and fetches no snapshot", async () => {
  const c = new FakeClient();
  const store = storeWith(c);
  await open(store, "a", previewPage(40));
  await open(store, "b", previewPage(40));
  await open(store, "a", previewPage(40));
  assert.deepEqual(c.snapshots.map((s) => s.threadId), ["a", "b"], "a was not fetched twice");
  assert.deepEqual(c.resumes, [{ threadId: "a", afterSeq: 40 }], "and the subscription reopens from the cached seq");
  assert.equal(store.state.view?.items.size, 4);
  assert.equal(store.state.view?.loading, false);
});

test("the painted view is there before select() resolves", () => {
  const c = new FakeClient();
  const store = storeWith(c);
  return open(store, "a").then(() => open(store, "b")).then(() => {
    const p = open(store, "a"); // not awaited: a revisit waits on no daemon
    assert.equal(store.state.view?.threadId, "a");
    assert.equal(store.state.view?.items.size, 4);
    assert.equal(store.state.view?.loading, false, "nothing is in flight to wait for");
    return p;
  });
});

test("the revisit resumes from the last event applied, not from the snapshot", async () => {
  const c = new FakeClient();
  const store = storeWith(c);
  await open(store, "a");
  // What a live turn does to the view while the reader watches it.
  (store as any).applyThread(MACHINE, "a", { seq: 57, kind: "item.upserted", item: item(5, "a") });
  await open(store, "b");
  await open(store, "a");
  assert.deepEqual(c.resumes, [{ threadId: "a", afterSeq: 57 }]);
  assert.equal(store.state.view?.items.size, 5, "the item the event added came back with the view");
});

test("the cached page stands in for the limit a revisit asks for", async () => {
  const c = new FakeClient();
  const store = storeWith(c);
  await open(store, "a", previewPage(40)); // a preview: a screen's worth
  await open(store, "b", previewPage(40));
  await open(store, "a", FULL_PAGE); // opened for real
  assert.equal(c.snapshots.length, 2, "no snapshot: loadOlder tops the page up if the pane is short");
  assert.equal(store.state.view?.hasMore, true);
});

test("a view that failed to load is not cached", async () => {
  const c = new FakeClient();
  c.fail = true;
  const store = storeWith(c);
  await open(store, "a");
  assert.equal(store.state.view?.error, "not connected");
  c.fail = false;
  await open(store, "b");
  await open(store, "a");
  assert.deepEqual(c.snapshots.map((s) => s.threadId), ["a", "b", "a"], "the fragment was not painted again");
});

test("dropping a machine forgets its cached threads", async () => {
  const c = new FakeClient();
  const store = storeWith(c);
  await open(store, "a");
  await open(store, "b");
  store.removeMachine(MACHINE);
  const store2 = storeWith(c);
  await store2.select({ machine: MACHINE, threadId: "a" });
  assert.deepEqual(c.snapshots.map((s) => s.threadId), ["a", "b", "a"]);
});
