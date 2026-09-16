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
  assert.equal(store.getState().clientStale, true);
  assert.match(store.getState().notice?.text ?? "", /newer build/);
});

test("a client with no build to watch never claims to be stale", async (t) => {
  const { store, cleanup } = scratchStore({ watchBuild: () => 0 });
  t.after(cleanup);
  await settle(30);
  assert.equal(store.getState().clientStale, false);
});
