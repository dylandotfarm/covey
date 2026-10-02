/**
 * Pasting a block of text into the composer — the chip, and the keys on it.
 *
 * Two hundred pasted lines used to fill the draft: the transcript went off the
 * screen, the composer scrolled, and the sentence the reader was writing went
 * with it. So a paste of more than two lines becomes `[pasted 200 lines]` and
 * the lines are held aside (`@covey/client`'s `paste.ts`).
 *
 * The rules of the text are tested there. What is here is the wiring, which
 * lives in App and nowhere else: `stdin.type(s)` delivers `s` as one chunk, the
 * way a terminal delivers a paste, so a case that typed the characters one at a
 * time would pass with the wiring cut.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import type { PastedText } from "@covey/client";
import { App } from "./App.js";
import type { AppState, MachineState, Store, ThreadView } from "../store.js";
import type { TaggedAttachment } from "../attachments.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

const THREE = "one\ntwo\nthree";

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
    sidebarCollapsed: true, expanded: {}, toggledRows: new Set(), lod: "compact",
    overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null, drafts: new Map(),
    pendingAttachments: new Map(), pendingPastes: new Map(), tick: 0, diffView: null, attention: new Map(),
    selection: null, relaunch: null, clientBuild: null, clientStale: false,
  };
}

/** Mount App with an empty composer, and read back what the draft holds. */
async function composer() {
  const state = appState();
  const store = {
    subscribe: () => () => {},
    getState: () => state,
    pendingRequest: () => null,
    attachments: (id: string) => state.pendingAttachments.get(id) ?? [],
    setAttachments: (id: string, a: TaggedAttachment[]) => { state.pendingAttachments.set(id, a); },
    pastes: (id: string) => state.pendingPastes.get(id) ?? [],
    setPastes: (id: string, held: PastedText[]) => { state.pendingPastes.set(id, held); },
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
  await settle();
  return {
    stdin,
    draft: () => state.drafts.get("t") ?? "",
    held: () => state.pendingPastes.get("t") ?? [],
    unmount: () => ink.unmount(),
  };
}

test("a paste of three lines becomes one chip, and the lines are held", async () => {
  const c = await composer();
  try {
    c.stdin.type(THREE);
    await until(() => c.draft().includes("[pasted"));
    assert.equal(c.draft(), "[pasted 3 lines] ");
    assert.deepEqual(c.held(), [{ tag: "[pasted 3 lines]", text: THREE }]);
  } finally { c.unmount(); }
});

test("a paste of two lines is part of the sentence and stays in it", async () => {
  const c = await composer();
  try {
    c.stdin.type("first\nsecond");
    await until(() => c.draft().length > 0);
    assert.equal(c.draft(), "first\nsecond", "a short paste is text, not a chip");
    assert.deepEqual(c.held(), []);
  } finally { c.unmount(); }
});

test("one backspace takes the whole chip out, and the lines with it", async () => {
  const c = await composer();
  try {
    c.stdin.type(THREE);
    await until(() => c.draft() === "[pasted 3 lines] ");
    c.stdin.type(BACKSPACE);                       // the space the paste left
    await until(() => c.draft() === "[pasted 3 lines]");
    c.stdin.type(BACKSPACE);                       // and the chip, in one key
    await until(() => c.draft() === "");
    assert.equal(c.draft(), "", "sixteen characters went in one key");
  } finally { c.unmount(); }
});

test("the arrow keys walk over a chip in one step", async () => {
  const c = await composer();
  try {
    c.stdin.type(THREE);
    await until(() => c.draft() === "[pasted 3 lines] ");
    c.stdin.type(LEFT);                            // over the trailing space
    await settle();
    c.stdin.type(LEFT);                            // over the chip, whole
    await settle();
    c.stdin.type("X");
    await until(() => c.draft().startsWith("X"));
    assert.equal(c.draft(), "X[pasted 3 lines] ",
      "one key crossed the chip; a key per character would have landed inside it");
  } finally { c.unmount(); }
});

test("the same block pasted again shows the text instead of holding it twice", async () => {
  const c = await composer();
  try {
    c.stdin.type(THREE);
    await until(() => c.draft() === "[pasted 3 lines] ");
    await settle();                                // the seam closes; this is a second paste
    c.stdin.type(THREE);
    await until(() => c.draft().includes("three"));
    assert.equal(c.draft(), `${THREE} `, "the chip became the lines it stood for");
    assert.deepEqual(c.held(), [], "and nothing is held aside any more");
  } finally { c.unmount(); }
});

test("a block the terminal writes in two goes is one chip, not two", async () => {
  const c = await composer();
  try {
    c.stdin.type(THREE);
    await until(() => c.draft() === "[pasted 3 lines] ");
    c.stdin.type("\nfour\nfive");
    await until(() => c.draft().includes("5 lines"));
    assert.equal(c.draft(), "[pasted 5 lines] ", "one chip, counting every line of the paste");
    assert.deepEqual(c.held(), [{ tag: "[pasted 5 lines]", text: `${THREE}\nfour\nfive` }]);
  } finally { c.unmount(); }
});

test("a chunk that was the reader's own writing is never joined into a chip", async () => {
  const c = await composer();
  try {
    // What a terminal hands over for a typed-then-pasted line is two chunks a
    // moment apart, and the first is prose. Joining them put the question
    // itself inside the chip: the reader watched their own words disappear.
    c.stdin.type("why does this fail? ");
    await until(() => c.draft() === "why does this fail? ");
    c.stdin.type(THREE);
    await until(() => c.draft().includes("[pasted"));
    assert.equal(c.draft(), "why does this fail? [pasted 3 lines] ", "the question stayed on the screen");
    assert.deepEqual(c.held(), [{ tag: "[pasted 3 lines]", text: THREE }]);
  } finally { c.unmount(); }
});
