/**
 * The environment panel has two faces, and this is the second one.
 *
 * `e` on a project row was the only way in, so a reader who did not remember
 * the key could not set a secret at all. The command palette is where a reader
 * looks for a thing they cannot name, so the row lives there too — and the
 * whole worth of it is that one *word* finds it. A reader types what they call
 * these: the environment, the keys, the variables.
 *
 * So the case types each of those words and then opens the panel, rather than
 * asserting on the option list. `filterOptions` passing on a literal row says
 * nothing about the row covey actually offers, and the row and its keywords are
 * built inside App.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-envpalette-"));

import React from "react";
import { render } from "ink";
import type { Project, Thread } from "@covey/protocol";
import { App } from "./App.js";
import type { AppState, MachineState, Overlay, Store } from "../store.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

/** One repository, cloned on two machines: one project row, a pool of two. */
const project = (id: string): Project => ({
  id, title: "covey", workspaceRoot: `/repos/${id}`, repositoryIdentity: "github.com/o/r",
  baseBranch: "main", defaultModel: null, secretKeys: ["STRIPE_KEY"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

const thread = (id: string): Thread => ({
  id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: "2026-01-02T00:00:00Z", archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

const machine = (key: string, projectId: string): MachineState => ({
  key, saved: { name: key, url: `ws://${key}:3790` }, conn: "connected", error: null,
  info: { name: key, os: "linux", arch: "arm64", settings: {} },
  projects: new Map([[projectId, project(projectId)]]),
  threads: new Map([[`t-${key}`, { ...thread(`t-${key}`), projectId }]]),
  runs: new Map(), update: null, restarting: false,
} as unknown as MachineState);

function appState(): AppState {
  return {
    machines: new Map([["pi", machine("pi", "p")], ["mac", machine("mac", "q")]]),
    order: ["pi", "mac"], selected: null, view: null, focus: "sidebar",
    sidebarCollapsed: false, showHidden: false, expanded: {}, toggledRows: new Set(), lod: "compact",
    overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null,
    drafts: new Map(), pendingAttachments: new Map(), pendingPastes: new Map(),
    tick: 0, diffView: null, terminal: null, attention: new Map(), selection: null, relaunch: null,
    clientBuild: null, clientStale: false,
  } as unknown as AppState;
}

/**
 * Enough store for the palette. `setOverlay` is the one that matters: it holds
 * the overlay in the state the way `Store` does, so the pick App opened is the
 * pick App then reads keys against.
 */
function fakeStore() {
  let state = appState();
  const listeners = new Set<() => void>();
  const notices: string[] = [];
  const store = {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getState: () => state,
    setOverlay: (ov: Overlay | null) => { state = { ...state, overlay: ov } as AppState; for (const l of listeners) l(); },
    pendingRequest: () => null,
    attachments: () => [], pastes: () => [],
    draft: () => "", setDraft: () => {}, setFocus: () => {},
    select: async () => {}, loadOlder: async () => {}, clearSelection: () => {},
    notify: (text: string) => { notices.push(text); },
    isExpanded: () => true, toggleExpanded: () => {},
    machineKeyOf: (id: string) => id, machineNameOf: (id: string) => id,
    fleets: () => ["covey"], theme: "covey", bell: false, clientSource: null,
    shutdown: () => {},
  };
  return { store: store as unknown as Store, notices, overlay: () => state.overlay };
}

/** Mount App on a fake terminal, with the cursor on the project row. */
function mount() {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const f = fakeStore();
  const ink = render(React.createElement(App, { store: f.store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { ...f, stdin, stdout, ink };
}

/** ctrl+k, as a terminal writes it. */
const CTRL_K = "\x0b";

for (const word of ["environment", "secrets", "keys", "variables", "env"]) {
  test(`the palette finds the environment panel by "${word}"`, async () => {
    const { store: _s, stdin, overlay, ink } = mount();
    try {
      stdin.type(CTRL_K);
      await until(() => overlay()?.kind === "pick");
      assert.equal(overlay()?.kind, "pick", "ctrl+k opened no command palette");

      for (const ch of word) { stdin.type(ch); await settle(20); }
      stdin.type("\r");
      await until(() => overlay()?.kind === "secrets");

      const ov = overlay();
      assert.equal(ov?.kind, "secrets",
        `"${word}" did not reach the environment panel — the palette settled on ${ov?.kind ?? "nothing"}`);
      assert.equal(ov!.kind === "secrets" && ov.scope, "project", "the palette opened the wrong scope");
    } finally {
      ink.unmount();
    }
  });
}

/**
 * The panel writes to every machine of the pool, as `e` on the project row
 * does. The two faces read the pool through one function, and this is what
 * says so: a second route that wrote to one machine would leave the same
 * repository working differently on the other.
 */
test("the palette's panel writes to every machine of the pool", async () => {
  const { stdin, overlay, ink } = mount();
  try {
    stdin.type(CTRL_K);
    await until(() => overlay()?.kind === "pick");
    for (const ch of "environment") { stdin.type(ch); await settle(20); }
    stdin.type("\r");
    await until(() => overlay()?.kind === "secrets");
    const ov = overlay();
    assert.ok(ov?.kind === "secrets");
    assert.deepEqual(
      ov.targets.map((t) => `${t.machine}:${t.ownerId}`).sort(),
      ["mac:q", "pi:p"],
      "the panel opened on one machine of a pool of two",
    );
  } finally {
    ink.unmount();
  }
});
