/**
 * The `/covey` skill reaches a session as a plugin from the checkout, or not
 * at all: a checkout without the plugin, or no checkout, hands the session
 * nothing rather than a path that does not exist. The cases below that read
 * the skill hold what the plugin offers, which is its `description` and the
 * two loops the description has to name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveyPlugin } from "./plugin.js";
import { sourceRoot } from "./update.js";

test("this checkout ships the plugin, with the skill inside it", () => {
  const root = sourceRoot(dirname(fileURLToPath(import.meta.url)));
  assert.ok(root, "the test runs from a checkout");
  assert.equal(coveyPlugin(root), join(root, "plugin"));
});

test("no checkout, or a checkout without the plugin, hands the session nothing", (t) => {
  const bare = mkdtempSync(join(tmpdir(), "covey-plugin-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(coveyPlugin(null), null);
  assert.equal(coveyPlugin(bare), null);
  // A manifest without the skill is not the plugin either.
  mkdirSync(join(bare, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(bare, "plugin", ".claude-plugin", "plugin.json"), "{}");
  assert.equal(coveyPlugin(bare), null);
});

// ---- what the plugin offers ------------------------------------------------

/**
 * A plugin *offers* a skill: the name and the one-line `description` are the
 * whole of what reaches a session's context, and the model then decides, turn
 * by turn, whether to read the rest. So the description is the reach of the
 * skill. It read "Take a GitHub issue to completion", which is issue-shaped,
 * and a thread that opened with "fix this bug" never loaded the skill at all.
 * It names both loops now (#191), or the work that has no number never finds
 * the loop that covers it.
 */
test("the skill's description names the work that has no issue, not an issue alone", () => {
  const root = sourceRoot(dirname(fileURLToPath(import.meta.url)))!;
  const skill = readFileSync(join(root, "plugin", "skills", "covey", "SKILL.md"), "utf8");
  const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
  assert.match(description, /issue/, "the description never names an issue");
  assert.match(description, /the user's own words/, "the description never names work that has no issue");
  assert.match(description, /File no issue unless the user asks/, "the description never says the default is to file nothing");
});

/**
 * Two loops that differ in one step, and the rule that picks between them. The
 * no-issue loop is the default for conversational work, and it files nothing:
 * an issue opened and closed inside the minute by the same agent is a row no
 * reader ever saw.
 */
test("the skill holds both loops and the rule that picks one", () => {
  const root = sourceRoot(dirname(fileURLToPath(import.meta.url)))!;
  const skill = readFileSync(join(root, "plugin", "skills", "covey", "SKILL.md"), "utf8");
  for (const heading of ["## Which loop", "## The issue loop", "## The no-issue loop"]) {
    assert.ok(skill.includes(heading), `the skill lost the section ${heading}`);
  }
  assert.match(skill, /Never file an issue to hold work you are about to do/);
  assert.match(skill, /Do not file an issue for work the user did not ask you to file/);
});
