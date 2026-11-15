/**
 * `POST /upload`: a file too big for the `turn.send` frame, against a real
 * daemon.
 *
 * `threadUpload.test.ts` holds the route's own rules — the cap, the names, the
 * half-written file. This is the wiring: the daemon answers the route at all,
 * it reserves a path in the right thread's store, the path it answers with is
 * one `materialiseAttachments` will take, and the gate is `authenticate` and
 * not `webEnabled`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { startDaemon, stopAll } from "./daemons.js";
import { threadFilesDir } from "../src/attachments.js";
import { scratchRemote } from "../src/scratch.js";

after(stopAll);

test("a file streams to the thread's own store and the message names the copy", async () => {
  const remote = await scratchRemote("covey-upload-");
  try {
    const d = await startDaemon({ name: "upload" });
    const base = `http://127.0.0.1:${d.port}`;
    await rpc(d.port, "command", { commandId: randomUUID(), type: "project.create", url: remote.url });
    const projectId = (await rpc(d.port, "shell.snapshot", {})).result.projects[0]!.id;
    const threadId = randomUUID();
    await rpc(d.port, "command", { commandId: randomUUID(), type: "thread.create", projectId, threadId, sessionId: randomUUID() });
    const thread = (await rpc(d.port, "shell.snapshot", {})).result.threads.find((t: { id: string }) => t.id === threadId);
    assert.ok(thread?.worktreePath, "the thread works in a worktree of its own");

    // What the client does with a video: the bytes go up on their own, before
    // the message, so neither end ever holds the file.
    const body = Buffer.alloc(3 * 1024 * 1024, 9);
    const up = await fetch(`${base}/upload?thread=${threadId}&name=clip.mp4`, {
      method: "POST", body, headers: { "content-type": "video/mp4" },
    });
    const said = await up.text();
    assert.equal(up.status, 200, said);
    const answer = JSON.parse(said) as { path: string; name: string; bytes: number };
    assert.equal(answer.name, "clip.mp4");
    assert.equal(answer.bytes, body.byteLength);
    assert.equal(answer.path, join(threadFilesDir(thread.worktreePath, threadId), "clip.mp4"));
    assert.equal(readFileSync(answer.path).byteLength, body.byteLength);

    // And the `/file` route serves it back, so the picture the reader sent is
    // the picture the page paints.
    const got = await fetch(`${base}/file?thread=${threadId}&path=${encodeURIComponent(answer.path)}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "video/mp4");
    assert.equal(Number(got.headers.get("content-length")), body.byteLength);

    // The store keeps itself out of git wherever the thread works, which is
    // the whole reason a 3 MB file left there costs nothing.
    assert.equal(readFileSync(join(thread.worktreePath, ".covey", ".gitignore"), "utf8"), "*\n");
  } finally {
    remote.drop();
  }
});

test("a thread this daemon does not hold writes nothing, and says so", async () => {
  const d = await startDaemon({ name: "upload-nothread" });
  const res = await fetch(`http://127.0.0.1:${d.port}/upload?thread=${randomUUID()}&name=clip.mp4`, {
    method: "POST", body: "x",
  });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no such thread on this machine/);
});

test("the route is gated by authenticate, and by nothing else", async () => {
  const d = await startDaemon({ name: "upload-gate" });
  const lan = lanAddress();
  if (!lan) return void console.log("no address but loopback on this machine; the off-machine half is unproven here");
  const token = (JSON.parse(readFileSync(join(d.home, "daemon.json"), "utf8")) as { token: string }).token;
  const opened = await rpc(d.port, "command", { commandId: randomUUID(), type: "machine.settings", bind: "all" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  try {
    // No credentials from off the machine: 401, and before any thread is
    // looked up — a write route must not say which threads exist.
    const bare = await fetch(`http://${lan}:${d.port}/upload?thread=${randomUUID()}&name=a`, { method: "POST", body: "x" });
    assert.equal(bare.status, 401);
    assert.match(await bare.text(), /^upload: no credentials/);
    // With the token: through the gate, and then the ordinary answer. The web
    // client is off on this daemon and has no say here, which is `/file`'s own
    // rule — the machine that holds a thread is often not the one serving the
    // page, and gating on `webEnabled` made every file on a second machine
    // unreachable.
    const withToken = await fetch(`http://${lan}:${d.port}/upload?token=${encodeURIComponent(token)}&thread=${randomUUID()}&name=a`, { method: "POST", body: "x" });
    assert.equal(withToken.status, 404, await withToken.text());
  } finally {
    await rpc(d.port, "command", { commandId: randomUUID(), type: "machine.settings", bind: "loopback" });
  }
});

test("nothing is left behind when an upload is cut short", async () => {
  const remote = await scratchRemote("covey-upload-cut-");
  try {
    const d = await startDaemon({ name: "upload-cut" });
    await rpc(d.port, "command", { commandId: randomUUID(), type: "project.create", url: remote.url });
    const projectId = (await rpc(d.port, "shell.snapshot", {})).result.projects[0]!.id;
    const threadId = randomUUID();
    await rpc(d.port, "command", { commandId: randomUUID(), type: "thread.create", projectId, threadId, sessionId: randomUUID() });
    const thread = (await rpc(d.port, "shell.snapshot", {})).result.threads.find((t: { id: string }) => t.id === threadId);

    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(4096)); },
      pull() { throw new Error("the phone lost the link"); },
    });
    await fetch(`http://127.0.0.1:${d.port}/upload?thread=${threadId}&name=clip.mp4`, {
      method: "POST", body, duplex: "half",
    } as RequestInit).catch(() => {});
    await new Promise((done) => setTimeout(done, 100));
    // A truncated video in the store is a video the agent reads as whole.
    assert.equal(existsSync(join(threadFilesDir(thread.worktreePath, threadId), "clip.mp4")), false);
  } finally {
    remote.drop();
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
