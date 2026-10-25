/**
 * Pasting a path into the composer, and the way back to the path.
 *
 * A path a reader pastes is read as the file it names (#124, #85): nearly
 * always what they meant, and sometimes not — sometimes they want to *write*
 * about the file, and what they get is a chip and no path on the screen. So
 * pasting the same path again gives the path back, in place of its chip, which
 * is the rule a block of pasted text already follows (`revealPaste`).
 *
 * It is here rather than beside the pure rules because the decision lives in
 * App: `stdin.type(s)` delivers `s` as one chunk, the way a terminal delivers a
 * paste, so a case that typed the characters would pass with the wiring cut.
 * The other way back, shift+cmd+v, reads a real pasteboard and is held by
 * `attachments.test.ts` with a reader of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { PastedText } from "@covey/client";
import { App } from "./App.js";
import type { AppState, MachineState, Store, ThreadView } from "../store.js";
import type { TaggedAttachment } from "../attachments.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

/**
 * The other way back is a key, and a key needs a clipboard. This stubs the
 * Linux reader covey asks first — two answers, the type list and the text — so
 * the case drives the real `readClipboardText` through the real App. Linux
 * only: a Mac runs `osascript`, which no stub on the PATH can stand in for.
 */
const SHIFT_CTRL_V = "\x1b[118;6u";
const stub = process.platform === "linux" ? false : "this case stubs the Linux clipboard reader";

function clipboardHolds(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "covey-clip-"));
  writeFileSync(join(dir, "wl-paste"), [
    "#!/bin/sh",
    'case "$1" in',
    '  --list-types) echo "text/plain;charset=utf-8" ;;',
    `  *) printf '%s' '${text}' ;;`,
    "esac",
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

/** A real file, because the drop rules read the disk and must keep doing so. */
function shot(name = "shot 1.png"): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "covey-paste-"));
  const path = join(dir, name);
  writeFileSync(path, Buffer.from("\x89PNG\r\n\x1a\n"));
  return { dir, path };
}

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
    sidebarCollapsed: true, showHidden: false, expanded: {}, toggledRows: new Set(), lod: "compact",
    overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null, drafts: new Map(),
    pendingAttachments: new Map(), pendingPastes: new Map(), tick: 0, diffView: null, terminal: null, attention: new Map(),
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
    files: () => state.pendingAttachments.get("t") ?? [],
    unmount: () => ink.unmount(),
  };
}

test("a pasted path attaches the file, and the chip remembers the path", async () => {
  const f = shot();
  const c = await composer();
  try {
    c.stdin.type(f.path);
    await until(() => c.draft().includes("["));
    assert.equal(c.draft(), "[shot 1.png] ");
    assert.deepEqual(c.files().map((a) => a.paths), [f.path], "without this there is no way back to the path");
  } finally { c.unmount(); }
});

test("the same path pasted again gives the path back, and lets the file go", async () => {
  const f = shot();
  const c = await composer();
  try {
    // The reader writes the question and pastes the path into it. A chunk is
    // a drop only when every word of it names a file, so the prose and the
    // path are two chunks, which is also how a hand produces them.
    c.stdin.type("why is ");
    await until(() => c.draft() === "why is ");
    c.stdin.type(f.path);
    await until(() => c.draft().includes("["));
    assert.equal(c.draft(), `why is [shot 1.png] `);
    c.stdin.type(f.path);
    await until(() => c.draft().includes(f.path));
    assert.equal(c.draft(), `why is ${f.path} `, "the chip became the path, where it stood");
    assert.deepEqual(c.files(), [], "and nothing is left to send");
  } finally { c.unmount(); }
});

test("a path the terminal writes in two goes reveals the same way", async () => {
  // A screenshot dropped on a Mac arrives as the directory and then the name
  // (#130). The chip holds the *joined* path, so the whole path pasted after
  // it is the same path and reveals it.
  const f = shot();
  const c = await composer();
  try {
    c.stdin.type(`${f.dir}/`);
    await until(() => c.draft().length > 0);
    c.stdin.type("shot 1.png");
    await until(() => c.draft().includes("["));
    assert.equal(c.draft(), "[shot 1.png] ", "one chip, for one file");
    c.stdin.type(f.path);
    await until(() => c.draft().includes(f.path));
    assert.equal(c.draft(), `${f.path} `);
    assert.deepEqual(c.files(), []);
  } finally { c.unmount(); }
});

test("a path cut in two the second time reveals from the join", async () => {
  const f = shot();
  const c = await composer();
  try {
    c.stdin.type(f.path);
    await until(() => c.draft() === "[shot 1.png] ");
    // The same drop again, in the same two pieces. The first piece is half a
    // path and reads as text; the join is what names the file.
    c.stdin.type(`${f.dir}/`);
    await until(() => c.draft().includes(f.dir));
    c.stdin.type("shot 1.png");
    await until(() => !c.draft().includes("["));
    assert.equal(c.draft(), `${f.path} `, "the half in the draft went with the chip");
    assert.deepEqual(c.files(), []);
  } finally { c.unmount(); }
});

test("a different path is a second file, not a reveal", async () => {
  const f = shot();
  const g = shot("other.png");
  const c = await composer();
  try {
    c.stdin.type(f.path);
    await until(() => c.draft() === "[shot 1.png] ");
    c.stdin.type(g.path);
    await until(() => c.draft().includes("other"));
    assert.equal(c.draft(), "[shot 1.png] [other.png] ");
    assert.deepEqual(c.files().map((a) => a.name), ["shot 1.png", "other.png"]);
  } finally { c.unmount(); }
});

test("prose that mentions no file is still prose", async () => {
  const c = await composer();
  try {
    c.stdin.type("what do you make of this");
    await until(() => c.draft().length > 0);
    assert.equal(c.draft(), "what do you make of this");
    assert.deepEqual(c.files(), []);
  } finally { c.unmount(); }
});

test("shift+ctrl+v pastes a copied path as the path, not as the file", { skip: stub }, async () => {
  const f = shot();
  clipboardHolds(f.path);
  const c = await composer();
  try {
    c.stdin.type("why is ");
    await until(() => c.draft() === "why is ");
    c.stdin.type(SHIFT_CTRL_V);
    await until(() => c.draft().includes(".png"));
    assert.equal(c.draft(), `why is ${f.path}`, "the path the reader meant to write about");
    assert.deepEqual(c.files(), [], "ctrl+v is the key that attaches it");
  } finally { c.unmount(); }
});

test("a text-only paste does not join the chip of the paste before it", { skip: stub }, async () => {
  // A key the reader pressed is not a terminal finishing a chunk. The seam
  // joins a block a terminal wrote in two goes; read here it would put the
  // clipboard inside the chip of the paste a moment earlier, leaving one chip
  // where the reader made two.
  clipboardHolds("and this one");
  const c = await composer();
  try {
    c.stdin.type("one\ntwo\nthree");
    await until(() => c.draft() === "[pasted 3 lines] ");
    c.stdin.type(SHIFT_CTRL_V);                     // well inside PASTE_SEAM_MS
    await until(() => c.draft().includes("and this one"));
    assert.equal(c.draft(), "[pasted 3 lines] and this one", "two pastes, and the chip still holds three lines");
  } finally { c.unmount(); }
});
