/**
 * What the terminal says about its own window must never land in the composer.
 *
 * Resize the window and two things come back up the stream: the answer to the
 * cell size question covey asks for a preview (#163), and, on some terminals,
 * a window size report nobody asked for. Ink hands an unrecognised CSI to
 * `useInput` as the reader's typing, so a reader who dragged the window by
 * its corner found `[6;34;16t` thirty-eight times over in the composer.
 *
 * The form the answer arrives in is the whole of the bug, and it is why this
 * mounts App rather than test the helper beside it. Ink splits one chunk into
 * one event per escape sequence (`input-parser.js`) and then drops that
 * event's *leading* escape (`use-input.js`), so what reaches covey is
 * `[6;34;16t` — which is not what an answer looks like anywhere else, and not
 * what the old guard matched. `media.test.ts` states which text is a report;
 * what is here is the wiring, which lives in App and nowhere else.
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

const ESC = "\u001b";
/** The answer to `CELL_SIZE_QUERY`, as ink delivers the first of a chunk: its
 *  own escape is gone. Every answer after it in the same chunk keeps one. */
const REPLY = "[6;34;16t";
const MORE = `${ESC}[6;34;16t`;

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
    unmount: () => ink.unmount(),
  };
}

test("a drag's worth of cell size answers never reaches the composer", async () => {
  const c = await composer();
  try {
    // One drag of a corner: covey asked again on every resize, and the
    // terminal answered every question. Ink cuts this into 38 events.
    c.stdin.type(REPLY + MORE.repeat(37));
    // A spell, and not `until`: this case is about what did *not* happen, and
    // there is no condition to watch for that.
    await settle();
    assert.equal(c.draft(), "", "the answers are the terminal's, not the reader's");
  } finally { c.unmount(); }
});

test("a report inside a paste goes, and the reader's own words stay", async () => {
  const c = await composer();
  try {
    // The one route that really does hand covey a report with text around it.
    // covey registers no `usePaste`, so ink gives the whole of a bracketed
    // paste to `useInput` as one string, reports and all. The report itself is
    // dropped with nothing said, which is the cost of reading one from
    // anywhere in the chunk; what must not happen is the reader losing the
    // words they pasted.
    c.stdin.type(`${ESC}[200~before ${MORE} after${ESC}[201~`);
    await until(() => c.draft().includes("after"));
    assert.equal(c.draft(), "before  after", "the paste kept its words");
  } finally { c.unmount(); }
});

test("ordinary typing is untouched", async () => {
  const c = await composer();
  try {
    // One key to a chunk, which is the path a report takes as well. Each
    // waits on the character before it: Ink gives every chunk of a batch the
    // state of the render in front of it, so five keys at once are one key
    // (#128), and that is not what this case is about.
    let n = 0;
    for (const ch of "hello") { c.stdin.type(ch); n++; await until(() => c.draft().length === n); }
    assert.equal(c.draft(), "hello", "a word the reader typed still lands");
  } finally { c.unmount(); }
});
