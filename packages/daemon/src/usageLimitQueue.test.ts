/**
 * The plan's usage limit, driven through a whole engine.
 *
 * One account is one limit, so the afternoon it runs out every thread on the
 * machine stops inside a minute, each with a red row and a turn nobody
 * finished. What a reader had to do then was come back hours later and type
 * each message again. What covey does now is hold the work and send it again
 * when the limit resets, which is the timer's rule with the clock read off the
 * refusal.
 *
 * The clock is a variable and the CLI is an auto-reply that can be told to
 * refuse, so no Claude subprocess starts and nothing here waits on a real
 * limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { threadIsFinished, threadNeedsPerson, threadOnLimit, type MachineInfo, type Project, type Thread } from "@covey/protocol";
import { threadNews } from "@covey/client";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { autoReply, fakeCli, settle } from "./claudeFake.js";
import { USAGE_LIMIT_BACKOFF_MS, USAGE_LIMIT_GRACE_MS, USAGE_LIMIT_MAX_ROUNDS } from "./usageLimit.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

const MINUTE = 60_000;
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Four in the afternoon, local, so the reset below is eight hours off. */
const START = new Date(2026, 10, 15, 16, 8, 0, 0).getTime();
const RESET = new Date(2026, 10, 16, 0, 10, 0, 0).getTime();
/** What Claude Code answered the afternoon this was written. */
const REFUSED = `You've hit your session limit · resets 12:10am (${ZONE})`;
/** And a refusal with no time in it, which covey has to back off from. */
const NO_TIME = "You've reached your usage limit";

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-limit-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let clock = START;
  const cli = fakeCli();
  const reply = autoReply(cli);
  const engines: Engine[] = [];
  const make = (database: Db) => new Engine(database, { ...MACHINE }, { now: () => clock, spawn: reply });
  let engine = make(db);
  engines.push(engine);
  return {
    db, dir, cli,
    get engine() { return engine; },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    newThread(id: string) { db.putThread(thread(id)); return id; },
    thread(id: string): Thread { return db.getThread(id)!; },
    /** A message from the reader, answered or refused by the fake CLI. */
    async send(threadId: string, text = "do the work") {
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text } as never);
      await settle();
    },
    /** One tick of the daemon's own interval. */
    async tick() {
      const woke = await engine.fireLimits();
      await settle();
      return woke;
    },
    turns(threadId: string): { text: string; system?: boolean }[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "user") as never;
    },
    notes(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
    },
    /** A second engine on the same database: what a daemon restart is. */
    restart() { engine.shutdown(); engine = make(new Db(dir)); engines.push(engine); return engine; },
    cleanup() { for (const e of engines) e.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- holding the work -------------------------------------------------------

test("a turn refused for the limit is held, not failed", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1", "write the tests");

  const limit = s.thread("t1").usageLimit!;
  assert.equal(limit.message, REFUSED);
  assert.equal(limit.round, 1);
  assert.equal(limit.firedAt, null);
  assert.equal(Date.parse(limit.resetsAt!), RESET, "the reset is read out of the refusal itself");
  assert.equal(Date.parse(limit.dueAt), RESET + USAGE_LIMIT_GRACE_MS, "and covey waits a minute past it");
  assert.equal(limit.turnId, s.thread("t1").latestTurn!.turnId, "the work it holds is the turn that was refused");

  // What every client reads off the row. The thread is waiting on covey, so it
  // is neither the reader's again nor something they have to act on.
  assert.equal(threadOnLimit(s.thread("t1")), true);
  assert.equal(threadNeedsPerson(s.thread("t1")), false);
  assert.equal(threadIsFinished(s.thread("t1")), false);
  assert.equal(s.thread("t1").status, "idle");

  const note = s.notes("t1").at(-1)!;
  assert.match(note, /You've hit your session limit/);
  assert.match(note, /in 8h/, "the note says when the work goes again");
  assert.match(note, /Nothing is needed from you/);
});

/**
 * The record has to ride on the frame that carries the failed turn. A client
 * reads a turn going to `error` as the bell, and a bell every five hours for a
 * thread covey is coming back to is what this feature exists to stop.
 */
test("the thread raises no bell while covey holds its work", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  const seen: (Thread | null)[] = [];
  s.engine.onThread((_id, ev) => { if (ev.kind === "thread.updated") seen.push(ev.thread); });
  s.cli.refusal = REFUSED;
  await s.send("t1");

  let prev = thread("t1");
  const news = [];
  for (const next of seen) { if (!next) continue; const n = threadNews(prev, next); if (n) news.push(n); prev = next; }
  assert.ok(news.length > 0, "the thread said nothing at all about the refusal");
  assert.deepEqual(news.filter((n) => n.wants), [], "something asked for the reader");
  assert.ok(news.some((n) => n.lead === "waiting on the usage limit"), news.map((n) => n.lead).join(", "));
});

/**
 * One failure reaches the engine twice — the turn's result and the session's
 * status both carry it — and a thread must not wait twice for one limit.
 */
test("one refusal is one wait", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  const first = s.thread("t1").usageLimit!;
  await settle();
  assert.deepEqual(s.thread("t1").usageLimit, first);
  assert.equal(s.notes("t1").filter((n) => n.includes("session limit")).length, 1, "the reader was told twice");
});

// ---- sending it again -------------------------------------------------------

test("the work goes again when the limit resets, and only then", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1", "write the tests");
  assert.equal(s.turns("t1").length, 1);

  s.advance(7 * 3_600_000);
  assert.deepEqual(await s.tick(), [], "a wait that is not up wakes nothing");
  assert.equal(s.turns("t1").length, 1);

  s.cli.refusal = null;
  s.advance(2 * 3_600_000);
  assert.deepEqual(await s.tick(), ["t1"]);

  const turns = s.turns("t1");
  assert.equal(turns.length, 2);
  // The turn died before its first word, so what goes back is the reader's own
  // message rather than covey's "go on" — and covey must not dress the
  // reader's words up as its own.
  assert.equal(turns[1]!.text, "write the tests");
  assert.notEqual(turns[1]!.system, true);

  // The work answered, so the chain is over and the row is the reader's again.
  assert.equal(s.thread("t1").usageLimit, null);
  assert.equal(threadOnLimit(s.thread("t1")), false);
  assert.equal(threadIsFinished(s.thread("t1")), true);

  s.advance(3 * 3_600_000);
  assert.deepEqual(await s.tick(), [], "a wait fires once");
});

/**
 * A turn that had already written something carries on instead, because the
 * transcript holds that work and the model can read it. The sentence is
 * covey's own, so `system` marks it.
 */
test("a turn that had started is carried on rather than sent again", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  s.cli.wrote = "I have read the two files and started on the first.";
  await s.send("t1", "and now the docs");
  s.cli.refusal = null;
  s.cli.wrote = null;
  s.advance(9 * 3_600_000);
  await s.tick();
  const last = s.turns("t1").at(-1)!;
  assert.match(last.text, /the account had reached its usage limit/);
  assert.match(last.text, /The limit has reset/);
  assert.equal(last.system, true, "covey wrote this one, so no client paints it as the reader's");
});

/**
 * Claude Code writes the refusal twice, as an assistant message and again as
 * the error result. Without this a turn refused before its first word would
 * look like one that had started, and the model would be told to go on from a
 * point it never reached.
 */
test("the refusal itself is not work the turn did", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1", "write the tests");
  assert.ok(
    s.engine.threadSnapshot("t1").items.some((i) => i.kind === "assistant" && (i as { text: string }).text === REFUSED),
    "the fake CLI no longer reports the refusal the way Claude Code does",
  );
  s.cli.refusal = null;
  s.advance(9 * 3_600_000);
  await s.tick();
  assert.equal(s.turns("t1").at(-1)!.text, "write the tests");
});

/**
 * The record lives on the row, so the daemon that holds the thread fires it
 * from there. An hour switched off loses nothing.
 */
test("a daemon that was off still sends the work", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1", "write the tests");
  s.restart();
  s.cli.refusal = null;
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), ["t1"]);
  assert.equal(s.turns("t1").length, 2);
});

/**
 * A reader who writes first has already carried the thread on. The wait stays
 * armed and the next tick looks again, so nothing is lost and no turn lands
 * behind the one the reader is reading.
 */
test("a wait due on a working thread waits for it to stop", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  s.cli.held = true;
  s.advance(9 * 3_600_000);
  void s.send("t1", "never mind, do this instead");
  await settle();
  assert.deepEqual(await s.tick(), [], "the turn in flight was interrupted by a wait");
  assert.equal(s.thread("t1").usageLimit!.firedAt, null, "and the wait was spent on it");

  s.cli.held = false;
  s.cli.release();
  await settle();
  assert.deepEqual(await s.tick(), ["t1"], "once the thread is idle the held work goes");
});

/**
 * A turn that answered is a limit that has passed, whatever covey was waiting
 * for. The reader who writes and gets an answer has carried the thread on, and
 * a wait left on the row would send that work a second time.
 */
test("a turn that answers clears the wait", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  assert.equal(threadOnLimit(s.thread("t1")), true);
  s.cli.refusal = null;
  await s.send("t1", "never mind, do this instead");
  assert.equal(s.thread("t1").usageLimit, null);
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), []);
});

// ---- when covey cannot read a reset ------------------------------------------

test("a refusal with no time in it is backed off from, and then given up on", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = NO_TIME;
  await s.send("t1");

  for (let round = 1; round <= USAGE_LIMIT_MAX_ROUNDS; round++) {
    const limit = s.thread("t1").usageLimit!;
    assert.equal(limit.round, round);
    assert.equal(limit.resetsAt, null, "covey never claims a reset it did not read");
    assert.equal(Date.parse(limit.dueAt) - s.now(), USAGE_LIMIT_BACKOFF_MS[round - 1]!);
    s.advance(USAGE_LIMIT_BACKOFF_MS[round - 1]!);
    assert.deepEqual(await s.tick(), ["t1"], `round ${round} did not fire`);
  }

  // The work is still refused after the last round, so covey stops. The row
  // holds no wait, which is what puts the failed turn back on the reader's
  // screen: `threadNews` rings for it because nothing says covey is coming
  // back any more.
  assert.equal(s.thread("t1").usageLimit, null);
  assert.equal(threadOnLimit(s.thread("t1")), false);
  assert.equal(threadIsFinished(s.thread("t1")), false);
  assert.match(s.notes("t1").at(-1)!, new RegExp(`waited for this limit ${USAGE_LIMIT_MAX_ROUNDS} times`));
  assert.deepEqual(await s.tick(), [], "and nothing wakes it again");

  // And a reader who comes back and writes gets a fresh set of waits.
  await s.send("t1", "try again");
  assert.equal(s.thread("t1").usageLimit!.round, 1);
});

/**
 * One account is one limit, so a reset one thread read is every thread's
 * reset. Without it the second thread would spend five minutes at a time
 * finding out what the first one already knew.
 */
test("a reset one thread read is what the next thread waits for", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  s.cli.refusal = NO_TIME;
  await s.send("t2");
  assert.equal(Date.parse(s.thread("t2").usageLimit!.resetsAt!), RESET);
  assert.equal(Date.parse(s.thread("t2").usageLimit!.dueAt), RESET + USAGE_LIMIT_GRACE_MS);
});

// ---- the row the reader put away ---------------------------------------------

test("archiving takes the wait, so no turn wakes a row the reader put away", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  await s.engine.dispatch({ commandId: randomUUID(), type: "thread.archive", threadId: "t1", archived: true } as never);
  assert.equal(s.thread("t1").usageLimit, null);
  s.cli.refusal = null;
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), []);
});

test("/clear takes the wait with the conversation it belongs to", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  await s.engine.dispatch({ commandId: randomUUID(), type: "thread.clear", threadId: "t1" } as never);
  assert.equal(s.thread("t1").usageLimit, null);
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), []);
  assert.equal(s.turns("t1").length, 0, "a cleared thread has no turn to send again");
});

test("a wait with no turn behind it says so rather than never moving", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  const t1 = s.thread("t1");
  t1.usageLimit = { ...t1.usageLimit!, turnId: null };
  s.db.putThread(t1);
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), ["t1"]);
  assert.equal(s.thread("t1").usageLimit!.firedAt !== null, true, "covey came back, so the row stops saying it will");
  assert.match(s.notes("t1").at(-1)!, /no turn to send again/);
  assert.equal(threadNeedsPerson(s.thread("t1")), true, "and the row is the reader's again");
});

/**
 * The turn a background task opened (#156). No message asked for the work, so
 * there is no user item to send again and nothing the turn wrote to carry on
 * from — the refusal is the only thing in it. Covey cannot repeat that work,
 * so it must say so and give the row back: it told the reader hours earlier
 * that nothing was needed from them, and that is the sentence that makes
 * silence here worse than the red row covey left before this existed.
 */
test("a wait covey cannot send again strands nothing: it says so and gives the row back", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "write the tests");          // one ordinary turn, answered
  // A background task wakes the session, and its first word is the refusal.
  s.cli.push({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-bg", model: "opus", content: [{ type: "text", text: REFUSED }] } });
  s.cli.push({ type: "result", subtype: "error_during_execution", is_error: true, result: REFUSED, modelUsage: {}, user_message_uuid: null });
  await settle();

  const limit = s.thread("t1").usageLimit!;
  assert.equal(limit.turnId, s.thread("t1").latestTurn!.turnId);
  assert.notEqual(limit.turnId, null, "the unprompted turn has an id, so the no-turn guard never sees it");
  assert.equal(threadOnLimit(s.thread("t1")), true);

  const seen: Thread[] = [];
  s.engine.onThread((_id, ev) => { if (ev.kind === "thread.updated" && ev.thread) seen.push(ev.thread); });
  s.cli.refusal = null;
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), ["t1"]);

  assert.equal(s.turns("t1").length, 1, "covey sent a turn it had no work for");
  assert.match(s.notes("t1").at(-1)!, /no turn to send again/, "the row went quiet about it");
  // The row is the reader's again, which is what it was before this feature
  // existed and the one thing the note must not leave untrue.
  assert.equal(threadNeedsPerson(s.thread("t1")), true);
  assert.equal(s.thread("t1").status, "error");
  assert.equal(s.thread("t1").lastError, REFUSED);

  let prev = s.thread("t1");
  prev = { ...prev, status: "idle", usageLimit: limit };
  const news = seen.map((next) => { const n = threadNews(prev, next); prev = next; return n; }).filter((n) => n !== null);
  assert.ok(news.some((n) => n!.wants), `nothing asked for the reader: ${news.map((n) => n!.lead).join(", ") || "(silence)"}`);
});

test("a thread that is merely ill does not wait for anything", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = "Error: the test suite failed";
  await s.send("t1");
  assert.equal(s.thread("t1").usageLimit, undefined);
  assert.equal(threadOnLimit(s.thread("t1")), false, "a turn that merely failed is the reader's, and rings for them");
  s.advance(9 * 3_600_000);
  assert.deepEqual(await s.tick(), []);
});

test("the wait is a minute of the clock and not of the turn", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.cli.refusal = REFUSED;
  await s.send("t1");
  s.advance(8 * 3_600_000);
  assert.deepEqual(await s.tick(), [], "the grace is still owed");
  s.advance(5 * MINUTE);
  s.cli.refusal = null;
  assert.deepEqual(await s.tick(), ["t1"]);
});
