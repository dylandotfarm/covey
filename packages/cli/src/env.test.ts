/**
 * `covey env`, the shell face of the secrets of #126.
 *
 * Two halves, as `loop.test.ts` has: the parser is pure, and the transport
 * runs against a stand-in daemon on loopback. The case that matters most is
 * the one that holds the whole feature up — what this command prints must
 * never be a value, because what it prints is the agent's transcript.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { SecretEntry } from "@covey/protocol";
import { describeSecrets, parseEnvArgs, runEnv } from "./env.js";
import { LOOP_CLIENT } from "./loop.js";

const request = (line: string) => { const r = parseEnvArgs(line.split(" ")); assert.ok("request" in r, line); return r.request; };
const error = (line: string) => { const r = parseEnvArgs(line.split(" ")); assert.ok("error" in r, `${line} parsed`); return r.error; };

test("each spelling asks for what it says", () => {
  assert.deepEqual(request("env"), { kind: "list" });
  assert.deepEqual(request("env list"), { kind: "list" });
  assert.deepEqual(request("env exec -- ./deploy.sh --now"), { kind: "exec", command: "./deploy.sh", args: ["--now"] });
  // `--` is the usual way to end a command's own flags, and it is optional.
  assert.deepEqual(request("env exec curl -sS https://api.example.com"), { kind: "exec", command: "curl", args: ["-sS", "https://api.example.com"] });
});

test("a bad spelling is a sentence, not a stack", () => {
  assert.match(error("env set A=b"), /takes `list` or `exec/);
  assert.match(error("env exec"), /needs a command/);
  assert.match(error("env exec --"), /needs a command/);
});

test("the list an agent reads names the secrets and never a value", () => {
  const secrets: SecretEntry[] = [
    { key: "AWS_ID", scope: "project", updatedAt: "" },
    { key: "STRIPE_KEY", scope: "thread", overrides: true, updatedAt: "" },
    { key: "TMP_TOKEN", scope: "thread", updatedAt: "" },
  ];
  const lines = describeSecrets(secrets);
  assert.match(lines[0]!, /3 secrets, already in your environment/);
  assert.match(lines[0]!, /Write \$NAME/);
  assert.match(lines[1]!, /^ {2}AWS_ID +the project$/);
  assert.match(lines[2]!, /^ {2}STRIPE_KEY {2}this thread \(hides the project's\)$/);
  assert.match(lines[3]!, /^ {2}TMP_TOKEN {3}this thread$/);

  const none = describeSecrets([]);
  assert.match(none[0]!, /no secrets/);
  assert.match(none[1]!, /press e on the project row/);
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

test("list asks secrets.list for this thread, and prints names", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => ({ secrets: [{ key: "STRIPE_KEY", scope: "project", updatedAt: "" }] });
  const out = await runEnv({ kind: "list" }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, true);
  assert.deepEqual(d.calls[0], { method: "hello", params: { protocolVersion: 1, client: LOOP_CLIENT, threadId: "t-1" } });
  assert.deepEqual(d.calls[1], { method: "secrets.list", params: { threadId: "t-1" } });
  assert.ok(out.lines.some((l) => l.includes("STRIPE_KEY")));
  assert.equal(out.run, undefined);
});

test("exec reads the environment and hands the command back for the caller to run", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => ({ env: { STRIPE_KEY: "sk_live_0123456789" } });
  const out = await runEnv({ kind: "exec", command: "./deploy.sh", args: ["--now"] }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, true);
  assert.deepEqual(d.calls[1], { method: "secrets.env", params: { threadId: "t-1" } });
  assert.deepEqual(out.run, { command: "./deploy.sh", args: ["--now"], env: { STRIPE_KEY: "sk_live_0123456789" } });
  assert.deepEqual(out.lines, [], "nothing is printed: the value must not reach the transcript");
});

test("a daemon that refuses, and a shell that is not a thread, are sentences", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => { throw new Error("secrets.env answers a connection from this machine only"); };
  const refused = await runEnv({ kind: "exec", command: "env", args: [] }, { threadId: "t-1", port: d.port });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.lines, ["secrets.env answers a connection from this machine only"]);

  const none = await runEnv({ kind: "list" }, { threadId: undefined, port: d.port });
  assert.equal(none.ok, false);
  assert.match(none.lines[0]!, /COVEY_THREAD_ID/);
  assert.equal(d.calls.length, 2, "a command with no thread never reaches the daemon");
});
