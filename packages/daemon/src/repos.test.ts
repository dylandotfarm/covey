/**
 * The repository list and the one write beside it (#89, part 3). Nothing
 * here runs `gh`: the parse and the merge take what `gh` prints, and the
 * guard is asked about the commands the list uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoList, mergeRepoLists, createRepo } from "./repos.js";
import { assertReadOnly } from "./integrate/gh.js";

const printed = JSON.stringify([
  { nameWithOwner: "acme/api", isPrivate: true, pushedAt: "2026-09-20T10:00:00Z", url: "https://github.com/acme/api", sshUrl: "git@github.com:acme/api.git", description: "the api" },
  { nameWithOwner: "acme/web", isPrivate: false, pushedAt: null, url: "https://github.com/acme/web", sshUrl: "git@github.com:acme/web.git", description: null },
]);

test("parseRepoList keeps the fields a pick shows, with the clone URL in the protocol gh uses", () => {
  const ssh = parseRepoList(printed, "ssh");
  assert.deepEqual(ssh.map((r) => [r.nameWithOwner, r.isPrivate, r.pushedAt, r.cloneUrl, r.description]), [
    ["acme/api", true, "2026-09-20T10:00:00Z", "git@github.com:acme/api.git", "the api"],
    ["acme/web", false, null, "git@github.com:acme/web.git", ""],
  ]);
  assert.equal(parseRepoList(printed, "https")[0]!.cloneUrl, "https://github.com/acme/api.git", "https gets the .git it needs to clone");
  assert.deepEqual(parseRepoList("not json", "https"), [], "a list that is not a list is empty, not a throw");
  assert.deepEqual(parseRepoList("{}", "https"), []);
});

test("mergeRepoLists keeps one row per repository, newest push first", () => {
  const a = parseRepoList(printed, "https");
  const org = parseRepoList(JSON.stringify([
    { nameWithOwner: "acme/api", isPrivate: true, pushedAt: "2026-09-20T10:00:00Z", url: "https://github.com/acme/api", sshUrl: "", description: "" },
    { nameWithOwner: "org/newest", isPrivate: true, pushedAt: "2026-09-21T00:00:00Z", url: "https://github.com/org/newest", sshUrl: "", description: "" },
  ]), "https");
  assert.deepEqual(mergeRepoLists([a, org]).map((r) => r.nameWithOwner), ["org/newest", "acme/api", "acme/web"]);
});

test("the read guard lets the list through and refuses the create", () => {
  assertReadOnly(["repo", "list", "--json", "nameWithOwner", "--limit", "300"]);
  assertReadOnly(["repo", "list", "acme", "--json", "nameWithOwner"]);
  assertReadOnly(["config", "get", "git_protocol"]);
  assert.throws(() => assertReadOnly(["repo", "create", "acme/api", "--private"]), /not a read-only command/);
});

test("createRepo refuses a name that is not one before it spawns anything", async () => {
  // Never `gh`: the first version of this case reached GitHub with `../x`,
  // which it read as `x`, and made a repository on the user's account.
  const never = async (): Promise<{ stdout: string }> => { throw new Error("a name check must not spawn gh"); };
  for (const name of ["", "  ", "a b", "acme/api/extra", "../x", "..", ".hidden", "$(rm -rf)", "-flag"]) {
    await assert.rejects(createRepo("/tmp", { name, visibility: "private" }, never), /is not a repository name/, `refused ${JSON.stringify(name)}`);
  }
});

test("createRepo reads the URL gh prints and answers with the clone URL", async () => {
  const seen: string[][] = [];
  const fake = async (args: string[]) => { seen.push(args); return { stdout: "https://github.com/acme/api\n" }; };
  const made = await createRepo("/tmp", { name: "acme/api", visibility: "public", description: "the api" }, fake);
  assert.deepEqual(seen, [["repo", "create", "acme/api", "--public", "--description", "the api"]]);
  assert.equal(made.nameWithOwner, "acme/api");
  assert.match(made.cloneUrl, /^(git@github\.com:acme\/api\.git|https:\/\/github\.com\/acme\/api\.git)$/, "in the protocol gh is set to here");
});
