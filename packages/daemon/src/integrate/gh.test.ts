import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnly, realGhHost } from "./gh.js";

test("the read path allows the commands it reads with", () => {
  for (const args of [
    ["pr", "view", "branch", "--json", "number"],
    ["pr", "list", "--state", "open"],
    ["pr", "diff", "60"],
    ["pr", "checks", "60"],
    ["issue", "view", "45"],
    ["issue", "list"],
    ["run", "view", "123"],
    ["repo", "view"],
    ["api", "repos/o/r/commits/main", "--jq", "{oid:.sha}"],
    ["api", "--method", "GET", "repos/o/r/commits/main"],
    ["api", "--method=get", "repos/o/r/commits/main"],
  ]) {
    assert.doesNotThrow(() => assertReadOnly(args), args.join(" "));
  }
});

test("the read path refuses every command that can change a repository", () => {
  for (const args of [
    ["pr", "merge", "60", "--merge"],
    ["pr", "close", "60"],
    ["pr", "create", "--title", "x"],
    ["pr", "comment", "60", "--body", "x"],
    ["pr", "edit", "60"],
    ["issue", "close", "45"],
    ["issue", "comment", "45", "--body", "x"],
    ["issue", "create"],
    ["release", "create", "v1"],
    ["repo", "delete", "o/r"],
    ["workflow", "run", "ci.yml"],
    ["run", "rerun", "123"],
    ["auth", "token"],
  ]) {
    assert.throws(() => assertReadOnly(args), /not a read-only command/, args.join(" "));
  }
});

test("gh api with a write method is refused, however the flag is spelled", () => {
  assert.throws(() => assertReadOnly(["api", "-X", "POST", "repos/o/r/merges"]), /writes/);
  assert.throws(() => assertReadOnly(["api", "--method", "PUT", "repos/o/r/pulls/1/merge"]), /writes/);
  assert.throws(() => assertReadOnly(["api", "--method=DELETE", "repos/o/r/git/refs/heads/x"]), /writes/);
  assert.throws(() => assertReadOnly(["api", "-X", "patch", "repos/o/r"]), /writes/);
});

test("gh api with a body is a write, because gh turns it into a POST", () => {
  for (const flag of ["-f", "-F", "--field", "--raw-field", "--input"]) {
    assert.throws(() => assertReadOnly(["api", "repos/o/r/merges", flag, "base=main"]), /sends a body/, flag);
  }
});

test("a host built without the merge capability has no way to merge", () => {
  const readOnly = realGhHost({ cwd: process.cwd() });
  assert.equal(readOnly.mergePullRequest, undefined, "nothing can call what is not there");
  const integrator = realGhHost({ cwd: process.cwd(), allowMerge: true });
  assert.equal(typeof integrator.mergePullRequest, "function");
});
