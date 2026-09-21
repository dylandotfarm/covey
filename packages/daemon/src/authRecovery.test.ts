import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

/**
 * What the daemon does when the credentials fail, not the work.
 *
 * Every session on a machine reads one credential store and then holds its
 * access token in memory. A refresh anywhere rotates that token and the server
 * revokes the old one, so a session that was live across the rotation answers
 * every later message with `401 OAuth access token has been revoked` — a
 * thread that cannot be typed out of, because an SDK session has no `/login`.
 *
 * These tests drive a whole engine against a stand-in for the CLI, so the
 * failure is a line in a test rather than a revoked account.
 */

const AUTH_ERROR = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

const MACHINE = (): MachineInfo => ({
  machineId: "m1", name: "test", os: "darwin", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

function thread(id: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * One stand-in for a CLI subprocess. Smaller than the one in
 * `sessionEviction.test.ts` on purpose: these tests need what the daemon said
 * to each process and how each one failed, and nothing else.
 */
interface FakeCli {
  options: Options;
  /** Everything the daemon has sent this process, in order. */
  prompts: string[];
  /** True once the engine aborted it — the signal that kills a subprocess. */
  aborted: boolean;
  /** Write a line without ending the turn. */
  say(text: string): void;
  /** End the turn the way an API error ends it. */
  fail(error: string): void;
  /** End the turn the way an answer ends it. */
  finish(text: string): void;
}

function makeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options): FakeCli & { query: Query } {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };

  const cli: FakeCli & { query: Query } = {
    options,
    prompts: [],
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
    say(text: string) {
      push({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: "opus", content: [{ type: "text", text }] } });
    },
    fail(error: string) {
      push({ type: "result", subtype: "error_during_execution", is_error: true, result: error, modelUsage: {}, user_message_uuid: null });
    },
    finish(text: string) {
      cli.say(text);
      push({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: {}, user_message_uuid: null });
    },
  };

  options.abortController?.signal.addEventListener("abort", () => { cli.aborted = true; done = true; wake?.(); });
  void (async () => {
    for await (const m of prompt) {
      const blocks = (m.message.content ?? []) as { type: string; text?: string }[];
      cli.prompts.push(typeof m.message.content === "string" ? m.message.content : blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
    }
  })();
  return cli;
}

/**
 * Let the engine's queued microtasks, the session pump and the restart run.
 *
 * A restart is a timer, then a new session, then the prompt that goes to it,
 * and each step is its own turn of the loop. A fixed number of turns is
 * therefore a race: it passed here every time and failed on a loaded runner,
 * with the second process made and its prompt not yet sent. So a caller that
 * waits for a step gives the step, and this waits for it to happen.
 */
const settle = async (ok?: () => boolean, ms = 10_000) => {
  for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
  if (!ok) return;
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

/** The prompt a restarted process was given, once it has one. */
const restarted = (clis: { prompts: string[] }[], n: number) => () => (clis[n]?.prompts.length ?? 0) > 0;

function setup(stamps: (string | null)[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "covey-auth-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const clis: (FakeCli & { query: Query })[] = [];
  const engine = new Engine(db, MACHINE(), {
    spawn: ({ prompt, options }) => {
      const cli = makeCli(prompt, options);
      clis.push(cli);
      return cli.query;
    },
    credentialStamp: async () => (stamps.length > 1 ? stamps.shift()! : stamps[0] ?? null),
  });
  return {
    db, engine, dir, clis,
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

// ---- the failure, and the restart -----------------------------------------

test("a turn that dies on the credentials loses its process, and a new one goes on", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "review the diff");
  s.clis[0]!.say("I read the diff.");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle(restarted(s.clis, 1));

  // The process that holds the dead token is gone, not reused.
  assert.equal(s.clis[0]!.aborted, true);
  assert.equal(s.clis.length, 2, "a second process took the work");
  assert.equal(s.clis[1]!.prompts.length, 1);
  assert.match(s.clis[1]!.prompts[0]!, /Go on from the point where it stopped/);
  assert.ok(s.notes("t1").some((n) => n.includes("could not authenticate") && n.includes("starts a new one")), s.notes("t1").join(" | "));
  assert.equal(s.engine.sessionCensus().live, 1);
});

test("a turn that died before its first word is sent again, word for word", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "count the open PRs");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle(restarted(s.clis, 1));

  assert.equal(s.clis.length, 2);
  assert.deepEqual(s.clis[1]!.prompts, ["count the open PRs"], "\"go on\" means nothing to a model that never started");
});

test("one restart, not two: the second failure names the command that fixes it", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle(restarted(s.clis, 1));
  assert.equal(s.clis.length, 2);

  s.clis[1]!.fail(AUTH_ERROR);
  await settle();
  assert.equal(s.clis.length, 2, "a thread must not talk to itself while the credentials stay broken");
  assert.ok(s.notes("t1").some((n) => n.includes("twice in a row") && n.includes("claude auth login")), s.notes("t1").join(" | "));
  assert.equal(s.engine.sessionCensus().live, 0);
});

test("a turn that answers gives the thread its restart back", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "one");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle(restarted(s.clis, 1));
  s.clis[1]!.finish("done");
  await settle();

  await s.send("t1", "two");
  s.clis[1]!.fail(AUTH_ERROR);
  await settle(restarted(s.clis, 2));
  assert.equal(s.clis.length, 3, "the next rotation is a new fault, and gets its own restart");
});

test("a failure that is not about the credentials leaves the session alone", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.fail("API Error: 500 Internal server error");
  await settle();

  assert.equal(s.clis.length, 1, "nothing was restarted");
  assert.equal(s.clis[0]!.aborted, false);
  assert.equal(s.engine.sessionCensus().live, 1);
});

// ---- the siblings ---------------------------------------------------------

test("the sessions that hold the same credentials are stopped before a user meets the 401", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();
  await s.send("t2", "hello");
  s.clis[1]!.finish("hi");
  await settle();
  assert.equal(s.engine.sessionCensus().live, 2);

  await s.send("t1", "again");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle(() => s.clis[1]!.aborted);

  assert.equal(s.clis[1]!.aborted, true, "the idle sibling holds the same dead token");
  assert.ok(s.notes("t2").some((n) => n.includes("same credentials")), s.notes("t2").join(" | "));
});

test("a sibling in the middle of a turn keeps its session", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();
  await s.send("t2", "a long job");   // left running
  await settle();

  await s.send("t1", "again");
  s.clis[0]!.fail(AUTH_ERROR);
  await settle();

  assert.equal(s.clis[1]!.aborted, false, "to kill a turn in flight costs more than the failure it saves");
});

// ---- the rotation, before anything fails ----------------------------------

test("a rotation of the credential store stops the sessions it left stale", async (t) => {
  const s = setup(["keychain:20260918210920Z", "keychain:20260919050920Z"]);
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  assert.deepEqual(await s.engine.checkCredentials(), [], "the first read only records");
  assert.deepEqual(await s.engine.checkCredentials(), ["t1"]);
  assert.equal(s.clis[0]!.aborted, true);
  assert.ok(s.notes("t1").some((n) => n.includes("credentials changed")), s.notes("t1").join(" | "));

  // The next message starts a process on the credentials as they are now.
  await s.send("t1", "again");
  assert.equal(s.clis.length, 2);
});

test("a store this daemon cannot read turns the watch off, and nothing else", async (t) => {
  const s = setup([null]);
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  assert.deepEqual(await s.engine.checkCredentials(), []);
  assert.deepEqual(await s.engine.checkCredentials(), []);
  assert.equal(s.clis[0]!.aborted, false);
});
