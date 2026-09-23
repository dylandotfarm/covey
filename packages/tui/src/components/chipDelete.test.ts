/**
 * Deleting an attachment chip — one key, not one key per character.
 *
 * A drop puts `[Screenshot 2026-09-22 at 8.48.31 PM.png]` in the draft, and
 * taking it back out used to be forty backspaces. Worse, a chip half deleted
 * is a file silently dropped: the tag is the only record of it, so the moment
 * the text stops matching, `keepTagged` forgets the bytes.
 *
 * The rule lives in App's key handler, where the draft and the pending list
 * meet, so `tagSpanAt` and `cutTag` on their own would pass with the wiring
 * cut. These mount App on a fake terminal and press the key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { AppState, MachineState, Store, ThreadView } from "../store.js";
import type { TaggedAttachment } from "../attachments.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

/** A client with one machine and one thread open, the composer focused. */
function appState(): AppState {
  const m = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info: { name: "pi", os: "linux" }, projects: new Map(), threads: new Map(),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  const view = {
    machine: "pi", threadId: "t", thread: null, items: new Map(), loading: false, error: null,
    hasMore: false, loadingOlder: false, seq: 1, commands: null, dirs: new Map(),
  } as unknown as ThreadView;
  return {
    machines: new Map([["pi", m]]), order: ["pi"], selected: { machine: "pi", threadId: "t" }, view, focus: "composer",
    sidebarCollapsed: true, expanded: {}, expandedItems: new Set(), toolsExpanded: false,
    overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null, drafts: new Map(),
    pendingAttachments: new Map(), tick: 0, diffView: null, attention: new Map(),
    selection: null, relaunch: null, clientBuild: null, clientStale: false,
  };
}

/**
 * Mount App with `draft` in the composer and `atts` standing behind its chips.
 *
 * App seeds its own draft from the store in an effect, so the mount is not
 * done until that has been through React. A key pressed before it lands is a
 * key pressed against an empty composer.
 */
async function composer(draft: string, atts: TaggedAttachment[]) {
  const state = appState();
  state.drafts.set("t", draft);
  state.pendingAttachments.set("t", atts);
  const store = {
    subscribe: () => () => {},
    getState: () => state,
    pendingRequest: () => null,
    attachments: (id: string) => state.pendingAttachments.get(id) ?? [],
    setAttachments: (id: string, a: TaggedAttachment[]) => { state.pendingAttachments.set(id, a); },
    draft: (id: string) => state.drafts.get(id) ?? "",
    setDraft: (id: string, v: string) => { state.drafts.set(id, v); },
    setFocus: () => {}, select: async () => {}, loadOlder: async () => {},
    clearSelection: () => {}, notify: () => {}, setOverlay: () => {},
    isExpanded: () => true, toggleExpanded: () => {}, shutdown: () => {},
    setScroll: () => {}, syncAttachments: () => [], sendTurn: async () => {},
  } as unknown as Store;
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  const read = () => state.drafts.get("t") ?? "";
  await until(() => read() === draft);
  return { stdin, draft: read, unmount: () => ink.unmount() };
}

const att = (name: string, tag: string): TaggedAttachment =>
  ({ name, path: `/a/${name}`, mimeType: "image/png", tag });

const LONG = "[Screenshot 2026-09-22 at 8.48.31 PM.png]";

test("one backspace takes a whole chip out of the draft", async () => {
  const c = await composer(`compare ${LONG} `, [att("Screenshot 2026-09-22 at 8.48.31 PM.png", LONG)]);
  try {
    c.stdin.type(BACKSPACE);              // the space the drop put after the chip
    await until(() => c.draft() === `compare ${LONG}`);
    c.stdin.type(BACKSPACE);              // and now the chip, in one key
    await until(() => c.draft() === "compare");
    assert.equal(c.draft(), "compare", "the chip went whole, and left no double space");
  } finally { c.unmount(); }
});

test("delete takes the chip in front of the caret", async () => {
  const c = await composer(`${LONG} tail`, [att("Screenshot 2026-09-22 at 8.48.31 PM.png", LONG)]);
  try {
    c.stdin.type("\x01");                 // ctrl+a: the caret to the start of the line
    await settle();
    c.stdin.type(DELETE);
    await until(() => c.draft() === "tail");
    assert.equal(c.draft(), "tail");
  } finally { c.unmount(); }
});

test("text that is not a chip is still deleted a character at a time", async () => {
  const c = await composer("a [note] here", []);
  try {
    c.stdin.type(BACKSPACE);
    await until(() => c.draft() === "a [note] her");
    assert.equal(c.draft(), "a [note] her", "brackets the reader typed are not a chip");
  } finally { c.unmount(); }
});

test("one chip of a directory drop takes every file of it", async () => {
  const files = [att("a.md", "[notes/]"), att("deep/b.md", "[notes/]")];
  const c = await composer("look at [notes/]", files);
  try {
    c.stdin.type(BACKSPACE);
    await until(() => c.draft() === "look at");
    assert.equal(c.draft(), "look at", "the two files shared one chip, so one key took both");
  } finally { c.unmount(); }
});
