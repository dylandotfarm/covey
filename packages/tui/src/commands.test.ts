import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@covey/protocol";
import { acceptCommand, commandLabel, commandMenu, commandMenuHeight, commandToken, menuWindowStart, MENU_ROWS } from "./commands.js";

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

test("covey's own commands sit beside the SDK's, and keep their source", () => {
  const menu = commandMenu(LIST, [covey("clear", "Start again")], "c");
  assert.deepEqual(menu.map((c) => c.name), ["clear", "compact", "context", "usage"]);
  assert.equal(menu[0]!.source, "covey");
});

test("a covey command hides the SDK command of the same name", () => {
  const menu = commandMenu([sdk("clear", "the SDK one")], [covey("clear", "ours")], "clear");
  assert.equal(menu.length, 1);
  assert.equal(menu[0]!.description, "ours");
});

test("a thread with no session yet offers covey's commands and nothing else", () => {
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
  assert.equal(commandLabel(sdk("compact", "", "<instructions>")), "/compact <instructions>");
  assert.equal(commandLabel(sdk("resume")), "/resume");
});

// ---- the shape on screen --------------------------------------------------

test("the menu is as tall as its rows plus the hint, and never taller than the window", () => {
  assert.equal(commandMenuHeight({ items: LIST.slice(0, 3), index: 0, known: true }), 4);
  const many = Array.from({ length: 40 }, (_, i) => sdk(`c${i}`));
  assert.equal(commandMenuHeight({ items: many, index: 0, known: true }), MENU_ROWS + 1);
});

test("an empty menu is one line saying why", () => {
  assert.equal(commandMenuHeight({ items: [], index: 0, known: false }), 1);
});

test("the window follows the cursor, and stops at the ends of the list", () => {
  const n = 20;
  assert.equal(menuWindowStart(n, 0), 0);
  assert.equal(menuWindowStart(n, MENU_ROWS - 1), 0);
  assert.equal(menuWindowStart(n, MENU_ROWS), 1);
  assert.equal(menuWindowStart(n, n - 1), n - MENU_ROWS);
  assert.equal(menuWindowStart(3, 2), 0);
});
