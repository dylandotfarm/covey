import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@covey/protocol";
import { acceptCommand, commandMenu, commandRows, commandToken } from "./commands.js";

// The token, the ranking and the accept are the client's, and
// `packages/client/src/commands.test.ts` holds them. This file checks that
// the TUI reaches them and shapes a row the way `Composer` paints it.

const sdk = (name: string, description = "", argumentHint = ""): SlashCommandInfo => ({ name, description, argumentHint, source: "sdk" });

test("the composer reaches the client's command logic", () => {
  assert.equal(commandToken("/com"), "com");
  assert.deepEqual(commandMenu([sdk("compact"), sdk("resume")], [], "co").map((c) => c.name), ["compact"]);
  assert.deepEqual(acceptCommand(sdk("compact")), { value: "/compact ", caret: 9 });
});

test("a row shows the argument hint when the command takes arguments", () => {
  const rows = commandRows([sdk("compact", "Free up context", "<instructions>"), sdk("resume", "Pick up a thread")]);
  assert.deepEqual(rows, [
    { key: "compact", label: "/compact <instructions>", hint: "Free up context" },
    { key: "resume", label: "/resume", hint: "Pick up a thread" },
  ]);
});
