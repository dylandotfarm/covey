/**
 * The keys the shell panel takes, and the one key that opens it — issue #10.
 *
 * These mount App on a fake terminal, because the decision they are about
 * lives there: the shell is a *place to type*, so it has to take a key before
 * anything that reads a bare letter as a command, and it has to do that without
 * the composer's paste rules (#128) getting hold of the chunk first.
 *
 * The case that matters most is the binding itself. ctrl+` reaches Ink two
 * different ways depending on whether the kitty keyboard protocol negotiated,
 * and both have to land on the same handler — so both bytes are typed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { AnsiLog } from "../ansi.js";
import type { AppState, MachineState, Store, ThreadView } from "../store.js";
import { FakeStdin, FakeStdout, settle, until } from "./testTerminal.js";

/** Everything the panel would have asked the store to do. */
interface Calls {
  toggle: number;
  sent: string[];
  interrupt: number;
  ended: number;
  cleared: number;
  recalled: number[];
  drafts: [string, number][];
  scrolls: number[];
  diffScrolls: number[];
}

function mount(opts: { open: boolean; busy?: boolean; draft?: string; output?: string; diff?: boolean }) {
  const calls: Calls = { toggle: 0, sent: [], interrupt: 0, ended: 0, cleared: 0, recalled: [], drafts: [], scrolls: [], diffScrolls: [] };
  const log = new AnsiLog(100);
  if (opts.output) log.write(opts.output);
  const machine = {
    key: "pi", saved: { name: "pi", url: "ws://pi:3790" }, conn: "connected", error: null,
    info: { name: "pi", os: "linux" }, projects: new Map(), threads: new Map(),
    runs: new Map(), update: null, restarting: false,
  } as unknown as MachineState;
  const state: AppState = {
    machines: new Map([["pi", machine]]), order: ["pi"], selected: { machine: "pi", threadId: "t1" },
    view: { machine: "pi", threadId: "t1", thread: { id: "t1", title: "work" }, items: new Map(), seq: 1 } as unknown as ThreadView,
    focus: "composer", sidebarCollapsed: true, showHidden: false, expanded: {}, toggledRows: new Set(),
    lod: "compact", overlay: null, notice: null, scrollFromBottom: 0, scrollAnchor: null,
    drafts: new Map(), pendingAttachments: new Map(), pendingPastes: new Map(), tick: 0,
    diffView: opts.diff
      ? { threadId: "t1", loading: false, scroll: 0, diff: { turnId: "t1", additions: 1, deletions: 0, files: [{ path: "a.ts", additions: 1, deletions: 0, status: "M" }], patch: "diff --git a/a.ts b/a.ts\n+one\n" } }
      : null,
    terminal: {
      machine: "pi", threadId: "t1", terminalId: "x1", open: opts.open, cwd: "/work", shell: "bash",
      busy: !!opts.busy, exitCode: null, log, logGen: log.generation,
      draft: opts.draft ?? "", caret: (opts.draft ?? "").length, scroll: 0, history: ["git status"], historyAt: null, ended: false,
    },
    attention: new Map(), selection: null, relaunch: null, clientBuild: null, clientStale: false,
  };
  const store = {
    subscribe: () => () => {},
    getState: () => state,
    pendingRequest: () => null,
    attachments: () => [], pastes: () => [], draft: () => "", setDraft: () => {}, setFocus: () => {},
    select: async () => {}, loadOlder: async () => {}, clearSelection: () => {},
    notify: () => {}, setOverlay: () => {}, isExpanded: () => true, toggleExpanded: () => {}, shutdown: () => {},
    setDiffScroll: (n: number) => { calls.diffScrolls.push(n); },
    toggleTerminal: async () => { calls.toggle++; },
    sendTerminal: async () => { calls.sent.push(state.terminal!.draft); },
    interruptTerminal: async () => { calls.interrupt++; },
    endTerminal: async () => { calls.ended++; },
    clearTerminal: () => { calls.cleared++; },
    recallTerminal: (d: number) => { calls.recalled.push(d); },
    setTerminalDraft: (draft: string, caret: number) => { calls.drafts.push([draft, caret]); state.terminal = { ...state.terminal!, draft, caret }; },
    setTerminalScroll: (n: number) => { calls.scrolls.push(n); },
    resizeTerminal: async () => {},
    toggleDiff: async () => {},
  } as unknown as Store;
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const ink = render(React.createElement(App, { store }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { calls, stdin, stdout, state, unmount: () => ink.unmount() };
}

test("ctrl+` opens the shell, whether or not the kitty protocol negotiated", async () => {
  // A terminal without the protocol sends a bare NUL, and Ink's legacy parser
  // turns a control byte into `String.fromCharCode(b + 96)` — which for 0 is
  // the backtick. With the protocol it is codepoint 96 and the ctrl modifier.
  // Both arrive as ``input === "`"`` with `ctrl`, which is why this binding
  // needs no ctrl fallback of its own, unlike covey's cmd bindings.
  for (const bytes of ["\x00", "\x1b[96;5u"]) {
    const app = mount({ open: false });
    try {
      app.stdin.type(bytes);
      await until(() => app.calls.toggle > 0);
      assert.equal(app.calls.toggle, 1, JSON.stringify(bytes));
    } finally { app.unmount(); }
  }
});

test("the open shell takes a letter before anything reads it as a command", async () => {
  const app = mount({ open: true });
  try {
    // `d` with the transcript on screen is nothing, and in the sidebar it opens
    // the diff. At a shell prompt it is the first letter of a command.
    app.stdin.type("d");
    await until(() => app.calls.drafts.length > 0);
    assert.deepEqual(app.calls.drafts.at(-1), ["d", 1]);
  } finally { app.unmount(); }
});

test("enter runs the line and ctrl+c interrupts what is running", async () => {
  const app = mount({ open: true, draft: "ls -la" });
  try {
    app.stdin.type("\r");
    await until(() => app.calls.sent.length > 0);
    assert.deepEqual(app.calls.sent, ["ls -la"]);
  } finally { app.unmount(); }

  const busy = mount({ open: true, busy: true });
  try {
    // ctrl+c belongs to the shell here, as it does in any terminal: it must
    // not arm covey's quit, which would make the second press leave covey.
    busy.stdin.type("\x03");
    await until(() => busy.calls.interrupt > 0);
    assert.equal(busy.calls.interrupt, 1);
  } finally { busy.unmount(); }
});

test("ctrl+d ends the shell only on an empty line", async () => {
  const half = mount({ open: true, draft: "rm -rf /" });
  try {
    // Otherwise ctrl+d next to a half-typed command would throw the command
    // away with the shell.
    half.stdin.type("\x04");
    await settle();
    assert.equal(half.calls.ended, 0);
  } finally { half.unmount(); }

  const empty = mount({ open: true });
  try {
    empty.stdin.type("\x04");
    await until(() => empty.calls.ended > 0);
    assert.equal(empty.calls.ended, 1);
  } finally { empty.unmount(); }
});

test("the arrow keys walk the history and shift scrolls the output", async () => {
  const app = mount({ open: true, output: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n" });
  try {
    // At a prompt ↑ means "what did I just run" in every shell there is, so the
    // bare arrows go to the history and the scroll takes shift.
    app.stdin.type("\x1b[A");
    await until(() => app.calls.recalled.length > 0);
    assert.deepEqual(app.calls.recalled, [-1]);
    app.stdin.type("\x1b[1;2A");
    await until(() => app.calls.scrolls.length > 0);
    assert.ok(app.calls.scrolls.length > 0);
  } finally { app.unmount(); }
});

test("readline's own line editing works at the prompt", async () => {
  const app = mount({ open: true, draft: "one two" });
  try {
    app.stdin.type("\x17"); // ctrl+w: back over one word
    await until(() => app.calls.drafts.length > 0);
    assert.deepEqual(app.calls.drafts.at(-1), ["one ", 4]);
    app.stdin.type("\x15"); // ctrl+u: to the start of the line
    await until(() => app.calls.drafts.length > 1);
    assert.deepEqual(app.calls.drafts.at(-1), ["", 0]);
  } finally { app.unmount(); }

  const clear = mount({ open: true });
  try {
    clear.stdin.type("\x0c"); // ctrl+l
    await until(() => clear.calls.cleared > 0);
    assert.equal(clear.calls.cleared, 1);
  } finally { clear.unmount(); }
});

test("a paste at the prompt goes in whole and is not a composer chip", async () => {
  const app = mount({ open: true });
  try {
    // One `type` is one chunk, which is what a real terminal does with a
    // paste. Replayed key by key this would paint once per character; handed
    // to the composer's rules it would become a chip (#128), which is the
    // wrong answer at a shell prompt — there, the paste *is* the command.
    app.stdin.type("git log --oneline -20");
    await until(() => app.calls.drafts.length > 0);
    assert.equal(app.calls.drafts.length, 1, "one update for the whole paste");
    assert.deepEqual(app.calls.drafts[0], ["git log --oneline -20", 21]);
  } finally { app.unmount(); }
});

test("a pasted line that ends in a newline runs", async () => {
  const app = mount({ open: true });
  try {
    app.stdin.type("echo hi\n");
    await until(() => app.calls.sent.length > 0);
    assert.deepEqual(app.calls.sent, ["echo hi"]);
  } finally { app.unmount(); }
});

test("esc puts the transcript back without ending the shell", async () => {
  const app = mount({ open: true });
  try {
    app.stdin.type("\x1b");
    await until(() => app.calls.toggle > 0);
    assert.equal(app.calls.toggle, 1);
    // `toggleTerminal` hides; only ctrl+d lets go of the shell, because the
    // shell is still running on the daemon in the directory the reader walked to.
    assert.equal(app.calls.ended, 0);
  } finally { app.unmount(); }
});

test("the panel paints the output, the prompt and the directory", async () => {
  const app = mount({ open: true, output: "\x1b[32mon branch main\x1b[39m\n", draft: "git status" });
  try {
    await until(() => app.stdout.lastFrame.includes("on branch main"));
    const frame = app.stdout.lastFrame;
    assert.match(frame, /Shell/);
    assert.match(frame, /on branch main/);
    assert.match(frame, /git status/);
    // The escapes became spans, so no raw `[32m` is painted — and the width
    // the frame was laid out with is the width the reader sees.
    assert.ok(!frame.includes("[32mon branch"), frame);
  } finally { app.unmount(); }
});

test("the diff and the shell never disagree about which pane is on screen", async () => {
  // The defect the review caught: `toggleTerminal` left `diffView` set, and the
  // painter, the key handler and `hitTest` each read their own ordering of the
  // same two fields. The diff painted, the shell held the keyboard, and `esc`
  // hid a pane that was not on the screen — so the reader's first press read as
  // a key that did nothing, with a shell really running on the daemon behind it.
  //
  // The store now puts one away when the other opens, so this state cannot be
  // reached. It is built by hand here anyway, because what is being tested is
  // that App has *one* answer rather than three: a future pane added to one of
  // the three chains and not the others would put the bug straight back.
  const app = mount({ open: true, diff: true });
  try {
    await until(() => app.stdout.lastFrame.includes("Shell"));
    const frame = app.stdout.lastFrame;
    assert.match(frame, /Shell/, "the shell paints");
    assert.ok(!frame.includes("Changes "), "and the diff does not");
    // The bar names the pane that is painted.
    assert.match(frame, /ctrl\+` hides/);
    // A letter goes to the pane that is painted, not to the diff's scroll.
    app.stdin.type("j");
    await until(() => app.calls.drafts.length > 0);
    assert.deepEqual(app.calls.drafts.at(-1), ["j", 1]);
    assert.deepEqual(app.calls.diffScrolls, [], "the diff's keys belong to the diff, and the diff is not up");
    // And esc closes what the reader can see.
    app.stdin.type("\x1b");
    await until(() => app.calls.toggle > 0);
    assert.equal(app.calls.toggle, 1);
  } finally { app.unmount(); }
});
