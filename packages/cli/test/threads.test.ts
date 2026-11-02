/**
 * `covey threads` against two real daemons.
 *
 * The unit test proves the rules against stand-in machines. This proves the
 * part no stand-in can: that one daemon's CLI dials another daemon, that the
 * same local project on both folds into one, and that `thread.readFile` hands
 * over a file the other machine wrote. Two covey homes, two ports, one project
 * name; nothing here reaches a network or a model.
 *
 * The test of 2026-11-02 is what it reproduces. Two machines held the same
 * local project, and the agent on each could see only its own thread.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startDaemon, stopAll, type TestDaemon } from "../../daemon/test/daemons.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "src", "index.ts");
const run = promisify(execFile);

/** The same bound `stop.test.ts` uses: booting the CLI under tsx is the slow
 *  part, and this one also dials a second daemon. */
const CLI_BUDGET_MS = 150_000;

after(stopAll);

/**
 * Two daemons for the whole file, started once.
 *
 * A daemon start is the expensive part of this suite and the one that loses a
 * race for a port on a loaded machine (#53), so the file pays for two and no
 * more. Each test names its own project, which is what keeps them apart.
 */
let box!: TestDaemon;
let pi!: TestDaemon;
before(async () => { [box, pi] = await Promise.all([startDaemon({ name: "box" }), startDaemon({ name: "pi" })]); });

/** One socket, several calls. The daemon answers loopback without a token. */
async function talk<T>(port: number, work: (call: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("dial")); });
  let id = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const n = ++id;
    const on = (ev: MessageEvent) => {
      const r = JSON.parse(String(ev.data));
      if (r.id !== n) return;
      ws.removeEventListener("message", on);
      r.ok ? res(r.result) : rej(new Error(r.error?.message ?? "refused"));
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  try {
    await call("hello", { protocolVersion: 1, client: "covey-tui" });
    return await work(call);
  } finally {
    ws.close();
  }
}

/** A local project of this name on `d`, with one thread in it. Its id. */
async function seed(d: TestDaemon, title: string): Promise<{ projectId: string; threadId: string; dir: string }> {
  return talk(d.port, async (call) => {
    await call("command", { commandId: randomUUID(), type: "project.create", local: title });
    const snap = await call("shell.snapshot", {});
    const project = snap.projects.find((p: { localId?: string }) => p.localId === title);
    assert.ok(project, `the local project ${title} should exist on this daemon`);
    const threadId = randomUUID();
    await call("command", { commandId: randomUUID(), type: "thread.create", projectId: project.id, threadId, sessionId: randomUUID(), title: `work on ${d.port}` });
    return { projectId: project.id, threadId, dir: project.workspaceRoot as string };
  });
}

/** Run the CLI as the agent in `threadId` on the daemon at `port` would. */
async function covey(d: TestDaemon, threadId: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const env = { ...process.env, COVEY_HOME: d.home, COVEY_PORT: String(d.port), COVEY_THREAD_ID: threadId };
  try {
    const r = await run(process.execPath, ["--import", "tsx", cliEntry, ...args], { env, timeout: CLI_BUDGET_MS });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

test("an agent on one machine reads the threads and the files of the same project on another", async () => {
  const [a, b] = [box, pi];
  const [mine, theirs] = await Promise.all([seed(a, "testproject"), seed(b, "testproject")]);

  // What the thread on pi wrote into the project's one directory. Every thread
  // of a local project works there, so this is the file box's agent is after.
  writeFileSync(join(theirs.dir, "birds.txt"), "A heron stood still in the shallows.\n");

  // Before the fleet list: box knows only itself, and says so rather than
  // answering with its own thread as if that were the whole project.
  const alone = await covey(a, mine.threadId, "threads");
  assert.equal(alone.code, 0, alone.out);
  assert.match(alone.out, /this machine knows of no other/, alone.out);

  // What the TUI hands every connected daemon (`machine.peers`).
  await talk(a.port, (call) => call("command", { commandId: randomUUID(), type: "machine.peers", machines: [{ name: "pi", url: `ws://127.0.0.1:${b.port}` }] }));

  const listed = await covey(a, mine.threadId, "threads");
  assert.equal(listed.code, 0, listed.out);
  assert.match(listed.out, /testproject — a local project in fleet covey/, listed.out);
  assert.match(listed.out, new RegExp(`${theirs.threadId.slice(0, 8)}\\s+pi\\s`), `pi's thread should be in the list:\n${listed.out}`);
  assert.match(listed.out, new RegExp(`${mine.threadId.slice(0, 8)}\\s+box\\s`), listed.out);
  assert.match(listed.out, /\(this thread\)/, listed.out);

  // Its files, and one of them, over the wire from the other daemon.
  const files = await covey(a, mine.threadId, "threads", "files", theirs.threadId.slice(0, 8));
  assert.equal(files.code, 0, files.out);
  assert.match(files.out, /birds\.txt/, files.out);

  const got = await covey(a, mine.threadId, "threads", "get", theirs.threadId.slice(0, 8), "birds.txt");
  assert.equal(got.code, 0, got.out);
  assert.match(got.out, /A heron stood still in the shallows\./, got.out);

  // The boundary holds across the wire as well: a path that leaves the
  // thread's directory is refused by name rather than read.
  const out = await covey(a, mine.threadId, "threads", "get", theirs.threadId.slice(0, 8), "../../../etc/hostname");
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /outside the thread's directory/, out.out);
});

test("a thread of a different project on the other machine is not in this project's list", async () => {
  const [a, b] = [box, pi];
  const [mine, other] = await Promise.all([seed(a, "notes"), seed(b, "ledger")]);
  // The peer list is the machine's and not the project's, so box asks pi
  // about every project it holds. Set again here rather than leaned on from
  // the test above: a test that reads another test's state is one that breaks
  // the day somebody runs it alone.
  await talk(a.port, (call) => call("command", { commandId: randomUUID(), type: "machine.peers", machines: [{ name: "pi", url: `ws://127.0.0.1:${b.port}` }] }));
  const listed = await covey(a, mine.threadId, "threads");
  assert.equal(listed.code, 0, listed.out);
  assert.match(listed.out, /notes — a local project/, listed.out);
  assert.doesNotMatch(listed.out, new RegExp(other.threadId.slice(0, 8)), `a different project on pi is not this project:\n${listed.out}`);
});
