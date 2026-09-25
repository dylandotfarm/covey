/**
 * The session limits on the machine control panel.
 *
 * A thread's session is a subprocess of about 300 MB, and `maxLiveSessions` and
 * `sessionIdleMinutes` are what a reader turns to hold that down. Until now the
 * only way to change either was to edit `daemon.json` on the machine and
 * restart the daemon, or to set an environment variable — which is to say, an
 * `ssh` session, which is the one thing the control panel exists to replace.
 *
 * `@covey/client` holds the words and node tests them (`sessionBudget.test.ts`).
 * What this file covers is the wiring, which a unit test of that list cannot
 * reach: that the rows are on the panel at all, that each one opens its picker,
 * and that picking a row sends the command the daemon reads. It mounts App on a
 * fake terminal and types, the way `App.test.ts` does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { MachineInfo } from "@covey/protocol";
import { App } from "./App.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-cfg-"));
const { Store } = await import("../store.js");

const INFO = (settings: Partial<MachineInfo["settings"]> = {}): MachineInfo => ({
  machineId: "m1", name: "pi", os: "linux", arch: "arm64", homeDir: "/home/pi",
  daemonVersion: "abc1234", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, ...settings },
  // 4 sessions is what 8 GB of memory affords, so the panel says 4 where a
  // workstation would say 8. That is the figure no client could work out.
  sessionBudget: { idleMinutes: 120, liveLimit: 4, sessionMemoryBytes: 300 * 1024 * 1024 },
});

/** A store with one connected machine, and every command it was sent. */
function harness(settings: Partial<MachineInfo["settings"]> = {}) {
  const sent: Record<string, unknown>[] = [];
  const store = new Store([]);
  const s = store as any;
  const info = INFO(settings);
  s.state.machines.set("pi", {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info, projects: new Map(), threads: new Map(), runs: new Map(), update: null, restarting: false,
  });
  s.state.order = ["pi"];
  s.clients.set("pi", { state: "connected", info, command: async (c: Record<string, unknown>) => { sent.push(c); return {}; } });
  return { store, sent, info };
}

/** Mount App, and hand back the screen and the keyboard. */
function mount(store: unknown) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store: store as never }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { stdout, stdin, ink };
}

test("the control panel carries both session limits, named with the figures the daemon resolved", async () => {
  const { store } = harness();
  const { stdout, stdin, ink } = mount(store);
  try {
    stdin.type("\u000b"); // ctrl+k
    await until(() => stdout.lastFrame.includes("Commands"));
    stdin.type("machine control");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions"));
    const frame = stdout.lastFrame;
    // The number behind the word, on the row itself: a reader must not have to
    // open the picker to learn what this machine's default resolves to.
    assert.match(frame, /Live sessions: from memory \(4\)/, frame);
    assert.match(frame, /Release when idle: default \(2 hours\)/, frame);
  } finally {
    ink.unmount();
  }
});

test("picking a live-session ceiling sends it, and the panel prices every choice", async () => {
  const { store, sent } = harness();
  const { stdout, stdin, ink } = mount(store);
  try {
    stdin.type("\u000b");
    await until(() => stdout.lastFrame.includes("Commands"));
    stdin.type("machine control");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions"));

    stdin.type("live sessions");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions on pi"));
    // What a ceiling costs, beside the ceiling. The count is not the thing
    // being chosen; the memory is.
    assert.match(stdout.lastFrame, /about 1\.3 GB/, stdout.lastFrame);

    stdin.type("4 session");
    await settle(60);
    stdin.type("\r");
    await until(() => sent.length > 0);
    assert.deepEqual(sent.map((c) => [c.type, c.maxLiveSessions]), [["machine.settings", 4]]);
  } finally {
    ink.unmount();
  }
});

test("the idle picker offers never, and clearing a limit sends null rather than a number", async () => {
  // A machine that holds a limit of its own, so the panel shows it and the
  // "Default" row is the one that clears it.
  const { store, sent } = harness({ sessionIdleMinutes: 30 });
  const { stdout, stdin, ink } = mount(store);
  try {
    stdin.type("\u000b");
    await until(() => stdout.lastFrame.includes("Commands"));
    stdin.type("machine control");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions"));
    assert.match(stdout.lastFrame, /Release when idle: 30 minutes/, stdout.lastFrame);

    stdin.type("release when idle");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Release an idle session on pi"));
    const frame = stdout.lastFrame;
    assert.match(frame, /Never/, frame);
    assert.match(frame, /only the live-session limit releases one/, frame);
    // The default row names what that default resolves to on this machine, in
    // its label — the hint is where "current" goes on the row in force.
    assert.match(frame, /Default \(2 hours\)/, frame);

    stdin.type("default (2");
    await settle(60);
    stdin.type("\r");
    await until(() => sent.length > 0);
    assert.deepEqual(sent, [{ type: "machine.settings", sessionIdleMinutes: null }],
      "the default row clears the setting; it must not send 0, which means never");
  } finally {
    ink.unmount();
  }
});

test("a daemon too old to send a budget still offers the pickers, and claims no figures", async () => {
  const { store, sent, info } = harness();
  delete info.sessionBudget;
  const { stdout, stdin, ink } = mount(store);
  try {
    stdin.type("\u000b");
    await until(() => stdout.lastFrame.includes("Commands"));
    stdin.type("machine control");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions"));
    const frame = stdout.lastFrame;
    assert.match(frame, /Live sessions: from memory(?!\s*\()/, frame);
    assert.match(frame, /Release when idle: default(?!\s*\()/, frame);

    // And the reader can still set one. What they cannot be told is what the
    // default was — which is better than a number guessed on this machine's
    // memory rather than that one's.
    stdin.type("live sessions");
    await settle(60);
    stdin.type("\r");
    await until(() => stdout.lastFrame.includes("Live sessions on pi"));
    assert.doesNotMatch(stdout.lastFrame, /GB/, stdout.lastFrame);
    stdin.type("2 session");
    await settle(60);
    stdin.type("\r");
    await until(() => sent.length > 0);
    assert.deepEqual(sent, [{ type: "machine.settings", maxLiveSessions: 2 }]);
  } finally {
    ink.unmount();
  }
});
