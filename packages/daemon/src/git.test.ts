import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { worktreePath, cloneBare, gitComplaint, cloneCandidates, createWorktree, normaliseRemote, remoteForms, removeWorktree, restoreWorktree } from "./git.js";
import { scratchRemote } from "./scratch.js";

const execFile = promisify(execFileCb);

test("normaliseRemote collapses ssh/https/.git variants", () => {
  const want = "github.com/org/repo";
  for (const u of ["git@github.com:org/repo.git", "https://github.com/org/repo", "ssh://git@github.com/org/repo.git", "https://github.com/Org/Repo.git/"]) {
    assert.equal(normaliseRemote(u), want, u);
  }
});

test("gitComplaint keeps the line that names the reason, not the advice git ends with", () => {
  const refused = ["git@github.com: Permission denied (publickey).", "fatal: Could not read from remote repository.", "", "Please make sure you have the correct access rights", "and the repository exists."].join("\n");
  assert.equal(gitComplaint(refused), "git@github.com: Permission denied (publickey).", "the key, not the advice: it is why the clone must try the other URL");
  const missing = ["ERROR: Repository not found.", "fatal: Could not read from remote repository.", "Please make sure you have the correct access rights", "and the repository exists."].join("\n");
  assert.equal(gitComplaint(missing), "ERROR: Repository not found.");
  assert.equal(gitComplaint("fatal: '/tmp/nope' does not appear to be a git repository"), "fatal: '/tmp/nope' does not appear to be a git repository", "one line stays one line");
  assert.equal(gitComplaint("   "), "git failed");
});

test("remoteForms writes one repository both ways, and leaves a URL it must not rewrite alone", () => {
  const both = { host: "github.com", path: "org/repo", ssh: "git@github.com:org/repo.git", https: "https://github.com/org/repo.git" };
  assert.deepEqual(remoteForms("https://github.com/org/repo"), { ...both, protocol: "https" });
  assert.deepEqual(remoteForms("git@github.com:org/repo.git"), { ...both, protocol: "ssh" });
  assert.deepEqual(remoteForms("ssh://git@github.com/org/repo.git"), { ...both, protocol: "ssh" });
  assert.equal(remoteForms("https://gitlab.com/acme/group/api.git")?.ssh, "git@gitlab.com:acme/group/api.git", "a subgroup keeps its whole path");
  for (const u of [
    "/tmp/covey/remote.git",              // a path, which is what the tests clone
    "C:\\repos\\api",                     // a path on Windows
    "work:org/repo.git",                  // a host from the user's ssh config
    "ssh://git@github.com:2222/org/repo", // a port is the user's own setup
    "https://token@github.com/org/repo",  // so is a credential in the URL
    "https://github.com/org",             // no repository to name
  ]) assert.equal(remoteForms(u), null, u);
});

test("cloneCandidates leads with the machine's protocol and keeps the other as a second chance", () => {
  const ssh = "git@github.com:org/repo.git";
  const https = "https://github.com/org/repo.git";
  assert.deepEqual(cloneCandidates("https://github.com/org/repo", "ssh"), [ssh, https], "a machine that clones by ssh gets ssh, whatever the client sent");
  assert.deepEqual(cloneCandidates(ssh, "https"), [https, ssh], "and one that clones by https gets https");
  assert.deepEqual(cloneCandidates(ssh, null), [ssh, https], "a machine with no preference keeps the URL as it came");
  assert.deepEqual(cloneCandidates("/tmp/covey/remote.git", "ssh"), ["/tmp/covey/remote.git"], "a path is the only candidate there is");
});

test("cloneBare tries each URL of a repository and keeps the one that answered", async (t) => {
  const remote = await scratchRemote();
  t.after(() => remote.drop());
  const dir = mkdtempSync(join(tmpdir(), "covey-clone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "repo.git");
  const gone = join(remote.dir, "nowhere.git");

  const first = await cloneBare([gone, remote.url], bare);
  assert.deepEqual(first, { ok: true, url: remote.url }, "the second URL answered, and the answer names it");
  assert.equal(await execFile("git", ["remote", "get-url", "origin"], { cwd: bare }).then((r) => r.stdout.trim()), remote.url, "origin keeps the URL that worked, so every later fetch takes that route");
  assert.ok((await execFile("git", ["rev-parse", "origin/main"], { cwd: bare })).stdout.trim(), "and the refs are here");

  const none = await cloneBare([gone, join(remote.dir, "nor-here.git")], join(dir, "other.git"));
  assert.ok("error" in none && none.error.includes(gone) && none.error.includes("nor-here.git"), `every URL tried is in the reason: ${JSON.stringify(none)}`);
});

/** A throwaway repo with one commit, the smallest thing a worktree can hang off. */
async function scratchRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "covey-git-"));
  const run = (...args: string[]) => execFile("git", args, { cwd: dir });
  await run("init", "-q");
  await run("config", "user.email", "test@covey");
  await run("config", "user.name", "covey test");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  await run("add", "-A");
  await run("commit", "-qm", "init");
  return dir;
}

const branches = async (repo: string) =>
  (await execFile("git", ["branch", "--format=%(refname:short)"], { cwd: repo })).stdout.split("\n").filter(Boolean);

test("a thread's worktree goes away on archive, and comes back on the same branch", async (t) => {
  const repo = await scratchRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, "abc123", "HEAD", worktreePath({ workspaceRoot: repo }, "abc123"));
  assert.ok(!("error" in wt), "worktree created");
  if ("error" in wt) return;
  // ignored junk is exactly what a worktree accumulates, and must not hold it hostage
  mkdirSync(join(wt.path, "node_modules"), { recursive: true });
  writeFileSync(join(wt.path, "node_modules", "dep.js"), "//\n");
  writeFileSync(join(wt.path, "a.txt"), "hello\nfrom the thread\n");
  await execFile("git", ["commit", "-qam", "work"], { cwd: wt.path });

  assert.deepEqual(await removeWorktree(repo, wt.path), { ok: true });
  assert.ok(!existsSync(wt.path), "the checkout is gone, node_modules with it");
  assert.ok((await branches(repo)).includes(wt.branch), "the branch — and the commit on it — stays");

  assert.deepEqual(await restoreWorktree(repo, wt.path, wt.branch), { ok: true });
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "hello\nfrom the thread\n", "back with its work");
});

test("a worktree with unsaved work is kept, and says why", async (t) => {
  const repo = await scratchRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, "def456", "HEAD", worktreePath({ workspaceRoot: repo }, "def456"));
  if ("error" in wt) return assert.fail("worktree created");
  writeFileSync(join(wt.path, "a.txt"), "uncommitted\n");

  const r = await removeWorktree(repo, wt.path);
  assert.ok("error" in r && /modified or untracked/.test(r.error), r as any);
  assert.ok(existsSync(wt.path), "nothing unsaved is thrown away");
});

test("a worktree deleted behind git's back can still be restored", async (t) => {
  const repo = await scratchRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, "ghi789", "HEAD", worktreePath({ workspaceRoot: repo }, "ghi789"));
  if ("error" in wt) return assert.fail("worktree created");
  rmSync(wt.path, { recursive: true, force: true }); // leaves a stale admin entry
  assert.deepEqual(await restoreWorktree(repo, wt.path, wt.branch), { ok: true });
  assert.ok(existsSync(join(wt.path, "a.txt")));
});
