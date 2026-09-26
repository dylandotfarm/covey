/**
 * `covey show`: a file an agent makes, shown in the conversation — issue #160.
 *
 * The whole route, against a real daemon: the command copies the file into the
 * thread's own store, one note carries it, and the `/file` route serves the
 * bytes to whatever is looking at the thread. Nothing here reaches GitHub, and
 * the remote is a scratch clone.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { startDaemon, stopAll } from "./daemons.js";
import { threadFilesDir } from "../src/attachments.js";
import { scratchRemote } from "../src/scratch.js";

after(stopAll);

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("a file an agent shows lands in the thread's store, on a note, and serves over /file (#160)", async () => {
  const remote = await scratchRemote("covey-show-");
  try {
    const d = await startDaemon({ name: "show" });
    const base = `http://127.0.0.1:${d.port}`;
    await rpc(d.port, "command", { commandId: randomUUID(), type: "project.create", url: remote.url });
    const projectId = (await rpc(d.port, "shell.snapshot", {})).result.projects[0]!.id;
    const threadId = randomUUID();
    await rpc(d.port, "command", { commandId: randomUUID(), type: "thread.create", projectId, threadId, sessionId: randomUUID() });
    const thread = (await rpc(d.port, "shell.snapshot", {})).result.threads.find((t: { id: string }) => t.id === threadId);
    assert.ok(thread?.worktreePath, "the thread works in a worktree of its own");

    // What an agent does: write a file somewhere of its own, then show it.
    const made = join(thread.worktreePath, "shot.png");
    writeFileSync(made, PNG);
    const shown = await rpc(d.port, "thread.showFiles", { threadId, text: "the sidebar after the fix", files: [{ name: "shot.png", path: made }] });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    const copy = join(threadFilesDir(thread.worktreePath, threadId), "shot.png");
    assert.deepEqual(shown.result.files, [{ name: "shot.png", path: copy }]);
    assert.ok(existsSync(copy), "the bytes are the thread's own now, not the agent's");

    // One note carries the file, and it is not folded into a chain of calls.
    const items = (await rpc(d.port, "thread.snapshot", { threadId })).result.items as any[];
    const note = items.find((i) => i.kind === "note" && i.files);
    assert.ok(note, `expected a note carrying files, got ${items.map((i) => i.kind).join(", ")}`);
    assert.equal(note.text, "the sidebar after the fix");
    assert.equal(note.tone, "info");
    assert.equal(note.groupId, undefined, "a picture must never fold away into a chain row");
    assert.deepEqual(note.files, [{ name: "shot.png", path: copy, mimeType: "image/png" }]);

    // And the route the clients load it from answers with the bytes.
    const got = await fetch(`${base}/file?thread=${threadId}&path=${encodeURIComponent(copy)}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

    // A file that is not there is a sentence the agent can act on.
    const gone = await rpc(d.port, "thread.showFiles", { threadId, files: [{ name: "gone.png", path: join(thread.worktreePath, "gone.png") }] });
    assert.equal(gone.ok, false);
    assert.match(gone.error.message, /could not read/);
  } finally {
    remote.drop();
  }
});

test("showing a file is refused off this machine, as a secret's value is (#160)", async () => {
  const d = await startDaemon({ name: "show-remote" });
  // `loopback` is the one fact the daemon works out for itself rather than
  // being told, so proving the refusal takes a connection that really comes
  // from somewhere else. The daemon moves its listeners while it runs, so the
  // test opens the machine up, dials its own LAN address, and shuts it again.
  const lan = lanAddress();
  if (!lan) return void console.log("no address but loopback on this machine; the off-machine half is unproven here");
  const token = (JSON.parse(readFileSync(join(d.home, "daemon.json"), "utf8")) as { token: string }).token;
  const opened = await rpc(d.port, "command", { commandId: randomUUID(), type: "machine.settings", bind: "all" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  try {
    const ws = new WebSocket(`ws://${lan}:${d.port}?token=${token}`);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("the daemon refused the connection")); });
    try {
      const answers = new Map<number, (v: any) => void>();
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); answers.get(m.id)?.(m); };
      const call = (id: number, method: string, params: unknown) => new Promise<any>((res) => { answers.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      await call(1, "hello", { protocolVersion: 1, client: "covey-tui" });
      const r = await call(2, "thread.showFiles", { threadId: randomUUID(), files: [{ name: "passwd", path: "/etc/passwd" }] });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "forbidden");
      assert.match(r.error.message, /from this machine only/);
    } finally {
      ws.close();
    }
  } finally {
    await rpc(d.port, "command", { commandId: randomUUID(), type: "machine.settings", bind: "loopback" });
  }
});

/** One request, one answer, over one socket on loopback. */
async function rpc(port: number, method: string, params: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("connection refused")); });
  try {
    return await new Promise<any>((res) => {
      ws.onmessage = (e) => res(JSON.parse(String(e.data)));
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** An address of this machine that is not loopback, or null when it has none. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}
