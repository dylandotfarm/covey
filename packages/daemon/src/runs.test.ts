/**
 * Regression tests for the run record in the daemon.
 *
 * Each case is a defect of the run of 2026-09-16, not a wish:
 *
 *  1. The run of that day lived in a shell script and one operator's head.
 *     A run has to outlive the client that started it, which is why the record
 *     is daemon state and why the first case reopens the database.
 *  2. Scope changed in the middle — one task was cancelled and another added —
 *     and the only way to absorb it by hand was to start over.
 *  3. A member is placed before it is dispatched, and the operator must be able
 *     to move it. A run that dispatched on creation could not offer that.
 *  4. `withdrawn` is an ordinary outcome beside `merged`. A run that can only
 *     succeed or fail records a cancelled task as a failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isFinalMemberState, runState, tallyRun, type MachineInfo, type RunInit, type RunMemberInit, type RunMemberReview } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "mac", os: "darwin", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

function member(n: number, machineId = "m1"): RunMemberInit {
  return {
    id: `mem${n}`,
    task: { key: `#${n}`, title: `Issue ${n}`, issue: n, url: null, requires: [] },
    machineId,
    projectId: "p1",
    resources: { port: 3800 + n, coveyHome: `/tmp/covey-run-${n}`, coveyConfig: `/tmp/covey-run-${n}-config` },
  };
}

function runInit(o: Partial<RunInit> = {}): RunInit {
  return {
    runId: "run-1",
    name: "covey issues",
    goal: "close the backlog",
    briefTemplate: "Work on {{issue}} on port {{port}}",
    workspaceMode: "worktree-default",
    members: [member(44), member(45), member(46)],
    ...o,
  };
}

function engine() {
  const dir = mkdtempSync(join(tmpdir(), "covey-runs-"));
  const db = new Db(dir);
  return { engine: new Engine(db, { ...MACHINE }), db, dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

async function send(e: Engine, cmd: any) {
  return e.dispatch({ ...cmd, commandId: randomUUID() });
}

test("a run outlives the process that stored it", async () => {
  const { engine: e, dir, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { threadId: "t1", branch: "covey/aaa", state: "working" } });
    // A second Engine on the same directory is what a daemon restart is.
    const again = new Engine(new Db(dir), { ...MACHINE });
    const runs = again.shellSnapshot().runs ?? [];
    assert.equal(runs.length, 1, "the run did not survive the restart — it is not in the daemon's database");
    const run = runs[0]!;
    assert.equal(run.name, "covey issues");
    assert.equal(run.members.length, 3);
    assert.equal(run.members[0]!.threadId, "t1");
    assert.equal(run.members[0]!.branch, "covey/aaa");
    assert.equal(run.members[0]!.state, "working");
  } finally { close(); }
});

test("a run is created placed, never dispatched — every member starts planned", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    const run = e.shellSnapshot().runs![0]!;
    assert.deepEqual(run.members.map((m) => m.state), ["planned", "planned", "planned"]);
    assert.deepEqual(run.members.map((m) => m.threadId), [null, null, null]);
    assert.equal(runState(run), "planning");
  } finally { close(); }
});

test("a member may be moved to another machine before dispatch", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem45", patch: { machineId: "pi", projectId: "p-pi", resources: { port: 3899, coveyHome: "/tmp/pi", coveyConfig: "/tmp/pi-config" } } });
    const m = e.shellSnapshot().runs![0]!.members[1]!;
    assert.equal(m.machineId, "pi");
    assert.equal(m.resources.port, 3899);
  } finally { close(); }
});

test("a task added mid-run does not tear the run down", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { threadId: "t1", state: "working" } });
    await send(e, { type: "run.member.add", runId: "run-1", member: member(38) });
    const run = e.shellSnapshot().runs![0]!;
    assert.equal(run.members.length, 4);
    assert.equal(run.members[0]!.state, "working", "the members already at work keep their place");
    assert.equal(run.members[3]!.task.issue, 38);
  } finally { close(); }
});

test("withdrawing a member is an outcome, not a failure — and its reasoning is kept", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { state: "merged" } });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem45", patch: { state: "withdrawn", note: "esc cannot be rebound; a second press must stay a safe no-op" } });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem46", patch: { state: "merged" } });
    const run = e.shellSnapshot().runs![0]!;
    assert.equal(run.members[1]!.note, "esc cannot be rebound; a second press must stay a safe no-op");
    assert.ok(isFinalMemberState("withdrawn"));
    assert.equal(runState(run), "finished", "a withdrawn member does not hold a run open");
    assert.equal(tallyRun(run).withdrawn, 1);
  } finally { close(); }
});

test("blocked is not an error and does not finish a run", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { state: "blocked", note: "waiting on #45's model" } });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem45", patch: { state: "merged" } });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem46", patch: { state: "merged" } });
    const run = e.shellSnapshot().runs![0]!;
    assert.equal(runState(run), "running");
    assert.equal(tallyRun(run).blocked, 1);
  } finally { close(); }
});

test("a run in a shared checkout is refused — parallel agents in one tree is the defect", async () => {
  const { engine: e, close } = engine();
  try {
    await assert.rejects(
      () => send(e, { type: "run.create", run: runInit({ workspaceMode: "checkout" }) }),
      (err: unknown) => err instanceof EngineError && err.code === "bad_workspace",
    );
  } finally { close(); }
});

test("a retried run.create does not throw away a run that has been dispatched", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { threadId: "t1", state: "working" } });
    await send(e, { type: "run.create", run: runInit() });
    const run = e.shellSnapshot().runs![0]!;
    assert.equal(run.members[0]!.threadId, "t1");
    assert.equal(run.members[0]!.state, "working");
  } finally { close(); }
});

test("a dispatched member is withdrawn, never removed — its thread did the work", async () => {
  const { engine: e, close } = engine();
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { threadId: "t1" } });
    await assert.rejects(
      () => send(e, { type: "run.member.remove", runId: "run-1", memberId: "mem44" }),
      (err: unknown) => err instanceof EngineError && err.code === "dispatched",
    );
    await send(e, { type: "run.member.remove", runId: "run-1", memberId: "mem45" });
    assert.equal(e.shellSnapshot().runs![0]!.members.length, 2);
  } finally { close(); }
});

test("review state is carried whole and never read here — the seam for issue #45", async () => {
  const { engine: e, dir, close } = engine();
  // The real shape, now that #45 owns the field. Typed on purpose: a fixture
  // that is only `unknown` would keep passing while the two halves drifted.
  const review: RunMemberReview = {
    gate: {
      memberId: "mem44", branch: "issue-44-run-model", ok: false, ci: "stale",
      checks: [{ name: "check", workflow: "ci", state: "success", startedAt: "2026-09-16T16:33:12Z", url: null }],
      refusals: [{ code: "ci-stale", message: "CI on #66 is green against an older base" }],
      evidence: null,
    },
    evidence: {
      reverted: "the placement loop in engine.ts",
      test: "packages/daemon/src/runs.test.ts → a second run is placed against what the first one carries",
      failure: "✖ a second run is placed against what the first one carries\nℹ fail 1",
      recordedAt: "2026-09-16T17:00:00Z",
    },
    queue: {
      memberId: "mem44", branch: "issue-44-run-model", label: "#44 run model",
      position: 1, total: 2, size: 1438, meets: [], brief: "You are 1 of 2 in the merge queue.",
    },
    audit: null,
    checkedAt: "2026-09-16T17:00:00Z",
  };
  try {
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { review } });
    // It has to survive the round trip through SQLite as well as the patch.
    const runs = new Engine(new Db(dir), { ...MACHINE }).shellSnapshot().runs ?? [];
    assert.equal(runs.length, 1, "the run did not survive the restart — it is not in the daemon's database");
    const run = runs[0]!;
    assert.deepEqual(run.members[0]!.review, review, "every field came back, including the nested refusals and the brief");
    assert.equal(run.members[1]!.review, null);
  } finally { close(); }
});

test("a run change reaches a client as one whole run", async () => {
  const { engine: e, close } = engine();
  try {
    const seen: any[] = [];
    e.onShell((ev) => seen.push(ev));
    await send(e, { type: "run.create", run: runInit() });
    await send(e, { type: "run.member.patch", runId: "run-1", memberId: "mem44", patch: { state: "dispatched" } });
    await new Promise((r) => setTimeout(r, 5));
    const upserts = seen.filter((ev) => ev.kind === "run.upserted");
    assert.equal(upserts.length, 2);
    assert.equal(upserts[1]!.run.members.length, 3, "the whole run, not a patch");
    assert.equal(upserts[1]!.run.members[0]!.state, "dispatched");
  } finally { close(); }
});
