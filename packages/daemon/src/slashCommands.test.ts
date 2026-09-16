import { test } from "node:test";
import assert from "node:assert/strict";
import { toCommandInfos } from "./slashCommands.js";

test("an SDK command becomes a protocol command, and says where it came from", () => {
  const [c] = toCommandInfos([{ name: "compact", description: "Compact the conversation", argumentHint: "<instructions>" }]);
  assert.deepEqual(c, { name: "compact", description: "Compact the conversation", argumentHint: "<instructions>", source: "sdk" });
});

test("a command with no description or hint still has both fields", () => {
  const [c] = toCommandInfos([{ name: "review" }]);
  assert.equal(c!.description, "");
  assert.equal(c!.argumentHint, "");
});

test("the leading slash is dropped, wherever it appears", () => {
  const [c] = toCommandInfos([{ name: "/usage", aliases: ["/cost", "stats"] }]);
  assert.equal(c!.name, "usage");
  assert.deepEqual(c!.aliases, ["cost", "stats"]);
});

test("a command bound to the CLI's own terminal is hidden from a remote client", () => {
  const out = toCommandInfos(
    [{ name: "exit" }, { name: "statusline" }, { name: "compact" }],
    ["exit", "statusline"],
  );
  assert.deepEqual(out.map((c) => c.name), ["compact"]);
});

test("an alias of a terminal command is hidden with it: both names run the same code", () => {
  const out = toCommandInfos([{ name: "quit", aliases: ["exit"] }, { name: "compact" }], ["exit"]);
  assert.deepEqual(out.map((c) => c.name), ["compact"]);
});

test("a name repeated by the SDK appears once", () => {
  const out = toCommandInfos([{ name: "help" }, { name: "help", description: "second" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.description, "");
});

test("an alias that repeats the name is dropped, and an empty alias list is omitted", () => {
  const [c] = toCommandInfos([{ name: "usage", aliases: ["usage", ""] }]);
  assert.equal("aliases" in c!, false);
});

test("a command with no name at all is dropped rather than shown as a bare slash", () => {
  assert.deepEqual(toCommandInfos([{ name: "" }, { name: "  " }]), []);
});
