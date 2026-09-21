/**
 * Test support: throwaway repositories under `tmpdir`.
 *
 * A project is a clone of a remote, so a test that makes a project needs a
 * remote. This one is a bare repository on disk with one commit on `main`, so
 * a clone of it reaches no network. Nothing here may be pointed at a real
 * checkout: the helpers commit and push.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const git = async (cwd: string, ...args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

export interface ScratchRemote {
  /** The bare repository, as a URL a project can clone. */
  url: string;
  /** The directory that holds the remote and its seed checkout. */
  dir: string;
  /** Add a commit to `main` on the remote, and return its short hash. */
  push: (msg: string) => Promise<string>;
  /** Push the seed checkout's current state to a named branch. */
  pushBranch: (branch: string, msg: string) => Promise<string>;
  drop: () => void;
}

/** A bare remote with one commit on `main`, and a seed checkout to add more. */
export async function scratchRemote(prefix = "covey-remote-"): Promise<ScratchRemote> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const url = join(dir, "shared.git");
  await execFile("git", ["init", "-q", "--bare", "-b", "main", url]);
  const seed = join(dir, "seed");
  await execFile("git", ["clone", "-q", url, seed]);
  await git(seed, "config", "user.email", "test@covey");
  await git(seed, "config", "user.name", "covey test");
  const commit = async (msg: string) => {
    writeFileSync(join(seed, "README.md"), `${msg}\n`);
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", msg);
    return git(seed, "rev-parse", "--short", "HEAD");
  };
  const push = async (msg: string) => {
    const sha = await commit(msg);
    await git(seed, "push", "-q", "origin", "main");
    return sha;
  };
  const pushBranch = async (branch: string, msg: string) => {
    const sha = await commit(msg);
    await git(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    return sha;
  };
  await push("hello");
  return { url, dir, push, pushBranch, drop: () => rmSync(dir, { recursive: true, force: true }) };
}
