/**
 * Pasting into a one-line prompt — issue #128.
 *
 * Ink gives `useInput` a whole paste in one call, and App replays it character
 * by character, so every character queues a state update against one render. A
 * handler that ran inside that batch and read the render's `ovFilter` read the
 * text the paste started from. A paste holding a newline therefore submitted
 * the empty string, and the value the reader pasted was gone without a word.
 *
 * The defect lived in App, so these mount App on a fake terminal and paste into
 * it. `stdin.type(s)` delivers `s` as one chunk, which is exactly what a real
 * terminal does with a paste — so a test that typed the characters one at a
 * time would pass with the defect put back, and protect nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { AppState, MachineState, Overlay, Store } from "../store.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

/** A client with one machine, nothing in it, and whatever overlay the case wants. */
function appState(overlay: Overlay | null): AppState {
  const m = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info: { name: "pi", os: "linux" }, projects: new Map(), threads: new Map(),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  return {
    machines: new Map([["pi", m]]), order: ["pi"], selected: null, view: null, focus: "sidebar",
    sidebarCollapsed: false, expanded: {}, toggledRows: new Set(), lod: "compact",
    overlay, notice: null, scrollFromBottom: 0, scrollAnchor: null, drafts: new Map(),
    pendingAttachments: new Map(), tick: 0, diffView: null, attention: new Map(),
    selection: null, relaunch: null, clientBuild: null, clientStale: false,
  };
}

/** Mount App with one prompt open, and record what the prompt is handed. */
function prompt(opts: { mask?: boolean }) {
  const submitted: string[] = [];
  const overlay: Overlay = {
    kind: "input", title: "Value", ...(opts.mask ? { mask: true } : {}),
    onSubmit: (v: string) => { submitted.push(v); },
  };
  const state = appState(overlay);
  const store = {
    subscribe: () => () => {},
    getState: () => state,
    pendingRequest: () => null,
    attachments: () => [], draft: () => "", setDraft: () => {}, setFocus: () => {},
    select: async () => {}, loadOlder: async () => {}, clearSelection: () => {},
    notify: () => {}, setOverlay: () => {}, isExpanded: () => true,
    toggleExpanded: () => {}, shutdown: () => {},
  } as unknown as Store;
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { submitted, stdin, stdout, unmount: () => ink.unmount() };
}

const SECRET = "p@ss#w0rd $has\"quotes'and`ticks";

test("a paste that ends in a newline submits what was pasted, not what was on screen", async () => {
  const p = prompt({});
  try {
    // One chunk, the way a terminal delivers a paste. Before the fix the
    // newline submitted the empty string and the 30 characters were lost.
    p.stdin.type(`${SECRET}\n`);
    await until(() => p.submitted.length > 0);
    assert.deepEqual(p.submitted, [SECRET]);
  } finally { p.unmount(); }
});

test("a paste with no newline waits for the reader's own enter, and keeps every character", async () => {
  const p = prompt({});
  try {
    p.stdin.type(SECRET);
    await settle();
    assert.equal(p.submitted.length, 0, "nothing confirmed it yet");
    p.stdin.type("\r");
    await until(() => p.submitted.length > 0);
    assert.deepEqual(p.submitted, [SECRET]);
  } finally { p.unmount(); }
});

test("a masked prompt keeps a pasted newline, so a private key pastes whole", async () => {
  const p = prompt({ mask: true });
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nBgkqhkiG9w0B\n-----END PRIVATE KEY-----\n";
  try {
    p.stdin.type(key);
    await until(() => p.submitted.length > 0);
    // The newlines inside the key stay; the one that ends the paste confirms,
    // and the trim takes it off, as it takes the space off every value.
    const got = p.submitted.join("|");
    assert.equal(got, key.trim(), "the key arrived whole, not as its first line");
    assert.equal(got.split("\n").length, 4, "four lines, not one");
  } finally { p.unmount(); }
});

test("a masked paste with no trailing newline waits, and keeps its inner newlines", async () => {
  const p = prompt({ mask: true });
  try {
    p.stdin.type("first\nsecond");
    await settle();
    assert.equal(p.submitted.length, 0, "nothing confirmed it yet");
    p.stdin.type("\r");
    await until(() => p.submitted.length > 0);
    assert.equal(p.submitted.join("|"), "first\nsecond");
  } finally { p.unmount(); }
});

test("a one-line prompt drops the newlines in a paste instead of submitting twice", async () => {
  const p = prompt({});
  try {
    // Rename, the run's task list: the field holds one line. A browser drops
    // the newlines on paste; so does this. What it must never do is submit
    // "one", then submit "two" over the top of it.
    p.stdin.type("one\ntwo\n");
    await until(() => p.submitted.length > 0);
    await settle();
    assert.deepEqual(p.submitted, ["onetwo"], "one confirm, and the whole paste in it");
  } finally { p.unmount(); }
});

test("backspace still works after a paste, so the field is the text and not a render behind it", async () => {
  const p = prompt({});
  try {
    p.stdin.type("abcdef");
    await settle();
    p.stdin.type("\x7f");
    await settle();
    p.stdin.type("\r");
    await until(() => p.submitted.length > 0);
    assert.deepEqual(p.submitted, ["abcde"]);
  } finally { p.unmount(); }
});
