import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync as mkdirp, writeFileSync as writeFile } from "node:fs";
import { join } from "node:path";
import type { ProjectGit } from "@covey/protocol";

const run = promisify(execFile);

/** Like `git()`, but keeps git's own complaint so it can be shown to the user. */
async function gitTry(cwd: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 10_000 });
    return { ok: true, out: stdout.trim() };
  } catch (e: any) {
    const text = String(e?.stderr ?? e?.message ?? e).trim();
    return { ok: false, err: text.split("\n").filter(Boolean).pop() ?? "git failed" };
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await gitTry(cwd, args);
  return r.ok ? r.out : null;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Normalise a git remote into a stable cross-machine identity:
 *  git@github.com:org/repo.git and https://github.com/org/repo → github.com/org/repo */
export function normaliseRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "").replace(/^git@/, "");
  u = u.replace(/^([^/:]+):/, "$1/"); // host:path → host/path
  u = u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return u.toLowerCase();
}

export async function repositoryIdentity(cwd: string): Promise<string | null> {
  const remote = await git(cwd, ["remote", "get-url", "origin"]);
  if (!remote) return null;
  return normaliseRemote(remote);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function repoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * The ref a "clean start" worktree branches from: whatever `origin/HEAD` points
 * at if the remote's default is known locally, else a local main/master.
 * Returned as the ref to pass to git, so the UI can show `origin/main` honestly
 * when that is what we would use.
 */
export async function defaultBranchRef(cwd: string): Promise<string | null> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const origin = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (origin) {
    const local = origin.replace(/^origin\//, "");
    return (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`])) ? local : origin;
  }
  for (const b of ["main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  }
  return null;
}

/** Branch state of a project directory, read fresh — branches move under us. */
export async function gitInfo(dir: string): Promise<ProjectGit> {
  const empty: ProjectGit = { isRepo: false, root: null, currentBranch: null, defaultBranch: null, hasCommits: false };
  if (!isGitRepo(dir)) return empty;
  const root = await repoRoot(dir);
  if (!root) return empty;
  // `branch --show-current` (unlike rev-parse) survives a repo with no commits
  // and reports empty rather than "HEAD" when detached.
  const [branch, head, def] = await Promise.all([
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    defaultBranchRef(root),
  ]);
  return { isRepo: true, root, currentBranch: branch || null, defaultBranch: def, hasCommits: !!head };
}

/** Create a worktree for a thread at `base`, under <repo>/.covey/worktrees/<name>. */
export async function createWorktree(
  repo: string,
  name: string,
  base: string,
): Promise<{ path: string; branch: string } | { error: string }> {
  const root = (await repoRoot(repo)) ?? repo;
  const branch = `covey/${name}`;
  const path = join(root, ".covey", "worktrees", name);
  // A self-ignoring .gitignore, so worktrees never show up in the main repo's
  // status — or in the turn checkpoints, which honour .gitignore.
  try {
    mkdirp(join(root, ".covey"), { recursive: true });
    const ignore = join(root, ".covey", ".gitignore");
    if (!existsSync(ignore)) writeFile(ignore, "*\n");
  } catch { /* best effort; worktree creation is what matters */ }
  const r = await gitTry(root, ["worktree", "add", "-b", branch, path, base]);
  if (!r.ok) return { error: r.err };
  return { path, branch };
}

/**
 * Give a thread's worktree back: the checkout goes, the branch (and every
 * commit on it) stays. Never forced — git refuses while the tree holds
 * modified or untracked files, and a tree we cannot remove safely is one we
 * keep. Ignored files (node_modules, dist) do not count and are deleted with it.
 */
export async function removeWorktree(repo: string, path: string): Promise<{ ok: true } | { error: string }> {
  const root = (await repoRoot(repo)) ?? repo;
  const r = await gitTry(root, ["worktree", "remove", path]);
  return r.ok ? { ok: true } : { error: r.err };
}

/** Put a removed worktree back where it was, on the branch it had. */
export async function restoreWorktree(repo: string, path: string, branch: string): Promise<{ ok: true } | { error: string }> {
  const root = (await repoRoot(repo)) ?? repo;
  // The admin entry outlives a directory deleted behind git's back, and would
  // make `worktree add` refuse the path it already knows.
  await gitTry(root, ["worktree", "prune"]);
  const r = await gitTry(root, ["worktree", "add", path, branch]);
  return r.ok ? { ok: true } : { error: r.err };
}

// ---- checkpoints ------------------------------------------------------------
// A checkpoint is a git tree object of the whole working directory (tracked +
// untracked, honouring .gitignore), built with a throwaway index so the user's
// index and branch are untouched. The tree is pinned under refs/covey/ so gc
// never prunes it. Diff between two checkpoints = the turn's changes.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

async function gitEnv(cwd: string, args: string[], env: Record<string, string>): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 60_000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout.replace(/\n$/, "");
  } catch {
    return null;
  }
}

export async function captureCheckpoint(cwd: string, refName: string): Promise<string | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const dir = mkdtempSync(join(tmpdir(), "covey-idx-"));
  const index = join(dir, "index");
  try {
    // seed from HEAD so the tree includes unchanged tracked files, then add everything
    await gitEnv(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
    const added = await gitEnv(root, ["add", "-A", "--", "."], { GIT_INDEX_FILE: index });
    if (added === null) return null;
    const tree = await gitEnv(root, ["write-tree"], { GIT_INDEX_FILE: index });
    if (!tree) return null;
    await gitEnv(root, ["update-ref", `refs/covey/${refName}`, tree], {});
    return tree;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface DiffFile { path: string; additions: number; deletions: number; status: "A" | "M" | "D" | "R" }

export async function diffCheckpoints(cwd: string, before: string, after: string): Promise<{ files: DiffFile[]; additions: number; deletions: number } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const numstat = await gitEnv(root, ["diff-tree", "-r", "--numstat", "-M", before, after], {});
  const names = await gitEnv(root, ["diff-tree", "-r", "--name-status", "-M", before, after], {});
  if (numstat === null || names === null) return null;
  const status = new Map<string, DiffFile["status"]>();
  for (const line of names.split("\n").filter(Boolean)) {
    const [st, ...rest] = line.split("\t");
    const path = rest[rest.length - 1]!;
    status.set(path, (st![0] as DiffFile["status"]) ?? "M");
  }
  const files: DiffFile[] = [];
  let additions = 0, deletions = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest[rest.length - 1]!;
    const add = a === "-" ? 0 : Number(a), del = d === "-" ? 0 : Number(d);
    additions += add; deletions += del;
    files.push({ path, additions: add, deletions: del, status: status.get(path) ?? "M" });
  }
  return { files, additions, deletions };
}

export async function patchBetween(cwd: string, before: string, after: string): Promise<string | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  return gitEnv(root, ["diff-tree", "-r", "-p", "-M", "--no-color", before, after], {});
}

export async function deleteCheckpointRefs(cwd: string, prefix: string): Promise<void> {
  const root = await repoRoot(cwd);
  if (!root) return;
  const refs = await gitEnv(root, ["for-each-ref", "--format=%(refname)", `refs/covey/${prefix}`], {});
  for (const r of (refs ?? "").split("\n").filter(Boolean)) await gitEnv(root, ["update-ref", "-d", r], {});
}

/** Make the working tree match `tree`: restore changed/deleted files, delete added ones.
 *  Returns the list of touched paths. Leaves the user's index alone. */
export async function restoreTree(cwd: string, tree: string): Promise<string[] | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const current = await captureCheckpoint(root, `tmp/restore-${Date.now()}`);
  if (!current) return null;
  const names = await gitEnv(root, ["diff-tree", "-r", "--name-status", "--no-renames", tree, current], {});
  if (names === null) return null;
  const touched: string[] = [];
  for (const line of names.split("\n").filter(Boolean)) {
    const [st, path] = line.split("\t") as [string, string];
    const abs = join(root, path);
    touched.push(path);
    if (st.startsWith("A")) {
      // exists now, did not exist before → delete
      rmSync(abs, { force: true });
      continue;
    }
    // modified or deleted since → restore bytes from the tree (binary-safe)
    const { stdout } = await run("git", ["cat-file", "blob", `${tree}:${path}`], { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    mkdirSync(dirname(abs), { recursive: true });
    const mode = (await gitEnv(root, ["ls-tree", tree, "--", path], {}))?.split(" ")[0];
    writeFileSync(abs, stdout as unknown as Buffer, { mode: mode === "100755" ? 0o755 : 0o644 });
  }
  await gitEnv(root, ["update-ref", "-d", `refs/covey/tmp/restore-${Date.now()}`], {}).catch(() => null);
  await deleteCheckpointRefs(root, "tmp");
  return touched;
}
