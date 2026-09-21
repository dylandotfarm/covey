/**
 * Who asked for a thread — issue #49.
 *
 * `hello` has always carried a client name and the daemon has always thrown it
 * away, so a thread fifteen agents created looked exactly like a thread a
 * person opened by hand. These cases hold the two halves of keeping it:
 *
 *  1. the name lives on the connection, not in the one `hello` call, so every
 *     thread that connection creates is stamped — the easy thing to lose is a
 *     `const client = p.client` inside the `hello` case;
 *  2. a caller that knows better than its own client name can say so, because
 *     the TUI dispatches a run's members over the connection a person types
 *     into, and those threads are machinery all the same.
 *
 * The name is self-declared and the daemon cannot check it. Nothing here treats
 * it as anything but a hint for a person reading the sidebar.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, USER_CLIENT, type MachineInfo, type Thread } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, threadOrigin } from "./engine.js";
import { startServer } from "./server.js";
import { Updater } from "./update.js";
import { scratchRemote } from "./scratch.js";

/** A port the OS says is free. `startServer` reports back the port it was
 *  asked for, so asking for 0 would hand out 0 and never reach the listener. */
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

const MACHINE: MachineInfo = {
  machineId: "m1", name: "mac", os: "darwin", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

// ---- the pure rule -----------------------------------------------------------

test("the client that a person types into makes a user thread, and any other name a program's", () => {
  assert.deepEqual(threadOrigin(undefined, USER_CLIENT), { by: "user", client: USER_CLIENT });
  // The name the script that ran the fifteen agents of 2026-09-16 sent.
  assert.deepEqual(threadOrigin(undefined, "covey-ctl"), { by: "agent", client: "covey-ctl" });
});

test("a connection that names nothing leaves the thread as it was before this field existed", () => {
  assert.equal(threadOrigin(undefined, ""), undefined);
});

test("the thread a connection speaks for becomes the parent of what it creates", () => {
  assert.deepEqual(
    threadOrigin(undefined, "claude-code", "t-parent"),
    { by: "agent", client: "claude-code", parentThreadId: "t-parent" },
  );
  assert.deepEqual(
    threadOrigin(undefined, "", "t-parent"),
    { by: "agent", parentThreadId: "t-parent" },
    "a connection that names a thread is a program by that fact alone",
  );
  // Which of the two parents wins is `Engine.apply`'s question, because only
  // it can check an id against the database. What arrives here is the answer.
  assert.deepEqual(
    threadOrigin({ by: "agent", parentThreadId: "asked-for-this-one" }, "claude-code", "checked-this-one"),
    { by: "agent", client: "claude-code", parentThreadId: "checked-this-one" },
    "the id the caller checked is the one recorded",
  );
  assert.deepEqual(
    threadOrigin({ by: "agent", parentThreadId: "a-thread-nobody-holds" }, "claude-code"),
    { by: "agent", client: "claude-code" },
    "and an id that survived no check is not recorded at all",
  );
});

test("the command wins over the client name, and keeps the name beside it", () => {
  // The TUI dispatching a run member: a person's client, a program's thread.
  assert.deepEqual(
    threadOrigin({ by: "agent" }, USER_CLIENT),
    { by: "agent", client: USER_CLIENT },
    "a caller that says it is a program is a program, whatever its client is called",
  );
  assert.deepEqual(
    threadOrigin({ by: "agent" }, "covey-ctl", "t-parent"),
    { by: "agent", client: "covey-ctl", parentThreadId: "t-parent" },
    "the parent link the caller checked survives",
  );
});

// ---- over a real connection --------------------------------------------------

const dirs: string[] = [];
const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) { try { c(); } catch { /* a closed server is fine */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A daemon in this process, on a port the OS picked, reachable over loopback. */
async function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "covey-origin-"));
  dirs.push(dir);
  const engine = new Engine(new Db(dir), { ...MACHINE, projectsDir: join(dir, "projects") });
  const port = await freePort();
  const config = {
    machineId: "m1", name: "mac", token: "t", port, bind: "loopback",
    createdAt: new Date().toISOString(), defaultModel: null, defaultPermissionMode: null,
    defaultStreaming: null, sessionIdleMinutes: null, maxLiveSessions: null,
  };
  const server = await startServer({
    config, engine, updater: new Updater("m1", () => {}), host: "127.0.0.1", log: () => {},
  });
  closers.push(server.close);
  const remote = await scratchRemote("covey-origin-remote-");
  dirs.push(remote.dir);
  return { engine, port: server.port, url: remote.url };
}

/**
 * One connection that says `hello` under `client`, then speaks rpc. `threadId`
 * is the thread the connection runs inside — what an agent reads from
 * `COVEY_THREAD_ID` and passes on, so the daemon can file its work under it.
 */
async function connect(port: number, client: string, threadId?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  closers.push(() => ws.close());
  let id = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const reqId = `r${++id}`;
    const onMessage = (d: Buffer) => {
      const m = JSON.parse(d.toString());
      if (m.id !== reqId) return;
      ws.off("message", onMessage);
      m.ok ? res(m.result) : rej(new Error(m.error?.message ?? "rpc failed"));
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  await rpc("hello", { protocolVersion: PROTOCOL_VERSION, client, ...(threadId ? { threadId } : {}) });
  return {
    rpc,
    command: (cmd: Record<string, unknown>) => rpc("command", { ...cmd, commandId: randomUUID() }),
  };
}

const threadOf = (engine: Engine, id: string): Thread =>
  engine.shellSnapshot().threads.find((t) => t.id === id)!;

test("a thread carries the origin of the connection that created it, and the name outlives hello", async () => {
  const { engine, port, url } = await daemon();
  const ctl = await connect(port, "covey-ctl");
  await ctl.command({ type: "project.create", url, title: "repo" });
  const projectId = engine.shellSnapshot().projects[0]!.id;

  // Two threads on one connection. The second is what catches a daemon that
  // read the name inside the `hello` case and let it go out of scope.
  const first = randomUUID();
  const second = randomUUID();
  for (const threadId of [first, second]) {
    await ctl.command({ type: "thread.create", projectId, threadId, sessionId: randomUUID() });
  }
  assert.deepEqual(threadOf(engine, first).origin, { by: "agent", client: "covey-ctl" });
  assert.deepEqual(
    threadOf(engine, second).origin, { by: "agent", client: "covey-ctl" },
    "the second thread on the same connection lost its origin — the client name did not outlive hello",
  );

  // A second connection, calling itself the TUI, on the same daemon.
  const tui = await connect(port, USER_CLIENT);
  const mine = randomUUID();
  await tui.command({ type: "thread.create", projectId, threadId: mine, sessionId: randomUUID() });
  assert.deepEqual(threadOf(engine, mine).origin, { by: "user", client: USER_CLIENT });
});

test("a caller that knows better than its client name says so, parent and all", async () => {
  const { engine, port, url } = await daemon();
  const tui = await connect(port, USER_CLIENT);
  await tui.command({ type: "project.create", url, title: "repo" });
  const projectId = engine.shellSnapshot().projects[0]!.id;

  const manager = randomUUID();
  const child = randomUUID();
  await tui.command({ type: "thread.create", projectId, threadId: manager, sessionId: randomUUID() });
  await tui.command({
    type: "thread.create", projectId, threadId: child, sessionId: randomUUID(),
    origin: { by: "agent", parentThreadId: manager },
  });
  assert.deepEqual(threadOf(engine, child).origin, { by: "agent", client: USER_CLIENT, parentThreadId: manager });
  assert.equal(threadOf(engine, manager).origin?.by, "user", "the thread the person opened is still theirs");
});

/**
 * The half that was missing, and the reason some agent threads nested and some
 * did not. Nothing told an agent which thread it was running inside, so a
 * program that made a thread could not name its parent even when it wanted to,
 * and its work landed beside the thread that asked for it instead of under it.
 * The session now carries `COVEY_THREAD_ID`, and a connection that passes it on
 * at `hello` has every thread and every run it creates filed under that thread.
 */
test("a connection that names its own thread has its work filed under that thread", async () => {
  const { engine, port, url } = await daemon();
  const tui = await connect(port, USER_CLIENT);
  await tui.command({ type: "project.create", url, title: "repo" });
  const projectId = engine.shellSnapshot().projects[0]!.id;
  const manager = randomUUID();
  await tui.command({ type: "thread.create", projectId, threadId: manager, sessionId: randomUUID() });

  // The agent inside that thread, connecting on its own.
  const agent = await connect(port, "claude-code", manager);
  const first = randomUUID();
  const second = randomUUID();
  for (const threadId of [first, second]) {
    await agent.command({ type: "thread.create", projectId, threadId, sessionId: randomUUID() });
  }
  for (const id of [first, second]) {
    assert.deepEqual(threadOf(engine, id).origin, { by: "agent", client: "claude-code", parentThreadId: manager },
      "every thread of the connection is a child, not only the first");
  }

  // And the runs it asks for.
  const runId = randomUUID();
  await agent.command({
    type: "run.create",
    run: { runId, name: "pre-release", goal: "g", briefTemplate: "b", members: [] },
  });
  assert.equal(engine.shellSnapshot().runs?.[0]?.parentThreadId, manager);
});

test("a parent this daemon does not hold is dropped rather than recorded", async () => {
  const { engine, port, url } = await daemon();
  const tui = await connect(port, USER_CLIENT);
  await tui.command({ type: "project.create", url, title: "repo" });
  const projectId = engine.shellSnapshot().projects[0]!.id;

  // A thread id from another machine, and a thread naming itself. Neither can
  // ever be painted, and a link that leads nowhere loses the child.
  const stranger = await connect(port, "claude-code", "a-thread-on-another-machine");
  const child = randomUUID();
  await stranger.command({ type: "thread.create", projectId, threadId: child, sessionId: randomUUID() });
  assert.deepEqual(threadOf(engine, child).origin, { by: "agent", client: "claude-code" });

  const itself = randomUUID();
  const loop = await connect(port, "claude-code", itself);
  await loop.command({ type: "thread.create", projectId, threadId: itself, sessionId: randomUUID() });
  assert.equal(threadOf(engine, itself).origin?.parentThreadId, undefined, "a thread is never its own parent");

  // The same check on the other road in. A command may name a parent outright,
  // and for a while only the `hello` id was checked — so the daemon would
  // store a link to a thread it does not hold, which nothing can ever paint.
  const named = randomUUID();
  await stranger.command({
    type: "thread.create", projectId, threadId: named, sessionId: randomUUID(),
    origin: { by: "agent", parentThreadId: "invented-by-the-client" },
  });
  assert.equal(threadOf(engine, named).origin?.parentThreadId, undefined,
    "a parent named in the command is checked exactly as one named at hello");

  const own = randomUUID();
  await stranger.command({
    type: "thread.create", projectId, threadId: own, sessionId: randomUUID(),
    origin: { by: "agent", parentThreadId: own },
  });
  assert.equal(threadOf(engine, own).origin?.parentThreadId, undefined);
});

test("a thread created before this existed has none, and the daemon still serves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-origin-old-"));
  dirs.push(dir);
  const db = new Db(dir);
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") });
  const remote = await scratchRemote("covey-origin-remote-");
  dirs.push(remote.dir);
  // `dispatch` with no client is the daemon's own caller, and it is also what
  // every thread in an existing database was written by.
  await engine.dispatch({ type: "project.create", url: remote.url, title: "repo", commandId: randomUUID() });
  const projectId = engine.shellSnapshot().projects[0]!.id;
  const id = randomUUID();
  await engine.dispatch({ type: "thread.create", projectId, threadId: id, sessionId: randomUUID(), commandId: randomUUID() });
  assert.equal(threadOf(engine, id).origin, undefined, "no origin is a thread from before this field, and stays valid");

  // It survives a restart of the daemon with nothing invented for it.
  const again = new Engine(new Db(dir), { ...MACHINE });
  assert.equal(threadOf(again, id).origin, undefined);
});
