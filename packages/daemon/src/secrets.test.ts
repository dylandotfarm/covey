/**
 * The environment a thread works in — issue #126.
 *
 * The promise is narrow and these cases hold every half of it:
 *
 *  1. a value reaches the session's environment, so the agent can use it;
 *  2. a value reaches nothing else — no command answer, no event, no timeline
 *     item, no transcript;
 *  3. a value that comes back out of a session anyway is taken out again.
 *
 * The engine runs against a stand-in for the CLI, so nothing here starts a
 * Claude subprocess, and the project is a bare directory rather than a clone:
 * no test touches a remote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { secretKeyError } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { startServer } from "./server.js";
import { Updater } from "./update.js";

/** A port the OS says is free: `startServer` listens on what it is given. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

const TOKEN = "sk_live_0123456789abcdef";
const OTHER = "sk_test_fedcba9876543210";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

/** One stand-in CLI: it records the options it was started with and replies on demand. */
interface FakeCli {
  options: Options;
  aborted: boolean;
  reply(text: string): void;
  /** Start a turn's reply without finishing it, so the session reads as busy. */
  startTurn(): void;
}

function makeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options): FakeCli & { query: Query } {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
  const key = { sessionId: (options.resume ?? options.sessionId)!, projectKey: "", subpath: "" };
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
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      backgroundTasks: async () => true,
    } as unknown as Query,
    startTurn() {
      push({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: "opus", content: [{ type: "text", text: "working" }] } });
    },
    reply(text: string) {
      // The CLI mirrors its transcript into the session store; a resumed
      // session reads the conversation back out of it, which is why what
      // lands there matters as much as the timeline.
      void options.sessionStore!.append(key, [{ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text }] } }] as never);
      push({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: "opus", content: [{ type: "text", text }] } });
      push({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: {}, user_message_uuid: null });
    },
  };
  options.abortController?.signal.addEventListener("abort", () => { cli.aborted = true; done = true; wake?.(); });
  void (async () => { for await (const _ of prompt) { /* the daemon's messages need no answer here */ } })();
  return cli;
}

function thread(id: string, projectId = "p1"): Thread {
  return {
    id, projectId, title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-secrets-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  const clis: FakeCli[] = [];
  const engine = new Engine(db, { ...MACHINE }, {
    spawn: ({ prompt, options }) => { const cli = makeCli(prompt, options); clis.push(cli); return cli.query; },
  });
  const send = (cmd: any) => engine.dispatch({ ...cmd, commandId: randomUUID() });
  return {
    db, engine, clis, send,
    newThread(id: string) { db.putThread(thread(id)); return id; },
    async turn(threadId: string, text = "go") {
      await send({ type: "turn.send", threadId, turnId: randomUUID(), text });
      await settle();
    },
    items(threadId: string) { return engine.threadSnapshot(threadId).items; },
    notes(threadId: string) { return engine.threadSnapshot(threadId).items.filter((i) => i.kind === "note").map((i) => (i as { text: string }).text); },
    /** Everything this daemon has written down about itself, as one string. */
    everythingStored() {
      return JSON.stringify([
        db.shellEventsAfter(0),
        db.listProjects(),
        db.listThreads(),
        db.listThreads().flatMap((t) => db.allItems(t.id)),
        db.listThreads().map((t) => db.loadTranscript(t.id, t.sessionId, "")),
      ]);
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- the rules on a name ---------------------------------------------------

test("a secret's name is an environment variable name, and not one covey owns", () => {
  assert.equal(secretKeyError("STRIPE_KEY"), null);
  assert.equal(secretKeyError("_x1"), null);
  assert.match(secretKeyError("1KEY")!, /not an environment variable name/);
  assert.match(secretKeyError("MY KEY")!, /not an environment variable name/);
  assert.match(secretKeyError("")!, /not an environment variable name/);
  // A thread that could rewrite these would file its work under another
  // thread, or start no tools at all.
  assert.match(secretKeyError("COVEY_THREAD_ID")!, /belongs to covey/);
  assert.match(secretKeyError("PATH")!, /what the session needs to run/);
  assert.match(secretKeyError("HOME")!, /what the session needs to run/);
});

test("a bad name is refused, and nothing beside it is written", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await assert.rejects(
    s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "GOOD", value: TOKEN }, { key: "PATH", value: "/nowhere" }] }),
    (e: EngineError) => e.code === "bad_key",
  );
  assert.equal(s.db.getProject("p1")!.secretKeys, undefined, "the good name did not go in either");
});

// ---- what a client is told --------------------------------------------------

test("a project keeps the names, and nothing covey stores holds the value", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }, { key: "AWS_ID", value: OTHER }] });
  assert.deepEqual(s.db.getProject("p1")!.secretKeys, ["AWS_ID", "STRIPE_KEY"], "sorted, so the panel does not shuffle");
  assert.equal(s.everythingStored().includes(TOKEN), false);
  assert.equal(s.everythingStored().includes(OTHER), false);
});

test("a thread's name hides the project's, and the list says so", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }, { key: "AWS_ID", value: OTHER }] });
  await s.send({ type: "thread.setSecrets", threadId: "t1", secrets: [{ key: "STRIPE_KEY", value: "sk_thread_000000000" }] });

  assert.deepEqual(s.db.getThread("t1")!.secretKeys, ["STRIPE_KEY"]);
  assert.deepEqual(s.engine.secretsList({ threadId: "t1" }).map((x) => [x.key, x.scope, x.overrides ?? false]), [
    ["AWS_ID", "project", false],
    ["STRIPE_KEY", "thread", true],
  ]);
  assert.deepEqual(s.engine.secretsEnv("t1"), { AWS_ID: OTHER, STRIPE_KEY: "sk_thread_000000000" });
  // A project's own list is its own: the thread's names are not in it.
  assert.deepEqual(s.engine.secretsList({ projectId: "p1" }).map((x) => x.key), ["AWS_ID", "STRIPE_KEY"]);
});

test("a null value takes the name away", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "A", value: TOKEN }, { key: "B", value: OTHER }] });
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "A", value: null }] });
  assert.deepEqual(s.db.getProject("p1")!.secretKeys, ["B"]);
  assert.deepEqual(s.engine.secretsEnv("t1"), { B: OTHER });
});

// ---- what the session gets ---------------------------------------------------

test("the session starts with the secrets in its environment, the thread's over the project's", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }, { key: "AWS_ID", value: OTHER }] });
  await s.send({ type: "thread.setSecrets", threadId: "t1", secrets: [{ key: "STRIPE_KEY", value: "sk_thread_000000000" }] });
  await s.turn("t1");

  const env = s.clis[0]!.options.env as Record<string, string>;
  assert.equal(env.AWS_ID, OTHER);
  assert.equal(env.STRIPE_KEY, "sk_thread_000000000");
  // Covey's own names are still covey's: a secret cannot take one, so the
  // thread a session speaks for is never in doubt.
  assert.equal(env.COVEY_THREAD_ID, "t1");
  assert.equal(env.COVEY_PROJECT_ID, "p1");
  assert.ok(env.PATH, "the rest of the environment is still there");
});

test("a thread with no secrets starts with the environment it always had", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.turn("t1");
  const env = s.clis[0]!.options.env as Record<string, string>;
  assert.equal(env.COVEY_THREAD_ID, "t1");
});

// ---- what comes back out -----------------------------------------------------

test("a value a session says is taken out of the timeline and out of the transcript", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }] });
  await s.turn("t1");
  s.clis[0]!.reply(`the key is ${TOKEN}, I read it from the environment`);
  await settle();

  const said = s.items("t1").filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text);
  assert.deepEqual(said, ["the key is [secret STRIPE_KEY], I read it from the environment"]);
  assert.equal(s.everythingStored().includes(TOKEN), false, "not in an item, an event or the transcript");
  // The transcript is what a resumed session reads, so a secret left there
  // would go back to the model at every resume.
  assert.match(JSON.stringify(s.db.loadTranscript("t1", "sess-t1", "")), /\[secret STRIPE_KEY\]/);
});

test("a message the reader typed is redacted too", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }] });
  await s.turn("t1", `use ${TOKEN} please`);
  const typed = s.items("t1").filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
  assert.deepEqual(typed, ["use [secret STRIPE_KEY] please"]);
});

// ---- the session that already copied the old values --------------------------

test("setting a secret releases an idle session, so the next turn has the new one", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.turn("t1");
  s.clis[0]!.reply("hi");
  await settle();
  assert.equal(s.engine.sessionCensus().live, 1);

  await s.send({ type: "thread.setSecrets", threadId: "t1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }] });
  assert.equal(s.engine.sessionCensus().live, 0);
  assert.equal(s.clis[0]!.aborted, true);
  assert.ok(s.notes("t1").some((n) => /secrets you just set/.test(n)));

  await s.turn("t1", "again");
  assert.equal((s.clis[1]!.options.env as Record<string, string>).STRIPE_KEY, TOKEN);
});

test("a session in the middle of a turn keeps its environment, and the thread is told", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.turn("t1");
  s.clis[0]!.startTurn();
  await settle();

  await s.send({ type: "thread.setSecrets", threadId: "t1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }] });
  assert.equal(s.engine.sessionCensus().live, 1, "the turn is not thrown away for a setting");
  assert.equal(s.clis[0]!.aborted, false);
  assert.ok(s.notes("t1").some((n) => /keeps the environment it started with/.test(n)));
});

// ---- when the owner goes ------------------------------------------------------

test("deleting a thread takes its secrets, and deleting a project takes the project's", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "A", value: TOKEN }] });
  await s.send({ type: "thread.setSecrets", threadId: "t1", secrets: [{ key: "B", value: OTHER }] });

  await s.send({ type: "thread.delete", threadId: "t1" });
  assert.deepEqual(s.db.secretKeys("thread", "t1"), []);
  assert.deepEqual(s.db.secretKeys("project", "p1"), ["A"], "the project's are the project's");

  await s.send({ type: "project.delete", projectId: "p1" });
  assert.deepEqual(s.db.secretKeys("project", "p1"), []);
});

// ---- over the socket ---------------------------------------------------------

/**
 * `covey env` speaks to the daemon like any other client, so the two calls it
 * makes are proven here against a real server on loopback. The refusal for a
 * connection from anywhere else is in `server.ts`, on the one fact the daemon
 * works out for itself rather than being told.
 */
test("a loopback client reads the names, and the environment behind them", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.newThread("t1");
  await s.send({ type: "project.setSecrets", projectId: "p1", secrets: [{ key: "STRIPE_KEY", value: TOKEN }] });

  const port = await freePort();
  const server = await startServer({
    config: {
      machineId: "m1", name: "test", token: "t", port, bind: "loopback",
      createdAt: "2026-01-01T00:00:00Z", defaultModel: null, defaultPermissionMode: null,
      defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null,
    } as any,
    engine: s.engine, updater: new Updater("m1", () => {}), host: "127.0.0.1", log: () => {},
  });
  t.after(() => server.close());

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  t.after(() => ws.close());
  let id = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const reqId = ++id;
    const onMessage = (d: Buffer) => {
      const m = JSON.parse(d.toString());
      if (m.id !== reqId) return;
      ws.off("message", onMessage);
      m.ok ? res(m.result) : rej(new Error(m.error?.message ?? "rpc failed"));
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  await rpc("hello", { protocolVersion: 1, client: "covey-cli", threadId: "t1" });

  assert.deepEqual((await rpc("secrets.list", { threadId: "t1" })).secrets.map((x: any) => [x.key, x.scope]), [["STRIPE_KEY", "project"]]);
  assert.deepEqual(await rpc("secrets.env", { threadId: "t1" }), { env: { STRIPE_KEY: TOKEN } });
  await assert.rejects(rpc("secrets.list", {}), /needs a threadId or a projectId/);
});
