/**
 * The daemon links the `/covey` skill into the user's Claude Code skills on
 * every start, so the internal update puts a new skill in place. Every case
 * runs in a temporary home and a temporary checkout, and touches nothing of
 * the user's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSkillLink, linkSkill, skillSource } from "./skill.js";

function checkout(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `covey-skill-${name}-`));
  mkdirSync(skillSource(root), { recursive: true });
  writeFileSync(join(skillSource(root), "SKILL.md"), "---\nname: covey\n---\n");
  return root;
}

test("a fresh home gets the link, and a second start keeps it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "covey-skill-home-"));
  const root = checkout("a");
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const first = linkSkill(root, home);
  assert.equal(first.did, "linked");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "covey")), skillSource(root));
  assert.equal(linkSkill(root, home).did, "kept");
  assert.match(describeSkillLink(first), /skill: linked/);
});

test("a link to a checkout that is gone is replaced; a link to a live one elsewhere is left alone", (t) => {
  const home = mkdtempSync(join(tmpdir(), "covey-skill-home-"));
  const old = checkout("old");
  const now = checkout("new");
  t.after(() => { for (const d of [home, old, now]) rmSync(d, { recursive: true, force: true }); });
  assert.equal(linkSkill(old, home).did, "linked");
  // Two checkouts on one machine: the daemon of the second does not steal the link.
  const other = linkSkill(now, home);
  assert.equal(other.did, "left");
  assert.match(describeSkillLink(other), /left .* alone, it points at .*old/);
  // The first checkout is deleted: the link leads nowhere, and the second takes it.
  rmSync(old, { recursive: true, force: true });
  assert.equal(linkSkill(now, home).did, "replaced");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "covey")), skillSource(now));
});

test("a directory of the user's at that path is never touched", (t) => {
  const home = mkdtempSync(join(tmpdir(), "covey-skill-home-"));
  const root = checkout("a");
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const mine = join(home, ".claude", "skills", "covey");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "the user's own");
  const r = linkSkill(root, home);
  assert.equal(r.did, "left");
  assert.match(describeSkillLink(r), /directory of the user's/);
});

test("no checkout, or a checkout without the skill, links nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "covey-skill-home-"));
  const bare = mkdtempSync(join(tmpdir(), "covey-skill-bare-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); });
  assert.equal(linkSkill(null, home).did, "none");
  assert.equal(linkSkill(bare, home).did, "none");
});
