import { test } from "node:test";
import assert from "node:assert/strict";
import type { BuildInfo } from "@covey/protocol";
import { buildLine, buildSkew } from "./build.js";

function build(patch: Partial<BuildInfo> = {}): BuildInfo {
  return { commit: "aaaaaaa", committedAt: "2026-09-10T12:00:00Z", branch: "main", dirty: false, builtAt: null, ...patch };
}

test("the same commit is the same build, whatever the clocks say", () => {
  const client = build({ builtAt: "2026-09-15T09:00:00Z" });
  // The Pi compiled a week later and its clock is an hour out. Same commit.
  const pi = build({ builtAt: "2026-09-22T00:00:00Z" });
  assert.equal(buildSkew(client, pi), "same");
});

test("an older commit date is behind, a newer one is ahead", () => {
  const client = build({ commit: "bbbbbbb", committedAt: "2026-09-14T00:00:00Z" });
  const older = build({ commit: "aaaaaaa", committedAt: "2026-09-01T00:00:00Z" });
  const newer = build({ commit: "ccccccc", committedAt: "2026-09-20T00:00:00Z" });
  assert.equal(buildSkew(client, older), "behind");
  assert.equal(buildSkew(client, newer), "ahead");
});

test("a local mtime never decides the answer", () => {
  // The client compiled this morning; the daemon compiled last week and holds
  // the newer commit. Ordering by mtime would call the daemon behind.
  const client = build({ commit: "bbbbbbb", committedAt: "2026-09-01T00:00:00Z", builtAt: "2026-09-15T08:00:00Z" });
  const daemon = build({ commit: "aaaaaaa", committedAt: "2026-09-14T00:00:00Z", builtAt: "2026-09-08T00:00:00Z" });
  assert.equal(buildSkew(client, daemon), "ahead");
});

test("a daemon that does not report its build is unknown, not behind", () => {
  assert.equal(buildSkew(build(), undefined), "unknown");
  assert.equal(buildSkew(build(), null), "unknown");
  assert.equal(buildSkew(null, build()), "unknown");
});

test("two builds that do not order give unknown", () => {
  const client = build({ commit: "bbbbbbb" });
  // No commit date on one side, and two branches off the same commit date.
  assert.equal(buildSkew(client, build({ commit: "aaaaaaa", committedAt: null })), "unknown");
  assert.equal(buildSkew(client, build({ commit: "aaaaaaa" })), "unknown");
  assert.equal(buildSkew(client, build({ commit: "aaaaaaa", committedAt: "not a date" })), "unknown");
});

test("buildLine names the commit, the branch, the day, and a dirty checkout", () => {
  assert.equal(buildLine(build()), "aaaaaaa on main, 2026-09-10");
  assert.equal(buildLine(build({ dirty: true })), "aaaaaaa-dirty on main, 2026-09-10");
  assert.equal(buildLine(build({ commit: null, branch: null, committedAt: null })), "no checkout");
  assert.equal(buildLine(null), "build unknown");
});
