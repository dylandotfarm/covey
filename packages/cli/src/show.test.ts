/**
 * `covey show`, the shell face of #160.
 *
 * Two halves, as `loop.test.ts` has: the parser is pure and each spelling is
 * proven without a daemon, and the transport is proven against a stand-in
 * daemon on loopback that records what the command asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describeShown, parseShowArgs, runShow } from "./show.js";
import { LOOP_CLIENT as LOOP } from "./loop.js";

const requestOf = (argv: string[]) => { const r = parseShowArgs(argv); assert.ok("request" in r, JSON.stringify(r)); return r.request; };
const error = (argv: string[]) => { const r = parseShowArgs(argv); assert.ok("error" in r, `${argv.join(" ")} parsed`); return r.error; };

test("every file is named absolute, in the order given, because the daemon reads them from its own cwd", () => {
  const r = requestOf(["show", "shot.png", "--text", "the sidebar after the fix", "/abs/demo.mp4"]);
  assert.equal(r.text, "the sidebar after the fix");
  assert.deepEqual(r.files, [
    { name: "shot.png", path: join(process.cwd(), "shot.png") },
    { name: "demo.mp4", path: "/abs/demo.mp4" },
  ]);
});

test("a file is all it takes; the words are optional", () => {
  assert.deepEqual(requestOf(["show", "/a/shot.png"]), { text: "", files: [{ name: "shot.png", path: "/a/shot.png" }] });
});

test("--thread and --port are the caller's flags, and are not mistaken for files", () => {
  const r = requestOf(["show", "--thread", "t-1", "/a/shot.png", "--port", "3799"]);
  assert.deepEqual(r.files, [{ name: "shot.png", path: "/a/shot.png" }]);
});

test("a bad spelling is a sentence, not a stack", () => {
  assert.match(error(["show"]), /needs a file/);
  assert.match(error(["show", "--text", "words only"]), /needs a file/);
  assert.match(error(["show", "a.png", "--text"]), /--text needs one line/);
  assert.match(error(["show", "a.png", "--attach", "b.png"]), /does not know --attach/);
  assert.match(error(["show", ...Array.from({ length: 21 }, (_, i) => `f${i}.png`)]), /20 files at a time/);
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

test("the thread goes into hello, and the files go to the daemon as name and path", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  const files = [{ name: "shot.png", path: "/w/shot.png" }];
  d.answer = () => ({ files: [{ name: "shot.png", path: "/w/.covey/threads/t-1/files/shot.png" }] });
  const out = await runShow({ text: "after the fix", files }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, true);
  assert.deepEqual(d.calls[0], { method: "hello", params: { protocolVersion: 1, client: LOOP, threadId: "t-1" } });
  assert.deepEqual(d.calls[1], { method: "thread.showFiles", params: { threadId: "t-1", text: "after the fix", files } });
  assert.match(out.lines[0]!, /showing 1 file/);
  assert.match(out.lines[1]!, /shot\.png {2}\/w\/\.covey\/threads\/t-1\/files\/shot\.png/, "the copy's path, so a later --attach can name it");
});

test("a refusal from the daemon is the daemon's sentence, and no thread is a sentence too", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => { throw new Error("thread.showFiles answers a connection from this machine only"); };
  const refused = await runShow({ text: "", files: [{ name: "a.png", path: "/a.png" }] }, { threadId: "t-1", port: d.port });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.lines, ["thread.showFiles answers a connection from this machine only"]);

  const none = await runShow({ text: "", files: [{ name: "a.png", path: "/a.png" }] }, { threadId: undefined, port: d.port });
  assert.equal(none.ok, false);
  assert.match(none.lines[0]!, /COVEY_THREAD_ID/);
  assert.equal(d.calls.length, 2, "a command with no thread never reaches the daemon");
});

test("what the agent reads back says where a reader sees the file", () => {
  const lines = describeShown([{ name: "a.png", path: "/s/a.png" }, { name: "b.mp4", path: "/s/b.mp4" }]);
  assert.match(lines[0]!, /showing 2 files/);
  assert.match(lines[0]!, /inline on a phone/);
  assert.equal(lines.length, 3);
});
