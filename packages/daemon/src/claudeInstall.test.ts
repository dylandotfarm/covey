/**
 * Which Claude Code a machine resolves to, and what the registry offers.
 *
 * The pure half only: nothing here runs pnpm and nothing reaches npm. What is
 * worth holding is the set of refusals, because every one of them is a machine
 * that would otherwise be unable to start a session — `chooseClaude` is the
 * last thing between a reader's typo and a daemon with no Claude Code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_SYSTEM } from "@covey/protocol";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseClaude, claudeFromSdk, compareSdk, loadInstalled, releaseFor, releasesFrom } from "./claudeInstall.js";

const nothing = { entryFor: () => null, systemClaude: () => null };
const everything = {
  entryFor: (sdk: string) => `/data/claude/${sdk}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`,
  systemClaude: () => ({ path: "/usr/local/bin/claude", version: "2.1.323" }),
};

test("no setting is the version the lockfile pins, and needs nothing from the machine", () => {
  for (const setting of [null, undefined]) {
    const c = chooseClaude(setting, nothing);
    assert.equal(c.source, "lockfile");
    assert.equal(c.entry, null, "the lockfile's is the bare specifier, not a path");
    assert.equal(c.executable, null);
    assert.equal(c.reason, undefined);
  }
});

test("a version that is installed is loaded from its own directory", () => {
  const c = chooseClaude("0.3.325", everything);
  assert.equal(c.source, "managed");
  assert.match(c.entry!, /0\.3\.325.*sdk\.mjs$/);
  assert.equal(c.executable, null, "a managed install spawns its own binary");
});

test("a version that is not installed falls back and names the version, not just the failure", () => {
  const c = chooseClaude("0.3.325", nothing);
  assert.equal(c.source, "lockfile", "a machine must never be left with no Claude Code");
  assert.equal(c.requested, "0.3.325");
  assert.match(c.reason!, /2\.1\.325/, "the reader has to be told which version went missing");
});

test("`system` is the bundled JavaScript pointed at the machine's own binary", () => {
  const c = chooseClaude(CLAUDE_SYSTEM, everything);
  assert.equal(c.source, "system");
  assert.equal(c.entry, null, "the SDK JavaScript is still covey's own");
  assert.equal(c.executable, "/usr/local/bin/claude");
});

test("`system` on a machine with no claude falls back rather than failing to start", () => {
  const c = chooseClaude(CLAUDE_SYSTEM, nothing);
  assert.equal(c.source, "lockfile");
  assert.equal(c.requested, CLAUDE_SYSTEM);
  assert.match(c.reason!, /PATH/);
});

test("the Claude Code an SDK version carries is read from the 0.3 line and guessed nowhere else", () => {
  assert.equal(claudeFromSdk("0.3.280"), "2.1.280");
  assert.equal(claudeFromSdk("0.3.325"), "2.1.325");
  // The convention is a fact about one minor line, not a promise. A guess past
  // it would print a Claude Code version that does not exist.
  assert.equal(claudeFromSdk("0.4.0"), null);
  assert.equal(claudeFromSdk("1.0.0"), null);
  assert.equal(claudeFromSdk("not-a-version"), null);
});

test("versions sort by their numbers, so 0.3.99 is older than 0.3.325", () => {
  const sorted = ["0.3.99", "0.3.325", "0.3.100"].sort(compareSdk);
  assert.deepEqual(sorted, ["0.3.325", "0.3.100", "0.3.99"]);
});

test("the registry list is the newest few, newest first, and marks what is here", () => {
  const doc = {
    "dist-tags": { latest: "0.3.323" },
    versions: Object.fromEntries(["0.3.319", "0.3.321", "0.3.322", "0.3.323", "0.3.324", "0.3.325"].map((v) => [v, {}])),
    time: { "0.3.325": "2026-11-13T20:00:00Z" },
  };
  const rows = releasesFrom(doc, { installed: ["0.3.323"], count: 5 });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.sdk), ["0.3.325", "0.3.324", "0.3.323", "0.3.322", "0.3.321"]);
  assert.equal(rows.find((r) => r.sdk === "0.3.323")!.installed, true);
  assert.equal(rows[0]!.publishedAt, "2026-11-13T20:00:00Z");
  assert.equal(rows[0]!.claude, "2.1.325");
});

test("the tagged version is always offered, even when newer untagged ones exist", () => {
  // `latest` is what the registry recommends and is not always the highest
  // number published. A reader must never be shown only untagged builds.
  const doc = {
    "dist-tags": { latest: "0.3.300" },
    versions: Object.fromEntries(["0.3.300", "0.3.321", "0.3.322", "0.3.323", "0.3.324", "0.3.325"].map((v) => [v, {}])),
  };
  const rows = releasesFrom(doc, { count: 3 });
  assert.ok(rows.some((r) => r.sdk === "0.3.300"), "the tagged version was dropped");
});

test("a release covey only inferred says so, so a client can print the sdk instead", () => {
  assert.equal(releaseFor("0.3.325").exact, false);
  assert.equal(releaseFor("0.3.325", { claude: "2.1.325" }).exact, true);
  // Outside the 0.3 line there is nothing to infer, so the label falls back to
  // the one number covey is sure of.
  assert.equal(releaseFor("0.4.0").claude, "0.4.0");
});

/**
 * A directory that looks like an install from the outside.
 *
 * This is what `entryFor` sees and accepts, and it is why the already-installed
 * path may not skip the load: an interrupted `pnpm install` or a full disk
 * leaves exactly this.
 */
function halfWritten(sdk: string): string {
  const home = mkdtempSync(join(tmpdir(), "covey-claude-"));
  process.env.COVEY_HOME = home;
  const dir = join(home, "claude", sdk, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sdk.mjs"), "export const notQuery = 1;\n");
  return home;
}

test("a half-written install is refused rather than written down as the machine's Claude Code", async (t) => {
  const was = process.env.COVEY_HOME;
  t.after(() => { if (was === undefined) delete process.env.COVEY_HOME; else process.env.COVEY_HOME = was; });
  halfWritten("0.3.999");
  // `entryFor` is satisfied — `sdk.mjs` is there — which is the whole point:
  // the load is the only thing that tells this from a working install.
  await assert.rejects(() => loadInstalled("0.3.999"), /manifest\.json/);
});

test("an install whose sdk.mjs exports no query is refused by name", async (t) => {
  const was = process.env.COVEY_HOME;
  t.after(() => { if (was === undefined) delete process.env.COVEY_HOME; else process.env.COVEY_HOME = was; });
  const home = halfWritten("0.3.998");
  writeFileSync(join(home, "claude", "0.3.998", "node_modules", "@anthropic-ai", "claude-agent-sdk", "manifest.json"), JSON.stringify({ version: "2.1.998" }));
  await assert.rejects(() => loadInstalled("0.3.998"), /exports no `query`/);
});

test("a version with no directory at all is refused before anything is loaded", async (t) => {
  const was = process.env.COVEY_HOME;
  t.after(() => { if (was === undefined) delete process.env.COVEY_HOME; else process.env.COVEY_HOME = was; });
  process.env.COVEY_HOME = mkdtempSync(join(tmpdir(), "covey-claude-"));
  await assert.rejects(() => loadInstalled("0.3.997"), /sdk\.mjs/);
});
