/**
 * The palette is the device's, and the device remembers it.
 *
 * `theme.test.ts` measures the colours; this is the other half — that the row
 * a reader picked is the palette the next client starts in, and that a name
 * covey no longer knows falls back rather than painting nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "covey-tui-theme-"));
process.env.COVEY_CONFIG = dir;

const { Store } = await import("./store.js");
const { DEFAULT_THEME, setTheme, themeId } = await import("./theme.js");

const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
/** A client that starts from whatever is on disk now. */
const client = () => new Store([]);

test("a theme the reader picked is written down and read back at the next start", (t) => {
  t.after(() => setTheme(DEFAULT_THEME));
  const first = client();
  try {
    assert.equal(first.theme, DEFAULT_THEME, "a client with no config paints in covey's own");
    first.setTheme("nord");
    assert.equal(first.theme, "nord");
    assert.equal(config().prefs.theme, "nord", "and nothing else has to be done to keep it");
  } finally { first.shutdown(); }

  // A fresh client over the same config: this is the restart.
  setTheme(DEFAULT_THEME);
  const second = client();
  try { assert.equal(second.theme, "nord"); } finally { second.shutdown(); }
});

test("a name this covey does not know is the default, not an empty screen", (t) => {
  t.after(() => setTheme(DEFAULT_THEME));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ machines: [], prefs: { theme: "vaporwave" } }));
  setTheme("nord");
  const store = client();
  try {
    assert.equal(store.theme, DEFAULT_THEME, "a palette written by a newer covey reads back as no opinion");
    // And the row the reader actually picks still takes.
    store.setTheme("dracula");
    assert.equal(themeId(), "dracula");
  } finally { store.shutdown(); }
});

test("the bell is a setting of this client too, and keeps the name it was stored under", (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ machines: [], prefs: {} }));
  const store = client();
  try {
    assert.equal(store.bell, true, "silence is something a reader asks for");
    store.setBell(false);
    assert.equal(store.bell, false);
    assert.equal(config().prefs.quiet, true, "stored as `quiet`, so a rollback still finds it");
  } finally { store.shutdown(); }
});
