/**
 * Where a `worktree-default` worktree starts. Issue #76.
 *
 * Measured on the macOS host on 2026-09-18: local `main` at 506def4,
 * `origin/main` at 774c764, 46 commits apart, and `defaultBranchRef` returned
 * the local one. Work is pushed to `origin` and reviewed there, so `origin` is
 * the truth about what the default branch is; every agent dispatched that day
 * started two days behind and spent a round merging before its work could land.
 *
 * Every repository here is a throwaway under `tmpdir`, and every "remote" is a
 * bare repository beside it. **No test in this file reaches the network**, and
 * none of them may ever be pointed at a real checkout: they create worktrees
 * and they fetch, which are real operations on a real repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { MachineInfo, SystemNoteItem } from "@covey/protocol";
import { cleanStartBase, cleanStartNote, createWorktree, defaultBranchRef } from "./git.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

const execFile = promisify(execFileCb);
const git = async (cwd: string, ...args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();
const head = (cwd: string) => git(cwd, "rev-parse", "--short", "HEAD");

interface Clone {
  /** The working checkout, standing in for the operator's own. */
  repo: string;
  /** The bare remote, as a URL a project can clone. */
  remote: string;
  dir: string;
  /** Add a commit to the remote's `main`, behind the checkout's back. */
  moveRemote: (msg: string) => Promise<string>;
  /** Point `origin` at somewhere that is not there, the way being offline looks. */
  breakRemote: () => Promise<void>;
  drop: () => void;
}

/** A checkout cloned from a bare repository beside it: a remote with no network. */
async function scratchClone(): Promise<Clone> {
  const dir = mkdtempSync(join(tmpdir(), "covey-clean-"));
  const remote = join(dir, "remote.git");
  await execFile("git", ["init", "-q", "--bare", "-b", "main", remote]);

  const seed = join(dir, "seed");
  await execFile("git", ["clone", "-q", remote, seed]);
  await git(seed, "config", "user.email", "test@covey");
  await git(seed, "config", "user.name", "covey test");
  const moveRemote = async (msg: string) => {
    writeFileSync(join(seed, "a.txt"), `${msg}\n`);
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", msg);
    await git(seed, "push", "-q", "origin", "main");
    return head(seed);
  };
  await moveRemote("one");

  const repo = join(dir, "repo");
  await execFile("git", ["clone", "-q", remote, repo]);
  await git(repo, "config", "user.email", "test@covey");
  await git(repo, "config", "user.name", "covey test");
  return {
    repo,
    remote,
    dir,
    moveRemote,
    breakRemote: async () => { await git(repo, "remote", "set-url", "origin", join(dir, "gone.git")); },
    drop: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A repository with one commit and no remote at all. */
async function scratchRepo(): Promise<{ repo: string; drop: () => void }> {
  const repo = mkdtempSync(join(tmpdir(), "covey-solo-"));
  await execFile("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@covey");
  await git(repo, "config", "user.name", "covey test");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init");
  return { repo, drop: () => rmSync(repo, { recursive: true, force: true }) };
}

test("a clean start branches from origin/main, not from the local main behind it", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const ahead = await c.moveRemote("two");
  await git(c.repo, "fetch", "-q", "origin", "main"); // origin/main is fresh; local main is not
  const local = await git(c.repo, "rev-parse", "--short", "main");
  assert.notEqual(local, ahead, "the checkout is behind its remote, which is the case under test");

  assert.equal(await defaultBranchRef(c.repo), "origin/main", "a local main must not win over the remote's");

  const start = await cleanStartBase(c.repo);
  assert.ok(start, "a clean start has a base");
  assert.equal(start!.ref, "origin/main");
  assert.equal(start!.commit, ahead, "branched from what the remote has, not from the local copy");

  const wt = await createWorktree(c.repo, "aaa111", start!.ref);
  assert.ok(!("error" in wt), JSON.stringify(wt));
  if ("error" in wt) return;
  assert.equal(await head(wt.path), ahead, "the worktree itself starts at origin/main");
});

test("a clean start fetches first, so origin/main is what the remote has now", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const stale = await git(c.repo, "rev-parse", "--short", "origin/main");
  const ahead = await c.moveRemote("two"); // nobody in the checkout has fetched this
  assert.notEqual(stale, ahead);

  const start = await cleanStartBase(c.repo);
  assert.equal(start?.fetch.state, "fetched");
  assert.equal(start?.commit, ahead, "origin/main was only as fresh as the last fetch");

  const wt = await createWorktree(c.repo, "bbb222", start!.ref);
  if ("error" in wt) return assert.fail(wt.error);
  assert.equal(await head(wt.path), ahead);
});

test("one fetch serves a whole dispatch, and a second thread a second later reuses it", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const first = await cleanStartBase(c.repo);
  assert.equal(first?.fetch.state, "fetched");

  // The remote moves between two threads of the same dispatch. Within the
  // freshness window covey does not pay for a second round trip.
  const ahead = await c.moveRemote("two");
  const second = await cleanStartBase(c.repo);
  assert.equal(second?.commit, first?.commit, "a second fetch a moment later is a round trip nobody asked for");
  assert.notEqual(second?.commit, ahead);
});

test("a fetch that failed is not remembered, so the next thread tries again", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const ahead = await c.moveRemote("two");
  const url = await git(c.repo, "remote", "get-url", "origin");
  await c.breakRemote();

  const blip = await cleanStartBase(c.repo);
  assert.equal(blip?.fetch.state, "failed", "the case under test is a fetch that did not work");

  // The remote comes back in the same second, the way a blip does. The six
  // threads behind this one in a dispatch must not all start where the blip
  // left them: that is #76 again, one minute wide instead of two days.
  await git(c.repo, "remote", "set-url", "origin", url);
  const next = await cleanStartBase(c.repo);
  assert.equal(next?.fetch.state, "fetched", "a failed fetch must not count as fresh");
  assert.equal(next?.commit, ahead, "the second thread starts where the remote really is");
});

test("a remote that says nothing is named as a timeout, not as 'git failed'", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  // A socket that accepts the connection and then answers nothing — the one
  // case FETCH_TIMEOUT_MS exists for, and the one git never complains about.
  const sink = createServer((sock) => { sock.resume(); });
  t.after(() => sink.close());
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const { port } = sink.address() as AddressInfo;
  await git(c.repo, "remote", "set-url", "origin", `git://127.0.0.1:${port}/hang.git`);

  const start = await cleanStartBase(c.repo);
  assert.equal(start?.fetch.state, "failed");
  assert.match((start!.fetch as { error: string }).error, /no answer from origin within 20s/);
  const [tone, text] = cleanStartNote(start!);
  assert.equal(tone, "warning");
  assert.match(text, /no answer from origin within 20s/, "the thread is told what actually happened");
});

test("a repository with no remote still gets its local default branch", async (t) => {
  const { repo, drop } = await scratchRepo();
  t.after(drop);
  assert.equal(await defaultBranchRef(repo), "main");

  const start = await cleanStartBase(repo);
  assert.equal(start?.ref, "main");
  assert.equal(start?.fetch.state, "no-remote");
  assert.equal(start?.commit, await head(repo));

  const wt = await createWorktree(repo, "ccc333", start!.ref);
  if ("error" in wt) return assert.fail(wt.error);
  assert.equal(await head(wt.path), start!.commit);
});

test("a remote that cannot be reached still gets a worktree, and says it may be behind", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const here = await git(c.repo, "rev-parse", "--short", "origin/main");
  await c.breakRemote();

  const start = await cleanStartBase(c.repo);
  assert.ok(start, "an agent that cannot start is worse than one that starts stale and knows it");
  assert.equal(start!.fetch.state, "failed", "the fetch did not work and must not claim it did");
  assert.equal(start!.ref, "origin/main");
  assert.equal(start!.commit, here, "branched from what is here");

  const [tone, text] = cleanStartNote(start!);
  assert.equal(tone, "warning");
  assert.match(text, /origin\/main/);
  assert.match(text, new RegExp(here));
  assert.match(text, /fetch from origin failed/);

  const wt = await createWorktree(c.repo, "ddd444", start!.ref);
  assert.ok(!("error" in wt), "the worktree is created anyway");
});

test("the note names the ref and the commit in every outcome", () => {
  assert.deepEqual(cleanStartNote({ ref: "origin/main", commit: "774c764", fetch: { state: "fetched" } }), [
    "info",
    "Branched from origin/main at 774c764, fetched from origin just now.",
  ]);
  const [tone, text] = cleanStartNote({ ref: "main", commit: "506def4", fetch: { state: "no-remote" } });
  assert.equal(tone, "info");
  assert.match(text, /Branched from main at 506def4/);
});

test("worktree-head is untouched: it branches from the checkout, however far behind it is", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const ahead = await c.moveRemote("two");
  await git(c.repo, "fetch", "-q", "origin", "main");
  const local = await head(c.repo);

  const wt = await createWorktree(c.repo, "eee555", "HEAD");
  if ("error" in wt) return assert.fail(wt.error);
  assert.equal(await head(wt.path), local, "HEAD means HEAD; carrying work over is the point of this mode");
  assert.notEqual(await head(wt.path), ahead);
});

test("a branch from origin/main does not take origin/main as its upstream", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const wt = await createWorktree(c.repo, "fff666", "origin/main");
  if ("error" in wt) return assert.fail(wt.error);
  // With origin/main as upstream, `git push` under push.default=simple refuses
  // the branch outright, because the upstream has another name.
  const upstream = await execFile("git", ["config", "--get", `branch.${wt.branch}.merge`], { cwd: c.repo }).catch(() => null);
  assert.equal(upstream, null, "the thread's branch tracks nothing");
});

// ---- the thread is told where it started ------------------------------------

const MACHINE: MachineInfo = {
  machineId: "m1", name: "mac", os: "darwin", arch: "arm64", homeDir: "/tmp",
  daemonVersion: "0.0.1", protocolVersion: 1,
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/** An engine over a throwaway database and its own projects directory. */
function engineOn() {
  const dir = mkdtempSync(join(tmpdir(), "covey-clean-db-"));
  const db = new Db(dir);
  const engine = new Engine(db, { ...MACHINE, projectsDir: join(dir, "projects") });
  const send = (cmd: any) => engine.dispatch({ ...cmd, commandId: randomUUID() });
  return { engine, db, send, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Clone `url` as a project, then make one thread in it. `beforeThread` runs
 * between the two, on the clone, so a test can break its remote the way being
 * offline looks.
 */
async function threadNotes(url: string, beforeThread: (clone: string) => Promise<void> = async () => {}): Promise<{ notes: string[]; tones: string[]; branchedAt: string | null; worktree: string | null; clone: string; bare: boolean; threadId: string }> {
  const e = engineOn();
  try {
    await e.send({ type: "project.create", url });
    const project = e.engine.shellSnapshot().projects[0]!;
    await beforeThread(project.workspaceRoot);
    const threadId = randomUUID();
    await e.send({ type: "thread.create", projectId: project.id, threadId, sessionId: randomUUID() });
    const t = e.db.getThread(threadId)!;
    const items = e.db.listItems(threadId).items.filter((i): i is SystemNoteItem => i.kind === "note");
    const wt = t.worktreePath;
    return {
      notes: items.map((i) => i.text),
      tones: items.map((i) => i.tone),
      branchedAt: wt ? await head(wt) : null,
      worktree: wt,
      clone: project.workspaceRoot,
      bare: (await git(project.workspaceRoot, "rev-parse", "--is-bare-repository")) === "true",
      threadId,
    };
  } finally { e.drop(); }
}

test("a project is a bare clone, and a thread gets a worktree beside it at origin/main", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  const ahead = await c.moveRemote("two");

  const { notes, tones, branchedAt, worktree, clone, bare, threadId } = await threadNotes(c.remote);
  assert.ok(clone.endsWith(join("remote", "repo.git")), `the clone is named after the repository: ${clone}`);
  assert.ok(bare, "nothing is checked out in the project itself");
  assert.equal(worktree, join(dirname(clone), threadId.slice(0, 8)), "the worktree sits beside the bare repository");
  assert.equal(branchedAt, ahead, "the thread's own worktree starts at origin/main");
  assert.equal(notes.length, 1, `expected one note, got ${JSON.stringify(notes)}`);
  assert.equal(tones[0], "info");
  assert.equal(notes[0], `Branched from origin/main at ${ahead}, fetched from origin just now.`);
});

test("a thread whose fetch failed is warned, in its own transcript, that it may be behind", async (t) => {
  const c = await scratchClone();
  t.after(c.drop);
  let here = "";
  const { notes, tones, branchedAt } = await threadNotes(c.remote, async (clone) => {
    here = await git(clone, "rev-parse", "--short", "origin/main");
    await git(clone, "remote", "set-url", "origin", join(c.dir, "gone.git"));
  });
  assert.equal(branchedAt, here, "the thread started, which is the whole point");
  assert.equal(tones[0], "warning");
  assert.match(notes[0]!, new RegExp(`Branched from origin/main at ${here}`));
  assert.match(notes[0]!, /Merge main before you start/);
});
