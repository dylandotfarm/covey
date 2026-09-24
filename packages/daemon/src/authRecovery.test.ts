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
 * And a resumed session holds a copy without the refresh token, so when the
 * token expires it answers `401 OAuth access token has expired` and every
 * resume after it copies the same dead token, until Claude Code refreshes the
 * store. The daemon asks for that refresh (`refreshCredentials`) before it
 * starts the next process.
 *
 * These tests drive a whole engine against a stand-in for the CLI and a
 * stand-in for the refresh, so the failure is a line in a test rather than a
 * revoked account, and a refresh is a count rather than a rotation.
 */

/** `EXPIRY_MARGIN_MS` in the engine: the window Claude Code refreshes in, and
 *  therefore the end of a token that covey reads as already gone. */
const MARGIN_MS = 5 * 60_000;

/** `SWEEP_INTERVAL_MS` in the engine. */
const SWEEP_MS = 30_000;

const AUTH_ERROR = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
const EXPIRED_ERROR = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";

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

interface SetupOptions {
  /** What the credential store's fingerprint reads on each check. */
  stamps?: (string | null)[];
  /** When the store's token expires; `null` is a store the daemon cannot read. */
  expiry?: () => number | null;
  /** What a refresh does. The default answers; a test that wants a dead
   *  refresh token throws the CLI's own error text. */
  refresh?: () => Promise<void>;
  /** A daemon with no way to refresh, as before this existed. */
  noRefresher?: boolean;
}

function setup(o: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "covey-auth-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const clis: (FakeCli & { query: Query })[] = [];
  const stamps = o.stamps ?? [];
  /** Each refresh, as the number of processes that existed when it was asked
   *  for — so a test can say "the refresh came before the second process". */
  const refreshes: number[] = [];
  let clock = Date.now();
  const engine = new Engine(db, MACHINE(), {
    spawn: ({ prompt, options }) => {
      const cli = makeCli(prompt, options);
      clis.push(cli);
      return cli.query;
    },
    now: () => clock,
    credentialStamp: async () => (stamps.length > 1 ? stamps.shift()! : stamps[0] ?? null),
    credentialExpiry: async () => o.expiry?.() ?? null,
    ...(o.noRefresher ? {} : { refreshCredentials: async () => { refreshes.push(clis.length); await (o.refresh ?? (async () => {}))(); } }),
  });
  return {
    db, engine, dir, clis, refreshes,
    /** Move the engine's clock by `ms`. */
    tick(ms: number) { clock += ms; },
    now() { return clock; },
    newThread(id: string) { db.putThread(thread(id)); return id; },
    /** Give the thread a transcript, so its next session is a resume — the
     *  kind whose copy of the credentials has no refresh token. */
    withTranscript(id: string) { db.appendTranscript(id, `sess-${id}`, "", [{ type: "user", uuid: randomUUID(), message: { role: "user", content: "hi" } }]); },
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
  assert.ok(s.notes("t1").some((n) => n.includes("could not authenticate") && n.includes("refreshes the credentials")), s.notes("t1").join(" | "));
  assert.equal(s.engine.sessionCensus().live, 1);
  // The store was refreshed between the two processes, and once.
  assert.deepEqual(s.refreshes, [1], "one refresh, asked for when one process existed");
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
  const s = setup({ stamps: ["keychain:20260918210920Z", "keychain:20260919050920Z"] });
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
  const s = setup({ stamps: [null] });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  assert.deepEqual(await s.engine.checkCredentials(), []);
  assert.deepEqual(await s.engine.checkCredentials(), []);
  assert.equal(s.clis[0]!.aborted, false);
});

// ---- the refresh ----------------------------------------------------------

test("an expired token is refreshed before a session copies it, and a live one is left alone", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");

  expiresAt = s.now() - 1;
  await s.send("t1", "hello");
  assert.deepEqual(s.refreshes, [0], "the refresh came before the first process");
  assert.equal(s.clis.length, 1);
  assert.deepEqual(s.clis[0]!.prompts, ["hello"]);
  s.clis[0]!.finish("hi");
  await settle();
  assert.equal(s.notes("t1").length, 0, "nothing to tell the user: the turn simply went through");

  // The store is fresh for hours; a new thread's process copies it as it is.
  expiresAt = s.now() + 8 * 3_600_000;
  s.newThread("t2");
  await s.send("t2", "hello");
  assert.deepEqual(s.refreshes, [0], "no second refresh");
  assert.equal(s.clis.length, 2);
});

test("a token about to expire counts as expired: a process takes seconds to start", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");
  expiresAt = s.now() + 60_000;
  await s.send("t1", "hello");
  assert.deepEqual(s.refreshes, [0]);
});

test("the sweep stops an idle resumed session whose copied token is spent, before anyone types into it", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");
  s.newThread("t2");   // no transcript: a fresh process, which refreshes for itself
  expiresAt = s.now() + 3_600_000;
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await s.send("t2", "hello");
  s.clis[1]!.finish("hi");
  await settle();
  assert.equal(s.engine.sessionCensus().live, 2);

  // The last five minutes are the window Claude Code refreshes in, so covey
  // reads the token as gone there rather than hand a reader the end of it.
  s.tick(3_600_000 - MARGIN_MS - 1);
  assert.deepEqual(await s.engine.checkCredentials(), [], "not yet");
  s.tick(2);
  assert.deepEqual(await s.engine.checkCredentials(), ["t1"]);
  assert.equal(s.clis[0]!.aborted, true);
  assert.equal(s.clis[1]!.aborted, false, "a fresh process holds the refresh token and refreshes for itself");
  assert.ok(s.notes("t1").some((n) => n.includes("about to expire") && n.includes("stopped it before it failed")), s.notes("t1").join(" | "));

  // The next message refreshes the store — the stand-in's expiry has not
  // moved, so the daemon sees it still expired — and resumes.
  await s.send("t1", "again");
  assert.deepEqual(s.refreshes, [2]);
  assert.equal(s.clis.length, 3);
  assert.deepEqual(s.clis[2]!.prompts, ["again"]);
});

test("a message to a live session whose copied token ran out starts a new process instead", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");
  expiresAt = s.now() + 3_600_000;
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  s.tick(3_600_001);
  await s.send("t1", "again");
  assert.equal(s.clis[0]!.aborted, true, "the copy it holds cannot be refreshed");
  assert.equal(s.clis.length, 2);
  assert.deepEqual(s.refreshes, [1], "refreshed before the new process copied the store");
  assert.deepEqual(s.clis[1]!.prompts, ["again"]);
});

test("a refresh that fails on the credentials names claude auth login, and starts no process", async (t) => {
  const s = setup({ refresh: async () => { throw new Error(EXPIRED_ERROR); } });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  s.clis[0]!.fail(EXPIRED_ERROR);
  await settle(() => s.notes("t1").some((n) => n.includes("could not refresh")));

  assert.equal(s.clis.length, 1, "a process started now would fail the same way");
  assert.deepEqual(s.refreshes, [1]);
  const notes = s.notes("t1");
  assert.ok(notes.some((n) => n.includes("could not refresh the credentials") && n.includes("claude auth login")), notes.join(" | "));
  assert.ok(!notes.some((n) => n.includes("Could not start a new session")), "the refresh already said so: " + notes.join(" | "));
  assert.equal(s.engine.sessionCensus().live, 0);

  // Each later message asks again, and says so again, until a login mends it.
  await s.send("t1", "ping").catch(() => {});
  assert.equal(s.clis.length, 1);
  assert.deepEqual(s.refreshes, [1, 1]);
});

test("a refresh that fails on the network starts the process anyway", async (t) => {
  const s = setup({ expiry: () => 0, refresh: async () => { throw new Error("fetch failed: ENOTFOUND api.anthropic.com"); } });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  assert.deepEqual(s.refreshes, [0]);
  assert.equal(s.clis.length, 1, "Claude Code saves a refreshed pair before it asks the model, so the store may be fresh");
  assert.ok(s.notes("t1").some((n) => n.includes("could not refresh") && n.includes("starts on the store as it is")), s.notes("t1").join(" | "));
});

test("two threads that fail at once share one refresh", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  await s.send("t1", "one");
  await s.send("t2", "two");
  s.clis[0]!.fail(EXPIRED_ERROR);
  s.clis[1]!.fail(EXPIRED_ERROR);
  await settle(() => s.clis.length === 4 && restarted(s.clis, 2)() && restarted(s.clis, 3)());

  assert.equal(s.clis.length, 4);
  assert.equal(s.refreshes.length, 1, "one rotation, not one per thread: " + JSON.stringify(s.refreshes));
});

test("a failure from a process that started before the last refresh does not refresh again", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  s.newThread("t2");
  await s.send("t1", "one");
  await s.send("t2", "a long job");   // left running across the refresh
  s.tick(1000);
  s.clis[0]!.fail(EXPIRED_ERROR);
  await settle(restarted(s.clis, 2));
  assert.deepEqual(s.refreshes, [2], "asked for once, with both processes live");
  s.tick(1000);

  // t2's process copied the old token; its failure was written before the
  // refresh, and the store as it is now has answered a process already.
  s.clis[1]!.fail(EXPIRED_ERROR);
  await settle(restarted(s.clis, 3));
  assert.equal(s.clis.length, 4);
  assert.deepEqual(s.refreshes, [2], "the store is fresh; the work restarts on it");
});

test("a daemon that cannot refresh restarts once, as before, and then names the command", async (t) => {
  const s = setup({ noRefresher: true, expiry: () => 0 });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "hello");
  assert.equal(s.clis.length, 1, "an expired token it cannot refresh is not a reason to refuse the turn");
  s.clis[0]!.fail(EXPIRED_ERROR);
  await settle(restarted(s.clis, 1));
  s.clis[1]!.fail(EXPIRED_ERROR);
  await settle();
  assert.equal(s.clis.length, 2);
  assert.ok(s.notes("t1").some((n) => n.includes("twice in a row") && n.includes("claude auth login")), s.notes("t1").join(" | "));
});

// ---- the refresh nobody waited for ----------------------------------------

test("covey refreshes the store on the sweep, so the next reader does not wait for it", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt, stamps: ["file:1", "file:2"] });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");
  expiresAt = s.now() + 3_600_000;
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  // The token enters the window: the resumed session goes, and the store is
  // refreshed while nobody is asking for it.
  s.tick(3_600_000 - MARGIN_MS + 1);
  assert.deepEqual(await s.engine.checkCredentials(), ["t1"]);
  assert.deepEqual(s.refreshes, [1], "one refresh, and no thread waited on it");

  // The next message starts its process straight away. Nothing asks again:
  // the store answered a process already.
  expiresAt = s.now() + 8 * 3_600_000;
  await s.send("t1", "again");
  assert.deepEqual(s.refreshes, [1]);
  assert.equal(s.clis.length, 2);
  assert.deepEqual(s.clis[1]!.prompts, ["again"]);
});

test("the rotation covey made is not read back as somebody else's", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt, stamps: ["file:1", "file:2"] });
  t.after(s.cleanup);
  s.newThread("t1");
  expiresAt = s.now() + 60_000;
  await s.engine.checkCredentials();          // records the stamp
  await s.engine.checkCredentials();          // refreshes ahead of the expiry
  assert.deepEqual(s.refreshes, [0]);

  expiresAt = s.now() + 8 * 3_600_000;
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();
  assert.deepEqual(await s.engine.checkCredentials(), [], "the new stamp is covey's own work");
  assert.equal(s.clis[0]!.aborted, false, "a session started on the new token keeps it");
});

test("a refresh covey made to start a session is not read back as somebody else's", async (t) => {
  let expiresAt = 0;
  const s = setup({
    expiry: () => expiresAt,
    stamps: ["file:1", "file:2"],
    // What a refresh leaves behind: a token with hours on it, under a
    // fingerprint the store did not have before.
    refresh: async () => { expiresAt = s.now() + 8 * 3_600_000; },
  });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");
  expiresAt = s.now() + 8 * 3_600_000;
  await s.engine.checkCredentials();   // the first read only records the stamp
  assert.deepEqual(s.refreshes, []);

  // The token is inside the window Claude Code refreshes in, so covey asks for
  // a refresh to start the session — a rotation of its own, made while a
  // thread waits on it rather than on the quiet sweep.
  expiresAt = s.now() + MARGIN_MS - 1;
  await s.send("t1", "reproduce the bug");
  assert.deepEqual(s.refreshes, [0], "the store was refreshed to start the session");
  s.clis[0]!.finish("here you go");
  await settle();

  assert.deepEqual(await s.engine.checkCredentials(), [], "covey's own refresh is not a rotation to cycle for");
  assert.equal(s.clis[0]!.aborted, false, "the session covey started on the new token keeps it");
  assert.equal(s.notes("t1").some((n) => n.includes("credentials changed")), false, s.notes("t1").join(" | "));
});

test("a process that is writing is never stopped, whatever covey thinks its turn is doing", async (t) => {
  const s = setup({ stamps: ["file:1", "file:2"] });
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send("t1", "reproduce the bug");
  assert.deepEqual(await s.engine.checkCredentials(), [], "the first read only records the stamp");

  // The CLI reports a result for work covey never asked for — the tasks a
  // resumed session inherits from the one before it — so covey's turn reads as
  // over. The process then answers the message covey did send.
  s.clis[0]!.finish("2 background shells stopped");
  s.clis[0]!.say("New report: let me reproduce it.");
  await settle();

  assert.deepEqual(await s.engine.checkCredentials(), [], "a rotation leaves a process that is writing alone");
  assert.equal(s.clis[0]!.aborted, false);
});

test("a session that can refresh for itself is never revoked for nothing", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");   // no transcript: a fresh process, which holds the refresh token
  expiresAt = s.now() + 3_600_000;
  await s.send("t1", "hello");
  s.clis[0]!.finish("hi");
  await settle();

  s.tick(3_600_000 - MARGIN_MS + 1);
  assert.deepEqual(await s.engine.checkCredentials(), []);
  assert.deepEqual(s.refreshes, [], "the live session refreshes the store itself, in its own time");
  assert.equal(s.clis[0]!.aborted, false);
});

test("a turn in flight is never ended by a refresh covey chose to make", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt });
  t.after(s.cleanup);
  s.newThread("t1");
  s.withTranscript("t1");
  expiresAt = s.now() + 3_600_000;
  await s.send("t1", "a long job");   // left running
  await settle();

  s.tick(3_600_000 - MARGIN_MS + 1);
  assert.deepEqual(await s.engine.checkCredentials(), [], "a busy session is left to finish or to fail");
  assert.deepEqual(s.refreshes, []);
  assert.equal(s.clis[0]!.aborted, false);
});

test("a refresh ahead of the expiry that fails is not tried again every half minute", async (t) => {
  let expiresAt = 0;
  const s = setup({ expiry: () => expiresAt, refresh: async () => { throw new Error(EXPIRED_ERROR); } });
  t.after(s.cleanup);
  expiresAt = s.now() + 60_000;

  await s.engine.checkCredentials();
  await s.engine.checkCredentials();
  s.tick(SWEEP_MS * 10);
  await s.engine.checkCredentials();
  assert.deepEqual(s.refreshes, [0], "a dead refresh token fails every time; one process an hour, not two a minute");

  s.tick(30 * 60_000);
  await s.engine.checkCredentials();
  assert.deepEqual(s.refreshes, [0, 0], "and it does ask again, so a login mends the machine without a restart");
});
