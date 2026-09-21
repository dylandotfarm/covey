/**
 * The repositories a user can reach, and a new one, through `gh`.
 *
 * Nothing here needs a checkout: the calls speak to GitHub for the logged-in
 * user, so they run in the user's home directory, which always exists. The
 * read goes through `gh()` and its guard, as every `gh` read in the daemon
 * does. `createRepo` is the one write, and it sits alone.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import type { RepoInfo } from "@covey/protocol";
import { gh, ghError } from "./gh.js";

const run = promisify(execFile);

/** The whole list is one call that pages; a slow link gets a minute. */
const LIST_TIMEOUT_MS = 50_000;

/** A local config read touches no network. */
const CONFIG_TIMEOUT_MS = 5_000;

/** Where `gh` runs: a directory that exists on every machine. */
export const GH_CWD = homedir();

/**
 * One REST call for every repository the user owns or belongs to through an
 * organisation, newest push first. One process, however many organisations;
 * `gh repo list` would be one process per organisation, and forty at once on
 * a Pi is a memory problem and a rate limit.
 */
const LIST_ARGS = [
  "api", "user/repos?affiliation=owner,organization_member&sort=pushed&per_page=100", "--paginate",
  "--jq", ".[] | [.full_name, .private, .pushed_at, .html_url, .ssh_url, (.description // \"\")] | @tsv",
];

/** Which clone URL to hand out: the protocol `gh` itself is set to use. */
export type GitProtocol = "ssh" | "https";

/**
 * Turn the list, one repository per tab-separated line, into rows with the
 * clone URL for the protocol. Pure, so a test can feed it what `gh` prints.
 * A line that does not parse is left out, never a throw.
 */
export function parseRepoList(tsv: string, protocol: GitProtocol): RepoInfo[] {
  const rows: RepoInfo[] = [];
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue;
    const [nameWithOwner, isPrivate, pushedAt, url, sshUrl, description = ""] = line.split("\t");
    if (!nameWithOwner || !url || !/^https?:\/\//.test(url)) continue;
    rows.push({
      nameWithOwner,
      isPrivate: isPrivate === "true",
      pushedAt: pushedAt || null,
      cloneUrl: cloneUrlFor({ url, sshUrl: sshUrl ?? "" }, protocol),
      description: description.replace(/\\t/g, " ").replace(/\\n/g, " "),
    });
  }
  return rows;
}

/** The clone URL in the protocol: ssh when `gh` clones by ssh, else https with its `.git`. */
export function cloneUrlFor(r: { url: string; sshUrl: string }, protocol: GitProtocol): string {
  if (protocol === "ssh" && r.sshUrl) return r.sshUrl;
  return r.url.endsWith(".git") ? r.url : `${r.url}.git`;
}

/**
 * The protocol `gh` clones with, as the user set it for github.com. The
 * answer `gh auth login` records lives under the host, so the host is asked
 * first and the global setting second. `https` when neither says.
 */
export async function gitProtocol(cwd = GH_CWD): Promise<GitProtocol> {
  for (const args of [["config", "get", "-h", "github.com", "git_protocol"], ["config", "get", "git_protocol"]]) {
    const r = await gh(cwd, args, CONFIG_TIMEOUT_MS);
    if (r.ok && r.out.trim() === "ssh") return "ssh";
    if (r.ok && r.out.trim() === "https") return "https";
  }
  return "https";
}

/**
 * Every repository the user can reach, newest push first. `error` names a
 * `gh` that is missing, not logged in, or unable to answer; the list is then
 * empty.
 */
export async function listRepos(cwd = GH_CWD): Promise<{ repos: RepoInfo[]; error: string | null }> {
  const [protocol, list] = await Promise.all([gitProtocol(cwd), gh(cwd, LIST_ARGS, LIST_TIMEOUT_MS)]);
  if (!list.ok) return { repos: [], error: list.error };
  return { repos: parseRepoList(list.out, protocol), error: null };
}

/** What runs `gh` for the one write. A test passes one that never spawns. */
export type Exec = (args: string[]) => Promise<{ stdout: string }>;

/** What `createRepo` needs from outside: the write itself, and the protocol. */
export interface CreateDeps {
  exec?: Exec;
  protocol?: GitProtocol;
}

/**
 * Make a repository on GitHub. The one write in this file: it does not go
 * through `gh()` and its guard, on purpose, so the guard refuses
 * `repo create` everywhere else.
 *
 * A test supplies `deps` in full, so a test can never spawn `gh`. On
 * 2026-09-21 a test of the name check reached GitHub with `../x`. GitHub read
 * it as `x` and made the repository. The check refuses that name now.
 */
export async function createRepo(o: { name: string; visibility: "private" | "public"; description?: string }, deps: CreateDeps = {}): Promise<{ nameWithOwner: string; cloneUrl: string }> {
  const name = o.name.trim();
  // A name, or owner/name, of the characters GitHub allows. A segment may
  // start with a dot (`.github`), but may not be only dots (`..` is a path),
  // and may not start with a dash (`--private` is a flag).
  const segment = /^(?!\.+$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
  const parts = name.split("/");
  if (!name || parts.length > 2 || !parts.every((p) => segment.test(p))) throw new Error(`${o.name} is not a repository name; use name or owner/name`);
  const description = o.description?.trim();
  const args = ["repo", "create", name, `--${o.visibility}`, ...(description ? ["--description", description] : [])];
  const exec = deps.exec ?? ((a) => run("gh", a, { cwd: GH_CWD, timeout: 30_000 }));
  let out: string;
  try {
    ({ stdout: out } = await exec(args));
  } catch (e) {
    throw new Error(`could not create ${name}: ${ghError(e)}`);
  }
  // `gh repo create` prints the repository's URL. Without one there is no
  // repository to name, and a guess would send every clone to a wrong place.
  const url = out.trim().split("\n").find((l) => /^https?:\/\//.test(l.trim()))?.trim();
  if (!url) throw new Error(`gh made ${name} but did not print its URL; find it on GitHub and add it by URL`);
  const { host, pathname } = new URL(url);
  const nameWithOwner = pathname.replace(/^\//, "").replace(/\.git$/, "");
  const protocol = deps.protocol ?? (await gitProtocol());
  return { nameWithOwner, cloneUrl: cloneUrlFor({ url, sshUrl: `git@${host}:${nameWithOwner}.git` }, protocol) };
}
