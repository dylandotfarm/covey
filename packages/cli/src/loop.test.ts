/**
 * `covey issue …` and `covey pr …`, the shell face of the loop of #94.
 *
 * Two halves. The parser is pure, so each spelling is proven to ask for the
 * right thing without a daemon. The transport is proven against a stand-in
 * daemon on loopback: a `ws` server that answers `hello` and records what the
 * command asked, so the test can read that the thread went into `hello` and
 * that each request became the right method with the right params. No real
 * daemon, no `gh`, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { Thread } from "@covey/protocol";
import { describeThread, parseLoopArgs, runLoop, LOOP_CLIENT } from "./loop.js";

const parse = (line: string) => parseLoopArgs(line.split(" "));
const requestOf = (argv: string[]) => { const r = parseLoopArgs(argv); assert.ok("request" in r, `${argv.join(" ")}: ${JSON.stringify(r)}`); return r.request; };
const request = (line: string) => requestOf(line.split(" "));
const error = (line: string) => { const r = parse(line); assert.ok("error" in r, `${line} parsed`); return r.error; };

test("each spelling asks for what it says", () => {
  assert.deepEqual(request("issue take 94"), { kind: "issue.take", issue: 94 });
  assert.deepEqual(request("issue drop"), { kind: "issue.take", issue: null });
  assert.deepEqual(requestOf(["pr", "open", "--title", "Fix the flag", "--body", "It was wrong."]),
    { kind: "pr.open", title: "Fix the flag", body: "It was wrong.", draft: false, merge: "manual", mergeMethod: "merge" });
  assert.deepEqual(requestOf(["pr", "open", "--title", "x", "--auto", "--squash", "--draft", "--rounds", "5"]),
    { kind: "pr.open", title: "x", body: "", draft: true, merge: "auto", mergeMethod: "squash", maxRounds: 5 });
  assert.deepEqual(request("pr watch 7"), { kind: "pr.watch", number: 7, merge: "manual", mergeMethod: "merge" });
  assert.deepEqual(request("pr watch 7 --auto --rebase"), { kind: "pr.watch", number: 7, merge: "auto", mergeMethod: "rebase" });
  assert.deepEqual(request("pr watch --stop"), { kind: "pr.watch", number: null, merge: "manual", mergeMethod: "merge" });
  assert.deepEqual(request("pr policy auto"), { kind: "pr.policy", merge: "auto" });
  assert.deepEqual(request("pr policy manual --squash"), { kind: "pr.policy", merge: "manual", mergeMethod: "squash" });
  assert.deepEqual(request("pr status"), { kind: "pr.status" });
});

test("the policy is manual unless --auto is spelled out", () => {
  const open = request("pr open --title x");
  assert.equal(open.kind === "pr.open" && open.merge, "manual");
  const watch = request("pr watch 7");
  assert.equal(watch.kind === "pr.watch" && watch.merge, "manual");
});

test("a bad spelling is a sentence, not a stack", () => {
  assert.match(error("issue take"), /needs a number/);
  assert.match(error("issue take abc"), /needs a number/);
  assert.match(error("issue close 1"), /take <n>/);
  assert.match(error("pr open"), /needs --title/);
  assert.match(error("pr open --title x --rounds 0"), /whole number above zero/);
  assert.match(error("pr watch"), /needs a number/);
  assert.match(error("pr policy sometimes"), /auto/);
  assert.match(error("pr merge 7"), /open.*watch.*policy.*status/);
  assert.match(error("pr open --title x --body-file /nonexistent/body.md"), /could not read --body-file/);
});

test("--body-file reads the body from disk, so a long body needs no quoting", () => {
  const dir = mkdtempSync(join(tmpdir(), "covey-loop-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, "What changed.\n\nWhy.\n");
    const r = requestOf(["pr", "open", "--title", "x", "--body-file", file]);
    assert.equal(r.kind === "pr.open" && r.body, "What changed.\n\nWhy.\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the transport ---------------------------------------------------------------

interface FakeDaemon { port: number; calls: { method: string; params: any }[]; close(): void; answer: (method: string, params: any) => unknown }

/** A daemon that answers `hello` and whatever `answer` says, and keeps every call. */
function fakeDaemon(): Promise<FakeDaemon> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const d: FakeDaemon = {
      port: 0, calls: [],
      close: () => wss.close(),
      answer: () => null,
    };
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

test("the thread goes into hello, and each request becomes the right method", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = (method) => method === "thread.openPullRequest" ? { number: 101, url: "https://github.com/o/r/pull/101" } : { seq: 1 };
  const env = { threadId: "t-1", port: d.port };

  const open = await runLoop({ kind: "pr.open", title: "Fix", body: "Body", draft: false, merge: "auto", mergeMethod: "squash", maxRounds: 2 }, env);
  assert.equal(open.ok, true);
  assert.match(open.lines[0]!, /opened pull request #101 https:\/\/github.com\/o\/r\/pull\/101/);
  assert.match(open.lines[1]!, /merge policy: auto.*do not poll/);
  assert.deepEqual(d.calls[0], { method: "hello", params: { protocolVersion: 1, client: LOOP_CLIENT, threadId: "t-1" } });
  assert.equal(d.calls[1]!.method, "thread.openPullRequest");
  assert.deepEqual(d.calls[1]!.params, { threadId: "t-1", title: "Fix", body: "Body", draft: false, merge: "auto", mergeMethod: "squash", maxRounds: 2 });

  const take = await runLoop({ kind: "issue.take", issue: 94 }, env);
  assert.equal(take.ok, true);
  const cmd = d.calls.at(-1)!;
  assert.equal(cmd.method, "command");
  assert.equal(cmd.params.type, "thread.takeIssue");
  assert.equal(cmd.params.issue, 94);
  assert.equal(cmd.params.threadId, "t-1");
  assert.ok(cmd.params.commandId, "a command carries an id, so a retry is not a second command");

  await runLoop({ kind: "pr.policy", merge: "manual" }, env);
  assert.deepEqual({ ...d.calls.at(-1)!.params, commandId: "" }, { type: "thread.setMerge", merge: "manual", threadId: "t-1", commandId: "" });
});

test("a refusal from the daemon is the daemon's sentence, and no thread is a sentence too", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  d.answer = () => { throw new Error("issue #94 is held by thread t-0 (Other work)"); };
  const out = await runLoop({ kind: "issue.take", issue: 94 }, { threadId: "t-1", port: d.port });
  assert.equal(out.ok, false);
  assert.deepEqual(out.lines, ["issue #94 is held by thread t-0 (Other work)"]);

  const none = await runLoop({ kind: "pr.status" }, { threadId: undefined, port: d.port });
  assert.equal(none.ok, false);
  assert.match(none.lines[0]!, /COVEY_THREAD_ID/);
  assert.equal(d.calls.length, 2, "a command with no thread never reaches the daemon");
});

test("status reads as lines an agent can act on", () => {
  const t = {
    id: "t-1", branch: "covey/abc",
    issue: { number: 94, title: "Take an issue", url: "https://github.com/o/r/issues/94", takenAt: "" },
    pullRequest: { number: 101, url: "https://github.com/o/r/pull/101", branch: "covey/abc", base: "main", openedAt: "" },
    watch: { number: 101, state: "blocked", reason: "the rounds ran out", merge: "auto", mergeMethod: "merge", rounds: 3, maxRounds: 3, error: "gh: not logged in" },
  } as unknown as Thread;
  assert.deepEqual(describeThread(t), [
    "issue: #94 Take an issue https://github.com/o/r/issues/94",
    "branch: covey/abc",
    "pull request: #101 https://github.com/o/r/pull/101 into main",
    "watch: blocked (the rounds ran out)",
    "merge policy: auto (merge); rounds used: 3 of 3",
    "last poll error: gh: not logged in",
  ]);
  assert.deepEqual(describeThread({ id: "t", branch: null } as unknown as Thread), ["issue: none taken", "branch: none", "pull request: none opened through covey", "watch: none"]);
});
