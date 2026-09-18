import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMerged, auditReport, findingFor } from "./audit.js";
import { parseRevList } from "./gh.js";
import { fakeHost, member } from "./testHost.js";

/** The shape `git rev-list --format=%H%x09%s --no-commit-header` prints. */
const REV_LIST = [
  "9b8a8ec2203a897882c37cddc3a18168ec90e9c3\tAdd a regression test for the wheel scroll offset",
  "bc23d90e38515a6acd4dee1247859913e503b311\tSplit the batched paste into its own useInput call",
].join("\n") + "\n";

test("parseRevList reads sha and subject, and survives a bare sha", () => {
  const commits = parseRevList(REV_LIST);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.sha, "9b8a8ec2203a897882c37cddc3a18168ec90e9c3");
  assert.equal(commits[0]!.subject, "Add a regression test for the wheel scroll offset");
  assert.deepEqual(parseRevList("abc123\n\n"), [{ sha: "abc123", subject: "" }]);
  assert.deepEqual(parseRevList(""), []);
});

test("a merged branch that still holds commits is the finding that recovered lost work", () => {
  const f = findingFor(member({ branch: "issue-20-wheel-scroll", label: "#20 wheel scroll", state: "merged" }), "main", parseRevList(REV_LIST));
  assert.ok(f);
  assert.equal(f.branch, "issue-20-wheel-scroll");
  assert.equal(f.commits.length, 2);
  assert.match(f.message, /holds 2 commits that `main` does not/);
  assert.match(f.message, /Add a regression test for the wheel scroll offset/);
  assert.match(f.message, /pushed after the merge/);
});

test("one commit is one commit, not `1 commits`", () => {
  const f = findingFor(member({ branch: "b", state: "merged" }), "main", parseRevList(REV_LIST.split("\n")[0] + "\n"));
  assert.match(f!.message, /holds 1 commit that/);
});

test("a branch with nothing new is not a finding", () => {
  assert.equal(findingFor(member({ branch: "b", state: "merged" }), "main", []), null);
});

test("the audit asks only about merged members", async () => {
  const asked: string[] = [];
  const host = fakeHost({ revLists: { anything: [] } });
  const wrapped = { ...host, revList: async (base: string, branch: string) => { asked.push(branch); return []; } };
  await auditMerged(wrapped, "main", [
    member({ branch: "landed", state: "merged" }),
    member({ branch: "still-open", state: "review" }),
    member({ branch: "cancelled", state: "withdrawn" }),
  ]);
  assert.deepEqual(asked, ["landed"], "an open branch is meant to be ahead; a withdrawn one never meant to land");
});

test("the audit returns a finding per merged branch that kept work back", async () => {
  const host = fakeHost({
    revLists: { "issue-20-wheel-scroll": parseRevList(REV_LIST), clean: [] },
  });
  const findings = await auditMerged(host, "main", [
    member({ branch: "issue-20-wheel-scroll", label: "#20 wheel scroll", state: "merged" }),
    member({ branch: "clean", label: "#19 usage", state: "merged" }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.branch, "issue-20-wheel-scroll");
});

test("the report says plainly when the audit found nothing, and lists the commits when it did", () => {
  assert.equal(auditReport([], 13), "Audit: 13 merged branches hold no commit that the base branch lacks.");
  assert.match(auditReport([], 1), /1 merged branch holds no commit/);
  const f = findingFor(member({ branch: "b", label: "#20", state: "merged" }), "main", parseRevList(REV_LIST))!;
  const text = auditReport([f], 1);
  assert.match(text, /1 merged branch holds work that never landed/);
  assert.match(text, /9b8a8ec Add a regression test for the wheel scroll offset/);
  assert.match(text, /bc23d90 Split the batched paste/);
});
