import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { worktreePath, createWorktree, normaliseRemote, removeWorktree, restoreWorktree } from "./git.js";

const execFile = promisify(execFileCb);

test("normaliseRemote collapses ssh/https/.git variants", () => {
  const want = "github.com/org/repo";
  for (const u of ["git@github.com:org/repo.git", "https://github.com/org/repo", "ssh://git@github.com/org/repo.git", "https://github.com/Org/Repo.git/"]) {
    assert.equal(normaliseRemote(u), want, u);
  }
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
