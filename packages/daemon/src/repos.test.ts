/**
 * The repository list and the one write beside it (#89, part 3).
 *
 * No test here runs `gh`. The parse takes what `gh` prints, the guard is
 * asked about the commands the list uses, and `createRepo` gets both of the
 * things it would ask `gh` for, so it has nothing to spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoList, cloneUrlFor, createRepo } from "./repos.js";
import { assertReadOnly } from "./integrate/gh.js";

const printed = [
  "acme/api\ttrue\t2026-09-20T10:00:00Z\thttps://github.com/acme/api\tgit@github.com:acme/api.git\tthe api",
  "acme/web\tfalse\t\thttps://github.com/acme/web\tgit@github.com:acme/web.git\t",
  "",
  "broken line with no url",
].join("\n");

test("parseRepoList keeps the fields a pick shows, with the clone URL in the protocol gh uses", () => {
  const ssh = parseRepoList(printed, "ssh");
  assert.deepEqual(ssh.map((r) => [r.nameWithOwner, r.isPrivate, r.pushedAt, r.cloneUrl, r.description]), [
    ["acme/api", true, "2026-09-20T10:00:00Z", "git@github.com:acme/api.git", "the api"],
    ["acme/web", false, null, "git@github.com:acme/web.git", ""],
  ], "a line that is not a repository is left out, not a throw");
  assert.equal(parseRepoList(printed, "https")[0]!.cloneUrl, "https://github.com/acme/api.git", "https gets the .git it needs to clone");
  assert.deepEqual(parseRepoList("", "https"), []);
  assert.equal(cloneUrlFor({ url: "https://github.com/acme/api.git", sshUrl: "" }, "https"), "https://github.com/acme/api.git", "and not a second .git");
});

test("the read guard lets the list and the config read through, and refuses the create", () => {
  assertReadOnly(["api", "user/repos?affiliation=owner&sort=pushed&per_page=100", "--paginate", "--jq", ".[]"]);
  assertReadOnly(["config", "get", "-h", "github.com", "git_protocol"]);
  assert.throws(() => assertReadOnly(["repo", "create", "acme/api", "--private"]), /not a read-only command/);
  assert.throws(() => assertReadOnly(["config", "set", "git_protocol", "ssh"]), /not a read-only command/);
});

/** An exec that fails the test that reaches it. */
const never = async (): Promise<{ stdout: string }> => { throw new Error("a name check must not spawn gh"); };

test("createRepo refuses a path or a flag as a name, and allows what GitHub allows", async () => {
  for (const name of ["", "  ", "a b", "acme/api/extra", "../x", "..", ".", "acme/..", "$(rm -rf)", "-flag", "acme/--private"]) {
    await assert.rejects(createRepo({ name, visibility: "private" }, { exec: never, protocol: "https" }), /is not a repository name/, `refused ${JSON.stringify(name)}`);
  }
  // `.github` is the name GitHub itself uses for an organisation's profile.
  const seen: string[][] = [];
  const fake = async (args: string[]) => { seen.push(args); return { stdout: "https://github.com/acme/.github\n" }; };
  const made = await createRepo({ name: "acme/.github", visibility: "public" }, { exec: fake, protocol: "https" });
  assert.equal(made.nameWithOwner, "acme/.github");
});

test("createRepo reads the URL gh prints and answers with the clone URL in the protocol", async () => {
  const seen: string[][] = [];
  const fake = async (args: string[]) => { seen.push(args); return { stdout: "https://github.com/acme/api\n" }; };
  const ssh = await createRepo({ name: "acme/api", visibility: "public", description: "the api" }, { exec: fake, protocol: "ssh" });
  assert.deepEqual(seen, [["repo", "create", "acme/api", "--public", "--description", "the api"]]);
  assert.deepEqual(ssh, { nameWithOwner: "acme/api", cloneUrl: "git@github.com:acme/api.git" });
  const https = await createRepo({ name: "api", visibility: "private" }, { exec: fake, protocol: "https" });
  assert.equal(https.cloneUrl, "https://github.com/acme/api.git", "the owner comes from what gh printed, not from the name");
  await assert.rejects(createRepo({ name: "api", visibility: "private" }, { exec: async () => ({ stdout: "done\n" }), protocol: "https" }), /did not print its URL/, "no URL is no answer, not a guess");
});
