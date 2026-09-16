import { test } from "node:test";
import assert from "node:assert/strict";
import { commandToken } from "./commands.js";
import { findTargets } from "./links.js";
import { mentionAt } from "./mentions.js";
import { applyDrop } from "./attachments.js";

/**
 * An attachment tag and the `/` and `@` prefixes share one draft, so the two
 * have to agree on what a word is. A tag must never read as a prefix, and a
 * tag in the draft must never stop a real prefix from being read.
 */

const att = (name: string) => ({ name, path: `/a/${name}`, mimeType: "image/png" });

test("a tag never starts a command, wherever it lands in the draft", () => {
  assert.equal(commandToken("[shot.png] "), null, "a tag at the start of the draft is prose, not a command");
  const mid = applyDrop("compare this", 12, [att("shot.png")], []);
  assert.equal(commandToken(mid.value), null);
});

test("a drop keeps a space in front of the tag, so it cannot join a command name", () => {
  // Without the space the draft would read `/compact[shot.png]`, and the menu
  // would go on offering completions for a name that no longer exists.
  const drop = applyDrop("/compact", 8, [att("shot.png")], []);
  assert.equal(drop.value, "/compact [shot.png] ");
  assert.equal(commandToken(drop.value), null, "a command with an argument has no menu, the same as `/diff HEAD`");
});

test("a tag in the draft does not stop a real mention being read", () => {
  const drop = applyDrop("compare and @src/", 8, [att("shot.png")], []);
  assert.equal(drop.value, "compare [shot.png] and @src/");
  const m = mentionAt(drop.value, drop.value.length);
  assert.deepEqual(m && { start: m.start, text: m.text }, { start: 23, text: "src/" });
});

test("the caret inside a tag is not inside a mention", () => {
  const drop = applyDrop("compare and @src/", 8, [att("shot.png")], []);
  assert.equal(mentionAt(drop.value, 10), null, "the caret sits in `[shot.png]`, which is not a mention");
});

test("a file whose name starts with @ still tags as a file, not a mention", () => {
  const drop = applyDrop("", 0, [att("@media.png")], []);
  assert.equal(drop.attachments[0]!.tag, "[@media.png]");
  assert.equal(mentionAt(drop.value, 3), null, "the word starts with `[`, so it is not a mention");
});

test("a space in the file name does not split the tag into a prefix", () => {
  const drop = applyDrop("", 0, [att("shot 1.png")], []);
  assert.equal(drop.value, "[shot 1.png] ");
  assert.equal(mentionAt(drop.value, 8), null);
  assert.equal(commandToken(drop.value), null);
});

test("a tag is never mistaken for a clickable path", () => {
  // #29 links an absolute path with two segments or more. A tag holds a
  // basename, which can never contain a `/`, so the two cannot collide.
  const drop = applyDrop("compare", 7, [att("shot.png")], []);
  assert.deepEqual(findTargets(drop.value, { localFiles: true, homeDir: "/Users/me" }), []);
  // The real path beside it still links, so the tag costs the reader nothing.
  const targets = findTargets(`${drop.value}/Users/me/shots/shot.png`, { localFiles: true, homeDir: "/Users/me" });
  assert.deepEqual(targets.map((t) => t.uri), ["file:///Users/me/shots/shot.png"]);
});
