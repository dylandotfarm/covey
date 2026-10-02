/**
 * A shell in a thread's working directory, over the wire — issue #10.
 *
 * The whole route against a real daemon: one socket opens the shell, the bytes
 * come back as pushes, `cd` lasts, the scrollback is handed to the reader who
 * opens it again, and a thread whose worktree goes takes its shell with it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startDaemon, stopAll } from "./daemons.js";
import { scratchRemote } from "../src/scratch.js";

after(stopAll);

/** One socket held open, so a push can arrive on it after the answer did. */
class Conn {
  private ws: WebSocket;
  private answers = new Map<number, (v: any) => void>();
  private id = 0;
  /** Every `terminal` push, in the order it arrived. */
  pushes: { terminalId: string; event: any }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.push === "terminal") { this.pushes.push({ terminalId: m.terminalId, event: m.event }); return; }
      this.answers.get(m.id)?.(m);
    };
  }

  static async open(port: number): Promise<Conn> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("connection refused")); });
    const c = new Conn(ws);
    const hello = await c.call("hello", { protocolVersion: 1, client: "covey-tui" });
    assert.equal(hello.ok, true, JSON.stringify(hello));
    return c;
  }

  call(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((res) => { this.answers.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }

  close() { this.ws.close(); }

  /** Everything the shell has written on this connection so far. */
  get output(): string { return this.pushes.filter((p) => p.event.kind === "output").map((p) => p.event.data).join(""); }
  get ran(): { exitCode: number; cwd: string }[] { return this.pushes.filter((p) => p.event.kind === "ran").map((p) => p.event); }

  async until(fn: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out; pushes so far: ${JSON.stringify(this.pushes)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

test("a reader opens a shell in the thread's worktree, and it is the thread's own directory (#10)", async () => {
  const remote = await scratchRemote("covey-shell-");
  try {
    const d = await startDaemon({ name: "shell" });
    const c = await Conn.open(d.port);
    try {
      await c.call("command", { commandId: randomUUID(), type: "project.create", url: remote.url });
      const projectId = (await c.call("shell.snapshot", {})).result.projects[0]!.id;
      const threadId = randomUUID();
      await c.call("command", { commandId: randomUUID(), type: "thread.create", projectId, threadId, sessionId: randomUUID() });
      const thread = (await c.call("shell.snapshot", {})).result.threads.find((t: { id: string }) => t.id === threadId);
      assert.ok(thread?.worktreePath, "the thread works in a worktree of its own");

      const opened = await c.call("terminal.open", { threadId, cols: 100, rows: 30 });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const { terminalId } = opened.result;
      // The shell starts where the Claude session starts, so the reader's `ls`
      // and the agent's `ls` list the same files.
      assert.equal(opened.result.cwd, thread.worktreePath);
      assert.equal(opened.result.busy, false);
      assert.equal(opened.result.scrollback, "");

      await c.call("terminal.input", { terminalId, data: "pwd\n" });
      await c.until(() => c.ran.length === 1);
      assert.ok(c.output.includes(thread.worktreePath), c.output);

      // A `cd` lasts, which is what makes this a shell rather than a runner.
      await c.call("terminal.input", { terminalId, data: "cd .. && pwd\n" });
      await c.until(() => c.ran.length === 2);
      assert.notEqual(c.ran[1]!.cwd, thread.worktreePath);

      // And a second open is the *same* shell, with what it wrote: the reader
      // shut the panel to read the transcript and came back.
      const again = await c.call("terminal.open", { threadId });
      assert.equal(again.result.terminalId, terminalId, "one shell per thread");
      assert.equal(again.result.cwd, c.ran[1]!.cwd);
      assert.ok(again.result.scrollback.includes(thread.worktreePath), "the scrollback is what the reader was looking at");

      // An interrupt stops the command and leaves the shell standing.
      await c.call("terminal.input", { terminalId, data: "echo going; sleep 30\n" });
      await c.until(() => c.output.includes("going"));
      await c.call("terminal.signal", { terminalId, signal: "int" });
      await c.until(() => c.ran.length === 3);
      assert.equal(c.ran[2]!.exitCode, 130);
      await c.call("terminal.input", { terminalId, data: "echo alive\n" });
      await c.until(() => c.output.includes("alive"));

      // Closing ends it, and the id stops meaning anything.
      await c.call("terminal.close", { terminalId });
      await c.until(() => c.pushes.some((p) => p.event.kind === "exit"));
      const dead = await c.call("terminal.input", { terminalId, data: "echo no\n" });
      assert.equal(dead.ok, false);
      assert.equal(dead.error.code, "not_found");
    } finally {
      c.close();
    }
  } finally {
    remote.drop();
  }
});

test("archiving a thread takes its shell with it, because the directory goes (#10)", async () => {
  const remote = await scratchRemote("covey-shell-archive-");
  try {
    const d = await startDaemon({ name: "shell-archive" });
    const c = await Conn.open(d.port);
    try {
      await c.call("command", { commandId: randomUUID(), type: "project.create", url: remote.url });
      const projectId = (await c.call("shell.snapshot", {})).result.projects[0]!.id;
      const threadId = randomUUID();
      await c.call("command", { commandId: randomUUID(), type: "thread.create", projectId, threadId, sessionId: randomUUID() });
      const { terminalId } = (await c.call("terminal.open", { threadId })).result;
      await c.call("terminal.input", { terminalId, data: "echo here\n" });
      await c.until(() => c.ran.length === 1);

      await c.call("command", { commandId: randomUUID(), type: "thread.archive", threadId, archived: true });
      // Left running it would be a shell standing in a path that no longer
      // exists, where every command fails with the same unhelpful line.
      await c.until(() => c.pushes.some((p) => p.event.kind === "exit"));
      const after = await c.call("terminal.input", { terminalId, data: "echo no\n" });
      assert.equal(after.ok, false);
    } finally {
      c.close();
    }
  } finally {
    remote.drop();
  }
});

test("a thread this daemon does not hold has no shell to open (#10)", async () => {
  const d = await startDaemon({ name: "shell-missing" });
  const c = await Conn.open(d.port);
  try {
    const r = await c.call("terminal.open", { threadId: randomUUID() });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_found");
    assert.match(r.error.message, /thread not found/);
  } finally {
    c.close();
  }
});
