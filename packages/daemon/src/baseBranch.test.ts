/**
 * A project that works from a branch of its own, not from `main`.
 *
 * A reader who builds one feature branch over many threads picks the branch
 * when the project is made. Every thread then starts from `origin/<branch>`,
 * and every pull request targets it. Without a pick, nothing changes: the
 * remote's default branch is the base, as before.
 *
 * Every remote here is a bare repository under `tmpdir`, and the `gh` host is
 * the fake. Nothing reaches the network or GitHub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo, Project, SystemNoteItem } from "@covey/protocol";
import { cleanStartBase, cleanStartNote, forgetFetch, listRemoteBranches, parseLsRemote } from "./git.js";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { fakeHost } from "./integrate/testHost.js";
import { scratchRemote, git, head } from "./scratch.js";

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/** An engine over a throwaway database, its own projects directory, and a `gh` that opens nothing. */
function engineOn() {
  const dir = mkdtempSync(join(tmpdir(), "covey-base-"));
  const db = new Db(dir);
  const host = fakeHost({ canCreate: true, prs: {} });
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") }, { ghHost: () => host });
  const send = (cmd: any) => engine.dispatch({ ...cmd, commandId: randomUUID() });
  return { engine, db, host, send, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseLsRemote puts the default branch first, sorts the rest, and ignores what is not a branch", () => {
  const out = [
    "ref: refs/heads/main\tHEAD",
    "1111111111111111111111111111111111111111\tHEAD",
    "2222222222222222222222222222222222222222\trefs/heads/zeta",
    "1111111111111111111111111111111111111111\trefs/heads/main",
    "3333333333333333333333333333333333333333\trefs/heads/alpha",
    "4444444444444444444444444444444444444444\trefs/tags/v1",
  ].join("\n");
  assert.deepEqual(parseLsRemote(out), { branches: ["main", "alpha", "zeta"], defaultBranch: "main", error: null });
  assert.deepEqual(parseLsRemote(""), { branches: [], defaultBranch: null, error: null });
  // A `HEAD` that names a branch the remote no longer has is no default.
  assert.deepEqual(parseLsRemote("ref: refs/heads/gone\tHEAD\n5555555555555555555555555555555555555555\trefs/heads/main"), { branches: ["main"], defaultBranch: null, error: null });
});

test("listRemoteBranches reads a remote without a clone, and names one it cannot read", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  await remote.pushBranch("feature", "on the feature branch");
  assert.deepEqual(await listRemoteBranches(remote.url), { branches: ["main", "feature"], defaultBranch: "main", error: null });

  const gone = await listRemoteBranches(join(remote.dir, "nowhere.git"));
  assert.deepEqual(gone.branches, []);
  assert.match(gone.error!, /could not read the branches of/);
  assert.match((await listRemoteBranches("--upload-pack=x")).error!, /URL is needed/, "an option is never handed to git as a URL");
});

test("a clean start on a chosen branch fetches that branch and starts at its tip", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await remote.pushBranch("feature", "one on feature");
  await e.send({ type: "project.create", url: remote.url, baseBranch: "feature" });
  const p = e.engine.shellSnapshot().projects[0]!;
  assert.equal(p.baseBranch, "feature");

  // The remote moves on both branches after the clone. The thread must start
  // where `feature` is now, and not where `main` is.
  const onFeature = await remote.pushBranch("feature", "two on feature");
  const onMain = await remote.push("two on main");
  // The clone's own fetch counts as fresh for a minute; this test is about
  // the fetch after that.
  forgetFetch(p.workspaceRoot);
  const start = await cleanStartBase(p.workspaceRoot, "feature");
  assert.equal(start?.ref, "origin/feature");
  assert.equal(start?.commit, onFeature, "the fetch took the base branch, not the default");
  assert.notEqual(start?.commit, onMain);
  assert.equal(cleanStartNote(start!)[1], `Branched from origin/feature at ${onFeature}, fetched from origin just now.`);
});

test("a project made on a branch gives every thread a worktree at that branch's tip", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  const onFeature = await remote.pushBranch("feature", "the feature so far");
  const onMain = await remote.push("main moves on");
  assert.notEqual(onFeature, onMain);

  await e.send({ type: "project.create", url: remote.url, baseBranch: "feature" });
  const p = e.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });
  const thread = e.db.getThread(threadId)!;
  assert.equal(await head(thread.worktreePath!), onFeature, "the worktree starts at origin/feature");
  assert.equal(await git(thread.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD"), `covey/${threadId.slice(0, 8)}`, "on the thread's own branch, as ever");
  const notes = e.db.listItems(threadId).items.filter((i): i is SystemNoteItem => i.kind === "note").map((i) => i.text);
  assert.ok(notes.some((n) => n.startsWith(`Branched from origin/feature at ${onFeature}`)), notes.join("\n"));
});

test("a pull request from a branch-based project targets the branch, and a default project targets main", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await remote.pushBranch("feature", "the feature so far");
  await e.send({ type: "project.create", url: remote.url, baseBranch: "feature" });
  const p = e.engine.shellSnapshot().projects[0]!;
  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });

  const opened = await e.engine.openPullRequest({ threadId, title: "A step of the feature", body: "" });
  const facts = await e.host.pullRequest(`covey/${threadId.slice(0, 8)}`);
  assert.equal(facts?.number, opened.number);
  assert.equal(facts?.baseRefName, "feature", "the pull request is against the project's branch");
  assert.equal(e.db.getThread(threadId)!.pullRequest?.base, "feature");

  // The same repository on another engine, with no branch picked: `main`.
  const plain = engineOn();
  t.after(plain.drop);
  await plain.send({ type: "project.create", url: remote.url });
  const q = plain.engine.shellSnapshot().projects[0]!;
  assert.equal(q.baseBranch, undefined);
  const other = randomUUID();
  await plain.send({ type: "thread.create", projectId: q.id, threadId: other, sessionId: randomUUID() });
  await plain.engine.openPullRequest({ threadId: other, title: "On main", body: "" });
  assert.equal(plain.db.getThread(other)!.pullRequest?.base, "main");
});

test("a branch the remote does not have is refused before the project exists, and a bad name before the clone", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await assert.rejects(e.send({ type: "project.create", url: remote.url, baseBranch: "nope" }), (err: EngineError) => err.code === "no_branch" && /has no branch nope/.test(err.message));
  assert.equal(e.engine.shellSnapshot().projects.length, 0, "no project without its base");
  await assert.rejects(e.send({ type: "project.create", url: remote.url, baseBranch: "--upload-pack=x" }), (err: EngineError) => err.code === "no_branch");
  await assert.rejects(e.send({ type: "project.create", url: remote.url, baseBranch: "a..b" }), (err: EngineError) => err.code === "no_branch");
});

test("project.update moves the base, fetches the branch first, and null returns it to the default", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await e.send({ type: "project.create", url: remote.url });
  const p = e.engine.shellSnapshot().projects[0]!;
  // The branch is made after the clone, so only a fetch can find it.
  const onFeature = await remote.pushBranch("feature", "made after the clone");
  await e.send({ type: "project.update", projectId: p.id, baseBranch: "feature" });
  assert.equal(e.db.getProject(p.id)!.baseBranch, "feature");

  const threadId = randomUUID();
  await e.send({ type: "thread.create", projectId: p.id, threadId, sessionId: randomUUID() });
  assert.equal(await head(e.db.getThread(threadId)!.worktreePath!), onFeature);

  await assert.rejects(e.send({ type: "project.update", projectId: p.id, baseBranch: "nope" }), (err: EngineError) => err.code === "no_branch");
  assert.equal(e.db.getProject(p.id)!.baseBranch, "feature", "a refused branch changes nothing");

  await e.send({ type: "project.update", projectId: p.id, baseBranch: null });
  const back: Project = e.db.getProject(p.id)!;
  assert.equal(back.baseBranch, undefined);
  assert.equal("baseBranch" in back, false, "the row reads as it did before the field existed");
});

test("a second clone of the repository is refused whatever branch it names, and the message says which base the first has", async (t) => {
  const remote = await scratchRemote();
  t.after(remote.drop);
  const e = engineOn();
  t.after(e.drop);
  await remote.pushBranch("feature", "x");
  await e.send({ type: "project.create", url: remote.url, baseBranch: "feature" });
  await assert.rejects(e.send({ type: "project.create", url: remote.url }), (err: EngineError) => err.code === "exists" && / on feature$/.test(err.message));
});
