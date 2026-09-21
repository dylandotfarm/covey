import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@covey/protocol";
import { commandMenuFor, stepRow } from "./commandMenu.js";

const sdk = (name: string, description = "", argumentHint = ""): SlashCommandInfo => ({ name, description, argumentHint, source: "sdk" });
const LIST = [sdk("compact", "Compact the conversation", "<instructions>"), sdk("context", "What is in the window"), sdk("resume")];

test("a draft that starts a command name opens the popover, best match first", () => {
  const m = commandMenuFor("/co", LIST);
  assert.ok(m);
  assert.equal(m.token, "co");
  assert.deepEqual(m.commands.map((c) => c.name), ["compact", "context"]);
});

test("a bare slash offers every command", () => {
  assert.deepEqual(commandMenuFor("/", LIST)?.commands.map((c) => c.name), ["compact", "context", "resume"]);
});

test("prose, a path and a chosen command have no popover", () => {
  assert.equal(commandMenuFor("hello /co", LIST), null);
  assert.equal(commandMenuFor("/usr/local", LIST), null);
  assert.equal(commandMenuFor("/compact now", LIST), null);
  assert.equal(commandMenuFor("", LIST), null);
});

test("a token that matches nothing says so", () => {
  const m = commandMenuFor("/zzz", LIST);
  assert.deepEqual(m?.commands, []);
  assert.equal(m?.empty, "no command matches");
});

test("a thread that has not started a session says the list is not here yet", () => {
  const m = commandMenuFor("/", null);
  assert.deepEqual(m?.commands, []);
  assert.match(m?.empty ?? "", /first turn/);
});

test("the highlighted row moves inside the list and stops at its ends", () => {
  assert.equal(stepRow(0, -1, 3), 0);
  assert.equal(stepRow(0, 1, 3), 1);
  assert.equal(stepRow(2, 1, 3), 2);
  assert.equal(stepRow(5, 0, 3), 2);
  assert.equal(stepRow(1, 1, 0), 0);
});
