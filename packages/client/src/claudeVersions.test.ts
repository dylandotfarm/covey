/**
 * The Claude Code picker's words.
 *
 * Every client reads this one list, so what it says is tested here rather than
 * three times over. The rules worth holding are the ones a reader cannot
 * recover from on their own: the way back is always offered, a fallback names
 * the version that went missing, and nothing is offered twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaudeInstall } from "@covey/protocol";
import { ageLabel, claudeChoices, claudeListNote, claudeNotice, claudeValue, claudeValueLabel, releaseLabel } from "./claudeVersions.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");

function install(over: Partial<ClaudeInstall> = {}): ClaudeInstall {
  return {
    version: "2.1.280",
    source: "lockfile",
    sdk: "0.3.280",
    lockfile: { sdk: "0.3.280", claude: "2.1.280", exact: true },
    system: { sdk: "", claude: "2.1.323", exact: true },
    available: [
      { sdk: "0.3.325", claude: "2.1.325", exact: false, publishedAt: "2026-11-13T00:00:00Z" },
      { sdk: "0.3.324", claude: "2.1.324", exact: false, publishedAt: "2026-11-12T00:00:00Z" },
      { sdk: "0.3.323", claude: "2.1.323", exact: false, publishedAt: "2026-11-11T00:00:00Z" },
    ],
    ...over,
  };
}

test("the way back is the first row, and it is marked when it is in force", () => {
  const rows = claudeChoices(install(), NOW);
  assert.equal(rows[0]!.id, "");
  assert.match(rows[0]!.label, /2\.1\.280/);
  assert.equal(rows[0]!.current, true);
  // Every row must be pickable except a system row with no claude: a reader
  // who chose badly has to have one press that always works.
  assert.equal(rows[0]!.pickable, true);
});

test("the newest is offered once, not twice", () => {
  const rows = claudeChoices(install(), NOW);
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `a version is offered twice: ${ids.join(", ")}`);
  assert.match(rows[1]!.label, /^Latest \(2\.1\.325\)/);
  assert.equal(rows[1]!.hint, "today");
});

test("the machine's own claude is offered, and says what moves it", () => {
  const rows = claudeChoices(install(), NOW);
  const sys = rows.find((r) => r.id === "system")!;
  assert.match(sys.label, /2\.1\.323/);
  assert.match(sys.hint, /claude update/);
  assert.equal(sys.pickable, true);
});

test("a machine with no claude on its PATH is told so, not left guessing", () => {
  const rows = claudeChoices(install({ system: null }), NOW);
  const sys = rows.find((r) => r.id === "system")!;
  assert.equal(sys.pickable, false);
  assert.match(sys.hint, /no `claude`/);
});

test("the version in force is in its own picker even when the registry forgot it", () => {
  // An older pick, or a registry read that failed. Without this row nothing in
  // the list is marked current and the reader cannot see what they are on.
  const rows = claudeChoices(install({ source: "managed", sdk: "0.3.300", version: "2.1.300", available: [] }), NOW);
  const mine = rows.find((r) => r.id === "0.3.300");
  assert.ok(mine, "the running version is missing from its own picker");
  assert.equal(mine!.current, true);
});

test("a fallback names the version that went missing as well as the one running", () => {
  const note = claudeNotice(install({ requested: "0.3.325", reason: "Claude Code 2.1.325 is not installed here" }));
  assert.ok(note);
  assert.match(note!, /0\.3\.325/);
  assert.match(note!, /2\.1\.280/);
});

test("no notice when the machine runs what it was asked to", () => {
  assert.equal(claudeNotice(install()), null);
});

test("the row names the source, because the number alone is what misled", () => {
  assert.match(claudeValueLabel(install()), /2\.1\.280 \(covey's own\)/);
  assert.match(claudeValueLabel(install({ source: "system", version: "2.1.323" })), /this machine's/);
  assert.match(claudeValueLabel(install({ source: "managed", version: "2.1.325" })), /installed by covey/);
  assert.equal(claudeValueLabel(undefined), "unknown");
});

test("an empty list says why, rather than reading as nothing published", () => {
  assert.match(claudeListNote(install({ available: [], availableError: "the npm registry did not answer in time" }))!, /did not answer/);
  assert.match(claudeListNote(install({ available: [] }))!, /not read the list/);
  assert.equal(claudeListNote(install()), null);
});

test("`` is the lockfile's version and nothing else is", () => {
  assert.equal(claudeValue(""), null);
  assert.equal(claudeValue("system"), "system");
  assert.equal(claudeValue("0.3.325"), "0.3.325");
});

test("a version covey only guessed at reads as its sdk, never as a wrong number", () => {
  // `claudeFromSdk` answers null outside the `0.3.x` line, and a guess printed
  // as a Claude Code version would be a version that does not exist.
  assert.equal(releaseLabel({ sdk: "0.4.0", claude: "0.4.0", exact: false }), "sdk 0.4.0");
  assert.equal(releaseLabel({ sdk: "0.3.325", claude: "2.1.325", exact: false }), "2.1.325");
});

test("ages read as a person would say them", () => {
  assert.equal(ageLabel("2026-11-13T00:00:00Z", NOW), "today");
  assert.equal(ageLabel("2026-11-12T00:00:00Z", NOW), "yesterday");
  assert.equal(ageLabel("2026-11-08T00:00:00Z", NOW), "5 days ago");
  assert.equal(ageLabel(undefined, NOW), "");
});
