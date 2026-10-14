/**
 * A project with no repository: one directory, named by the reader.
 *
 * The reader wanted a place to chat, to automate and to keep files, rather
 * than a change to land. So there is nothing to clone, every thread of the
 * project works in that one directory, and the three acts that need a
 * repository — an issue, a base branch, a pull request — are refused by name.
 * Everything else a project does, the pool and the secrets and the rename,
 * works as it does for a repository.
 *
 * Nothing here reaches the network or GitHub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost } from "./integrate/testHost.js";
import { normaliseRemote, projectSlug } from "./git.js";
import { emptyRemote, git, scratchRemote } from "./scratch.js";
import { COVEY_LOCAL_PREAMBLE, COVEY_PREAMBLE, preambleFor } from "./plugin.js";
import { threadEnv } from "./secrets.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

function engineOn() {
  const dir = mkdtempSync(join(tmpdir(), "covey-local-"));
  const db = new Db(dir);
  const host = fakeHost({ canCreate: true, prs: {} });
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") }, { ghHost: () => host });
  const send = (cmd: any) => engine.dispatch({ ...cmd, commandId: randomUUID() });
  return { engine, db, host, dir, send, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

test("project.create makes one directory for a local project, and records the name as its identity", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "My Notes" });
  const p: Project = e.engine.shellSnapshot().projects[0]!;
  assert.equal(p.kind, "local");
  assert.equal(p.localId, "my-notes", "the identity is the slug, which a rename never moves");
  assert.equal(p.title, "My Notes", "the title is what the reader typed");
  assert.equal(p.repositoryIdentity, null);
  assert.equal(p.remoteUrl, undefined);
  assert.equal(p.baseBranch, undefined);
  assert.equal(p.workspaceRoot, join(e.dir, "projects", "local", "my-notes"));
  assert.equal(statSync(p.workspaceRoot).isDirectory(), true, "the directory is there before the first thread");

  // `title` names the row and nothing else, so adding a machine to the pool
  // can send the identity with the title the reader has now.
  await e.send({ type: "project.create", local: "errands", title: "Errands and chores" });
  const second = e.engine.shellSnapshot().projects.find((q) => q.localId === "errands")!;
  assert.equal(second.title, "Errands and chores");
});

test("one local project of a name per machine, and a name covey cannot use is quoted", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  // The same name again is the project this machine already has — the answer
  // the reader gets when they add a machine that is already in the pool.
  await assert.rejects(e.send({ type: "project.create", local: "notes" }), (err: EngineError) => err.code === "exists" && /already has the local project Notes/.test(err.message));
  assert.equal(e.engine.shellSnapshot().projects.length, 1);

  await assert.rejects(e.send({ type: "project.create", local: "  " }), (err: EngineError) => err.code === "bad_name" && /needs a name/.test(err.message));
  await assert.rejects(e.send({ type: "project.create", local: "日記" }), (err: EngineError) => err.code === "bad_name" && /"日記"/.test(err.message));
  assert.equal(e.engine.shellSnapshot().projects.length, 1, "a refused name makes nothing");

  // A name that would walk out of the projects directory is slugged, never
  // honoured: one directory under `local`, whatever was typed.
  await e.send({ type: "project.create", local: "../../escape" });
  const out = e.engine.shellSnapshot().projects.find((q) => q.title === "../../escape")!;
  assert.equal(out.workspaceRoot, join(e.dir, "projects", "local", "escape"));
});

test("every thread of a local project works in the project's own directory, and keeps what the last one wrote", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "notes" });
  const p = e.engine.shellSnapshot().projects[0]!;

  const a = randomUUID();
  const b = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId: a, sessionId: randomUUID() });
  await e.send({ type: "thread.create", projectId: p.id, threadId: b, sessionId: randomUUID() });
  for (const id of [a, b]) {
    const t2 = e.db.getThread(id)!;
    assert.equal(t2.worktreePath, null, "no worktree: the project is the place to work");
    assert.equal(t2.branch, null, "and no branch, because there is no repository");
  }
  // Which is the whole point: the second thread sees what the first wrote.
  assert.equal(existsSync(join(p.workspaceRoot, ".covey", "worktrees")), false, "nothing per thread under the project");
  writeFileSync(join(p.workspaceRoot, "shopping.md"), "milk\n");
  assert.equal(existsSync(join(p.workspaceRoot, "shopping.md")), true);

  // A reader who runs `git init` in that directory keeps the project they
  // made: the test is the kind, never whether there is a repository.
  await e.send({ type: "thread.create", projectId: p.id, threadId: randomUUID(), sessionId: randomUUID() });
  assert.equal(existsSync(join(p.workspaceRoot, ".covey", "worktrees")), false);
});

test("an issue, a base branch and a pull request are refused by name on a local project", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "notes", title: "Notes" });
  const p = e.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });

  const named = (err: EngineError) => err.code === "unsupported" && /^Notes is a local project/.test(err.message);
  await assert.rejects(e.send({ type: "project.update", projectId: p.id, baseBranch: "main" }), named);
  await assert.rejects(e.send({ type: "thread.takeIssue", threadId, issue: 7 }), named);
  await assert.rejects(e.engine.openPullRequest({ threadId, title: "a change" }), named);
  // The reason is the repository and never the branch: a thread of a local
  // project is on no branch *because* there is no repository.
  await assert.rejects(e.engine.openPullRequest({ threadId, title: "a change" }), (err: EngineError) => /no repository to open a pull request against/.test(err.message));

  assert.equal(e.db.getProject(p.id)!.baseBranch, undefined, "a refused base changes nothing");
  assert.equal(e.db.getThread(threadId)!.issue, undefined);
  // Clearing an issue is not taking one, so it still answers.
  await e.send({ type: "thread.takeIssue", threadId, issue: null });
});

test("a local project renames, holds secrets, and keeps its identity through both", async (t) => {
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p = e.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });

  await e.send({ type: "project.update", projectId: p.id, title: "Household" });
  assert.equal(e.db.getProject(p.id)!.title, "Household");
  assert.equal(e.db.getProject(p.id)!.localId, "notes", "the identity is not the title: the pool survives a rename");

  await e.send({ type: "project.setSecrets", projectId: p.id, secrets: [{ key: "WEATHER_KEY", value: "s3cret-value" }] });
  assert.deepEqual(e.db.getProject(p.id)!.secretKeys, ["WEATHER_KEY"], "the names ride on the row, never the values");
  assert.deepEqual(Object.keys(threadEnv(e.db, p.id, threadId)), ["WEATHER_KEY"], "and the thread's session reads it");

  // The model may be pinned for the project, as on any other.
  await e.send({ type: "project.update", projectId: p.id, defaultModel: "sonnet" });
  assert.equal(e.db.getProject(p.id)!.defaultModel, "sonnet");
});

test("a local thread is told it has a directory and no repository, and a repository's thread is told the loop", () => {
  assert.equal(preambleFor({ kind: "local" }), COVEY_LOCAL_PREAMBLE);
  assert.equal(preambleFor({ kind: "clone" }), COVEY_PREAMBLE);
  assert.equal(preambleFor({ kind: "checkout" }), COVEY_PREAMBLE);
  assert.equal(preambleFor({}), COVEY_PREAMBLE, "a row written before the field reads as a checkout");
  // Every sentence of the loop's note is false in a local project, which is
  // the whole reason there are two.
  assert.match(COVEY_LOCAL_PREAMBLE, /no git repository/);
  assert.match(COVEY_LOCAL_PREAMBLE, /covey env/, "the two commands that do work here are named");
  assert.match(COVEY_LOCAL_PREAMBLE, /covey show/);
  assert.doesNotMatch(COVEY_LOCAL_PREAMBLE, /worktree|base branch/);
});

test("a local thread moves to the machine's own copy of that project, which covey makes when there is none", async (t) => {
  const from = engineOn();
  const to = engineOn();
  t.after(from.drop);
  t.after(to.drop);
  await from.send({ type: "project.create", local: "Notes" });
  const p = from.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await from.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID(), title: "the shopping list" });

  const exported = await from.engine.exportThread(threadId);
  assert.equal(exported.project.kind, "local");
  assert.equal(exported.project.localId, "notes", "the export carries the identity, the way it carries a remote URL");

  // The destination holds no such project, so it makes the directory — the
  // step a repository gets, which is a clone.
  const landed = await to.engine.importThread(exported, {});
  const there = to.db.getProject(landed.projectId)!;
  assert.equal(there.kind, "local");
  assert.equal(there.localId, "notes");
  assert.equal(there.workspaceRoot, join(to.dir, "projects", "local", "notes"));
  assert.equal(to.db.getThread(landed.threadId)!.worktreePath, null, "and the thread works in it");

  // A second thread of the same project lands in the project that is now here.
  const other = randomUUID();
  await from.send({ type: "thread.create", projectId: p.id, threadId: other, sessionId: randomUUID() });
  const second = await to.engine.importThread(await from.engine.exportThread(other), {});
  assert.equal(second.projectId, landed.projectId, "one local project, not a second directory");
});

// ---------------------------------------------------------------------------
// Upgrading a local project into a repository project (`project.makeGit`)
// ---------------------------------------------------------------------------

test("project.makeGit pushes the project's directory as the first commit and gives every thread a branch", async (t) => {
  const remote = await emptyRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const before = e.engine.shellSnapshot().projects[0]!;
  const was = before.workspaceRoot;

  // Two threads, and a file each wrote in the one directory they share.
  const a = randomUUID();
  const b = randomUUID();
  await e.send({ type: "thread.create", projectId: before.id, threadId: a, sessionId: randomUUID() });
  await e.send({ type: "thread.create", projectId: before.id, threadId: b, sessionId: randomUUID() });
  writeFileSync(join(was, "shopping.md"), "milk\n");
  // And a picture one of them was shown, which must not reach the commit.
  mkdirSync(join(was, ".covey", "threads", a, "files"), { recursive: true });
  writeFileSync(join(was, ".covey", "threads", a, "files", "shot.png"), "not really a png");

  await e.send({ type: "project.makeGit", projectId: before.id, url: remote.url });

  const p = e.db.getProject(before.id)!;
  assert.equal(p.kind, "clone");
  assert.equal(p.localId, undefined, "the local identity goes with the kind");
  assert.equal(p.repositoryIdentity, normaliseRemote(remote.url));
  assert.equal(p.remoteUrl, remote.url);
  assert.equal(p.workspaceRoot, join(e.dir, "projects", projectSlug(p.repositoryIdentity!), "repo.git"));
  assert.equal(p.title, "Notes", "the name the reader gave it stands");
  assert.equal(existsSync(was), true, "the old directory stays, as project.delete leaves a clone");

  // Every thread works in a worktree of its own now, on its own branch, with
  // the project's files in it.
  for (const id of [a, b]) {
    const th = e.db.getThread(id)!;
    assert.notEqual(th.worktreePath, null);
    assert.match(th.branch!, /^covey\//);
    assert.equal(existsSync(join(th.worktreePath!, "shopping.md")), true, "the files came along in the first commit");
  }
  assert.notEqual(e.db.getThread(a)!.worktreePath, e.db.getThread(b)!.worktreePath);

  // The store of files a reader was shown moves with its thread, or every
  // picture of the project goes when the project is upgraded.
  assert.equal(existsSync(join(e.db.getThread(a)!.worktreePath!, ".covey", "threads", a, "files", "shot.png")), true);
  // And it is not in the repository: `.covey` is ignored before anything is added.
  assert.equal(await git(was, "ls-files", "--", ".covey"), "", "nothing of .covey reached the commit");
  assert.match(await git(was, "ls-files"), /shopping\.md/);

  // Each thread is told what happened, with the old directory named.
  const notes = e.db.allItems(a).filter((i) => i.kind === "note");
  assert.equal(notes.length, 1);
  assert.match((notes[0] as any).text, /is now a git repository/);
  assert.match((notes[0] as any).text, new RegExp(was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a local project with no files at all upgrades, because the empty commit is the branch", async (t) => {
  const remote = await emptyRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "chat" });
  const p0 = e.engine.shellSnapshot().projects[0]!;
  await e.send({ type: "project.makeGit", projectId: p0.id, url: remote.url });
  assert.equal(e.db.getProject(p0.id)!.kind, "clone");
  // A thread made after the upgrade is an ordinary thread of a repository.
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p0.id, threadId, sessionId: randomUUID() });
  assert.match(e.db.getThread(threadId)!.branch!, /^covey\//);
});

test("project.makeGit refuses a repository that already has commits, and a project that is not local", async (t) => {
  const full = await scratchRemote();
  const empty = await emptyRemote();
  t.after(full.drop);
  t.after(empty.drop);
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p0 = e.engine.shellSnapshot().projects[0]!;
  writeFileSync(join(p0.workspaceRoot, "keep.md"), "mine\n");

  // Reconciling the reader's directory with a history somebody else wrote is
  // not a thing covey may decide for them.
  await assert.rejects(
    e.send({ type: "project.makeGit", projectId: p0.id, url: full.url }),
    (err: EngineError) => err.code === "exists" && /already has commits; a local project can only be upgraded into an empty repository/.test(err.message),
  );
  assert.equal(e.db.getProject(p0.id)!.kind, "local", "a refusal changes nothing");

  // The other half of the same question: a machine that is not the one that
  // pushes needs the branch the first one pushed.
  await assert.rejects(
    e.send({ type: "project.makeGit", projectId: p0.id, url: empty.url, push: false }),
    (err: EngineError) => err.code === "no_branch" && /has no commits yet; upgrade the machine whose files should become the repository first/.test(err.message),
  );

  await e.send({ type: "project.makeGit", projectId: p0.id, url: empty.url });
  await assert.rejects(
    e.send({ type: "project.makeGit", projectId: p0.id, url: empty.url }),
    (err: EngineError) => err.code === "unsupported" && /Notes is already a repository project/.test(err.message),
  );
});

test("the second machine of a pool clones what the first pushed, and its own directory stays put", async (t) => {
  const remote = await emptyRemote();
  t.after(remote.drop);
  const first = engineOn();
  const second = engineOn();
  t.after(first.drop);
  t.after(second.drop);
  // One local project, the same name on two machines: one row in the sidebar.
  await first.send({ type: "project.create", local: "Notes" });
  await second.send({ type: "project.create", local: "Notes" });
  const a = first.engine.shellSnapshot().projects[0]!;
  const b = second.engine.shellSnapshot().projects[0]!;
  writeFileSync(join(a.workspaceRoot, "from-the-first.md"), "a\n");
  writeFileSync(join(b.workspaceRoot, "from-the-second.md"), "b\n");
  const threadId = randomUUID();
  await second.send({ type: "thread.create", projectId: b.id, threadId, sessionId: randomUUID() });

  await first.send({ type: "project.makeGit", projectId: a.id, url: remote.url });
  await second.send({ type: "project.makeGit", projectId: b.id, url: remote.url, push: false });

  // Both machines are now on the repository, so the sidebar folds them into
  // one row again — `projectPool` reads the identity they share.
  const one = first.db.getProject(a.id)!;
  const two = second.db.getProject(b.id)!;
  assert.equal(two.kind, "clone");
  assert.equal(two.repositoryIdentity, one.repositoryIdentity);

  // The second machine's thread works on the branch, from the first
  // machine's files; its own directory is untouched and its note says so.
  const th = second.db.getThread(threadId)!;
  assert.match(th.branch!, /^covey\//);
  assert.equal(existsSync(join(th.worktreePath!, "from-the-first.md")), true);
  assert.equal(existsSync(join(th.worktreePath!, "from-the-second.md")), false);
  assert.equal(existsSync(join(b.workspaceRoot, "from-the-second.md")), true, "nothing of the second machine's own directory is lost");
  const note = second.db.allItems(threadId).find((i) => i.kind === "note") as any;
  assert.match(note.text, /stayed there: another machine's directory became the repository/);
});

test("a thread that is working keeps the directory it is in, and is told why", async (t) => {
  const remote = await emptyRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", local: "Notes" });
  const p0 = e.engine.shellSnapshot().projects[0]!;
  const was = p0.workspaceRoot;
  const busy = randomUUID();
  const idle = randomUUID();
  await e.send({ type: "thread.create", projectId: p0.id, threadId: busy, sessionId: randomUUID() });
  await e.send({ type: "thread.create", projectId: p0.id, threadId: idle, sessionId: randomUUID() });
  // A running turn is what the agent that asked for the upgrade is in: moving
  // its files under it is the one thing an upgrade must not do.
  const running = e.db.getThread(busy)!;
  running.latestTurn = { id: randomUUID(), state: "running", startedAt: new Date().toISOString() } as any;
  e.db.putThread(running);

  await e.send({ type: "project.makeGit", projectId: p0.id, url: remote.url });

  // `worktreePath` was null, which reads as the project's root — and that
  // root has just moved to the bare clone. So the path is recorded.
  assert.equal(e.db.getThread(busy)!.worktreePath, was, "the thread stays exactly where it was working");
  assert.equal(e.db.getThread(busy)!.branch, null);
  assert.notEqual(e.db.getThread(idle)!.worktreePath, null, "and the idle one gets its worktree");

  const note = e.db.allItems(busy).find((i) => i.kind === "note") as any;
  assert.equal(note.tone, "warning");
  assert.match(note.text, /was working, so it keeps/);
  assert.match(note.text, /Start a new thread in the project/);
});
