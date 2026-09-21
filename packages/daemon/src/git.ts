import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync as mkdirp, writeFileSync as writeFile } from "node:fs";
import { join, dirname } from "node:path";
import type { ProjectGit } from "@covey/protocol";

const run = promisify(execFile);

/** Like `git()`, but keeps git's own complaint so it can be shown to the user. */
async function gitTry(cwd: string, args: string[], timeout = 10_000): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout });
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

/** True for a working checkout (`.git` inside) and for a bare repository. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git")) || (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects")));
}

/** True when `dir` is a bare repository: refs and objects, no working tree. */
export async function isBareRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-bare-repository"])) === "true";
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

/**
 * The directory under `projectsDir` for a repository: its whole identity as a
 * path, `github.com/dylandotfarm/covey`, with anything a path must not hold
 * replaced by `-`. The host stays in, because `github.com/acme/api` and
 * `gitlab.com/acme/api` are two repositories and must not share one clone.
 */
export function projectSlug(identity: string): string {
  const parts = identity.split("/").filter(Boolean);
  const clean = parts.map((s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "_")).filter(Boolean);
  return clean.length ? clean.join("/") : "repo";
}

/** The URL of `origin`, as git has it. */
export async function remoteUrl(cwd: string): Promise<string | null> {
  return git(cwd, ["remote", "get-url", "origin"]);
}

export async function repositoryIdentity(cwd: string): Promise<string | null> {
  const remote = await remoteUrl(cwd);
  if (!remote) return null;
  return normaliseRemote(remote);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * The directory that git commands for this repository run in: the top of the
 * working tree, or the bare repository itself when there is no working tree.
 * A project covey cloned is bare, and every git call the engine makes on the
 * project (fetch, worktree add, the checkpoint refs) works there.
 *
 * A checkout answers in one call. A bare repository refuses `--show-toplevel`,
 * and then one more call reads the two facts that name it.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) return top;
  const facts = await git(cwd, ["rev-parse", "--is-bare-repository", "--absolute-git-dir"]);
  const [bare, dir] = facts?.split("\n") ?? [];
  return bare === "true" && dir ? dir : null;
}

/** How long the first fetch of a repository may take. A large repository over
 *  a slow link needs minutes, and a clone that is cut off is a project that
 *  does not exist, so the budget is large. The client waits as long. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Make `dir` a bare repository that mirrors `origin` at `url`, or bring one
 * that is already there up to date. Never a working tree: the threads'
 * worktrees are the only checkouts, so there is no `HEAD` to work from and no
 * directory that two threads change at the same time.
 *
 * `git clone --bare` would write no fetch refspec, so `origin/main` would never
 * appear and every fetch after the first would find nothing. `init` plus
 * `remote add` writes the refspec, and `remote set-head` records which branch
 * the remote calls its default.
 *
 * The bare repository's own `HEAD` stays unborn on purpose. A local copy of
 * the default branch would never move, and an agent that ran `git merge main`
 * in its worktree would merge the copy, not the remote. `origin/main` is the
 * ref every worktree can reach, and the one the thread is told to merge.
 */
export async function cloneBare(url: string, dir: string): Promise<{ ok: true } | { error: string }> {
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirp(dir, { recursive: true });
    const init = await gitTry(dir, ["init", "--quiet", "--bare"]);
    if (!init.ok) return { error: init.err };
  }
  // The URL is the caller's, every time. A directory left by a clone that
  // failed keeps the URL that failed, and a retry with another URL for the
  // same repository must not fetch from the old one.
  const has = await git(dir, ["remote", "get-url", "origin"]);
  const remote = await gitTry(dir, has === null ? ["remote", "add", "origin", url] : ["remote", "set-url", "origin", url]);
  if (!remote.ok) return { error: remote.err };
  const fetch = await gitTry(dir, ["fetch", "--no-tags", "--quiet", "origin"], CLONE_TIMEOUT_MS);
  if (!fetch.ok) return { error: fetch.err };
  const head = await gitTry(dir, ["remote", "set-head", "origin", "--auto"]);
  if (!head.ok) return { error: head.err };
  // A whole fetch just happened. The next thread must not pay for another.
  markFetched(dir);
  return { ok: true };
}

/** Fetch one branch from `origin`, so it can be branched from. False when the
 *  remote has no such branch, or cannot be reached. */
export async function fetchBranch(root: string, branch: string): Promise<boolean> {
  const r = await gitTry(root, ["fetch", "--no-tags", "--quiet", "origin", branch], FETCH_TIMEOUT_MS);
  return r.ok;
}

/**
 * How long a fetch on the clean-start path gets before we give up and branch
 * from the refs that are already here. A no-op fetch of this project over the
 * network measures 1.2s to 1.4s, so the budget is more than ten times a
 * healthy fetch. It bounds the one case that has no bound of its own: a remote
 * that accepts the connection and then says nothing.
 */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * How long one repository's fetch counts as fresh. A dispatch makes six or
 * eight threads in the same project within a few seconds, and 1.3s each on the
 * path the operator waits on is a delay they feel. One fetch a minute leaves a
 * worktree at most a minute behind the remote, against the two days this
 * replaces.
 *
 * This is the window for a fetch that *worked*. A fetch that failed is not
 * remembered at all — see `fetchOrigin`.
 */
const FETCH_FRESH_MS = 60_000;

/** What the fetch before a clean start did. */
export type FetchOutcome =
  | { state: "fetched" }
  /** No `origin`, so there is nothing to be behind. */
  | { state: "no-remote" }
  /** Offline, no credentials, a remote that is down. git's own complaint. */
  | { state: "failed"; error: string };

/** In-flight and recent fetches, by repo root. Also deduplicates a dispatch:
 *  eight threads in one project share the one fetch.
 *
 *  One entry per repository a daemon has ever dispatched into, which is a
 *  handful, so nothing evicts a good one before `FETCH_FRESH_MS` retires it in
 *  place. A failed one is deleted, so a blip is never remembered. */
const fetches = new Map<string, { at: number; done: Promise<FetchOutcome> }>();

/** Record that `root` was fetched whole just now, so the next clean start
 *  within `FETCH_FRESH_MS` reuses it. */
export function markFetched(root: string): void {
  fetches.set(root, { at: Date.now(), done: Promise.resolve({ state: "fetched" }) });
}

/** Forget the last fetch of `root`, so the next clean start fetches again.
 *  For a test that changes the remote and must see the change now. */
export function forgetFetch(root: string): void {
  fetches.delete(root);
}

/**
 * The remote's default branch, as a ref this machine can resolve: `origin/HEAD`
 * first, then the usual names. An `origin/HEAD` can outlive the branch it
 * names, so each candidate is verified rather than believed.
 */
async function remoteDefaultRef(root: string): Promise<string | null> {
  const head = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const named = head?.startsWith("origin/") ? [head.replace(/^origin\//, "")] : [];
  for (const b of [...named, "main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])) return `origin/${b}`;
  }
  return null;
}

/** Bring `origin` up to date, or say why we could not. Never throws. */
async function fetchOrigin(root: string): Promise<FetchOutcome> {
  if (!(await git(root, ["remote", "get-url", "origin"]))) return { state: "no-remote" };
  const hit = fetches.get(root);
  if (hit && Date.now() - hit.at < FETCH_FRESH_MS) return hit.done;
  const done = (async (): Promise<FetchOutcome> => {
    // One branch when we can name it, which is every repo that has ever
    // fetched; the whole remote only for one that has a remote and no refs
    // from it yet.
    const ref = await remoteDefaultRef(root);
    const name = ref?.replace(/^origin\//, "");
    const args = ["fetch", "--no-tags", "--quiet", "origin", ...(name ? [name] : [])];
    const started = Date.now();
    const r = await gitTry(root, args, FETCH_TIMEOUT_MS);
    if (r.ok) return { state: "fetched" };
    // A remote that says nothing leaves git nothing to complain about, so the
    // budget has to name itself. Without this the thread reads "the fetch from
    // origin failed (git failed)", which tells it nothing it can act on.
    const quiet = Date.now() - started >= FETCH_TIMEOUT_MS;
    return { state: "failed", error: quiet ? `no answer from origin within ${FETCH_TIMEOUT_MS / 1000}s` : r.err };
  })();
  fetches.set(root, { at: Date.now(), done });
  // A fetch that worked is remembered for a minute. A fetch that failed is
  // forgotten the moment it settles, so the next thread tries again: a blip
  // that lasted a second must not decide where the next seven agents start,
  // and that is #76 in miniature. The entry is removed only once it settles,
  // so threads created together still share the one attempt. A remote that is
  // really down is therefore retried once per thread — each bounded by
  // `FETCH_TIMEOUT_MS`, and each of those threads is told in its first line.
  void done.then((r) => { if (r.state === "failed" && fetches.get(root)?.done === done) fetches.delete(root); });
  return done;
}

/**
 * The ref a "clean start" worktree branches from. Work is pushed to `origin`
 * and reviewed there, so `origin` is the truth about what the default branch
 * is; the local branch of the same name is one machine's opinion of it, and on
 * a machine that dispatches agents it is a stale one, because nobody pulls a
 * checkout they only ever branch from. So: `origin/<default>` whenever a
 * remote has one, and a local main/master only for a repo with no remote.
 *
 * Reads refs and nothing else. `gitInfo` calls it on every project read, which
 * is why the fetch lives in `cleanStartBase` and not here.
 */
export async function defaultBranchRef(cwd: string): Promise<string | null> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const remote = await remoteDefaultRef(root);
  if (remote) return remote;
  for (const b of ["main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  }
  return null;
}

/** Where a clean-start worktree begins, and how fresh that is. */
export interface CleanStart {
  /** The ref to branch from: `origin/main`, or `main` in a repo with no remote. */
  ref: string;
  /** The commit the ref pointed at, abbreviated, so a thread can say where it started. */
  commit: string;
  fetch: FetchOutcome;
}

/**
 * The base for a `worktree-default` worktree: fetch `origin`, then resolve its
 * default branch. Without the fetch the ref is only as fresh as the last time
 * somebody typed `git pull`, which is the same defect wearing a different hat.
 *
 * A fetch that fails does not stop the worktree. The caller branches from what
 * is here and reports `fetch`, because an agent that starts stale and knows it
 * can merge the default branch first, and an agent that cannot start does
 * nothing at all.
 */
export async function cleanStartBase(cwd: string): Promise<CleanStart | null> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const fetch = await fetchOrigin(root);
  const ref = await defaultBranchRef(root);
  if (!ref) return null;
  const commit = await git(root, ["rev-parse", "--short", ref]);
  if (!commit) return null;
  return { ref, commit, fetch };
}

/**
 * The one line a clean-start thread gets in its transcript. It names the ref
 * and the commit, so the thread can say where it started; a fetch that failed
 * makes it a warning, because that is the case where the thread has to act.
 */
export function cleanStartNote(start: CleanStart): ["info" | "warning", string] {
  const at = `Branched from ${start.ref} at ${start.commit}`;
  if (start.fetch.state === "failed") {
    // The ref itself, not the local branch of that name: in a bare clone there
    // is no local branch, and in a checkout the local one is the stale copy.
    return ["warning", `${at}, but the fetch from origin failed (${start.fetch.error}), so ${start.ref} is only as fresh as the last fetch that worked. Fetch and merge ${start.ref} before you start if the work has to land on it.`];
  }
  if (start.fetch.state === "no-remote") return ["info", `${at}. The repository has no remote, so ${start.ref} is all there is.`];
  return ["info", `${at}, fetched from origin just now.`];
}

/** Branch state of a project directory, read fresh — branches move under us. */
export async function gitInfo(dir: string): Promise<ProjectGit> {
  const empty: ProjectGit = { isRepo: false, root: null, currentBranch: null, defaultBranch: null, hasCommits: false };
  if (!isGitRepo(dir)) return empty;
  const root = await repoRoot(dir);
  if (!root) return empty;
  // `branch --show-current` (unlike rev-parse) survives a repo with no commits
  // and reports empty rather than "HEAD" when detached.
  const [branch, head, def, bare] = await Promise.all([
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    defaultBranchRef(root),
    isBareRepo(root),
  ]);
  // A bare clone's HEAD is unborn on purpose (see `cloneBare`); its history is
  // the remote's, and it has no branch of its own checked out.
  if (bare) return { isRepo: true, root, currentBranch: null, defaultBranch: def, hasCommits: def !== null };
  return { isRepo: true, root, currentBranch: branch || null, defaultBranch: def, hasCommits: !!head };
}

/**
 * Where a thread's worktree goes. A clone keeps them beside its bare
 * repository: `<projectsDir>/<owner>/<repo>/<name>`. A checkout keeps them
 * inside itself, under `.covey/worktrees`, next to a self-ignoring `.gitignore`
 * so they never show in the checkout's status or in a turn checkpoint.
 */
export function worktreePath(project: { workspaceRoot: string; kind?: "clone" | "checkout" }, name: string): string {
  if (project.kind === "clone") return join(dirname(project.workspaceRoot), name);
  return join(project.workspaceRoot, ".covey", "worktrees", name);
}

/**
 * Create a worktree at `path` on `branch`, from `base`.
 *
 * `branch` is new in the common case: `covey/<name>`, which no repository has
 * seen. A moved thread brings a branch the repository may already hold, from
 * the time the thread was here before. That branch is moved to `base` and
 * checked out, so the worktree holds what the remote has. Git refuses when
 * the branch is checked out in another worktree, and the error says so.
 */
export async function createWorktree(
  repo: string,
  name: string,
  base: string,
  path: string,
  branch = `covey/${name}`,
): Promise<{ path: string; branch: string } | { error: string }> {
  const root = (await repoRoot(repo)) ?? repo;
  // A checkout keeps its worktrees inside itself, under `.covey`. The
  // self-ignoring `.gitignore` keeps them out of the checkout's status, and
  // out of the turn checkpoints, which honour `.gitignore`. A bare repository
  // has no status to keep them out of.
  if (!(await isBareRepo(root))) {
    try {
      mkdirp(join(root, ".covey"), { recursive: true });
      const ignore = join(root, ".covey", ".gitignore");
      if (!existsSync(ignore)) writeFile(ignore, "*\n");
    } catch { /* best effort; worktree creation is what matters */ }
  }
  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists) {
    const moved = await gitTry(root, ["branch", "--force", branch, base]);
    if (!moved.ok) return { error: moved.err };
  }
  // `--no-track`: branching from `origin/main` would otherwise make it the new
  // branch's upstream, and `git push` under push.default=simple refuses a
  // branch whose upstream has another name.
  const r = await gitTry(root, exists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "--no-track", "-b", branch, path, base]);
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
