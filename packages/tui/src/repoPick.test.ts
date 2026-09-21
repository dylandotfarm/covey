import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepoInfo } from "@covey/protocol";
import { repoOptions } from "./repos.js";
import * as repos from "./repos.js";

test("repoOptions names the repository, keeps its description in the label so typing finds it, and says private or public", () => {
  const repos: RepoInfo[] = [
    { nameWithOwner: "acme/api", isPrivate: true, pushedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), cloneUrl: "git@github.com:acme/api.git", description: "the api" },
    { nameWithOwner: "acme/web", isPrivate: false, pushedAt: null, cloneUrl: "https://github.com/acme/web.git", description: "" },
  ];
  const rows = repoOptions(repos);
  assert.deepEqual(rows.map((r) => r.id), ["git@github.com:acme/api.git", "https://github.com/acme/web.git"], "the id is what the clone takes");
  assert.equal(rows[0]!.label, "acme/api  the api");
  assert.equal(rows[1]!.label, "acme/web");
  assert.match(rows[0]!.hint!, /^private · /);
  assert.equal(rows[1]!.hint, "public", "no push, no time");
});

test("branchOptions leads with the default branch as the row that leaves the base unset, keeps thread branches last, and marks the current base", () => {
  const { branchOptions, DEFAULT_BASE } = repos;
  const r = { branches: ["main", "covey/1234abcd", "feature", "release"], defaultBranch: "main", error: null };
  const rows = branchOptions(r);
  assert.deepEqual(rows.map((o) => o.id), [DEFAULT_BASE, "feature", "release", "covey/1234abcd"]);
  assert.equal(rows[0]!.label, "main");
  assert.equal(rows[0]!.hint, "default · current", "no base picked means the default is the base now");
  assert.equal(rows[3]!.hint, "thread branch");

  const onFeature = branchOptions(r, "feature");
  assert.equal(onFeature[0]!.hint, "default");
  assert.equal(onFeature.find((o) => o.id === "feature")!.hint, "current");

  // A remote whose HEAD names nothing still offers "the default branch".
  const headless = branchOptions({ branches: ["a", "b"], defaultBranch: null, error: null });
  assert.equal(headless[0]!.label, "the default branch");
  assert.deepEqual(headless.slice(1).map((o) => o.id), ["a", "b"]);
});
