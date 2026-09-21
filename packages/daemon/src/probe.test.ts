import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread, TimelineItem } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { defaultLiveSessionLimit } from "./config.js";

/**
 * Releasing the session of an idle thread, and resuming it with its history.
 *
 * A session costs about 300 MB of resident memory, so a daemon that has run a
 * dozen threads holds gigabytes for conversations nobody reads. These tests
 * drive a whole engine against a stand-in for the CLI: no Claude subprocess
 * starts, and the clock is a variable, so a thread can be idle for an hour in
 * a millisecond.
 *
 * The stand-in mirrors transcript entries into the session store the way the
 * real CLI does, which is what makes the resume assertions mean anything: the
 * store is where a resumed session reads the conversation from.
 */

const MACHINE = (settings: Partial<MachineInfo["settings"]> = {}): MachineInfo => ({
  machineId: "m1", name: "test", os: "darwin", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null, ...settings },
});

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** One live stand-in for the CLI, and what the daemon asked it to do. */
interface FakeCli {
  options: Options;
  /** True once the engine aborted it — the same signal that kills a subprocess. */
  aborted: boolean;
  /** Put a tool call in front of the user, as `canUseTool` does on a real turn. */
  askApproval(): Promise<unknown>;
  /** Answer the turn in flight. */
  reply(text: string): void;
}

/** An engine whose sessions are stand-ins, and whose clock the test moves. */
function setup(settings: Partial<MachineInfo["settings"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "covey-evict-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let clock = Date.parse("2026-01-01T12:00:00Z");
  const clis: FakeCli[] = [];
  const engine = new Engine(db, MACHINE(settings), {
    now: () => clock,
    spawn: ({ prompt, options }) => {
      const cli = makeCli(prompt, options);
      clis.push(cli);
      return cli.query;
    },
  });
  return {
    db, engine, dir, clis,
    /** Move the clock on, in minutes. */
    advance: (minutes: number) => { clock += minutes * 60_000; },
    newThread(id: string) { db.putThread(thread(id)); return id; },
    async send(threadId: string, text: string) {
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text });
      await settle();
    },
    notes(threadId: string): string[] {
      return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text);
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Let the engine's queued microtasks and the session's pump run. */
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * A stand-in for one CLI subprocess. It reads the input stream, writes what it
 * is told into the session store (the CLI's own transcript mirror), and replies
 * when the test says so.
 */
function makeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options): FakeCli & { query: Query } {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
  const sessionId = (options.resume ?? options.sessionId)!;
  const key = { sessionId, projectKey: "", subpath: "" };

  const cli: FakeCli & { query: Query } = {
    options,
    aborted: false,
    query: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (done) return;
          if (out.length === 0) { await new Promise<void>((r) => (wake = r)); continue; }
          yield out.shift() as never;
        }
      },
      supportedCommands: async () => [],
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      backgroundTasks: async () => true,
    } as unknown as Query,
    async askApproval() {
      return options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu1" } as never);
    },
    reply(text: string) {
      const id = `msg-${randomUUID()}`;
      void options.sessionStore!.append(key, [{ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text }] } }] as never);
      push({ type: "assistant", parent_tool_use_id: null, message: { id, model: "opus", content: [{ type: "text", text }] } });
      push({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: {}, user_message_uuid: null });
    },
  };

  options.abortController?.signal.addEventListener("abort", () => { cli.aborted = true; done = true; wake?.(); });
  // Every user message lands in the transcript first, exactly as the CLI mirrors
  // it, so a later resume can read the conversation back out of the store.
  void (async () => {
    for await (const m of prompt) {
      const blocks = (m.message.content ?? []) as { type: string; text?: string }[];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      await options.sessionStore!.append(key, [{ type: "user", uuid: randomUUID(), message: { role: "user", content: text } }] as never);
    }
  })();
  return cli;
}

/** What the session store holds for a thread, as the SDK would read it. */
async function transcript(cli: FakeCli): Promise<string> {
  const rows = await cli.options.sessionStore!.load({ sessionId: (cli.options.resume ?? cli.options.sessionId)!, projectKey: "", subpath: "" });
  return JSON.stringify(rows ?? []);
}

// ---- the timer ------------------------------------------------------------

test("a session idle past the limit is stopped, and the thread says so", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.reply("hi");
  await settle();
  assert.equal(s.engine.sessionCensus().live, 1);

  s.advance(16);
  assert.deepEqual(s.engine.sweepSessions(), ["t1"]);
  assert.equal(s.engine.sessionCensus().live, 0);
  // The abort is what ends the subprocess; a real one dies with it (measured).
  assert.equal(s.clis[0]!.aborted, true);
  const note = s.notes("t1").find((n) => n.includes("Released"));
  assert.match(note ?? "", /16 minutes idle/);
  assert.match(note ?? "", /resumes the transcript/);
});

test("a session inside the limit is left alone", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.reply("hi");
  await settle();
  s.advance(14);
  assert.deepEqual(s.engine.sweepSessions(), []);
  assert.equal(s.engine.sessionCensus().live, 1);
});

test("a machine can keep its sessions for ever with a limit of zero", async (t) => {
  const s = setup({ sessionIdleMinutes: 0 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.reply("hi");
  await settle();
  s.advance(60 * 24);
  assert.deepEqual(s.engine.sweepSessions(), []);
  assert.equal(s.engine.sessionCensus().live, 1);
});

// ---- the one that matters: a resume is lossless ---------------------------

test("the next message resumes the released session with the conversation intact", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "the code word is quokka");
  s.clis[0]!.reply("noted");
  await settle();
  const before = await transcript(s.clis[0]!);
  assert.match(before, /quokka/, "the first turn is in the session store");

  s.advance(20);
  s.engine.sweepSessions();
  await s.send("t1", "what was the code word?");
  assert.equal(s.clis.length, 2, "the turn started a second session");

  const resumed = s.clis[1]!;
  // This is what "lossless" means at this layer: the new process is told to
  // resume the same session id, and what it reads back holds the whole
  // conversation — both earlier messages and the new one.
  assert.equal(resumed.options.resume, "sess-t1");
  assert.equal(resumed.options.sessionId, undefined);
  const after = await transcript(resumed);
  assert.match(after, /the code word is quokka/);
  assert.match(after, /noted/);
  assert.match(after, /what was the code word\?/);
  // And the reader is told where the extra wait comes from.
  assert.ok(s.notes("t1").some((n) => /Resumed this thread's Claude session/.test(n)));
});

// ---- what must never be released ------------------------------------------

test("a running turn is never released, however long it runs", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "read every file in the repository");
  // No reply: the turn is still in flight.
  s.advance(90);
  assert.deepEqual(s.engine.sweepSessions(), []);
  assert.equal(s.engine.sessionCensus().live, 1);
  assert.equal(s.clis[0]!.aborted, false);

  // Once it answers, the same thread is releasable again.
  s.clis[0]!.reply("done");
  await settle();
  s.advance(16);
  assert.deepEqual(s.engine.sweepSessions(), ["t1"]);
});

test("a thread that waits on an approval is never released", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "list the files");
  void s.clis[0]!.askApproval();
  await settle();
  assert.equal(s.db.getThread("t1")!.status, "waiting");
  assert.equal(s.db.getThread("t1")!.pendingApprovals, 1);

  // A user who leaves the approval on screen over lunch still has a session
  // to answer with when they come back.
  s.advance(120);
  assert.deepEqual(s.engine.sweepSessions(), []);
  assert.equal(s.engine.sessionCensus().live, 1);
  assert.equal(s.clis[0]!.aborted, false);
});

test("a thread that waits on a question is never released", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "which database?");
  void s.clis[0]!.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Postgres or SQLite?", options: [] }] }, { signal: new AbortController().signal, toolUseID: "tu2" } as never);
  await settle();
  assert.equal(s.db.getThread("t1")!.status, "waiting");

  s.advance(120);
  assert.deepEqual(s.engine.sweepSessions(), []);
  assert.equal(s.clis[0]!.aborted, false);
});

// ---- the budget -----------------------------------------------------------

test("over the budget, the least recently used session goes", async (t) => {
  const s = setup({ sessionIdleMinutes: 0, maxLiveSessions: 2 });
  t.after(s.cleanup);
  for (const id of ["t1", "t2", "t3"]) s.newThread(id);
  await s.send("t1", "one");
  s.clis[0]!.reply("ok");
  await settle();
  s.advance(5);
  await s.send("t2", "two");
  s.clis[1]!.reply("ok");
  await settle();
  s.advance(5);
  assert.equal(s.engine.sessionCensus().live, 2);

  // The third thread starts a session, which puts the machine over its budget.
  await s.send("t3", "three");
  assert.equal(s.engine.sessionCensus().live, 2);
  assert.equal(s.clis[0]!.aborted, true, "t1 worked longest ago");
  assert.equal(s.clis[1]!.aborted, false);
  assert.ok(s.notes("t1").some((n) => /keeps 2 sessions live/.test(n)));
});

test("the budget skips a busy session and takes the next oldest", async (t) => {
  const s = setup({ sessionIdleMinutes: 0, maxLiveSessions: 2 });
  t.after(s.cleanup);
  for (const id of ["t1", "t2", "t3"]) s.newThread(id);
  // t1 is the oldest, but its turn is still running.
  await s.send("t1", "one");
  s.advance(5);
  await s.send("t2", "two");
  s.clis[1]!.reply("ok");
  await settle();
  s.advance(5);
  await s.send("t3", "three");

  assert.equal(s.clis[0]!.aborted, false, "the running turn survives the budget");
  assert.equal(s.clis[1]!.aborted, true);
  assert.equal(s.engine.sessionCensus().live, 2);
});

test("a machine whose turns all run at once goes over its budget rather than break one", async (t) => {
  const s = setup({ sessionIdleMinutes: 0, maxLiveSessions: 1 });
  t.after(s.cleanup);
  for (const id of ["t1", "t2"]) s.newThread(id);
  await s.send("t1", "one");
  await s.send("t2", "two");
  assert.equal(s.engine.sessionCensus().live, 2);
  assert.equal(s.clis[0]!.aborted, false);
  assert.equal(s.clis[1]!.aborted, false);
});

// ---- settings -------------------------------------------------------------

test("a lower limit applies to the sessions already live", async (t) => {
  const s = setup({ sessionIdleMinutes: 0, maxLiveSessions: 4 });
  t.after(s.cleanup);
  for (const id of ["t1", "t2"]) s.newThread(id);
  await s.send("t1", "one");
  s.clis[0]!.reply("ok");
  await settle();
  s.advance(1);
  await s.send("t2", "two");
  s.clis[1]!.reply("ok");
  await settle();

  const home = mkdtempSync(join(tmpdir(), "covey-home-"));
  process.env.COVEY_HOME = home;
  t.after(() => { delete process.env.COVEY_HOME; rmSync(home, { recursive: true, force: true }); });
  await s.engine.dispatch({ commandId: randomUUID(), type: "machine.settings", maxLiveSessions: 1 });
  assert.equal(s.engine.sessionCensus().live, 1);
  assert.equal(s.clis[0]!.aborted, true);
});

test("the default budget follows the size of the machine", () => {
  const gb = 1024 ** 3;
  assert.equal(defaultLiveSessionLimit(2 * gb), 2, "a small board still keeps two");
  assert.equal(defaultLiveSessionLimit(8 * gb), 4);
  assert.equal(defaultLiveSessionLimit(24 * gb), 8, "and a large machine is still capped");
});

test("the timeline keeps the note about the released session", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.reply("hi");
  await settle();
  s.advance(20);
  s.engine.sweepSessions();
  const items = s.engine.threadSnapshot("t1").items;
  const note = items.find((i: TimelineItem) => i.kind === "note") as { tone: string; text: string } | undefined;
  assert.equal(note?.tone, "info");
  assert.match(note?.text ?? "", /nothing is lost/);
});

// ---- PROBE: interrupt ------------------------------------------------------

test("PROBE: an interrupted session can still be released", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "read every file");
  await settle();
  await s.engine.dispatch({ commandId: randomUUID(), type: "turn.interrupt", threadId: "t1" });
  await settle();
  const th = s.db.getThread("t1")!;
  console.log("PROBE after interrupt: status=", th.status, "latestTurn=", th.latestTurn?.state, "pendingApprovals=", th.pendingApprovals, "live=", s.engine.sessionCensus().live);
  s.advance(20);
  const rel = s.engine.sweepSessions();
  console.log("PROBE sweep released:", JSON.stringify(rel));
  assert.deepEqual(rel, ["t1"], "an interrupted, idle session must be releasable");
});

test("PROBE: a stale result after interrupt does not unpin a new running turn", async (t) => {
  const s = setup({ sessionIdleMinutes: 15 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "one");
  await settle();
  await s.engine.dispatch({ commandId: randomUUID(), type: "turn.interrupt", threadId: "t1" });
  await settle();
  // the interrupted CLI now reports the result of the turn it abandoned
  s.clis[0]!.reply("aborted");
  await settle();
  console.log("PROBE stale-result: status=", s.db.getThread("t1")!.status, "live=", s.engine.sessionCensus().live);
  s.advance(20);
  console.log("PROBE stale-result sweep:", JSON.stringify(s.engine.sweepSessions()));
});
