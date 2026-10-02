/**
 * The automated review, driven through a whole engine.
 *
 * A thread opens a pull request, covey starts a review thread of its own, the
 * reviewer comments and decides, and the merge waits on it. The `gh` host is
 * `fakeHost`, so nothing reaches GitHub and nothing is reviewed anywhere but in
 * memory; the CLI is the auto-reply, so no Claude subprocess starts and the
 * brief covey sends the reviewer completes at once. The clock is a variable.
 *
 * The words and the arithmetic are `integrate/review.test.ts`, and what each
 * side of the review *hears* is `integrate/news.test.ts`. This file is about
 * the threads: that one is made, that its verdict reaches the author's row, and
 * that the gate holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost, pr } from "./integrate/testHost.js";
import { POLL_MAX_MS } from "./integrate/news.js";
import { REVIEW_TAGLINE } from "./integrate/review.js";
import { autoReply, fakeCli, settle } from "./claudeFake.js";
import { scratchRemote, git, head } from "./scratch.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/** A green check that started after the base head landed, so it is not stale. */
const GREEN = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T09:30:00Z" }];

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: `covey/${id}`, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-review-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: "github.com/o/r",
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let clock = Date.parse("2026-10-02T10:00:00Z");
  const cli = fakeCli();
  const host = fakeHost({
    canCreate: true, canMerge: true, canComment: true, prs: {},
    base: { oid: "deadbeef", committedAt: "2026-10-02T09:00:00Z" },
  });
  const engines: Engine[] = [];
  const make = (database: Db) => new Engine(database, { ...MACHINE }, { now: () => clock, spawn: autoReply(cli), ghHost: () => host });
  let engine = make(db);
  engines.push(engine);
  const s = {
    db, dir, host,
    get engine() { return engine; },
    advance: (ms: number) => { clock += ms; },
    newThread(id: string) { db.putThread(thread(id)); return id; },
    command(cmd: Record<string, unknown>) { return engine.dispatch({ commandId: randomUUID(), ...cmd } as never); },
    /** Open a pull request, with one reviewer unless the case says otherwise. */
    async open(threadId: string, over: Record<string, unknown> = {}) {
      const opened = await engine.openPullRequest({ threadId, title: "Fold a chain away", body: "The change.", ...over });
      // The fake registers the pull request with no check on it, as GitHub does
      // the moment it is opened. Every case here is about the review, so the
      // build is green from the first poll.
      s.host.options.prs![`covey/${threadId}`]!.checks = GREEN;
      return opened;
    },
    async poll() { clock += POLL_MAX_MS; const polled = await engine.pollWatches(); await settle(); return polled; },
    thread(id: string): Thread { return db.getThread(id)!; },
    /** The reviewers of a thread's pull request, newest last. */
    reviewers(id: string) { return db.getThread(id)!.watch!.review!.reviewers; },
    /** Every review thread covey made, in the order it made them. */
    reviewThreads() { return db.listThreads().filter((t) => t.reviewOf).sort((a, b) => a.reviewOf!.index - b.reviewOf!.index); },
    turns(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    },
    notes(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
    },
    restart() { engine.shutdown(); engine = make(new Db(dir)); engines.push(engine); return engine; },
    cleanup() { for (const e of engines) e.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
  return s;
}

// ---- starting the reviewer ---------------------------------------------------

test("opening a pull request starts a reviewer, and the reviewer is a thread under the author", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();

  assert.equal(opened.reviewers.length, 1, "one reviewer unless the caller says otherwise");
  const reviewer = s.thread(opened.reviewers[0]!);
  assert.equal(reviewer.reviewOf?.number, 101);
  assert.equal(reviewer.reviewOf?.authorThreadId, "t1");
  assert.equal(reviewer.reviewOf?.branch, "covey/t1");
  assert.deepEqual([reviewer.reviewOf?.index, reviewer.reviewOf?.of], [1, 1]);
  // The sidebar paints a child under its parent, which is where a reader looks.
  assert.equal(reviewer.origin?.by, "agent");
  assert.equal(reviewer.origin?.parentThreadId, "t1");
  assert.match(reviewer.title, /review #101/);
  assert.equal(reviewer.watch?.role, "reviewer");
  assert.equal(reviewer.watch?.number, 101);
  assert.equal(reviewer.watch?.merge, "manual", "a reviewer never merges");

  // The author's row records what the pull request now needs.
  assert.deepEqual(s.thread("t1").watch!.review, {
    required: 1,
    reviewers: [{ threadId: reviewer.id, index: 1, state: "reviewing", note: null, startedAt: s.reviewers("t1")[0]!.startedAt, decidedAt: null }],
  });
  assert.ok(s.notes("t1").some((n) => /Started 1 automated review of pull request #101/.test(n)), s.notes("t1").join("\n"));

  // The brief is a turn, not a note: only a turn starts the session that reads it.
  const brief = s.turns(reviewer.id);
  assert.equal(brief.length, 1);
  assert.match(brief[0]!, /covey review: you are the reviewer on pull request #101/);
  assert.match(brief[0]!, /#101 Fold a chain away/);
  assert.match(brief[0]!, /covey review approve/);
});

test("--no-review asks for none, and nothing waits on a review nobody started", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { reviews: 0 });
  await settle();
  assert.deepEqual(opened.reviewers, []);
  assert.equal(s.reviewThreads().length, 0);
  assert.equal(s.thread("t1").watch!.review, null);
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: true }, "green, and waiting on nobody");
});

test("two reviewers each get their own seat, and the pull request needs both", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { reviews: 2 });
  await settle();
  assert.equal(opened.reviewers.length, 2);
  assert.equal(s.thread("t1").watch!.review!.required, 2);
  const [one, two] = s.reviewThreads();
  assert.deepEqual([one!.reviewOf!.index, one!.reviewOf!.of], [1, 2]);
  assert.deepEqual([two!.reviewOf!.index, two!.reviewOf!.of], [2, 2]);
  assert.match(s.turns(one!.id)[0]!, /you are reviewer 1 of 2/);
  assert.match(s.turns(two!.id)[0]!, /you are reviewer 2 of 2/);
  assert.notEqual(one!.id, two!.id);
});

test("covey pr review adds a reviewer to a pull request that has one, and raises what it needs", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  await settle();
  const added = await s.engine.requestReview({ threadId: "t1" });
  await settle();
  assert.equal(added.required, 2);
  assert.equal(s.reviewThreads().length, 2);
  assert.deepEqual(s.reviewers("t1").map((r) => r.index), [1, 2]);
  // The first reviewer was told it was the only one. Its tagline is computed
  // from this row at comment time, so it must now say how many there are.
  assert.deepEqual(s.reviewThreads().map((t) => [t.reviewOf!.index, t.reviewOf!.of]), [[1, 2], [2, 2]]);
  await s.engine.commentPullRequest({ threadId: s.reviewThreads()[0]!.id, body: "A note." });
  assert.match(s.host.comments.at(-1)!.body, /\(reviewer 1 of 2\)/);
});

test("a reviewer does not ask for a reviewer, and a thread with no pull request cannot", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await assert.rejects(
    () => s.engine.requestReview({ threadId: opened.reviewers[0]! }),
    (e: unknown) => e instanceof EngineError && e.code === "is_review",
  );
  s.newThread("t2");
  await assert.rejects(
    () => s.engine.requestReview({ threadId: "t2" }),
    (e: unknown) => e instanceof EngineError && e.code === "no_pull_request",
  );
});

test("more reviewers than one pull request may hold is refused", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { reviews: 0 });
  await settle();
  await assert.rejects(
    () => s.engine.requestReview({ threadId: "t1", count: 6 }),
    (e: unknown) => e instanceof EngineError && e.code === "too_many",
  );
  assert.equal(s.reviewThreads().length, 0, "none started, so none has to be undone");
});

// ---- the verdict -------------------------------------------------------------

test("a reviewer's comment carries the tagline, and the reviewer never hears its own words", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  const reviewerId = opened.reviewers[0]!;

  await s.engine.commentPullRequest({ threadId: reviewerId, body: "`lines.ts` line 20 drops the last row." });
  const left = s.host.comments.at(-1)!;
  assert.equal(left.number, 101);
  assert.match(left.body, /^`lines\.ts` line 20 drops the last row\./);
  assert.match(left.body, new RegExp(REVIEW_TAGLINE, "i"), "covey adds the tagline; the reviewer never writes it");
  // The URL goes on the reviewer's own cursor, so its own comment is not news.
  assert.deepEqual(s.thread(reviewerId).watch!.cursor.posted, [`https://github.com/o/r/pull/101#issuecomment-1`]);

  // The author's comment carries no tagline: it is a person's thread's words.
  await s.engine.commentPullRequest({ threadId: "t1", body: "Fixed, thanks." });
  assert.doesNotMatch(s.host.comments.at(-1)!.body, new RegExp(REVIEW_TAGLINE, "i"));
});

test("asking for changes holds the merge, and the reviewer keeps reviewing", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { merge: "auto" });
  await settle();
  const reviewerId = opened.reviewers[0]!;

  const out = await s.engine.reviewDecide({ threadId: reviewerId, verdict: "changes", body: "`lines.ts` line 20 drops the last row." });
  await settle();
  assert.deepEqual([out.signedOff, out.required], [0, 1]);
  assert.match(s.host.comments.at(-1)!.body, /Changes requested — from an automated covey review/);
  assert.equal(s.reviewers("t1")[0]!.state, "changesRequested");
  assert.equal(s.reviewers("t1")[0]!.note, "`lines.ts` line 20 drops the last row.");
  assert.equal(s.thread(reviewerId).archivedAt, null, "it has to read the author's answer");

  // The gate holds, under auto, with every GitHub fact green.
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: false, why: "an automated covey review asks for changes" });
  assert.equal(s.host.merges.length, 0, "nothing merged");
});

test("a pull request merged while a reviewer reads it archives the reviewer too, with no turn", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  const reviewerId = opened.reviewers[0]!;
  const before = s.turns(reviewerId).length;

  // Somebody merged it over the review. There is nothing left to read.
  s.host.options.prs!["covey/t1"]!.state = "MERGED";
  await s.poll();
  assert.equal(s.thread(reviewerId).watch!.state, "merged");
  assert.equal(s.turns(reviewerId).length, before, "a reviewer is not woken to say a merge happened");
  assert.match(s.notes(reviewerId).at(-1)!, /Pull request #101 merged: .*\nThere is nothing left to review\./s);
  assert.ok(s.thread(reviewerId).archivedAt);
  assert.equal(s.reviewers("t1")[0]!.state, "dropped", "its seat is over, and the author is reading the same merge");
});

test("a review that asks for changes with no words is refused before anything is posted", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  const before = s.host.comments.length;
  await assert.rejects(
    () => s.engine.reviewDecide({ threadId: opened.reviewers[0]!, verdict: "changes", body: "   " }),
    (e: unknown) => e instanceof EngineError && e.code === "bad_body",
  );
  assert.equal(s.host.comments.length, before, "nothing went up");
  assert.equal(s.reviewers("t1")[0]!.state, "reviewing");
});

test("signing off records the verdict, archives the review thread, and lets the merge through", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { merge: "auto" });
  await settle();
  const reviewerId = opened.reviewers[0]!;

  // Before the sign-off the pull request is green by every GitHub fact, and
  // still not ready: the review is the one refusal GitHub knows nothing about.
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: false, why: "0 of 1 automated reviews have signed off" });
  assert.equal(s.host.merges.length, 0);

  const out = await s.engine.reviewDecide({ threadId: reviewerId, verdict: "approve", body: "Reads right, and the edge cases are covered." });
  await settle();
  assert.deepEqual([out.state, out.signedOff, out.required], ["signedOff", 1, 1]);
  assert.match(s.host.comments.at(-1)!.body, /Approved — from an automated covey review/);
  assert.equal(s.reviewers("t1")[0]!.state, "signedOff");
  assert.ok(s.reviewers("t1")[0]!.decidedAt);
  assert.ok(s.thread(reviewerId).archivedAt, "the review is over, so the thread hands its worktree back");
  assert.equal(s.thread(reviewerId).watch!.state, "dropped");

  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: true });
  assert.deepEqual(s.host.merges, [{ number: 101, method: "merge" }], "covey merges, now that the review is in");
  // The same poll merged, so the thread is archived and hears none of this as
  // a turn. Nothing is lost: the note carries the whole batch — the reviewer's
  // own words, and the pass that is no longer blocked by the review. The review
  // is a `mergeBlock`, so the verdict is re-delivered the moment the block goes.
  assert.ok(s.thread("t1").archivedAt, "the merge is the end of the loop");
  const told = s.notes("t1").find((x) => /which signed off/.test(x))!;
  assert.ok(told, s.notes("t1").join("\n---\n"));
  assert.match(told, /Pull request #101 merged/);
  assert.match(told, /The checks passed on .*There is nothing to fix/s);
});

test("before the sign-off, a green pull request reads as blocked by the review", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  await settle();
  await s.poll();
  const told = s.turns("t1").find((x) => /The checks passed/.test(x))!;
  assert.ok(told, s.turns("t1").join("\n---\n"));
  // The one thing this must never say over a review that has not finished.
  assert.doesNotMatch(told, /nothing to fix/);
  assert.match(told, /Covey will not call the pull request ready yet: 0 of 1 automated reviews have signed off/);
});

test("under manual, a signed-off pull request is ready for a person and covey merges nothing", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await s.engine.reviewDecide({ threadId: opened.reviewers[0]!, verdict: "approve" });
  await settle();
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: true });
  assert.equal(s.host.merges.length, 0, "manual: a person merges");
  const told = s.turns("t1").find((x) => /which signed off/.test(x))!;
  assert.ok(told, s.turns("t1").join("\n---\n"));
  assert.match(told, /There is nothing to fix. The merge policy is manual: a person merges/);
});

test("two reviewers both have to sign off", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { reviews: 2, merge: "auto" });
  await settle();
  await s.engine.reviewDecide({ threadId: opened.reviewers[0]!, verdict: "approve" });
  await settle();
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: false, why: "1 of 2 automated reviews have signed off" });
  assert.equal(s.host.merges.length, 0);

  await s.engine.reviewDecide({ threadId: opened.reviewers[1]!, verdict: "approve" });
  await settle();
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: true });
  assert.equal(s.host.merges.length, 1);
});

test("`covey review` from a thread that reviews nothing is refused", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await assert.rejects(
    () => s.engine.reviewDecide({ threadId: "t1", verdict: "approve" }),
    (e: unknown) => e instanceof EngineError && e.code === "not_a_review",
  );
});

// ---- a review that ends with no verdict --------------------------------------

test("a review thread archived before it decided tells the author, and the merge stops waiting in silence", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { merge: "auto" });
  await settle();
  await s.command({ type: "thread.archive", threadId: opened.reviewers[0]!, archived: true });
  await settle();

  assert.equal(s.reviewers("t1")[0]!.state, "dropped");
  const told = s.turns("t1").find((x) => /ended with no verdict/.test(x));
  assert.ok(told, s.turns("t1").join("\n---\n"));
  assert.match(told!, /somebody archived the review thread before it decided/);
  assert.match(told!, /a person has to look/);

  await s.poll();
  const readiness = s.thread("t1").watch!.readiness!;
  assert.equal(readiness.ready, false);
  assert.match(readiness.ready === false ? readiness.why : "", /no automated review is left to sign off/);
  assert.equal(s.host.merges.length, 0, "a dropped reviewer never signs off, so auto never merges");
});

test("a reviewer archived because it signed off is not a dropped reviewer", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await s.engine.reviewDecide({ threadId: opened.reviewers[0]!, verdict: "approve" });
  await settle();
  assert.equal(s.reviewers("t1")[0]!.state, "signedOff", "covey archives a reviewer itself the moment it signs off");
  assert.equal(s.turns("t1").filter((x) => /ended with no verdict/.test(x)).length, 0);
});

test("a reviewer deleted before it decided tells the author too", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await s.command({ type: "thread.delete", threadId: opened.reviewers[0]! });
  await settle();
  assert.equal(s.reviewers("t1")[0]!.state, "dropped");
  assert.ok(s.turns("t1").some((x) => /somebody deleted the review thread/.test(x)));
});

test("the record survives a restart: the gate still holds after the daemon comes back", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { merge: "auto" });
  await settle();
  s.restart();
  assert.equal(s.thread("t1").watch!.review!.required, 1);
  assert.equal(s.thread(opened.reviewers[0]!).reviewOf?.number, 101);
  await s.poll();
  assert.deepEqual(s.thread("t1").watch!.readiness, { ready: false, why: "0 of 1 automated reviews have signed off" });
});

// ---- the worktree the reviewer reads ----------------------------------------

test("a review worktree sits on the branch under review and follows it", async (t) => {
  // The one fact only a real repository can prove, and the one that matters
  // most: the code in front of the reviewer has to be the code on the pull
  // request, not a fresh branch from the base.
  const remote = await scratchRemote();
  t.after(remote.drop);
  const dir = mkdtempSync(join(tmpdir(), "covey-review-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(dir);
  const cli = fakeCli();
  const host = fakeHost({ canCreate: true, canComment: true, prs: {} });
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") }, { spawn: autoReply(cli), ghHost: () => host });
  t.after(() => engine.shutdown());
  const send = (cmd: Record<string, unknown>) => engine.dispatch({ commandId: randomUUID(), ...cmd } as never);

  await send({ type: "project.create", url: remote.url });
  const project = engine.shellSnapshot().projects[0]!;
  const authorId = randomUUID();
  await send({ type: "thread.create", projectId: project.id, threadId: authorId, sessionId: randomUUID() });
  const author = db.getThread(authorId)!;

  // The author's work: a commit on its own branch, pushed to the remote.
  await git(author.worktreePath!, "config", "user.email", "test@covey");
  await git(author.worktreePath!, "config", "user.name", "covey test");
  await git(author.worktreePath!, "commit", "-q", "--allow-empty", "-m", "the change under review");
  const change = await head(author.worktreePath!);
  await git(author.worktreePath!, "push", "-q", "origin", `HEAD:${author.branch!}`);
  host.options.prs = { [author.branch!]: pr({ number: 101, headRefName: author.branch!, title: "the change" }) };

  const opened = await engine.openPullRequest({ threadId: authorId, title: "the change", body: "." });
  await settle();
  const reviewer = db.getThread(opened.reviewers[0]!)!;
  assert.equal(await head(reviewer.worktreePath!), change, "the reviewer reads the pull request's own head");
  assert.notEqual(reviewer.branch, author.branch, "git refuses one branch in two worktrees, so the name is its own");
  // `git pull` is what the reviewer is told to run when the author pushes, and
  // it needs this. It also makes git itself refuse a push, which is the other
  // half of "never push to this branch".
  assert.equal(await git(reviewer.worktreePath!, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${author.branch}`);

  // The author pushes again; the reviewer can reach the new head from where it is.
  await git(author.worktreePath!, "commit", "-q", "--allow-empty", "-m", "the fix");
  const fix = await head(author.worktreePath!);
  await git(author.worktreePath!, "push", "-q", "origin", `HEAD:${author.branch!}`);
  await git(reviewer.worktreePath!, "pull", "-q");
  assert.equal(await head(reviewer.worktreePath!), fix);
});

test("archiving the author winds up its reviewers: no session outlives the work", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1", { reviews: 2 });
  await settle();
  assert.equal(s.reviewThreads().filter((x) => !x.archivedAt).length, 2);

  await s.command({ type: "thread.archive", threadId: "t1", archived: true });
  await settle();
  assert.deepEqual(s.reviewThreads().map((x) => !!x.archivedAt), [true, true]);
  assert.deepEqual(s.reviewers("t1").map((r) => r.state), ["dropped", "dropped"]);
  assert.deepEqual(s.reviewers("t1").map((r) => r.note), ["the thread that wrote the change was archived", "the thread that wrote the change was archived"]);
  // The reader has just archived this thread; it must not be woken to be told
  // that the review it no longer cares about did not finish.
  assert.equal(s.turns("t1").filter((x) => /ended with no verdict/.test(x)).length, 0, s.turns("t1").join("\n---\n"));
  assert.ok(opened.reviewers.every((id) => s.thread(id).watch!.state === "dropped"));
});

test("a reviewer that signed off is left alone when the author is archived", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await s.engine.reviewDecide({ threadId: opened.reviewers[0]!, verdict: "approve", body: "Good." });
  await settle();
  await s.command({ type: "thread.archive", threadId: "t1", archived: true });
  await settle();
  assert.equal(s.reviewers("t1")[0]!.state, "signedOff", "a verdict is not undone by archiving the author");
  assert.equal(s.reviewers("t1")[0]!.note, "Good.");
});

test("deleting the author archives its reviewers, and leaves no turn behind", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const opened = await s.open("t1");
  await settle();
  await s.command({ type: "thread.delete", threadId: "t1" });
  await settle();
  assert.equal(s.db.getThread("t1"), null, "the author's row is gone");
  assert.ok(s.thread(opened.reviewers[0]!).archivedAt);
});
