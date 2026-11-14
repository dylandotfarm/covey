/**
 * Putting a project away, and bringing it back (#204).
 *
 * An archive is a fold and nothing else. The daemon's whole part in it is one
 * field: the clone stays, the threads stay, a session that runs goes on
 * running, and a watch goes on watching. `project.delete` is the other act,
 * and the rows and the threads do not come back from it.
 *
 * Nothing here reaches the network or GitHub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost } from "./integrate/testHost.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

function engineOn() {
  const dir = mkdtempSync(join(tmpdir(), "covey-archive-"));
  const db = new Db(dir);
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") }, { ghHost: () => fakeHost({ prs: {} }) });
  const send = (cmd: any) => engine.dispatch({ ...cmd, commandId: randomUUID() });
  return { engine, db, dir, send, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

test("project.archive writes one field, and the project's threads are untouched", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p: Project = e.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });
  const was = e.db.getThread(threadId)!;

  await e.send({ type: "project.archive", projectId: p.id, archived: true });
  const put = e.db.getProject(p.id)!;
  assert.ok(put.archivedAt, "the project says when it was put away");
  assert.equal(put.workspaceRoot, p.workspaceRoot, "and the directory it works in has not moved");

  const now = e.db.getThread(threadId)!;
  assert.equal(now.archivedAt, null, "a thread of an archived project is not archived");
  assert.equal(now.worktreePath, was.worktreePath, "and it keeps the directory it works in");
  assert.equal(e.engine.shellSnapshot().projects.length, 1, "the project is still a project");

  // And back, which is the whole reason the act exists.
  await e.send({ type: "project.archive", projectId: p.id, archived: false });
  assert.equal(e.db.getProject(p.id)!.archivedAt, undefined);
});

test("archiving a project twice is archiving it once, and an unknown project is refused", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p: Project = e.engine.shellSnapshot().projects[0]!;
  await e.send({ type: "project.archive", projectId: p.id, archived: true });
  const first = e.db.getProject(p.id)!.archivedAt;
  await e.send({ type: "project.archive", projectId: p.id, archived: true });
  assert.equal(e.db.getProject(p.id)!.archivedAt, first, "the stamp is when the reader put it away");

  await assert.rejects(e.send({ type: "project.archive", projectId: "nope", archived: true }),
    (err: EngineError) => err.code === "not_found");
});

test("a project this machine already holds says so even from the archive, and names where it is", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p: Project = e.engine.shellSnapshot().projects[0]!;
  await e.send({ type: "project.archive", projectId: p.id, archived: true });
  // Without the second half of this sentence the reader goes looking for a
  // row in the list it is not in (#132).
  await assert.rejects(e.send({ type: "project.create", local: "notes" }),
    (err: EngineError) => err.code === "exists" && /already has the local project Notes/.test(err.message) && /archived/.test(err.message));
});
