/**
 * A thread's own timer, driven through a whole engine.
 *
 * An agent that starts work it cannot watch — a build, a deploy, a test run on
 * another machine — had no honest way to be woken when that work ended. It
 * guessed: a watcher on a process that was not the right one, a poll inside
 * the turn, a background task whose end is not the end of the work. So it asks
 * covey for a turn at a time instead, and this file holds what covey owes it:
 * one turn, once, from the row, whatever the daemon did in between.
 *
 * The clock is a variable and the CLI is an auto-reply, so no Claude
 * subprocess starts and every turn a timer sends is answered at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TIMER_MAX_MS, TIMER_MIN_MS, threadIsFinished, threadOnTimer, type MachineInfo, type Project, type Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { autoReply, fakeCli, settle } from "./claudeFake.js";
import { MAX_TIMER_NOTE, TIMER_PREFIX, timerCommandArg, timerNoteText, timerTurn } from "./timer.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

const MINUTE = 60_000;

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-timer-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const cli = fakeCli();
  const make = (database: Db) => new Engine(database, { ...MACHINE }, { now: () => clock, spawn: autoReply(cli) });
  const engines: Engine[] = [];
  let engine = make(db);
  engines.push(engine);
  return {
    db, dir, cli,
    get engine() { return engine; },
    hold() { cli.held = true; },
    async release() { cli.held = false; cli.release(); cli.release = () => {}; await settle(); },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    newThread(id: string) { db.putThread(thread(id)); return id; },
    async command(cmd: Record<string, unknown>) {
      return engine.dispatch({ commandId: randomUUID(), ...cmd } as never);
    },
    async set(threadId: string, ms: number | null, note?: string) {
      return this.command({ type: "thread.timer", threadId, ms, ...(note === undefined ? {} : { note }) });
    },
    /** One tick of the daemon's own interval. */
    async tick() {
      const fired = await engine.fireTimers();
      await settle();
      return fired;
    },
    thread(id: string): Thread { return db.getThread(id)!; },
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

// ---- setting one ------------------------------------------------------------

test("a timer goes on the row, with a note the reader can read", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 10 * MINUTE, "the CI run on main");
  const timer = s.thread("t1").timer!;
  assert.equal(timer.everyMs, 10 * MINUTE);
  assert.equal(timer.note, "the CI run on main");
  assert.equal(timer.firedAt, null);
  assert.equal(timer.round, 1);
  assert.equal(Date.parse(timer.dueAt) - Date.parse(timer.setAt), 10 * MINUTE);
  assert.match(s.notes("t1")[0]!, /Timer set for 10m/);
  assert.match(s.notes("t1")[0]!, /the CI run on main/);
  // The thread is waiting on covey, not on the reader. A `✓` here would send
  // the reader to a conversation with nothing in it to do.
  assert.equal(threadOnTimer(s.thread("t1")), true);
});

/**
 * The bounds are the daemon's and not only the CLI's. A client is not to be
 * trusted with them, and a timer quietly clamped is a timer the agent waits
 * the wrong length for with nothing on screen to say so.
 */
test("a time outside the bounds is refused by name, and sets nothing", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  for (const ms of [0, 30_000, TIMER_MIN_MS - 1, TIMER_MAX_MS + 1, 24 * 3_600_000, Number.NaN]) {
    await assert.rejects(() => s.set("t1", ms), (e: EngineError) => {
      assert.equal(e.code, "bad_timer");
      assert.match(e.message, /between 1m and 6h/);
      return true;
    }, `${ms} was accepted`);
  }
  assert.equal(s.thread("t1").timer, undefined);
  await s.set("t1", TIMER_MIN_MS);
  await s.set("t1", TIMER_MAX_MS);
  assert.equal(s.thread("t1").timer!.everyMs, TIMER_MAX_MS, "the bounds themselves are allowed");
});

/**
 * One timer per thread. A thread waiting on two things is waiting on the later
 * of them, and there is nothing a reader could read in a list of them — so a
 * second set replaces the first and carries the chain on.
 */
test("a second timer replaces the first, and the chain counts", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 10 * MINUTE, "the build");
  s.advance(MINUTE);
  await s.set("t1", 2 * MINUTE, "the build, checked sooner");
  const timer = s.thread("t1").timer!;
  assert.equal(timer.everyMs, 2 * MINUTE);
  assert.equal(timer.round, 2);
  assert.equal(timer.note, "the build, checked sooner");
  assert.equal(Date.parse(timer.dueAt), s.now() + 2 * MINUTE, "the replacement runs from now, not from the first one");
});

test("clearing a timer takes it off the row, and clearing none is refused", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await assert.rejects(() => s.set("t1", null), (e: EngineError) => e.code === "no_timer");
  await s.set("t1", 10 * MINUTE);
  await s.set("t1", null);
  assert.equal(s.thread("t1").timer, null);
  assert.match(s.notes("t1").at(-1)!, /Timer cleared/);
  await s.set("t1", 10 * MINUTE);
  assert.equal(s.thread("t1").timer!.round, 1, "a cleared timer breaks the chain");
});

// ---- firing -----------------------------------------------------------------

test("the timer fires once, as a turn covey wrote itself", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 10 * MINUTE, "the CI run on main");

  s.advance(9 * MINUTE);
  assert.deepEqual(await s.tick(), [], "a timer that is not due wakes nothing");
  assert.equal(s.turns("t1").length, 0);

  s.advance(MINUTE);
  assert.deepEqual(await s.tick(), ["t1"]);
  const turns = s.turns("t1");
  assert.equal(turns.length, 1);
  assert.ok(turns[0]!.text.startsWith(TIMER_PREFIX), turns[0]!.text);
  assert.match(turns[0]!.text, /the CI run on main/, "the turn never says what the thread was waiting for");
  assert.match(turns[0]!.text, /covey timer 10m/, "the turn never says how to wait again");
  // Covey wrote this message, so every client paints it as covey's own and not
  // as the reader's. The wire refuses the claim from a client; this is the
  // daemon making it.
  assert.equal(turns[0]!.system, true);

  // Fired, and still on the row: the next timer reads the chain off it, and
  // `covey timer` can say when the last one went off to the very agent that
  // is reading the turn it sent.
  const timer = s.thread("t1").timer!;
  assert.equal(timer.firedAt, new Date(s.now()).toISOString());
  assert.equal(threadOnTimer(s.thread("t1")), false);

  s.advance(10 * MINUTE);
  assert.deepEqual(await s.tick(), [], "a timer fires once");
  assert.equal(s.turns("t1").length, 1);
});

/**
 * A thread that is working does not need waking. So the timer stays due and
 * the next tick tries again: nothing is lost, and a turn asking "is that build
 * done yet?" never lands behind one the reader is reading.
 */
test("a timer due while the thread works waits for it to stop", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", MINUTE);
  s.hold();
  await s.command({ type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "hello" });
  await settle();
  s.advance(2 * MINUTE);
  assert.deepEqual(await s.tick(), [], "the thread is busy");
  assert.equal(s.thread("t1").timer!.firedAt, null);
  await s.release();
  assert.deepEqual(await s.tick(), ["t1"], "and fires the moment it is idle");
  assert.equal(s.turns("t1").filter((x) => x.system).length, 1);
});

/**
 * The timer lives in the thread's row, so a daemon that restarted — or was off
 * for an hour — fires it from the row and re-arms nothing. That is the whole
 * reason it is not a `setTimeout`.
 */
test("a restart fires a timer that came due while the daemon was gone", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 30 * MINUTE, "the deploy");
  s.restart();
  s.advance(2 * 3_600_000);
  assert.deepEqual(await s.tick(), ["t1"]);
  assert.match(s.turns("t1")[0]!.text, /30m \(2h has passed\)/, "the turn never says how long really went by");
});

/**
 * "I am done here" is what archiving says, and a timer would answer it with a
 * turn. The record goes rather than waits, so a thread brought back a day
 * later does not meet a timer that came due while it was away.
 */
test("archiving clears the timer, and an archived thread refuses one", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 10 * MINUTE);
  await s.command({ type: "thread.archive", threadId: "t1", archived: true });
  assert.equal(s.thread("t1").timer, null);
  await assert.rejects(() => s.set("t1", 10 * MINUTE), (e: EngineError) => e.code === "archived");
  s.advance(3_600_000);
  assert.deepEqual(await s.tick(), []);
  assert.equal(s.turns("t1").length, 0);
});

/**
 * A clear empties the conversation, and the timer is part of it: what the
 * timer was for was written in the transcript this has just emptied, so the
 * turn it would send names work the session has no memory of starting.
 */
test("clearing the conversation clears the timer with it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.set("t1", 10 * MINUTE, "the deploy");
  await s.command({ type: "thread.clear", threadId: "t1" });
  assert.equal(s.thread("t1").timer, null);
  s.advance(3_600_000);
  assert.deepEqual(await s.tick(), []);
});

/** Each timer that fires starts a session of about 250 MB. Ten of them must
 *  not be ten processes starting together. */
test("timers that come due together are woken one at a time", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  for (const id of ["t1", "t2", "t3"]) { s.newThread(id); await s.set(id, MINUTE); }
  s.advance(2 * MINUTE);
  assert.deepEqual((await s.tick()).sort(), ["t1", "t2", "t3"]);
  for (const id of ["t1", "t2", "t3"]) assert.equal(s.turns(id).length, 1, id);
});

// ---- what the turn says -----------------------------------------------------

const timer = (over: Partial<Thread["timer"] & object> = {}) => ({
  note: null, everyMs: 10 * MINUTE, setAt: "2026-11-14T10:00:00Z",
  dueAt: "2026-11-14T10:10:00Z", firedAt: null, round: 1, ...over,
});
const NOW = Date.parse("2026-11-14T10:10:00Z");

/**
 * The one thing covey has to spell out. A timer fires once, so an agent that
 * reads this turn, finds the work still running and stops the turn without
 * setting another timer is a thread nothing will ever wake again.
 */
test("the turn names both moves, and that a timer fires once", () => {
  const text = timerTurn(timer({ note: "the nightly build" }), NOW);
  assert.match(text, /the nightly build/);
  assert.match(text, /It has finished/);
  assert.match(text, /It is still running/);
  assert.match(text, /covey timer 10m/);
  assert.match(text, /fires once/);
  assert.match(text, /Do not poll in a loop/);
  assert.doesNotMatch(text, /in a row/, "one timer is not a chain");
});

test("the turn says so when the thread has waited several times over", () => {
  assert.match(timerTurn(timer({ round: 11 }), NOW), /timer 11 in a row/);
  assert.match(timerTurn(timer({ round: 11 }), NOW), /tell the reader/);
});

test("a timer set with no note says to look back, rather than naming nothing", () => {
  assert.match(timerTurn(timer(), NOW), /no note/);
});

/** The length as an argument, not as a label: `timerLabel` puts a space in the
 *  compound form, which reads well in a row and is two arguments in a shell. */
test("the length the turn offers back is one argument", () => {
  assert.equal(timerCommandArg(90 * MINUTE), "1h30m");
  assert.equal(timerCommandArg(10 * MINUTE), "10m");
});

/** One line beside a title on three screens, and on every snapshot of the
 *  thread. A pasted paragraph would push the time left off a phone's row. */
test("a note is one line, trimmed, and bounded", () => {
  assert.equal(timerNoteText("  the   CI\nrun  "), "the CI run");
  assert.equal(timerNoteText(""), null);
  assert.equal(timerNoteText(undefined), null);
  assert.equal(timerNoteText("x".repeat(500))!.length, MAX_TIMER_NOTE);
});

/**
 * A thread on a timer is not the reader's again, any more than a thread under
 * review is. It stopped its turn on purpose, with work running somewhere else
 * and covey holding the only thing that will wake it.
 */
test("a thread on a timer is not finished, and one whose timer fired is", () => {
  const base = { ...thread("t1"), latestTurn: { turnId: "x", state: "completed" as const, startedAt: "", completedAt: "" } } as Thread;
  assert.equal(threadIsFinished(base), true);
  assert.equal(threadIsFinished({ ...base, timer: timer() }), false);
  assert.equal(threadIsFinished({ ...base, timer: timer({ firedAt: "2026-11-14T10:10:00Z" }) }), true);
  assert.equal(threadOnTimer({ ...base, timer: timer(), archivedAt: "2026-11-14T10:00:00Z" }), false);
  assert.equal(threadOnTimer({ ...base, timer: timer(), status: "running" }), false, "a working thread shows its work, not its timer");
});
