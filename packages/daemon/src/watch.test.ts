/**
 * The loop of issue #94, driven through a whole engine: a thread takes an
 * issue, opens a pull request, and hears what GitHub says about it as turns.
 *
 * The engine runs against two stand-ins. The `gh` host is `fakeHost`, so
 * nothing reaches GitHub and no pull request is opened anywhere but in
 * memory. The CLI is an auto-reply, so no Claude subprocess starts and every
 * turn the watch sends is answered at once. The clock is a variable.
 *
 * The acceptance list of the issue is the test list here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, truncateSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost, pr } from "./integrate/testHost.js";
import { POLL_MAX_MS, WATCH_MAX_MS, pollDelayMs } from "./integrate/news.js";
import { signComment } from "./integrate/sign.js";
import { autoReply, fakeCli, settle } from "./claudeFake.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

const FAILED = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/run/1" }];
const GREEN = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: `covey/${id}`, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-watch-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: "github.com/o/r",
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let clock = Date.parse("2026-09-21T10:00:00Z");
  const cli = fakeCli();
  const host = fakeHost({
    canCreate: true,
    canMerge: true,
    canAttach: true,
    canComment: true,
    prs: {},
    issues: { 94: { number: 94, title: "Let a thread take an issue", url: "https://github.com/o/r/issues/94", state: "OPEN" } },
  });
  const make = (database: Db) => new Engine(database, { ...MACHINE }, { now: () => clock, spawn: autoReply(cli), ghHost: () => host });
  const engines: Engine[] = [];
  let engine = make(db);
  engines.push(engine);
  const s = {
    db, dir, host, cli,
    /** Keep the next turns running until `release`. */
    hold() { cli.held = true; },
    async release() { cli.held = false; cli.release(); cli.release = () => {}; await settle(); },
    get engine() { return engine; },
    /** Move the clock on, in milliseconds. */
    advance: (ms: number) => { clock += ms; },
    newThread(id: string) { db.putThread(thread(id)); return id; },
    async command(cmd: Record<string, unknown>) {
      return engine.dispatch({ commandId: randomUUID(), ...cmd } as never);
    },
    /**
     * Open a pull request with *no* automated review unless the case asks for
     * one. Every case below is about the watch, and a reviewer of its own would
     * put a second thread, a second worktree and a merge gate into a test that
     * is not about any of them. `reviewLoop.test.ts` is where the review is the
     * subject, and it passes `reviews`.
     */
    async open(threadId: string, over: Record<string, unknown> = {}) {
      return engine.openPullRequest({ threadId, title: "Take issue 94", body: "The change.", reviews: 0, ...over });
    },
    /** One poll, with the clock moved past the longest back-off first. */
    async poll() {
      clock += POLL_MAX_MS;
      const polled = await engine.pollWatches();
      await settle();
      return polled;
    },
    thread(id: string): Thread { return db.getThread(id)!; },
    /** What the watch sent to the agent, in order. */
    turns(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    },
    notes(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
    },
    /** A second engine on the same database: what a daemon restart is. */
    restart() { engine.shutdown(); engine = make(new Db(dir)); engines.push(engine); return engine; },
    cleanup() { for (const e of engines) e.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
  return s;
}

// ---- taking an issue --------------------------------------------------------

test("a thread takes an issue, keeps it across a restart, and no second thread of the project may take it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  await s.command({ type: "thread.takeIssue", threadId: "t1", issue: 94 });
  assert.deepEqual(s.thread("t1").issue, { number: 94, title: "Let a thread take an issue", url: "https://github.com/o/r/issues/94", takenAt: s.thread("t1").issue!.takenAt });
  assert.match(s.notes("t1")[0]!, /Took issue #94 \(Let a thread take an issue\)/);
  await assert.rejects(
    () => s.command({ type: "thread.takeIssue", threadId: "t2", issue: 94 }),
    (e: unknown) => e instanceof EngineError && e.code === "taken",
  );
  // A number gh cannot read is still taken: the number is the link.
  await s.command({ type: "thread.takeIssue", threadId: "t2", issue: 95 });
  assert.equal(s.thread("t2").issue?.number, 95);
  assert.equal(s.thread("t2").issue?.title, null);

  s.restart();
  assert.equal(s.thread("t1").issue?.number, 94, "the link survives a restart");
  // An archived thread holds nothing, so the issue is free again.
  await s.command({ type: "thread.archive", threadId: "t1", archived: true });
  await s.command({ type: "thread.takeIssue", threadId: "t2", issue: 94 });
  assert.equal(s.thread("t2").issue?.number, 94);
});

// ---- opening a pull request ---------------------------------------------------

test("a thread opens a pull request through covey, and covey records the number and watches it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.command({ type: "thread.takeIssue", threadId: "t1", issue: 94 });
  const opened = await s.open("t1");
  assert.deepEqual(opened, { number: 101, url: "https://github.com/o/r/pull/101", reviewers: [] }, "no reviewer: this case passed `reviews: 0`");
  assert.equal(s.host.opened.length, 1, "one pull request, in memory");
  assert.equal(s.host.opened[0]!.branch, "covey/t1");
  assert.equal(s.host.opened[0]!.base, "main");
  assert.equal(s.host.opened[0]!.body, "The change.\n\nCloses #94", "the issue closes when the change lands");
  const row = s.thread("t1");
  assert.equal(row.pullRequest?.number, 101);
  assert.equal(row.pullRequest?.branch, "covey/t1");
  assert.equal(row.watch?.state, "watching");
  assert.equal(row.watch?.maxRounds, 3);
  assert.match(s.notes("t1").at(-1)!, /Watching pull request #101/);
  // A second open on a watched pull request is refused, not a duplicate.
  await assert.rejects(() => s.open("t1"), (e: unknown) => e instanceof EngineError && e.code === "exists");
  assert.equal(s.host.opened.length, 1);
});

test("a body that names the issue is left alone, and a thread with no issue gets no Closes line", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.command({ type: "thread.takeIssue", threadId: "t1", issue: 94 });
  await s.open("t1", { body: "Fixes #94 by the direct route." });
  assert.equal(s.host.opened[0]!.body, "Fixes #94 by the direct route.");
  s.newThread("t2");
  await s.open("t2", { body: "" });
  assert.equal(s.host.opened[1]!.body, "");
});

// ---- the watch: every terminal state, once ----------------------------------

test("a failed check reaches the thread as a turn, and the same failure is never sent twice", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = [{ name: "test", workflowName: "ci", status: "IN_PROGRESS" }];
  assert.deepEqual(await s.poll(), ["t1"]);
  assert.deepEqual(s.turns("t1"), [], "a pending check is not an answer");

  facts.checks = FAILED;
  facts.mergeStateStatus = "BLOCKED";
  await s.poll();
  const turns = s.turns("t1");
  assert.equal(turns.length, 1, "the failure fired");
  assert.match(turns[0]!, /covey watch: news on pull request #101/);
  assert.match(turns[0]!, /The checks failed on deadbee: `ci \/ test` \(https:\/\/ci\/run\/1\)/);
  assert.match(turns[0]!, /round 1 of 3/);
  assert.equal(s.engine.sessionCensus().live, 1, "the turn started a session, which is what a turn is for");
  assert.equal(s.thread("t1").watch?.rounds, 1);

  await s.poll();
  await s.poll();
  assert.equal(s.turns("t1").length, 1, "polled twice more, delivered once");
});

test("a fix the agent pushes leads to a second round without a person, and a pass ends the rounds", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = FAILED;
  await s.poll();
  assert.equal(s.turns("t1").length, 1);
  // The agent pushed: a new head, and the checks failed again.
  facts.headRefOid = "1111111aaaa";
  facts.checks = FAILED;
  await s.poll();
  assert.equal(s.turns("t1").length, 2, "a new head is a new verdict");
  assert.match(s.turns("t1")[1]!, /round 2 of 3/);
  // Then a push that passes.
  facts.headRefOid = "2222222bbbb";
  facts.checks = GREEN;
  await s.poll();
  assert.equal(s.turns("t1").length, 3);
  assert.match(s.turns("t1")[2]!, /The checks passed on 2222222/);
  assert.equal(s.thread("t1").watch?.rounds, 2, "a pass costs no round");
  assert.equal(s.thread("t1").watch?.state, "watching", "green is not the end; a merge is");
});

test("a loop that cannot finish stops the work, puts it in the transcript, and keeps watching", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { maxRounds: 1 });
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = FAILED;
  await s.poll();
  assert.equal(s.turns("t1").length, 1);
  facts.headRefOid = "1111111aaaa";
  await s.poll();
  assert.equal(s.turns("t1").length, 1, "the cap stops the work");
  const w = s.thread("t1").watch!;
  assert.equal(w.state, "watching", "the budget bounds the work, never the watch (#199)");
  assert.equal(w.rounds, 1);
  assert.ok(w.spentAt, "and the row says when covey stopped waking the thread");
  const notes = s.notes("t1");
  assert.match(notes.at(-1)!, /stops waking this thread for more/);
  assert.match(notes.at(-2)!, /The checks failed on 1111111/, "the news that stopped the loop is in the transcript for the reader");
  assert.ok((await s.poll()).includes("t1"), "and the pull request goes on being read");

  // The reader fixed it by hand. The pass asks for no work, so it arrives as a
  // turn like any other: this is the whole of what #199 lost.
  facts.checks = GREEN;
  facts.headRefOid = "2222222bbbb";
  await s.poll();
  assert.equal(s.turns("t1").length, 2, "a checks verdict with nothing to fix still reaches the thread");
  assert.match(s.turns("t1").at(-1)!, /There is nothing to fix/);
  assert.equal(s.thread("t1").watch?.rounds, 1, "and it spends no round");
  assert.equal(s.notes("t1").filter((n) => /stops waking this thread/.test(n)).length, 1, "said once");

  // And the merge still lands, which is the end of the watch. It is the one
  // end that costs no turn: the thread is archived with the news in a note.
  facts.state = "MERGED";
  await s.poll();
  assert.equal(s.thread("t1").watch?.state, "merged");
  assert.equal(s.turns("t1").length, 2, "the merge asks the agent for nothing");
  assert.match(s.notes("t1").at(-1)!, /Pull request #101 merged/);
  assert.ok(s.thread("t1").archivedAt);
});

test("a watch out of rounds still merges under auto when the pull request comes good", async (t) => {
  // #199 itself: three rounds went on a base that moved, the watch ended, and
  // the pull request sat approved with six green checks and nobody to merge it.
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { merge: "auto", maxRounds: 1 });
  s.host.options.base = BASE;
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = FAILED;
  await s.poll();
  facts.headRefOid = "1111111aaaa";
  await s.poll();
  assert.ok(s.thread("t1").watch?.spentAt, "the budget is spent");
  assert.deepEqual(s.host.merges, []);

  facts.checks = GREEN_ON_BASE;
  facts.headRefOid = "2222222bbbb";
  await s.poll();
  assert.deepEqual(s.host.merges, [{ number: 101, method: "merge" }], "covey merges it, as it would have before the budget ran out");
  assert.equal(s.thread("t1").watch?.state, "merged");
});

test("a review and its line comment arrive as one turn that carries the words", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = GREEN;
  await s.poll();
  assert.equal(s.turns("t1").length, 1);
  facts.reviews = [{ id: "r1", author: "dylan", state: "CHANGES_REQUESTED", body: "See the line note.", submittedAt: "2026-09-21T11:00:00Z", url: null }];
  s.host.options.lineComments = { 101: [{ id: "c1", author: "dylan", body: "This should be a Set.", createdAt: "2026-09-21T11:00:00Z", url: null, path: "packages/x.ts", line: 12 }] };
  await s.poll();
  const turns = s.turns("t1");
  assert.equal(turns.length, 2);
  assert.match(turns[1]!, /Review by dylan: changes requested\.\n  > See the line note\./);
  assert.match(turns[1]!, /Comment by dylan on packages\/x\.ts line 12:\n  > This should be a Set\./);
  assert.equal(s.thread("t1").watch?.rounds, 1, "a request for changes costs a round");
  await s.poll();
  assert.equal(s.turns("t1").length, 2, "delivered once");
});

test("a merge ends the watch and archives the thread, and spends no turn saying so", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.state = "MERGED";
  await s.poll();
  assert.equal(s.thread("t1").watch?.state, "merged");
  assert.deepEqual(s.turns("t1"), [], "the only answer a turn could bring back is `it merged`");
  assert.ok(s.thread("t1").archivedAt, "the loop is over, so the thread is put away");
  const notes = s.notes("t1");
  assert.match(notes.at(-2)!, /Stopped watching pull request #101: The pull request was merged/);
  assert.match(notes.at(-1)!, /Pull request #101 merged: https:\/\/github\.com\/o\/r\/pull\/101\nThe loop is done\. Covey stopped the watch and archived this thread/);
  assert.deepEqual(await s.poll(), [], "nothing left to watch");
});

test("with the archive turned off, the merge reaches the thread as a turn and the thread stays", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  // A fresh object, not a write to the shared one: every engine of this file
  // holds the same settings, and one test must not set another one's machine.
  s.engine.machine.settings = { ...s.engine.machine.settings, archiveOnMerge: false };
  s.newThread("t1");
  await s.open("t1");
  s.host.options.prs!["covey/t1"]!.state = "MERGED";
  await s.poll();
  assert.equal(s.thread("t1").watch?.state, "merged");
  assert.match(s.turns("t1")[0]!, /was merged\. The loop is done/);
  assert.equal(s.thread("t1").archivedAt, null);
});

test("a merge seen while the thread works waits for the turn, and a reader who writes keeps the thread", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  s.hold();
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "still working" });
  await settle();
  s.host.options.prs!["covey/t1"]!.state = "MERGED";
  await s.poll();
  assert.equal(s.thread("t1").archivedAt, null, "archiving takes the worktree back, so it waits for the turn");
  await s.release();
  assert.ok(s.thread("t1").archivedAt, "and lands when the turn ends");

  // The reader has more for this thread, so the next merge archives nothing.
  s.newThread("t2");
  await s.open("t2");
  s.hold();
  await s.command({ type: "turn.send", threadId: "t2", turnId: randomUUID(), text: "still working" });
  await settle();
  s.host.options.prs!["covey/t2"]!.state = "MERGED";
  await s.poll();
  await s.command({ type: "turn.send", threadId: "t2", turnId: randomUUID(), text: "one more thing" });
  await s.release();
  assert.equal(s.thread("t2").archivedAt, null, "somebody wrote to it, so the thread stays");
});

// ---- the watch is bounded, and it is dropped with the thread -----------------

test("a merge never takes a session that still owns a background task", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  // The agent pushed, started a build in the background, and ended its turn —
  // which is what a thread looks like at the moment its pull request merges.
  // A background task leaves no running turn behind (#156) and dies with its
  // session, and archiving drops the session and takes the worktree back.
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "start the build in the background" });
  await settle();
  s.cli.backgroundTask("task-1");
  await settle();
  assert.equal(s.thread("t1").latestTurn?.state, "completed", "nothing is running, and the work is still there");

  s.host.options.prs!["covey/t1"]!.state = "MERGED";
  await s.poll();
  assert.equal(s.thread("t1").watch?.state, "merged", "the watch ends either way");
  assert.equal(s.thread("t1").archivedAt, null, "but the thread keeps its session until the task is done");

  // The task reports, the agent writes about it, and that turn ends.
  s.cli.finishTask("task-1");
  s.cli.woken("The build passed.");
  await settle();
  assert.ok(s.thread("t1").archivedAt, "and the thread goes at the end of the turn the report opened");
});

test("a message the agent reads inside the turn is answered, and the thread still goes", async (t) => {
  // The other half of the rule above. A message written while the session is
  // live is folded into the running turn rather than queued, so the agent reads
  // it and answers it before the turn ends. It is not a message nobody has
  // answered, and the loop is still over.
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  s.hold();
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "working" });
  await settle();
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "and check the logs" });
  assert.equal(s.thread("t1").queuedTurns, 0, "folded into the turn, not queued behind it");
  s.host.options.prs!["covey/t1"]!.state = "MERGED";
  await s.poll();
  await s.release();
  assert.ok(s.thread("t1").archivedAt, "answered, so the merge puts the thread away with the answer in it");
});

test("a quiet watch backs off, and a watch that runs too long is handed to a person", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  assert.deepEqual(await s.engine.pollWatches(), ["t1"], "the first poll is due at once");
  assert.deepEqual(await s.engine.pollWatches(), [], "and the next one is not");
  assert.equal(s.thread("t1").watch?.quiet, 1);
  // One quiet poll: the next wait is the curve's second step, not its first.
  s.advance(pollDelayMs(1) - 1);
  assert.deepEqual(await s.engine.pollWatches(), []);
  s.advance(1);
  assert.deepEqual(await s.engine.pollWatches(), ["t1"]);
  assert.equal(s.thread("t1").watch?.quiet, 2);
  s.advance(pollDelayMs(1));
  assert.deepEqual(await s.engine.pollWatches(), [], "the second quiet poll waits longer than the first");
  s.advance(pollDelayMs(2) - pollDelayMs(1));
  assert.deepEqual(await s.engine.pollWatches(), ["t1"]);
  assert.equal(s.host.reads.pullRequest, 3);

  s.advance(WATCH_MAX_MS);
  await s.engine.pollWatches();
  const w = s.thread("t1").watch!;
  assert.equal(w.state, "blocked");
  assert.match(w.reason!, /ran for 72 hours without a merge or a close/);
  assert.equal(s.host.reads.pullRequest, 3, "a watch past its end reads nothing");
});

test("archiving a thread drops its watch, so nothing wakes a thread that said it was done", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  await s.command({ type: "thread.archive", threadId: "t1", archived: true });
  assert.equal(s.thread("t1").watch?.state, "dropped");
  assert.match(s.thread("t1").watch!.reason!, /archived/);
  s.host.options.prs!["covey/t1"]!.checks = FAILED;
  assert.deepEqual(await s.poll(), []);
  assert.deepEqual(s.turns("t1"), []);
});

test("a watch stopped by request ends, and a pull request opened by hand can be handed to covey", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.host.options.prs!["covey/t1"] = pr({ number: 7, headRefName: "covey/t1", checks: FAILED });
  await s.command({ type: "thread.watch", threadId: "t1", number: 7, maxRounds: 2 });
  assert.equal(s.thread("t1").pullRequest?.number, 7);
  assert.equal(s.thread("t1").watch?.maxRounds, 2);
  await s.poll();
  assert.equal(s.turns("t1").length, 1);
  await s.command({ type: "thread.watch", threadId: "t1", number: null });
  assert.equal(s.thread("t1").watch?.state, "dropped");
  await assert.rejects(
    () => s.command({ type: "thread.watch", threadId: "t1", number: 8 }),
    (e: unknown) => e instanceof EngineError && e.code === "not_found",
  );
});

test("a gh that cannot answer is recorded on the watch and delivers nothing", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  s.host.options.prs!["covey/t1"]!.checks = FAILED;
  s.host.options.fail = new Error("gh: not logged in");
  await s.poll();
  assert.equal(s.thread("t1").watch?.error, "gh: not logged in");
  assert.deepEqual(s.turns("t1"), []);
  s.host.options.fail = null;
  await s.poll();
  assert.equal(s.thread("t1").watch?.error, null, "the next good poll clears it");
  assert.equal(s.turns("t1").length, 1, "and the failure still arrives, once");
});

// ---- the watch survives a restart ------------------------------------------------

test("a restart resumes the watch from its cursor: nothing is sent twice, and the next answer still arrives", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = FAILED;
  await s.poll();
  assert.equal(s.turns("t1").length, 1);

  s.restart();
  assert.equal(s.thread("t1").watch?.state, "watching", "the watch is in the row, not in memory");
  await s.poll();
  assert.equal(s.turns("t1").length, 1, "the cursor came back with the row");
  facts.headRefOid = "1111111aaaa";
  facts.checks = GREEN;
  await s.poll();
  assert.equal(s.turns("t1").length, 2);
  assert.match(s.turns("t1")[1]!, /The checks passed on 1111111/);
});

// ---- who merges --------------------------------------------------------------------

const BASE = { oid: "base1", committedAt: "2026-09-21T09:00:00Z" };
const GREEN_ON_BASE = [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-21T09:30:00Z" }];

test("the policy is manual unless said otherwise: a green pull request waits for a person, and a person can hand it to covey", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  assert.equal(s.thread("t1").watch?.merge, "manual");
  s.host.options.base = BASE;
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = GREEN_ON_BASE;
  await s.poll();
  assert.match(s.turns("t1")[0]!, /merge policy is manual: a person merges/);
  assert.deepEqual(s.host.merges, [], "nothing merged on a green check alone");
  await s.poll();
  assert.equal(s.thread("t1").watch?.state, "watching");

  // The person looked, and wants it landed.
  await s.command({ type: "thread.setMerge", threadId: "t1", merge: "auto", mergeMethod: "squash" });
  assert.match(s.notes("t1").at(-1)!, /Merge policy set to auto/);
  await s.poll();
  assert.deepEqual(s.host.merges, [{ number: 101, method: "squash" }]);
  assert.equal(s.thread("t1").watch?.state, "merged");
  assert.match(s.thread("t1").watch!.reason!, /Covey merged the pull request \(squash\)/);
  assert.match(s.notes("t1").at(-1)!, /Pull request #101 merged: \S+\nCovey merged it \(squash\) under the auto policy\./);
  await assert.rejects(
    () => s.command({ type: "thread.setMerge", threadId: "t1", merge: "manual" }),
    (e: unknown) => e instanceof EngineError && e.code === "no_watch",
  );
});

test("under manual, a green pull request GitHub will not merge says so, and says what to do", async (t) => {
  // The run of 2026-10-02: six checks green, the merge button grey because
  // the branch was out of date, and the thread told the reader it was ready.
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  s.host.options.base = BASE;
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = GREEN_ON_BASE;
  facts.mergeStateStatus = "BEHIND";
  await s.poll();
  const turn = s.turns("t1")[0]!;
  assert.match(turn, /The checks passed/);
  assert.match(turn, /GitHub will not merge the pull request yet: the branch is out of date with main/);
  assert.match(turn, /Merge main into covey\/t1 and push/);
  assert.doesNotMatch(turn, /a person merges the pull request/);
  assert.equal(s.thread("t1").watch?.rounds, 0, "the base moved; the change did not fail, so it costs no round (#199)");
  assert.equal(s.thread("t1").watch?.readiness?.ready, false);

  // The agent merged main in and pushed. Nothing blocks the merge now.
  facts.mergeStateStatus = "CLEAN";
  facts.headRefOid = "pushed";
  await s.poll();
  const next = s.turns("t1").at(-1)!;
  assert.match(next, /There is nothing to fix/);
  assert.match(next, /merge policy is manual: a person merges/);
  assert.deepEqual(s.thread("t1").watch?.readiness, { ready: true }, "the row the phone reads says ready, and means it");
});

test("under manual the base head is read too, so the row never calls a ready branch unready", async (t) => {
  // #172 computed the readiness under either policy, but the base head was
  // read only under auto. `isStale` refuses on doubt, so every manual watch
  // read as "6 checks started before the base head is unknown".
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1");
  s.host.options.base = BASE;
  s.host.options.prs!["covey/t1"]!.checks = GREEN_ON_BASE;
  await s.poll();
  assert.deepEqual(s.thread("t1").watch?.readiness, { ready: true });
});

test("under auto, covey merges when the checks pass, but never under a running turn", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { merge: "auto" });
  assert.match(s.notes("t1").at(-1)!, /Merge policy: auto/);
  s.host.options.base = BASE;
  const facts = s.host.options.prs!["covey/t1"]!;
  // The agent is at work when the checks go green.
  s.hold();
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "still working" });
  await settle();
  assert.equal(s.thread("t1").latestTurn?.state, "running");
  facts.checks = GREEN_ON_BASE;
  await s.poll();
  assert.deepEqual(s.host.merges, [], "a merge under a running turn hides the commits it is about to push");
  assert.match(s.turns("t1").at(-1)!, /The checks passed/, "the pass still reaches the thread");
  await s.release();
  assert.equal(s.thread("t1").latestTurn?.state, "completed");
  await s.poll();
  assert.deepEqual(s.host.merges, [{ number: 101, method: "merge" }]);
  assert.equal(s.thread("t1").watch?.state, "merged");
  assert.match(s.notes("t1").at(-1)!, /Pull request #101 merged: \S+\nCovey merged it \(merge\) under the auto policy\./);
});

test("under auto, a pass against an older base is work for the agent, not a merge and not a round", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { merge: "auto" });
  s.host.options.base = { oid: "moved", committedAt: "2026-09-21T09:45:00Z" };
  s.host.options.prs!["covey/t1"]!.checks = GREEN_ON_BASE;
  await s.poll();
  assert.deepEqual(s.host.merges, []);
  assert.match(s.turns("t1")[0]!, /but against an older main/);
  assert.equal(s.thread("t1").watch?.rounds, 0, "the base moved under the pass; that is not the change failing (#199)");
});

test("under auto, a review that asks for changes holds the merge, and a refusal from GitHub is reported once per head", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.open("t1", { merge: "auto" });
  s.host.options.base = BASE;
  const facts = s.host.options.prs!["covey/t1"]!;
  facts.checks = GREEN_ON_BASE;
  facts.reviewDecision = "CHANGES_REQUESTED";
  facts.reviews = [{ id: "r1", author: "dylan", state: "CHANGES_REQUESTED", body: "not yet", submittedAt: "2026-09-21T10:00:00Z", url: null }];
  await s.poll();
  assert.deepEqual(s.host.merges, []);
  assert.match(s.turns("t1")[0]!, /changes requested/);

  // The reviewer relented, and the repository refuses the merge for a reason of its own.
  facts.reviewDecision = "APPROVED";
  s.host.options.mergeFail = new Error("GraphQL: 2 of 2 required status checks are expected.");
  await s.poll();
  assert.match(s.turns("t1")[1]!, /GitHub refused: GraphQL: 2 of 2 required status checks are expected/);
  assert.equal(s.thread("t1").watch?.cursor.mergeTried, "deadbeef");
  await s.poll();
  assert.equal(s.turns("t1").length, 2, "one try per head");
  assert.equal(s.thread("t1").watch?.state, "watching", "a refused merge is a person's question; the watch goes on");
});

// ---- media on the pull request (#105) ----------------------------------------
//
// The attachment store is under `dataDir()`, which reads `COVEY_HOME` at call
// time, so each test points it at its own scratch directory.

function media(s: ReturnType<typeof setup>, name: string, size = 4): string {
  const path = join(s.dir, name);
  writeFileSync(path, "");
  truncateSync(path, size);
  return path;
}

const withHome = async (s: ReturnType<typeof setup>, f: () => Promise<void>) => {
  const prior = process.env.COVEY_HOME;
  process.env.COVEY_HOME = s.dir;
  try { await f(); } finally { if (prior === undefined) delete process.env.COVEY_HOME; else process.env.COVEY_HOME = prior; }
};

test("a video and an image go up as user attachments, render inline in the order given, and a copy is kept", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.command({ type: "thread.takeIssue", threadId: "t1", issue: 94 });
  await withHome(s, async () => {
    await s.open("t1", { attachments: [{ name: "demo.mp4", path: media(s, "demo.mp4") }, { name: "shot.png", path: media(s, "shot.png") }] });
  });
  assert.deepEqual(s.host.uploads.map((u) => [u.name, u.contentType, u.size]), [["demo.mp4", "video/mp4", 4], ["shot.png", "image/png", 4]]);
  const [video, image] = s.host.uploads;
  assert.equal(s.host.opened[0]!.body, `The change.\n\n${video!.url}\n\n![shot.png](${image!.url})\n\nCloses #94`,
    "the video is a bare URL and the image an image, in the order the flags were given, before the Closes line");
  const kept = readdirSync(join(s.dir, "attachments", "t1")).map((f) => f.slice(-4)).sort();
  assert.deepEqual(kept, [".mp4", ".png"], "the thread's attachment store holds a copy of each");
  const notes = s.notes("t1");
  assert.match(notes.find((n) => n.startsWith("Attached demo.mp4"))!, /^Attached demo\.mp4 \(video\/mp4\) as https:\/\/github\.com\/user-attachments\/assets\/1-demo\.mp4; a copy is at .*attachments.*t1/);
  assert.match(notes.find((n) => n.startsWith("Attached shot.png"))!, /^Attached shot\.png \(image\/png\)/);
});

test("a placeholder puts the media where the body says", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await withHome(s, async () => {
    await s.open("t1", { body: "Before.\n\n{{attach:demo.mp4}}\n\nAfter.", attachments: [{ name: "demo.mp4", path: media(s, "demo.mp4") }] });
  });
  assert.equal(s.host.opened[0]!.body, `Before.\n\n${s.host.uploads[0]!.url}\n\nAfter.`);
});

test("a file GitHub would not render is refused before the upload and before the push, and names the list", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await withHome(s, async () => {
    await assert.rejects(
      () => s.open("t1", { attachments: [{ name: "notes.txt", path: media(s, "notes.txt") }] }),
      (e: unknown) => e instanceof EngineError && e.code === "bad_attachment" && /cannot attach notes\.txt: GitHub renders only \.mp4, \.mov, \.webm, \.png, \.jpg, \.jpeg, \.gif, \.webp, \.svg inline/.test(e.message),
    );
  });
  assert.equal(s.host.uploads.length, 0, "nothing went up");
  assert.equal(s.host.opened.length, 0, "nothing was pushed or opened");
  assert.equal(s.thread("t1").pullRequest, undefined);
  assert.equal(existsSync(join(s.dir, "attachments")), false, "nothing was kept for a file that can never go up");
});

test("a file over the plan's cap is refused before the upload, with the size and the cap", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const big = media(s, "demo.mp4", 12 * 1024 * 1024);
  await withHome(s, async () => {
    await assert.rejects(
      () => s.open("t1", { attachments: [{ name: "demo.mp4", path: big }] }),
      (e: unknown) => e instanceof EngineError && /demo\.mp4: it is 12 MB, over 10 MB, the cap for a video on the free plan/.test(e.message),
    );
    assert.equal(s.host.uploads.length, 0);
    assert.equal(s.host.opened.length, 0);
    // The same file goes up on a paid plan, where the cap is 100 MB.
    s.host.options.plan = "paid";
    await s.open("t1", { attachments: [{ name: "demo.mp4", path: big }] });
  });
  assert.equal(s.host.uploads.length, 1);
  assert.equal(s.host.opened.length, 1);
});

test("an upload GitHub refuses stops before the push, prints the status, and names the by-hand fallback", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.host.options.uploadFail = { status: 403, body: '{"message":"Forbidden"}' };
  await withHome(s, async () => {
    await assert.rejects(
      () => s.open("t1", { attachments: [{ name: "shot.png", path: media(s, "shot.png") }] }),
      (e: unknown) => e instanceof EngineError && e.code === "upload_refused"
        && /GitHub refused the upload of shot\.png: HTTP 403 \{"message":"Forbidden"\}\. The file is kept at .*attachments.*t1.*\.png; a person can drag it into the pull request by hand instead\. Nothing was pushed and nothing was opened/.test(e.message),
    );
  });
  assert.equal(s.host.opened.length, 0, "no pull request with a path in its body");
  assert.equal(s.thread("t1").pullRequest, undefined);
  assert.equal(readdirSync(join(s.dir, "attachments", "t1")).length, 1, "the copy is there for the by-hand path");
});

test("a path that is not a file, a missing placeholder and two files of one name are each refused before anything happens", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await withHome(s, async () => {
    await assert.rejects(() => s.open("t1", { attachments: [{ name: "x.png", path: join(s.dir, "nope.png") }] }), (e: unknown) => e instanceof EngineError && e.code === "no_file");
    await assert.rejects(() => s.open("t1", { body: "{{attach:other.png}}", attachments: [{ name: "x.png", path: media(s, "x.png") }] }), (e: unknown) => e instanceof EngineError && /no --attach gives a file called other\.png/.test(e.message));
    const p = media(s, "same.png");
    await assert.rejects(() => s.open("t1", { attachments: [{ name: "same.png", path: p }, { name: "same.png", path: p }] }), (e: unknown) => e instanceof EngineError && /two files are called same\.png/.test(e.message));
  });
  assert.equal(s.host.opened.length, 0);
});

test("a comment goes on the thread's pull request with its media, and a thread with no pull request is told so", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await assert.rejects(() => s.engine.commentPullRequest({ threadId: "t1", body: "hi" }), (e: unknown) => e instanceof EngineError && e.code === "no_pull_request");
  await s.open("t1");
  await assert.rejects(() => s.engine.commentPullRequest({ threadId: "t1", body: "  " }), (e: unknown) => e instanceof EngineError && e.code === "bad_body");
  await withHome(s, async () => {
    const r = await s.engine.commentPullRequest({ threadId: "t1", body: "After the fix:", attachments: [{ name: "after.png", path: media(s, "after.png") }] });
    assert.deepEqual(r, { number: 101, url: "https://github.com/o/r/pull/101#issuecomment-1" });
    // Media alone is a comment too.
    await s.engine.commentPullRequest({ threadId: "t1", attachments: [{ name: "demo.mp4", path: media(s, "demo.mp4") }] });
  });
  // Every comment covey posts is signed with the thread that wrote it, so the
  // watch never sends it back as news. The signature goes on last, after the
  // attachment URLs.
  assert.deepEqual(s.host.comments, [
    { number: 101, body: signComment(`After the fix:\n\n![after.png](${s.host.uploads[0]!.url})`, "t1"), kind: "pull" },
    { number: 101, body: signComment(s.host.uploads[1]!.url, "t1"), kind: "pull" },
  ]);
  assert.match(s.notes("t1").at(-1)!, /Commented on pull request #101/);
  // A pull request handed to covey by hand takes a comment the same way.
  s.newThread("t2");
  s.host.options.prs!["covey/t2"] = pr({ number: 7, headRefName: "covey/t2" });
  await s.command({ type: "thread.watch", threadId: "t2", number: 7 });
  await s.engine.commentPullRequest({ threadId: "t2", body: "Seen." });
  assert.deepEqual(s.host.comments.at(-1), { number: 7, body: signComment("Seen.", "t2"), kind: "pull" });
});
