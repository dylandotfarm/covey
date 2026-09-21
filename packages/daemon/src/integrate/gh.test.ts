import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnly, realGhHost, parsePullRequestUrl, parsePullRequest, parseIssueItem, parsePullRequestItem, parseUploadAnswer, uploadRequest, UPLOAD_URL } from "./gh.js";

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
    ["pr", "review", "60", "--approve"],
    ["pr", "reopen", "60"],
    ["issue", "reopen", "45"],
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

test("a host built without the create capability has no way to open a pull request", () => {
  const readOnly = realGhHost({ cwd: process.cwd() });
  assert.equal(readOnly.createPullRequest, undefined, "nothing can call what is not there");
  const opener = realGhHost({ cwd: process.cwd(), allowCreate: true });
  assert.equal(typeof opener.createPullRequest, "function");
});

test("the number of a new pull request is read from the URL gh prints, and nothing else", () => {
  assert.deepEqual(parsePullRequestUrl("Creating pull request for covey/abc into main in o/r\n\nhttps://github.com/o/r/pull/95\n"), { number: 95, url: "https://github.com/o/r/pull/95" });
  assert.equal(parsePullRequestUrl("Warning: 1 uncommitted change\n"), null);
});

test("gh pr view output becomes the facts the watch reads", () => {
  const facts = parsePullRequest({
    number: 7, url: "https://github.com/o/r/pull/7", author: { login: "agent" },
    headRefName: "covey/abc", baseRefName: "main", headRefOid: "abc", state: "OPEN", isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", additions: 1, deletions: 0, files: [{ path: "a.ts" }],
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
    reviews: [{ id: "PRR_1", author: { login: "dylan" }, state: "CHANGES_REQUESTED", body: "no", submittedAt: "2026-09-21T10:00:00Z" }],
    comments: [{ id: "IC_1", author: { login: "dylan" }, body: "hi", createdAt: "2026-09-21T10:00:00Z", url: "https://github.com/o/r/pull/7#issuecomment-1" }],
  });
  assert.equal(facts.author, "agent");
  assert.deepEqual(facts.reviews, [{ id: "PRR_1", author: "dylan", state: "CHANGES_REQUESTED", body: "no", submittedAt: "2026-09-21T10:00:00Z", url: null }]);
  assert.deepEqual(facts.comments, [{ id: "IC_1", author: "dylan", body: "hi", createdAt: "2026-09-21T10:00:00Z", url: "https://github.com/o/r/pull/7#issuecomment-1", path: null, line: null }]);
  assert.deepEqual(facts.files, ["a.ts"]);
});

test("a host built without the attach or comment capability has no way to upload or comment", () => {
  const readOnly = realGhHost({ cwd: process.cwd() });
  assert.equal(readOnly.uploadAttachment, undefined, "nothing can call what is not there");
  assert.equal(readOnly.commentPullRequest, undefined);
  const attacher = realGhHost({ cwd: process.cwd(), allowAttach: true, allowComment: true });
  assert.equal(typeof attacher.uploadAttachment, "function");
  assert.equal(typeof attacher.commentPullRequest, "function");
  assert.equal(attacher.createPullRequest, undefined, "attach does not bring create along");
});

test("the upload is the request the web form makes: the route, the name, the type and the repository id in the query, the token in the header", () => {
  const bytes = Buffer.from("MP4!");
  const { url, init } = uploadRequest({ name: "demo.mp4", contentType: "video/mp4", bytes }, 1371967523, "gho_x");
  assert.equal(url, `${UPLOAD_URL}?name=demo.mp4&content_type=video%2Fmp4&repository_id=1371967523`);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { Authorization: "Bearer gho_x", Accept: "application/json", "Content-Type": "video/mp4" });
  assert.deepEqual(Buffer.from(init.body as Uint8Array), bytes);
});

test("the upload's answer is the URL it gives on 201, and anything else is null", () => {
  assert.equal(parseUploadAnswer('{"url":"https://github.com/user-attachments/assets/8b5a1e2c"}'), "https://github.com/user-attachments/assets/8b5a1e2c");
  assert.equal(parseUploadAnswer('{"url":"https://evil.example/x"}'), null, "only a user attachment renders inline");
  assert.equal(parseUploadAnswer("<html>"), null);
  assert.equal(parseUploadAnswer('{"message":"Forbidden"}'), null);
});

test("a host built without the review or the close capability has no way to review or close (#108)", () => {
  const readOnly = realGhHost({ cwd: process.cwd() });
  assert.equal(readOnly.reviewPullRequest, undefined);
  assert.equal(readOnly.closeItem, undefined);
  assert.equal(readOnly.reopenItem, undefined);
  assert.equal(readOnly.commentIssue, undefined);
  assert.equal(typeof readOnly.itemKind, "function", "the read is on every host");
  const reviewer = realGhHost({ cwd: process.cwd(), allowReview: true });
  assert.equal(typeof reviewer.reviewPullRequest, "function");
  assert.equal(reviewer.closeItem, undefined, "one flag, one write");
  const closer = realGhHost({ cwd: process.cwd(), allowClose: true });
  assert.equal(typeof closer.closeItem, "function");
  assert.equal(typeof closer.reopenItem, "function");
  assert.equal(closer.reviewPullRequest, undefined);
  const commenter = realGhHost({ cwd: process.cwd(), allowComment: true });
  assert.equal(typeof commenter.commentIssue, "function");
  assert.equal(typeof commenter.commentPullRequest, "function");
});

test("parsePullRequestItem reads what gh pr view prints, checks through the same fold as the gate (#108)", () => {
  const item = parsePullRequestItem({
    number: 107, title: "Let a project work from a branch", body: "## What changed\n\nA lot.", state: "MERGED", isDraft: false,
    author: { login: "dylandotfarm", is_bot: false }, url: "https://github.com/o/r/pull/107", createdAt: "2026-09-21T18:51:03Z",
    closedAt: "2026-09-21T18:57:52Z", mergedAt: "2026-09-21T18:57:52Z", headRefName: "covey/25cfe4a2", baseRefName: "main",
    mergeable: "UNKNOWN", reviewDecision: "", additions: 548, deletions: 23, files: [{ path: "README.md", additions: 2, deletions: 1 }, { path: "docs/DESIGN.md" }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "close", workflowName: "no external prs", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: "https://ci/1", startedAt: "2026-09-21T18:51:08Z" },
      { __typename: "CheckRun", name: "check", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/2", startedAt: "2026-09-21T18:51:09Z" },
      { __typename: "StatusContext", context: "lint", state: "PENDING", targetUrl: "https://ci/3" },
    ],
    reviews: [{ id: "R1", author: { login: "reviewer" }, state: "APPROVED", body: "ship it", submittedAt: "2026-09-21T18:55:00Z", url: "https://github.com/o/r/pull/107#pullrequestreview-1" }],
    comments: [{ id: "C1", author: { login: "someone" }, body: "hi", createdAt: "2026-09-21T18:52:00Z", url: "https://github.com/o/r/pull/107#issuecomment-1" }],
    labels: [{ name: "enhancement" }],
  }, { viewer: "me", readAt: "2026-09-21T19:00:00Z" });
  assert.equal(item.kind, "pull");
  assert.equal(item.state, "MERGED");
  assert.equal(item.author, "dylandotfarm");
  assert.deepEqual(item.files, ["README.md", "docs/DESIGN.md"]);
  assert.deepEqual(item.checks.map((c) => [c.name, c.state]), [["close", "neutral"], ["check", "success"], ["lint", "pending"]]);
  assert.deepEqual(item.reviews, [{ author: "reviewer", state: "APPROVED", body: "ship it", submittedAt: "2026-09-21T18:55:00Z", url: "https://github.com/o/r/pull/107#pullrequestreview-1" }]);
  assert.deepEqual(item.comments, [{ author: "someone", body: "hi", createdAt: "2026-09-21T18:52:00Z", url: "https://github.com/o/r/pull/107#issuecomment-1" }]);
  assert.deepEqual(item.labels, ["enhancement"]);
  assert.equal(item.viewer, "me");
  assert.equal(item.readAt, "2026-09-21T19:00:00Z");
  assert.equal(item.mergedAt, "2026-09-21T18:57:52Z");
});

test("parseIssueItem reads what gh issue view prints, and an empty answer is an open issue with nothing on it (#108)", () => {
  const item = parseIssueItem({
    number: 87, title: "The title bar collides", body: "## Summary", state: "OPEN", author: { login: "dylandotfarm" },
    url: "https://github.com/o/r/issues/87", createdAt: "2026-09-19T04:49:38Z", closedAt: null, labels: [{ name: "bug" }],
    comments: [{ author: { login: "a" }, body: "b", createdAt: "2026-09-19T05:00:00Z", url: null }],
  }, { viewer: null, readAt: "2026-09-21T19:00:00Z" });
  assert.equal(item.kind, "issue");
  assert.equal(item.state, "OPEN");
  assert.deepEqual(item.labels, ["bug"]);
  assert.deepEqual(item.comments, [{ author: "a", body: "b", createdAt: "2026-09-19T05:00:00Z", url: null }]);
  assert.equal(item.viewer, null);
  const bare = parseIssueItem({ number: 1 }, { viewer: null, readAt: "t" });
  assert.equal(bare.state, "OPEN");
  assert.equal(bare.body, "");
  assert.deepEqual(bare.comments, []);
  assert.equal(parseIssueItem({ number: 1, state: "closed" }, { viewer: null, readAt: "t" }).state, "CLOSED");
});
