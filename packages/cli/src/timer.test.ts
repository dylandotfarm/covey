/**
 * `covey timer`, the shell face of the timer.
 *
 * Two halves, as `loop.test.ts` has. The parser is pure, so each spelling an
 * agent might write is proven to ask for the right thing with no daemon. The
 * transport is proven against a stand-in daemon on loopback, so the test reads
 * that the thread went into `hello` and that one command carried the time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { Thread } from "@covey/protocol";
import { LOOP_CLIENT } from "./loop.js";
import { describeTimer, parseTimerArgs, runTimer, TIMER_USAGE } from "./timer.js";

const requestOf = (argv: string[]) => { const r = parseTimerArgs(argv); assert.ok("request" in r, `${argv.join(" ")}: ${JSON.stringify(r)}`); return r.request; };
const request = (line: string) => requestOf(line.split(" "));
const error = (line: string) => { const r = parseTimerArgs(line.split(" ")); assert.ok("error" in r, `${line} parsed`); return r.error; };

const MINUTE = 60_000;

test("each spelling asks for what it says", () => {
  assert.deepEqual(request("timer 10m"), { kind: "set", ms: 10 * MINUTE, note: null });
  assert.deepEqual(request("timer 90s"), { kind: "set", ms: 90_000, note: null });
  assert.deepEqual(request("timer 2h"), { kind: "set", ms: 2 * 3_600_000, note: null });
  assert.deepEqual(request("timer 20"), { kind: "set", ms: 20 * MINUTE, note: null }, "a bare number is minutes");
  assert.deepEqual(requestOf(["timer", "10m", "--note", "the CI run on main"]),
    { kind: "set", ms: 10 * MINUTE, note: "the CI run on main" });
  assert.deepEqual(request("timer stop"), { kind: "stop" });
  assert.deepEqual(request("timer clear"), { kind: "stop" }, "the other word a reader would reach for");
  assert.deepEqual(request("timer"), { kind: "status" });
  assert.deepEqual(request("timer status"), { kind: "status" });
});

/**
 * A shell splits on the space, and `1h 30m` is one time an agent will write
 * that way. The flags covey itself takes are not part of the time.
 */
test("a time written in two words is one time, and a flag is not part of it", () => {
  assert.deepEqual(request("timer 1h 30m"), { kind: "set", ms: 90 * MINUTE, note: null });
  assert.deepEqual(requestOf(["timer", "10m", "--thread", "t-1", "--port", "3799"]),
    { kind: "set", ms: 10 * MINUTE, note: null });
  assert.deepEqual(requestOf(["timer", "--note", "the build", "45m"]),
    { kind: "set", ms: 45 * MINUTE, note: "the build" }, "the flag may come first");
});

test("a bad spelling is a sentence, not a stack", () => {
  assert.match(error("timer soon"), /is not a time/);
  assert.match(error("timer 10 minutes or so"), /is not a time/);
  assert.match(error("timer 30s"), /shorter than a timer may be/);
  assert.match(error("timer 8h"), /longer than a timer may be/);
  assert.match(error("timer stop now"), /takes nothing after it/);
  assert.match(error("timer 10m --note"), /--note needs one line/);
});

/** The usage names both ends of the range and that a timer fires once: an
 *  agent that read neither would set a timer it cannot have, or wait for a
 *  second one that is not coming. */
test("the usage says the range and the one rule", () => {
  assert.match(TIMER_USAGE, /one minute at the shortest and 6h at the\s+longest/);
  assert.match(TIMER_USAGE, /fires once/);
  assert.match(TIMER_USAGE, /covey timer stop/);
});

// ---- the transport ---------------------------------------------------------

interface FakeDaemon { port: number; calls: { method: string; params: any }[]; close(): void; answer: (method: string, params: any) => unknown }

function fakeDaemon(): Promise<FakeDaemon> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const d: FakeDaemon = { port: 0, calls: [], close: () => wss.close(), answer: () => null };
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        d.calls.push({ method: m.method, params: m.params });
        try {
          const result = m.method === "hello" ? { machineId: "m1" } : d.answer(m.method, m.params);
          ws.send(JSON.stringify({ id: m.id, ok: true, result }));
        } catch (e: any) {
          ws.send(JSON.stringify({ id: m.id, ok: false, error: { code: "x", message: e.message } }));
        }
      });
    });
    wss.on("listening", () => { d.port = (wss.address() as { port: number }).port; resolve(d); });
  });
}

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t-1", projectId: "p1", title: "t", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z",
  ...over,
});

test("the thread goes into hello, and the time goes in one command", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => ({ seq: 1 });
  const env = { threadId: "t-1", port: d.port };

  const set = await runTimer({ kind: "set", ms: 10 * MINUTE, note: "the CI run" }, env);
  assert.equal(set.ok, true);
  assert.deepEqual(d.calls[0], { method: "hello", params: { protocolVersion: 1, client: LOOP_CLIENT, threadId: "t-1" } });
  assert.equal(d.calls[1]!.method, "command");
  assert.equal(d.calls[1]!.params.type, "thread.timer");
  assert.equal(d.calls[1]!.params.ms, 10 * MINUTE);
  assert.equal(d.calls[1]!.params.note, "the CI run");
  // The last line is the one that matters: a timer is for ending the turn, and
  // an agent that set one and went on polling has used none of the feature.
  assert.match(set.lines[0]!, /wakes this thread with a turn in 10m/);
  assert.match(set.lines.at(-1)!, /stop the turn now/i);
  assert.match(set.lines.join(" "), /fires once/);
});

test("stop clears it, and says what that means", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => ({ seq: 1 });
  const out = await runTimer({ kind: "stop" }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, true);
  assert.equal(d.calls[1]!.params.ms, null);
  assert.match(out.lines[0]!, /nothing will wake this thread/i);
});

test("a daemon that refuses is one sentence, and the exit code says so", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => { throw new Error("this thread is archived, so a timer would wake a thread the reader put away"); };
  const out = await runTimer({ kind: "set", ms: 10 * MINUTE, note: null }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, false);
  assert.match(out.lines[0]!, /archived/);
});

test("no thread and no daemon are each a sentence naming what is missing", async () => {
  const none = await runTimer({ kind: "status" }, { threadId: undefined, port: 3790 });
  assert.equal(none.ok, false);
  assert.match(none.lines[0]!, /COVEY_THREAD_ID/);
  const dead = await runTimer({ kind: "status" }, { threadId: "t-1", port: 1 });
  assert.equal(dead.ok, false);
  assert.match(dead.lines[0]!, /no covey daemon answers on port 1/);
});

// ---- what the status says --------------------------------------------------

const NOW = Date.parse("2026-11-14T10:03:00Z");
const timer = (over: Partial<NonNullable<Thread["timer"]>> = {}) => ({
  note: null, lengthMs: 10 * MINUTE, setAt: "2026-11-14T10:00:00Z",
  dueAt: "2026-11-14T10:10:00Z", firedAt: null, round: 1, ...over,
});

test("the status says how long is left, and to stop the turn", () => {
  const lines = describeTimer(thread({ timer: timer({ note: "the deploy" }) }), NOW).join("\n");
  assert.match(lines, /7m left of 10m/);
  assert.match(lines, /waiting for: the deploy/);
  assert.match(lines, /Stop the turn/);
});

/**
 * The agent reading this is very often the one the timer woke. "No timer"
 * there would read as covey having lost the thing that woke it, and send the
 * agent looking for a bug in the feature it is using correctly.
 */
test("a timer that has fired is still named, and says to set another", () => {
  const lines = describeTimer(thread({ timer: timer({ firedAt: "2026-11-14T10:01:00Z", note: "the deploy" }) }), NOW).join("\n");
  assert.match(lines, /fired 2m ago/);
  assert.match(lines, /no timer is running now/);
  assert.match(lines, /the deploy/);
  assert.match(lines, /Set another one/);
});

test("no timer says so, and says how to set one", () => {
  const lines = describeTimer(thread(), NOW).join("\n");
  assert.match(lines, /no timer/);
  assert.match(lines, /covey timer 10m/);
});

test("a chain of timers is counted on the status, so a loop can be seen", () => {
  assert.match(describeTimer(thread({ timer: timer({ round: 9 }) }), NOW).join("\n"), /timer 9 in a row/);
  assert.doesNotMatch(describeTimer(thread({ timer: timer() }), NOW).join("\n"), /in a row/);
});
