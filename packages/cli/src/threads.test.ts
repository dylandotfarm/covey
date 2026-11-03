/**
 * `covey threads`, the shell face of a pooled project.
 *
 * Two halves, as `loop.test.ts` has. The parser is pure, so each spelling is
 * proven without a daemon. The rest runs against a fleet of stand-in machines
 * — a `connect` that answers from a table keyed by URL — because the thing
 * worth proving is what happens across *several* machines: that the threads of
 * both come back, that a machine in another fleet is left out, and that a
 * machine which will not answer becomes a line rather than a project that
 * reads as empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerMachine, Project, Thread, TimelineItem } from "@covey/protocol";
import {
  DEFAULT_READ_ITEMS, ago, parseThreadsArgs, renderGet, resolveThread, runThreads,
  type FleetThread,
} from "./threads.js";
import type { Rpc } from "./loop.js";

const parse = (line: string) => parseThreadsArgs(line.split(" "));
const request = (line: string) => { const r = parse(line); assert.ok("request" in r, `${line}: ${JSON.stringify(r)}`); return r.request; };
const error = (line: string) => { const r = parse(line); assert.ok("error" in r, `${line} parsed`); return r.error; };

test("each spelling asks for what it says", () => {
  assert.deepEqual(request("threads"), { kind: "list", all: false });
  assert.deepEqual(request("threads list"), { kind: "list", all: false });
  assert.deepEqual(request("threads --all"), { kind: "list", all: true });
  assert.deepEqual(request("threads read 4f21"), { kind: "read", id: "4f21", limit: DEFAULT_READ_ITEMS });
  assert.deepEqual(request("threads read 4f21 --limit 5"), { kind: "read", id: "4f21", limit: 5 });
  assert.deepEqual(request("threads files 4f21"), { kind: "files", id: "4f21", dir: "" });
  assert.deepEqual(request("threads files 4f21 src"), { kind: "files", id: "4f21", dir: "src" });
  assert.deepEqual(request("threads get 4f21 notes.md"), { kind: "get", id: "4f21", path: "notes.md", out: null });
  // `--thread` and `--port` belong to the caller and are stepped over, so a
  // word after one of them is never mistaken for a subcommand or an id.
  assert.deepEqual(request("threads read 4f21 --thread t-1 --port 3799"), { kind: "read", id: "4f21", limit: DEFAULT_READ_ITEMS });
});

test("--out is made absolute, so the file lands where the agent stands", () => {
  const r = request("threads get 4f21 shot.png --out shot.png");
  assert.ok(r.kind === "get" && r.out?.startsWith("/"), JSON.stringify(r));
});

test("a bad spelling is a sentence, not a stack", () => {
  assert.match(error("threads read"), /needs the id of a thread/);
  assert.match(error("threads read 4f21 --limit 0"), /whole number above zero/);
  assert.match(error("threads read 4f21 --limit"), /--limit needs a value/);
  assert.match(error("threads files"), /needs the id of a thread/);
  assert.match(error("threads get 4f21"), /needs a thread and a file/);
  assert.match(error("threads send 4f21 hello"), /does not know send/);
  assert.match(error("threads --everything"), /does not know --everything/);
});

// ---- a stand-in fleet -------------------------------------------------------

interface FakeMachine {
  name: string;
  machineId: string;
  fleet?: string | null;
  projects: Project[];
  threads: Thread[];
  peers?: PeerMachine[];
  items?: Record<string, TimelineItem[]>;
  dirs?: Record<string, { name: string; isDir: boolean }[]>;
  files?: Record<string, Buffer>;
  /** This machine will not answer at all, with this reason. */
  down?: string;
  /** This machine runs a covey from before `thread.readFile`. */
  old?: boolean;
  /** This machine answers `hello` and then nothing, as a sleeping one does. */
  silent?: boolean;
}

function localProject(id: string): Project {
  return { id, title: "testproject", workspaceRoot: `/projects/local/testproject`, repositoryIdentity: null, kind: "local", localId: "testproject", defaultModel: null } as unknown as Project;
}

function thread(id: string, projectId: string, title: string, lastMessageAt: string): Thread {
  return { id, projectId, title, status: "idle", pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt, archivedAt: null, pinnedAt: null, movedTo: null, branch: null, worktreePath: "/projects/local/testproject", lastError: null } as unknown as Thread;
}

/** A `connect` over a table of machines, keyed by the URL that reaches each. */
function fleet(machines: Record<string, FakeMachine>) {
  const dialled: string[] = [];
  const connect = async (url: string): Promise<Rpc> => {
    dialled.push(url);
    const m = machines[url.split("?")[0]!];
    if (!m) throw new Error("connection refused");
    if (m.down) throw new Error(m.down);
    return {
      call: async (method: string, params: any) => {
        switch (method) {
          case "hello": return { machineId: m.machineId, name: m.name, settings: { fleet: m.fleet ?? null } };
          case "shell.snapshot":
            // A machine that answered the handshake and then went quiet.
            if (m.silent) return new Promise(() => {});
            return { projects: m.projects, threads: m.threads };
          case "machine.access": return { peers: m.peers ?? [] };
          case "thread.snapshot": return { items: (m.items?.[params.threadId] ?? []).slice(-params.limit), hasMore: false };
          case "thread.listDir": return { dir: params.dir, entries: m.dirs?.[params.dir] ?? [], truncated: false };
          case "thread.readFile": {
            if (m.old) throw new Error("unknown method thread.readFile");
            const bytes = m.files?.[params.path];
            if (!bytes) throw new Error(`${params.path} is not in the thread's directory`);
            return { path: params.path, bytes: bytes.toString("base64"), size: bytes.length, truncated: false };
          }
          default: throw new Error(`unknown method ${method}`);
        }
      },
      close: () => {},
    } as unknown as Rpc;
  };
  return { connect, dialled };
}

const BOX = "ws://127.0.0.1:3790";
const PI = "ws://pi.tail.ts.net:3790";

/** box holds the thread this command speaks for; pi holds the same project. */
function twoMachines(over: { piFleet?: string | null; piDown?: string; piOld?: boolean; piSilent?: boolean; peers?: PeerMachine[] } = {}) {
  const box: FakeMachine = {
    name: "box", machineId: "box-id",
    projects: [localProject("p-box")],
    threads: [thread("17f97b1b-aaaa", "p-box", "write a random sentence about birds", "2026-11-02T00:22:00.000Z")],
    peers: over.peers ?? [{ name: "pi", url: PI }],
    items: { "17f97b1b-aaaa": [
      { kind: "user", text: "this is a test: write a random sentence about birds" } as unknown as TimelineItem,
      { kind: "tool", summary: "Read notes.md", toolName: "Read" } as unknown as TimelineItem,
      { kind: "thinking", text: "a heron, maybe" } as unknown as TimelineItem,
      { kind: "assistant", text: "A heron stood still in the shallows\nuntil the water forgot it was there." } as unknown as TimelineItem,
    ] },
    dirs: { "": [{ name: "src", isDir: true }, { name: "birds.txt", isDir: false }] },
    files: { "birds.txt": Buffer.from("A heron stood still.\n"), "shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
  };
  const pi: FakeMachine = {
    name: "pi", machineId: "pi-id", fleet: over.piFleet ?? null,
    projects: [localProject("p-pi")],
    threads: [thread("a4c1dd02-bbbb", "p-pi", "what does the other thread say about birds?", "2026-11-02T00:23:00.000Z")],
    items: { "a4c1dd02-bbbb": [
      { kind: "user", text: "what does the other thread say about birds?" } as unknown as TimelineItem,
      { kind: "assistant", text: "I could not find out. It was not reachable." } as unknown as TimelineItem,
    ] },
    dirs: { "": [{ name: "notes.md", isDir: false }] },
    files: { "notes.md": Buffer.from("nothing yet\n") },
    ...(over.piDown ? { down: over.piDown } : {}),
    ...(over.piOld ? { old: true } : {}),
    ...(over.piSilent ? { silent: true } : {}),
  };
  return fleet({ [BOX]: box, [PI]: pi });
}

const env = { threadId: "17f97b1b-aaaa", port: 3790 };

test("the list holds the threads of both machines, newest first, with this one marked", async () => {
  const { connect, dialled } = twoMachines();
  const out = await runThreads({ kind: "list", all: false }, env, { connect });
  assert.equal(out.ok, true, out.lines.join("\n"));
  const text = out.lines.join("\n");
  assert.match(text, /testproject — a local project in fleet covey/);
  assert.match(text, /a4c1dd02 {2}pi .*what does the other thread say about birds\?/);
  assert.match(text, /17f97b1b {2}box .*\(this thread\)/);
  // pi's row is above box's: it spoke last.
  assert.ok(text.indexOf("a4c1dd02") < text.indexOf("17f97b1b"), text);
  assert.deepEqual(dialled, [BOX, PI]);
});

test("a machine in another fleet is left out, and is not reported as a failure", async () => {
  const { connect } = twoMachines({ piFleet: "work" });
  const out = await runThreads({ kind: "list", all: false }, env, { connect });
  const text = out.lines.join("\n");
  assert.doesNotMatch(text, /a4c1dd02/, text);
  assert.doesNotMatch(text, /could not read/, text);
});

test("a machine that will not answer is one line saying which and why", async () => {
  const { connect } = twoMachines({ piDown: "connection refused" });
  const out = await runThreads({ kind: "list", all: false }, env, { connect });
  assert.equal(out.ok, true);
  const text = out.lines.join("\n");
  // The threads this machine does hold still come back. A fleet member that is
  // away must never read as a project with nothing in it — that is the bug.
  assert.match(text, /17f97b1b/, text);
  assert.match(text, /could not read pi: connection refused/, text);
});

test("a machine that knows of no other says so, as a statement and not a failure", async () => {
  // A project really can be on one machine, and that reader must not be told
  // an error on every run. What they are owed is the reason the list is short.
  const { connect } = twoMachines({ peers: [] });
  const out = await runThreads({ kind: "list", all: false }, env, { connect });
  const text = out.lines.join("\n");
  assert.equal(out.ok, true);
  assert.match(text, /this machine knows of no other, so this is its own threads alone/);
  assert.doesNotMatch(text, /could not read/, "a machine alone on purpose is not a machine that failed");
  assert.match(text, /17f97b1b/, "its own threads still print");
});

test("the budget covers the whole exchange, not the dial alone", async () => {
  // The hazard: a machine that answers the handshake and then stops — a laptop
  // that sleeps a second after the dial. Without a bound on the exchange this
  // command hangs until TCP gives up, and holds back every machine that did
  // answer.
  const { connect } = twoMachines({ piSilent: true });
  const started = Date.now();
  const out = await runThreads({ kind: "list", all: false }, env, { connect, budgetMs: 60 });
  const text = out.lines.join("\n");
  assert.ok(Date.now() - started < 5_000, `the command must give up on pi inside the budget, not wait on it: ${Date.now() - started}ms`);
  assert.match(text, /could not read pi: no answer in 0\.06s/, text);
  assert.match(text, /17f97b1b/, "box's own threads still print");
});

test("a thread of this machine reads back as prose: what was said, each call on one line, no thoughts", async () => {
  const { connect, dialled } = twoMachines();
  const out = await runThreads({ kind: "read", id: "17f97b1b", limit: 60 }, env, { connect });
  assert.equal(out.ok, true, out.lines.join("\n"));
  const text = out.lines.join("\n");
  assert.match(text, /user: this is a test: write a random sentence about birds/);
  assert.match(text, /agent: A heron stood still in the shallows\n {2}until the water forgot it was there\./);
  assert.match(text, /tool: Read notes\.md/);
  assert.doesNotMatch(text, /a heron, maybe/, "a thought is never read back");
  // The thread is this machine's own, so no second connection is made for it.
  assert.deepEqual(dialled, [BOX, PI]);
});

test("a thread on the other machine is read from that machine — the whole point of this", async () => {
  // Box's agent asks what pi's thread said. This is the test of 2026-11-02 that
  // failed: `covey threads read` is the answer it did not have.
  const { connect, dialled } = twoMachines();
  const out = await runThreads({ kind: "read", id: "a4c1", limit: 60 }, env, { connect });
  assert.equal(out.ok, true, out.lines.join("\n"));
  const text = out.lines.join("\n");
  assert.match(text, /thread a4c1dd02 on pi — what does the other thread say about birds\?/);
  assert.match(text, /agent: I could not find out\./);
  assert.deepEqual(dialled, [BOX, PI, PI], "pi is dialled once to find the thread and once to read it");

  // And its files, from the same machine.
  const files = await runThreads({ kind: "files", id: "a4c1", dir: "" }, env, { connect });
  assert.match(files.lines.join("\n"), /notes\.md/);
  const got = await runThreads({ kind: "get", id: "a4c1", path: "notes.md", out: null }, env, { connect });
  assert.match(got.lines.join("\n"), /nothing yet/);
});

test("an id is as much of it as names one thread", () => {
  const threads = [
    { thread: thread("aaaa1111", "p", "one", null as any), machine: "box", url: "", here: false, workspace: null },
    { thread: thread("aaaa2222", "p", "two", null as any), machine: "pi", url: PI, here: false, workspace: null },
  ] as FleetThread[];
  assert.equal(("thread" in resolveThread(threads, "aaaa1111") ? "ok" : "no"), "ok");
  assert.equal(("thread" in resolveThread(threads, "aaaa2") ? "ok" : "no"), "ok");
  const many = resolveThread(threads, "aaaa");
  assert.ok("error" in many && /names 2 threads/.test(many.error), JSON.stringify(many));
  const none = resolveThread(threads, "zz");
  assert.ok("error" in none && /no thread of this project starts with zz/.test(none.error), JSON.stringify(none));
});

test("the files of a thread, and one of them read back", async () => {
  const { connect } = twoMachines();
  const listed = await runThreads({ kind: "files", id: "17f9", dir: "" }, env, { connect });
  assert.match(listed.lines.join("\n"), /src\/\n {2}birds\.txt/);

  const got = await runThreads({ kind: "get", id: "17f9", path: "birds.txt", out: null }, env, { connect });
  assert.equal(got.ok, true, got.lines.join("\n"));
  assert.match(got.lines.join("\n"), /A heron stood still\./);

  const missing = await runThreads({ kind: "get", id: "17f9", path: "nope.md", out: null }, env, { connect });
  assert.equal(missing.ok, false);
  assert.match(missing.lines[0]!, /nope\.md is not in the thread's directory/);
});

test("bytes that are not text are never printed; --out writes them here", async () => {
  const { connect } = twoMachines();
  const shown = await runThreads({ kind: "get", id: "17f9", path: "shot.png", out: null }, env, { connect });
  assert.match(shown.lines.join("\n"), /is not text.*--out/s);

  const dir = mkdtempSync(join(tmpdir(), "covey-threads-"));
  const file = join(dir, "shot.png");
  const saved = await runThreads({ kind: "get", id: "17f9", path: "shot.png", out: file }, env, { connect });
  assert.match(saved.lines.join("\n"), new RegExp(`→ ${file} \\(6 bytes\\)`));
  assert.deepEqual([...readFileSync(file)], [0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
});

test("a truncated file says how much of it came back", () => {
  const t = { thread: thread("aaaa1111", "p", "one", null as any), machine: "pi", url: PI, here: false, workspace: null } as FleetThread;
  const lines = renderGet(t, { path: "big.log", bytes: Buffer.from("head").toString("base64"), size: 9000, truncated: true }, null, () => {});
  assert.match(lines.join("\n"), /4 of 9000 bytes/);
});

test("a command with no thread never reaches a daemon", async () => {
  const { connect, dialled } = twoMachines();
  const out = await runThreads({ kind: "list", all: false }, { threadId: undefined, port: 3790 }, { connect });
  assert.equal(out.ok, false);
  assert.match(out.lines[0]!, /COVEY_THREAD_ID/);
  assert.deepEqual(dialled, []);
});

test("how long ago, in the fewest words that say it", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  assert.equal(ago(null, now), "never");
  assert.equal(ago("2026-11-02T11:59:30.000Z", now), "just now");
  assert.equal(ago("2026-11-02T11:40:00.000Z", now), "20m ago");
  assert.equal(ago("2026-11-02T09:00:00.000Z", now), "3h ago");
  assert.equal(ago("2026-10-30T12:00:00.000Z", now), "3d ago");
});

test("a machine running an older covey is named as that, not as an unknown method", async () => {
  const { connect } = twoMachines({ piOld: true });
  const out = await runThreads({ kind: "get", id: "a4c1", path: "notes.md", out: null }, env, { connect });
  assert.equal(out.ok, false);
  assert.match(out.lines[0]!, /pi runs an older covey and does not know this yet/, out.lines.join("\n"));
});
