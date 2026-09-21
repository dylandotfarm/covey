/**
 * The repositories a user can reach, and a new one, through `gh`.
 *
 * Nothing here needs a checkout: `gh repo list` and `gh repo create` speak to
 * GitHub for the logged-in user, so the calls run in the daemon's projects
 * directory. The read path goes through `assertReadOnly`, as every `gh` read
 * in the daemon does. `createRepo` is the one write, and it sits alone.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoInfo } from "@covey/protocol";
import { assertReadOnly } from "./integrate/gh.js";

const run = promisify(execFile);

/** GitHub answers a list in seconds; the budget is for a slow link. */
const CALL_TIMEOUT_MS = 30_000;

/** How many repositories one list call asks for. Past this, a user with
 *  more has a search box, and the newest are first. */
const LIST_LIMIT = 300;

const FIELDS = "nameWithOwner,isPrivate,pushedAt,url,sshUrl,description";

/** What `gh repo list --json` prints for one repository. */
interface RawRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  pushedAt: string | null;
  url: string;
  sshUrl: string;
  description: string | null;
}

/** Which clone URL to hand out: the protocol `gh` itself is set to use. */
export type GitProtocol = "ssh" | "https";

/**
 * Turn one `gh repo list` answer into rows, with the clone URL for the
 * protocol. Pure, so a test can feed it what `gh` prints.
 */
export function parseRepoList(json: string, protocol: GitProtocol): RepoInfo[] {
  let raw: RawRepo[];
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => r && typeof r.nameWithOwner === "string").map((r) => ({
    nameWithOwner: r.nameWithOwner,
    isPrivate: !!r.isPrivate,
    pushedAt: r.pushedAt ?? null,
    cloneUrl: cloneUrlFor(r, protocol),
    description: r.description ?? "",
  }));
}

function cloneUrlFor(r: { url: string; sshUrl: string }, protocol: GitProtocol): string {
  if (protocol === "ssh" && r.sshUrl) return r.sshUrl;
  return r.url.endsWith(".git") ? r.url : `${r.url}.git`;
}

/**
 * Merge the lists of the user and of every organisation: one row per
 * repository, the newest push first. A repository the user forked into an
 * organisation appears in both lists and is kept once.
 */
export function mergeRepoLists(lists: RepoInfo[][]): RepoInfo[] {
  const seen = new Map<string, RepoInfo>();
  for (const list of lists) for (const r of list) if (!seen.has(r.nameWithOwner)) seen.set(r.nameWithOwner, r);
  return [...seen.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.nameWithOwner.localeCompare(b.nameWithOwner));
}

async function gh(cwd: string, args: string[]): Promise<string> {
  assertReadOnly(args);
  const { stdout } = await run("gh", args, { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The protocol `gh` clones with, as the user set it. `https` when unset. */
export async function gitProtocol(cwd: string): Promise<GitProtocol> {
  try {
    const out = (await gh(cwd, ["config", "get", "git_protocol"])).trim();
    return out === "ssh" ? "ssh" : "https";
  } catch { return "https"; }
}

/** What went wrong, in the words the user can act on. */
function ghError(e: unknown): string {
  const err = e as { code?: string; stderr?: string; message?: string };
  if (err?.code === "ENOENT") return "gh is not installed on this machine";
  const text = String(err?.stderr ?? err?.message ?? e).trim();
  if (/auth login|not logged in|authentication/i.test(text)) return "gh is not logged in on this machine: run `gh auth login` there";
  return text.split("\n").filter(Boolean).pop() ?? "gh failed";
}

/**
 * Every repository the user can reach: their own, then each organisation's.
 * An organisation that cannot be listed costs nothing but its rows; the
 * user's own list failing is the error the caller shows.
 */
export async function listRepos(cwd: string): Promise<{ repos: RepoInfo[]; error: string | null }> {
  const protocol = await gitProtocol(cwd);
  let own: RepoInfo[];
  try {
    own = parseRepoList(await gh(cwd, ["repo", "list", "--json", FIELDS, "--limit", String(LIST_LIMIT)]), protocol);
  } catch (e) {
    return { repos: [], error: ghError(e) };
  }
  let orgs: string[] = [];
  try {
    orgs = (await gh(cwd, ["api", "user/orgs", "--jq", ".[].login"])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* no organisations, or no scope to list them: the user's own repositories are still the answer */ }
  const lists = await Promise.all(orgs.map(async (org) => {
    try { return parseRepoList(await gh(cwd, ["repo", "list", org, "--json", FIELDS, "--limit", String(LIST_LIMIT)]), protocol); }
    catch { return []; }
  }));
  return { repos: mergeRepoLists([own, ...lists]), error: null };
}

/** What runs `gh` for the one write. A test passes one that never spawns. */
export type Exec = (args: string[]) => Promise<{ stdout: string }>;

/**
 * Make a repository on GitHub. The one write in this file: it does not go
 * through `gh()` and its guard, on purpose, so the guard keeps refusing
 * `repo create` everywhere else. On 2026-09-21 a test of the name check with
 * `../x` reached GitHub, which resolved it to `x` and made the repository;
 * the check refuses that name now, and the test hands in an `exec` that
 * throws, so no test can make one again.
 */
export async function createRepo(cwd: string, o: { name: string; visibility: "private" | "public"; description?: string }, exec: Exec = (args) => run("gh", args, { cwd, timeout: CALL_TIMEOUT_MS })): Promise<{ nameWithOwner: string; cloneUrl: string }> {
  const name = o.name.trim();
  // A name, or owner/name, of the characters GitHub allows, and never a
  // segment that is only dots: `../x` is a path, not a repository.
  const segment = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
  const parts = name.split("/");
  if (parts.length > 2 || !parts.every((p) => segment.test(p))) throw new Error(`${o.name} is not a repository name; use name or owner/name`);
  const args = ["repo", "create", name, `--${o.visibility}`, ...(o.description?.trim() ? ["--description", o.description.trim()] : [])];
  let out: string;
  try {
    ({ stdout: out } = await exec(args));
  } catch (e) {
    throw new Error(`could not create ${name}: ${ghError(e)}`);
  }
  // `gh repo create` prints the repository's URL and nothing else.
  const url = out.trim().split("\n").find((l) => /^https?:\/\//.test(l)) ?? "";
  const nameWithOwner = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "") || name;
  const protocol = await gitProtocol(cwd);
  const host = url ? new URL(url).host : "github.com";
  const cloneUrl = protocol === "ssh" ? `git@${host}:${nameWithOwner}.git` : `${url || `https://${host}/${nameWithOwner}`}.git`;
  return { nameWithOwner, cloneUrl };
}
