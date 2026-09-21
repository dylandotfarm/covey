import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepoInfo } from "@covey/protocol";
import { repoOptions } from "./repos.js";

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
