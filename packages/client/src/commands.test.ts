import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@covey/protocol";
import { COVEY_COMMANDS, acceptCommand, commandLabel, commandMenu, commandToken, coveyCommand } from "./commands.js";
import { uuid } from "./uuid.js";

const sdk = (name: string, description = "", argumentHint = "", aliases?: string[]): SlashCommandInfo => ({
  name, description, argumentHint, ...(aliases ? { aliases } : {}), source: "sdk",
});
const covey = (name: string, description = ""): SlashCommandInfo => ({ name, description, argumentHint: "", source: "covey" });

const LIST = [sdk("compact", "Compact the conversation"), sdk("usage", "Cost and limits", "", ["cost"]), sdk("context", "What is in the window"), sdk("resume")];

// ---- the token ------------------------------------------------------------

test("a slash at the start of the draft names a command", () => {
  assert.equal(commandToken("/"), "");
  assert.equal(commandToken("/com"), "com");
});

test("a slash in the middle of a sentence is prose", () => {
  assert.equal(commandToken("and/or"), null);
  assert.equal(commandToken(" /compact"), null);
  assert.equal(commandToken("read this /compact"), null);
});

test("a space ends the name: the command is already chosen", () => {
  assert.equal(commandToken("/compact please"), null);
  assert.equal(commandToken("/compact "), null);
});

test("a second line ends the name too", () => {
  assert.equal(commandToken("/compact\nmore"), null);
});

test("a path is not a command", () => {
  assert.equal(commandToken("/usr/local/bin"), null);
  assert.equal(commandToken("/Users/dylan"), null);
});

test("a draft that does not start with a slash has no command in it", () => {
  assert.equal(commandToken(""), null);
  assert.equal(commandToken("hello"), null);
});

// ---- the menu -------------------------------------------------------------

test("a bare slash offers everything, in alphabetical order", () => {
  assert.deepEqual(commandMenu(LIST, [], "").map((c) => c.name), ["compact", "context", "resume", "usage"]);
});

test("a name that starts with the token beats an alias, which beats a name that merely holds it", () => {
  // usage is here for its alias `cost`; resume holds `sum` but does not start with it.
  assert.deepEqual(commandMenu(LIST, [], "co").map((c) => c.name), ["compact", "context", "usage"]);
  assert.deepEqual(commandMenu([sdk("resume"), sdk("summary")], [], "sum").map((c) => c.name), ["summary", "resume"]);
});

test("an alias finds the command it stands for", () => {
  assert.deepEqual(commandMenu(LIST, [], "cos").map((c) => c.name), ["usage"]);
});

test("an exact name comes first, even against a longer name that starts the same", () => {
  const list = [sdk("compactor"), sdk("compact")];
  assert.deepEqual(commandMenu(list, [], "compact").map((c) => c.name), ["compact", "compactor"]);
});

test("the token is matched whatever its case", () => {
  assert.deepEqual(commandMenu(LIST, [], "COMP").map((c) => c.name), ["compact"]);
});

test("a token that matches nothing gives an empty menu", () => {
  assert.deepEqual(commandMenu(LIST, [], "zzz"), []);
});

test("a client's own commands sit beside the SDK's, and keep their source", () => {
  const menu = commandMenu(LIST, [covey("clear", "Start again")], "c");
  assert.deepEqual(menu.map((c) => c.name), ["clear", "compact", "context", "usage"]);
  assert.equal(menu[0]!.source, "covey");
});

test("a client's command hides the SDK command of the same name", () => {
  const menu = commandMenu([sdk("clear", "the SDK one")], [covey("clear", "ours")], "clear");
  assert.equal(menu.length, 1);
  assert.equal(menu[0]!.description, "ours");
});

test("a thread with no session yet offers the client's commands and nothing else", () => {
  assert.deepEqual(commandMenu(null, [covey("clear")], "").map((c) => c.name), ["clear"]);
});

test("a menu that is not known yet and a menu that is empty both hold nothing", () => {
  // The two differ in what the composer says about them, not in the list.
  assert.deepEqual(commandMenu(null, [], ""), []);
  assert.deepEqual(commandMenu([], [], ""), []);
});

// ---- taking a row ---------------------------------------------------------

test("taking a row replaces the draft with the name and a space, which closes the menu", () => {
  const next = acceptCommand(sdk("compact", "", "<instructions>"));
  assert.deepEqual(next, { value: "/compact ", caret: 9 });
  assert.equal(commandToken(next.value), null);
});

test("a row shows the argument hint when the command takes arguments", () => {
  assert.equal(commandLabel(sdk("compact", "Free up context", "<instructions>")), "/compact <instructions>");
  assert.equal(commandLabel(sdk("resume", "Pick up a thread")), "/resume");
});

// ---- the commands covey answers itself (#16) -------------------------------

test("every client offers the same covey commands, and /clear is one of them", () => {
  // One list, so a command the TUI offers and the phone does not cannot exist.
  assert.deepEqual(COVEY_COMMANDS.map((c) => c.name), ["clear"]);
  assert.ok(COVEY_COMMANDS.every((c) => c.source === "covey"));
  assert.ok(COVEY_COMMANDS.every((c) => c.description !== ""), "a row with no hint says nothing");
  // None of them takes an argument, which is what lets `coveyCommand` ask for
  // the bare name.
  assert.ok(COVEY_COMMANDS.every((c) => c.argumentHint === ""));
});

test("a bare covey command is taken out of the send path", () => {
  assert.equal(coveyCommand("/clear")?.name, "clear");
  assert.equal(coveyCommand("  /clear  ")?.name, "clear");
  assert.equal(coveyCommand("/CLEAR")?.name, "clear");
});

test("anything else goes to the agent", () => {
  // The name has to stand alone: every covey command takes no argument, so a
  // line with more in it is prose that happens to start with a slash.
  assert.equal(coveyCommand("/clear the deck"), null);
  assert.equal(coveyCommand("/clear\nand start again"), null);
  // An SDK command is the agent's, and so is a path and ordinary prose.
  assert.equal(coveyCommand("/compact"), null);
  assert.equal(coveyCommand("/usr/local/bin"), null);
  assert.equal(coveyCommand("clear"), null);
  assert.equal(coveyCommand(""), null);
  assert.equal(coveyCommand("tell me about /clear"), null);
});

test("the menu offers a covey command under the same token the composer reads", () => {
  // The two halves have to agree: a row the menu offers for `/cl` and a send
  // path that then hands `/clear` to the agent is a row that does nothing.
  const menu = commandMenu([sdk("compact")], COVEY_COMMANDS, commandToken("/cl")!);
  assert.deepEqual(menu.map((c) => c.name), ["clear"]);
  assert.ok(coveyCommand(acceptCommand(menu[0]!).value.trim()));
});

// ---- uuid, on a runtime with no Web Crypto (#168) ---------------------------

test("uuid works where there is no crypto global at all", () => {
  // React Native is that runtime: Hermes implements no Web Crypto and nothing
  // polyfills one. This shipped once — every write from the phone's app crashed
  // on `commandId: uuid()` while every read went on working.
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = uuid();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a v4 uuid");
      seen.add(id);
    }
    assert.equal(seen.size, 500, "500 uuids, none repeated");
  } finally {
    if (real) Object.defineProperty(globalThis, "crypto", real);
  }
});

test("uuid uses getRandomValues when there is no randomUUID", () => {
  // A browser on a plain http origin, which is how the phone reaches a daemon.
  // node exposes `crypto` through a getter, so the descriptor carries no
  // `value`. Keep the object itself, not the descriptor's idea of it.
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const realCrypto = globalThis.crypto;
  try {
    let used = false;
    Object.defineProperty(globalThis, "crypto", {
      value: {
        getRandomValues(a: Uint8Array) { used = true; return realCrypto.getRandomValues(a); },
      },
      configurable: true,
    });
    assert.match(uuid(), /^[0-9a-f-]{36}$/);
    assert.equal(used, true, "it took the getRandomValues path");
  } finally {
    Object.defineProperty(globalThis, "crypto", real);
  }
});
